//! Spawn-owned process containment. Numeric PIDs and current PPIDs never grant
//! authority to kill a process. Windows jobs are assigned before child execution.
use crate::runtime::host::SpawnError;
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant};

const RECLAIM_DEADLINE: Duration = Duration::from_secs(5);
pub(crate) const JOB_MECHANISM: &str = "windows non-breakaway job; active count zero, original root and observed descendant handles signaled";

#[derive(Debug, Clone)]
pub struct ReclaimReport {
    pub root_pid: u32,
    pub mechanism: &'static str,
    /// Observed members before termination; job containment also covers members
    /// created during termination. These lists are not a PPID-derived kill plan.
    pub descendants_found: Vec<u32>,
    pub killed: Vec<u32>,
}

#[derive(Debug, Clone, Copy)]
pub struct NativeRoot {
    pub root_pid: u32,
    /// Unique local registration stamp, sampled before the suspended spawn.
    /// This is a lookup key, not a claim of OS process creation identity.
    pub spawned_at_ms: i64,
    pub exited_at_ms: Option<i64>,
}

#[cfg(not(target_os = "linux"))]
pub type ReclaimRoot = NativeRoot;

#[cfg(target_os = "linux")]
#[derive(Debug, Clone)]
pub struct ReclaimRoot {
    pub root_pid: u32,
    pub spawned_at_ms: i64,
    pub exited_at_ms: Option<i64>,
    pub(crate) owner: Arc<linux_broker::ReclaimHandle>,
}

#[cfg(all(test, target_os = "linux"))]
#[derive(Debug, Clone, Copy)]
pub struct ProcessRecord {
    pub ppid: u32,
    pub created_ms: Option<i64>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub(crate) fn registration_stamp() -> i64 {
    static LAST: AtomicI64 = AtomicI64::new(0);
    let now = now_ms();
    let previous = LAST
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |last| {
            Some(now.max(last.saturating_add(1)))
        })
        .unwrap_or_else(|last| last);
    now.max(previous.saturating_add(1))
}

type OwnershipKey = (u32, i64);
type OwnershipTable = Mutex<HashMap<OwnershipKey, Weak<Job>>>;
fn ownerships() -> &'static OwnershipTable {
    static TABLE: LazyLock<OwnershipTable> = LazyLock::new(|| Mutex::new(HashMap::new()));
    &TABLE
}
fn ownership_error() -> SpawnError {
    SpawnError::Io("process ownership unavailable or expired".into())
}

pub(crate) struct ReclaimObservation {
    members: Vec<u32>,
    #[cfg(windows)]
    processes: Vec<std::os::windows::io::OwnedHandle>,
}

impl ReclaimObservation {
    fn capture(job: &Job, root: NativeRoot) -> Result<Self, SpawnError> {
        let members = job.members()?;
        #[cfg(windows)]
        let processes = job.observe_members(&members, root.root_pid)?;
        #[cfg(not(windows))]
        let _ = root;
        Ok(Self {
            members,
            #[cfg(windows)]
            processes,
        })
    }

    fn complete(&self, job: &Job) -> Result<bool, SpawnError> {
        if !job.empty()? {
            return Ok(false);
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{
                Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
                System::Threading::WaitForSingleObject,
            };
            for process in &self.processes {
                match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
                    WAIT_OBJECT_0 => {}
                    WAIT_TIMEOUT => return Ok(false),
                    _ => {
                        return Err(SpawnError::Io(
                            "owned descendant exit signal unavailable".into(),
                        ))
                    }
                }
            }
        }
        Ok(true)
    }
}

fn begin_reclamation(job: &Job, root: NativeRoot) -> Result<ReclaimObservation, SpawnError> {
    // Termination must still be requested if observation fails; an incomplete
    // observation can never be reported as verified cleanup.
    let observation = ReclaimObservation::capture(job, root);
    job.terminate()?;
    observation
}

pub(crate) struct OwnedTree {
    job: Arc<Job>,
    root: Option<NativeRoot>,
}
impl OwnedTree {
    pub(crate) fn new() -> Result<Self, SpawnError> {
        Ok(Self {
            job: Arc::new(Job::new()?),
            root: None,
        })
    }
    pub(crate) fn lease(&self) -> Option<OwnedReclaimLease> {
        self.root.map(|root| OwnedReclaimLease::Job {
            root,
            job: Arc::clone(&self.job),
        })
    }
    #[cfg(windows)]
    pub(crate) fn attach(
        &mut self,
        process: windows_sys::Win32::Foundation::HANDLE,
        root: NativeRoot,
    ) -> Result<(), SpawnError> {
        self.job.assign(process)?;
        ownerships().lock().map_err(|_| ownership_error())?.insert(
            (root.root_pid, root.spawned_at_ms),
            Arc::downgrade(&self.job),
        );
        self.root = Some(root);
        resume_primary(process, root.root_pid)
    }
    pub(crate) fn terminate(&self) -> Result<ReclaimObservation, SpawnError> {
        let root = self.root.ok_or_else(ownership_error)?;
        begin_reclamation(&self.job, root)
    }
    pub(crate) fn empty(&self, observation: &ReclaimObservation) -> Result<bool, SpawnError> {
        observation.complete(&self.job)
    }
    pub(crate) fn report(
        &self,
        observation: ReclaimObservation,
    ) -> Result<ReclaimReport, SpawnError> {
        let root = self.root.ok_or_else(ownership_error)?;
        Ok(report(root, observation.members))
    }
}
impl Drop for OwnedTree {
    fn drop(&mut self) {
        // TerminateJobObject/CloseHandle are immediate OS requests: no waits,
        // snapshots, blocking tasks or root-only fallback on the dropping worker.
        if self.job.terminate().is_err() {
            tracing::error!(
                code = "PROCESS_CLEANUP_FAILED",
                "owned job termination failed"
            );
        }
        if let Some(root) = self.root {
            if let Ok(mut table) = ownerships().lock() {
                table.remove(&(root.root_pid, root.spawned_at_ms));
            }
        }
    }
}
fn report(root: NativeRoot, members: Vec<u32>) -> ReclaimReport {
    ReclaimReport {
        root_pid: root.root_pid,
        mechanism: JOB_MECHANISM,
        descendants_found: members
            .iter()
            .copied()
            .filter(|pid| *pid != root.root_pid)
            .collect(),
        killed: members,
    }
}

/// Retains the original OS ownership across native process abandonment.
/// Linux keeps the existing broker pidfd and private completion channel alive.
pub(crate) enum OwnedReclaimLease {
    Job {
        root: NativeRoot,
        job: Arc<Job>,
    },
    #[cfg(target_os = "linux")]
    Broker(ReclaimRoot),
}
impl OwnedReclaimLease {
    pub(crate) fn reclaim(self) -> Result<ReclaimReport, SpawnError> {
        match &self {
            Self::Job { root, job } => reclaim_owned(job, *root),
            #[cfg(target_os = "linux")]
            Self::Broker(root) => linux_broker::reclaim(root.clone()),
        }
    }
}
impl Drop for OwnedReclaimLease {
    fn drop(&mut self) {
        match self {
            Self::Job { job, .. } => {
                if job.terminate().is_err() {
                    tracing::error!(
                        code = "PROCESS_CLEANUP_FAILED",
                        "retained owned job termination failed"
                    );
                }
            }
            #[cfg(target_os = "linux")]
            // Last broker capability drop closes its private completion channel;
            // blocking exit proof belongs to reclaim(), not this destructor.
            Self::Broker(_) => {}
        }
    }
}

#[cfg(not(target_os = "linux"))]
pub fn reclaim_process_tree(root: NativeRoot) -> Result<ReclaimReport, SpawnError> {
    // A stale/recycled root can only resolve its retained original job, never
    // authorize walking its replacement's current descendant lineage.
    let job = ownerships()
        .lock()
        .map_err(|_| ownership_error())?
        .get(&(root.root_pid, root.spawned_at_ms))
        .and_then(Weak::upgrade)
        .ok_or_else(ownership_error)?;
    reclaim_owned(&job, root)
}

fn reclaim_owned(job: &Job, root: NativeRoot) -> Result<ReclaimReport, SpawnError> {
    let deadline = Instant::now() + RECLAIM_DEADLINE;
    let observation = begin_reclamation(job, root)?;
    loop {
        if Instant::now() >= deadline {
            return Err(SpawnError::Io("owned job reclamation timed out".into()));
        }
        if observation.complete(job)? {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    Ok(report(root, observation.members))
}

#[cfg(windows)]
pub(crate) struct Job {
    handle: windows_sys::Win32::Foundation::HANDLE,
    termination: std::sync::atomic::AtomicU8,
    // Runtime-input slot: the original suspended child handle is duplicated
    // exactly once during assignment, before any child code can execute.
    root_process: std::sync::OnceLock<std::os::windows::io::OwnedHandle>,
}
// SAFETY: the unnamed handle is non-inheritable, owned until Arc's last drop,
// and Job APIs are thread-safe. The atomic serializes the sole termination call.
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    fn new() -> Result<Self, SpawnError> {
        use windows_sys::Win32::System::JobObjects::*;
        // SAFETY: null security attributes create a non-inheritable unnamed job.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(ownership_error());
        }
        let job = Self {
            handle,
            termination: std::sync::atomic::AtomicU8::new(0),
            root_process: std::sync::OnceLock::new(),
        };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // Neither BREAKAWAY_OK nor SILENT_BREAKAWAY_OK is enabled.
        // SAFETY: correctly typed initialized buffer and its exact size.
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(ownership_error());
        }
        Ok(job)
    }
    fn assign(&self, process: windows_sys::Win32::Foundation::HANDLE) -> Result<(), SpawnError> {
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::{
            Foundation::DuplicateHandle,
            System::Threading::{GetCurrentProcess, PROCESS_SYNCHRONIZE},
        };
        let mut duplicate = std::ptr::null_mut();
        // SAFETY: caller retains the original suspended process handle.
        // Duplicate that exact kernel object, never reopen a PID. Only wait
        // permission is needed, and the resulting handle is non-inheritable.
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                process,
                GetCurrentProcess(),
                &mut duplicate,
                PROCESS_SYNCHRONIZE,
                0,
                0,
            )
        } == 0
            || duplicate.is_null()
        {
            return Err(SpawnError::Io(
                "owned root handle duplication failed".into(),
            ));
        }
        // SAFETY: successful DuplicateHandle transferred this fresh handle.
        let retained = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(duplicate) };
        self.root_process
            .set(retained)
            .map_err(|_| ownership_error())?;
        // SAFETY: caller retains the process handle; its primary thread is suspended.
        if unsafe {
            windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.handle, process)
        } == 0
        {
            return Err(ownership_error());
        }
        Ok(())
    }
    fn terminate(&self) -> Result<(), SpawnError> {
        match self
            .termination
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => {
                // SAFETY: job handle remains owned, affects only assigned members.
                let ok = unsafe {
                    windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, 1)
                } != 0;
                self.termination
                    .store(if ok { 2 } else { 3 }, Ordering::Release);
                if ok {
                    Ok(())
                } else {
                    Err(SpawnError::Io("owned job termination failed".into()))
                }
            }
            // Another retained owner may already be inside TerminateJobObject.
            // Drops remain nonblocking; reclaimers join via bounded empty().
            Err(1 | 2) => Ok(()),
            Err(_) => Err(SpawnError::Io("owned job termination failed".into())),
        }
    }
    fn active(&self) -> Result<u32, SpawnError> {
        use windows_sys::Win32::System::JobObjects::*;
        if self.termination.load(Ordering::Acquire) == 3 {
            return Err(SpawnError::Io("owned job termination failed".into()));
        }
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: exact initialized output struct, owned job handle.
        if unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(SpawnError::Io("owned job accounting unavailable".into()));
        }
        Ok(info.ActiveProcesses)
    }
    fn empty(&self) -> Result<bool, SpawnError> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::WaitForSingleObject,
        };
        if self.termination.load(Ordering::Acquire) == 1 {
            return Ok(false);
        }
        let root = self.root_process.get().ok_or_else(ownership_error)?;
        if self.active()? != 0 {
            return Ok(false);
        }
        // Accounting can reach zero before process-object rundown signals.
        // The retained duplicate stays live throughout this zero-time probe;
        // callers already impose the bounded reclamation deadline.
        match unsafe { WaitForSingleObject(root.as_raw_handle(), 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(SpawnError::Io("owned root exit signal unavailable".into())),
        }
    }
    fn observe_members(
        &self,
        members: &[u32],
        root_pid: u32,
    ) -> Result<Vec<std::os::windows::io::OwnedHandle>, SpawnError> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle};
        use windows_sys::Win32::{
            Foundation::{GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0},
            System::{
                JobObjects::IsProcessInJob,
                Threading::{
                    OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
                    PROCESS_SYNCHRONIZE,
                },
            },
        };
        let mut handles = Vec::with_capacity(members.len());
        for &pid in members.iter().filter(|&&pid| pid != root_pid) {
            // These handles are observation-only; the job, never a PID, retains
            // sole termination authority.
            let process = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            };
            if process.is_null() {
                if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
                    continue;
                }
                return Err(SpawnError::Io(
                    "owned descendant observation unavailable".into(),
                ));
            }
            let process = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(process) };
            let mut contained = 0;
            if unsafe { IsProcessInJob(process.as_raw_handle(), self.handle, &mut contained) } == 0
            {
                return Err(SpawnError::Io(
                    "owned descendant membership unavailable".into(),
                ));
            }
            if contained == 0 {
                // A PID may have been recycled, or the member may have left
                // the job before its process object signaled. Never claim
                // completion from that ambiguity.
                if unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } != WAIT_OBJECT_0 {
                    return Err(SpawnError::Io(
                        "owned descendant changed before observation".into(),
                    ));
                }
                continue;
            }
            handles.push(process);
        }
        Ok(handles)
    }
    fn members(&self) -> Result<Vec<u32>, SpawnError> {
        use windows_sys::Win32::System::JobObjects::*;
        // Bounded diagnostic snapshot, NOT cleanup authority. Job termination
        // and accounting cover any later members independently of this list.
        let active = self.active()? as usize;
        if active == 0 {
            return Ok(Vec::new());
        }
        if active > 4096 {
            return Err(SpawnError::Io("owned job membership exceeds budget".into()));
        }
        let mut slots = (active + 1).min(4096);
        let mut storage = Vec::<usize>::new();
        loop {
            storage.resize(slots + 2, 0);
            let bytes = (storage.len() * std::mem::size_of::<usize>()) as u32;
            // SAFETY: usize-aligned storage contains header and slots trailing IDs.
            let queried = unsafe {
                QueryInformationJobObject(
                    self.handle,
                    JobObjectBasicProcessIdList,
                    storage.as_mut_ptr().cast(),
                    bytes,
                    std::ptr::null_mut(),
                )
            } != 0;
            if !queried {
                let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
                if error == windows_sys::Win32::Foundation::ERROR_MORE_DATA && slots < 4096 {
                    slots = (slots * 2).min(4096);
                    continue;
                }
                return Err(SpawnError::Io(
                    "owned job membership unavailable or exceeds budget".into(),
                ));
            }
            let list = storage.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
            // SAFETY: successful query initialized this header and trailing IDs.
            let count = unsafe { (*list).NumberOfProcessIdsInList } as usize;
            if count > slots {
                return Err(SpawnError::Io("owned job membership exceeds budget".into()));
            }
            let ids = unsafe {
                std::slice::from_raw_parts(
                    storage
                        .as_ptr()
                        .cast::<u8>()
                        .add(std::mem::offset_of!(
                            JOBOBJECT_BASIC_PROCESS_ID_LIST,
                            ProcessIdList
                        ))
                        .cast::<usize>(),
                    count,
                )
            };
            return ids
                .iter()
                .map(|pid| u32::try_from(*pid).map_err(|_| ownership_error()))
                .collect();
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: sole owned handle; KILL_ON_JOB_CLOSE remains a last-resort guard.
        if unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) } == 0 {
            tracing::error!(
                code = "PROCESS_CLEANUP_FAILED",
                "owned job handle close failed"
            );
        }
    }
}

#[cfg(windows)]
fn resume_primary(
    process: windows_sys::Win32::Foundation::HANDLE,
    pid: u32,
) -> Result<(), SpawnError> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::*,
            Threading::{
                GetProcessIdOfThread, OpenThread, ResumeThread, WaitForSingleObject,
                THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
            },
        },
    };
    // SAFETY: read-only system thread snapshot; primary thread has not executed.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(ownership_error());
    }
    let mut entry = THREADENTRY32::default();
    entry.dwSize = std::mem::size_of_val(&entry) as u32;
    let mut found = None;
    let deadline = Instant::now() + RECLAIM_DEADLINE;
    // SAFETY: snapshot and correctly sized initialized entry remain valid.
    let mut has = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while has && Instant::now() < deadline {
        if entry.th32OwnerProcessID == pid {
            if found.replace(entry.th32ThreadID).is_some() {
                unsafe { CloseHandle(snapshot) };
                return Err(ownership_error());
            }
        }
        has = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    if has {
        return Err(ownership_error());
    }
    let tid = found.ok_or_else(ownership_error)?;
    let thread = unsafe {
        OpenThread(
            THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
            0,
            tid,
        )
    };
    if thread.is_null() {
        return Err(ownership_error());
    }
    // Retained process handle must still identify a live suspended root; a
    // recycled thread ID cannot authorize resuming an unrelated process.
    let valid =
        unsafe { GetProcessIdOfThread(thread) == pid && WaitForSingleObject(process, 0) == 258 };
    let resumed = valid && unsafe { ResumeThread(thread) } == 1;
    unsafe { CloseHandle(thread) };
    if resumed {
        Ok(())
    } else {
        Err(ownership_error())
    }
}

// This platform has no implemented authoritative non-breakaway containment.
// Refuse before spawn rather than claiming PPID/process-group sweeps prove it.
#[cfg(not(windows))]
pub(crate) struct Job;
#[cfg(not(windows))]
impl Job {
    fn new() -> Result<Self, SpawnError> {
        Err(ownership_error())
    }
    fn terminate(&self) -> Result<(), SpawnError> {
        Err(ownership_error())
    }
    fn members(&self) -> Result<Vec<u32>, SpawnError> {
        Err(ownership_error())
    }
    fn empty(&self) -> Result<bool, SpawnError> {
        Err(ownership_error())
    }
}

#[cfg(all(test, windows))]
pub(crate) fn snapshot_pids() -> std::collections::HashSet<u32> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::*,
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    assert_ne!(
        snapshot, INVALID_HANDLE_VALUE,
        "process observation unavailable"
    );
    let mut entry = PROCESSENTRY32W::default();
    entry.dwSize = std::mem::size_of_val(&entry) as u32;
    let mut ids = std::collections::HashSet::new();
    let mut has = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while has {
        ids.insert(entry.th32ProcessID);
        has = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    ids
}
#[cfg(all(test, not(windows), not(target_os = "linux")))]
pub(crate) fn snapshot_pids() -> std::collections::HashSet<u32> {
    panic!("authoritative process containment is unavailable on this platform")
}

#[cfg(all(test, windows))]
mod ownership_tests {
    use super::*;
    async fn empty_registered() -> crate::runtime::host::NativeProcess {
        let directory = crate::runtime::test_support::scratch();
        let config = crate::runtime::test_support::config(
            directory.path(),
            "exit",
            &directory.path().join("pid"),
        );
        let mut host = crate::runtime::host::spawn_native(&config).unwrap();
        host.reclaim()
            .await
            .expect("original job and root handle prove exit");
        host
    }
    #[test]
    fn empty_accounting_without_a_retained_root_handle_cannot_prove_cleanup() {
        let job = Job::new().unwrap();
        assert_eq!(job.active().unwrap(), 0);
        assert!(
            job.empty().is_err(),
            "job accounting alone cannot prove the original root process signaled"
        );
    }
    #[tokio::test]
    async fn recycled_numeric_pid_cannot_select_a_different_job() {
        // A real fixture root has already exited; a changed registration stamp
        // must not authorize cleanup of any process that later reuses its PID.
        let original = empty_registered().await;
        let root = original.root;
        let mut replacement = root;
        replacement.spawned_at_ms = 0;
        assert!(reclaim_process_tree(replacement).is_err());
        assert!(reclaim_process_tree(root).unwrap().killed.is_empty());
    }
    #[tokio::test]
    async fn recorded_job_failure_is_never_reported_as_verified_cleanup() {
        let mut owner = empty_registered().await;
        let lease = owner.reclaim_lease().unwrap();
        // Synthetic failure injection stays private to this unit test; there is
        // no runtime config flag or untrusted handle close/reuse in the fixture.
        let OwnedReclaimLease::Job { root, job } = &lease;
        job.termination.store(3, Ordering::Release);
        assert!(job.empty().is_err());
        assert!(reclaim_process_tree(*root).is_err());
        assert!(
            owner.reclaim().await.is_err(),
            "native consumer must return the original termination failure"
        );
    }
    #[tokio::test]
    async fn retained_lease_preserves_empty_proof_after_original_owner_and_registry_retire() {
        let owner = empty_registered().await;
        let lease = owner
            .reclaim_lease()
            .expect("capture actual job ownership while owner is live");
        let OwnedReclaimLease::Job { root, .. } = &lease;
        let root = *root;
        drop(owner);
        assert!(
            reclaim_process_tree(root).is_err(),
            "retired numeric metadata must not restore ownership"
        );
        assert!(
            lease.reclaim().unwrap().killed.is_empty(),
            "strong lease must still prove the original job empty"
        );
    }
}

#[cfg(target_os = "linux")]
pub fn reclaim_process_tree(root: ReclaimRoot) -> Result<ReclaimReport, SpawnError> {
    linux_broker::reclaim(root)
}
#[cfg(all(test, target_os = "linux"))]
pub(crate) fn snapshot_records() -> HashMap<u32, ProcessRecord> {
    linux_broker::snapshot_records()
}
#[cfg(all(test, target_os = "linux"))]
pub(crate) fn snapshot_pids() -> std::collections::HashSet<u32> {
    snapshot_records().into_keys().collect()
}

#[cfg(target_os = "linux")]
#[doc(hidden)]
pub mod linux_broker {
    //! Per-host Linux subreaper. This runs in a separate, single-threaded API
    //! helper process, never in the API's Tokio process or a `pre_exec` closure.
    //! Kernel adoption preserves ownership even across `setsid`, exec and crashes.
    #[cfg(test)]
    use std::collections::HashMap;
    use std::ffi::{c_int, c_long, OsString};
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::os::unix::process::ExitStatusExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    #[cfg(test)]
    use super::ProcessRecord;
    use super::{ReclaimReport, ReclaimRoot, RECLAIM_DEADLINE};
    use crate::runtime::host::SpawnError;

    pub const MODE: &str = "--weblabel-runtime-broker";
    const SIGTERM: c_int = 15;
    const SIGKILL: c_int = 9;
    const WNOHANG: c_int = 1;
    const ECHILD: i32 = 10;
    const ESRCH: i32 = 3;
    // Linux assigns these syscall numbers uniformly on its supported modern ABIs.
    const SYS_PIDFD_OPEN: c_long = 434;
    const SYS_PIDFD_SEND_SIGNAL: c_long = 424;
    unsafe extern "C" {
        fn prctl(option: c_int, ...) -> c_int;
        fn signal(number: c_int, handler: usize) -> usize;
        fn syscall(number: c_long, ...) -> c_long;
        fn waitpid(pid: c_int, status: *mut c_int, options: c_int) -> c_int;
        fn getppid() -> c_int;
        fn fcntl(fd: c_int, command: c_int, ...) -> c_int;
        fn raise(number: c_int) -> c_int;
        fn poll(fds: *mut PollFd, count: usize, timeout_ms: c_int) -> c_int;
    }
    static STOP: AtomicBool = AtomicBool::new(false);
    extern "C" fn request_stop(_: c_int) {
        STOP.store(true, Ordering::Relaxed);
    }

    #[repr(C)]
    struct PollFd {
        fd: c_int,
        events: i16,
        revents: i16,
    }
    fn owner_disappeared(parent: &OwnedFd, control: &UnixStream) -> io::Result<bool> {
        let mut descriptors = [
            PollFd {
                fd: parent.as_raw_fd(),
                events: 1,
                revents: 0,
            },
            PollFd {
                fd: control.as_raw_fd(),
                events: 1,
                revents: 0,
            },
        ];
        let ready = unsafe { poll(descriptors.as_mut_ptr(), descriptors.len(), 10) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                return Ok(false);
            }
            return Err(error);
        }
        Ok(ready > 0)
    }

    #[derive(Debug, Clone, Copy)]
    struct Identity {
        ppid: u32,
        start_ticks: u64,
        running: bool,
    }
    fn identity(pid: u32) -> Option<Identity> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // comm may itself contain whitespace and parentheses.
        let mut fields = stat[stat.rfind(") ")? + 2..].split_whitespace();
        let running = !matches!(fields.next()?, "Z" | "X");
        let ppid = fields.next()?.parse().ok()?;
        Some(Identity {
            ppid,
            start_ticks: fields.nth(17)?.parse().ok()?,
            running,
        })
    }
    #[cfg(test)]
    fn records() -> HashMap<u32, Identity> {
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return HashMap::new();
        };
        entries
            .filter_map(|entry| {
                let pid = entry.ok()?.file_name().to_str()?.parse().ok()?;
                Some((pid, identity(pid)?))
            })
            .collect()
    }
    #[cfg(test)]
    pub(crate) fn snapshot_records() -> HashMap<u32, ProcessRecord> {
        records()
            .into_iter()
            .filter(|(_, record)| record.running)
            .map(|(pid, record)| {
                (
                    pid,
                    ProcessRecord {
                        ppid: record.ppid,
                        created_ms: None,
                    },
                )
            })
            .collect()
    }
    fn pidfd(pid: u32) -> io::Result<OwnedFd> {
        // A pidfd pins the kernel process identity; no signal is sent by naked PID.
        let fd = unsafe { syscall(SYS_PIDFD_OPEN, pid as c_int, 0_u32) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd as c_int) })
    }
    fn send_signal(fd: &OwnedFd, number: c_int) -> io::Result<()> {
        let result = unsafe {
            syscall(
                SYS_PIDFD_SEND_SIGNAL,
                fd.as_raw_fd(),
                number,
                std::ptr::null::<()>(),
                0_u32,
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ESRCH) {
                return Err(error);
            }
        }
        Ok(())
    }
    #[derive(Debug)]
    pub(crate) struct ReclaimHandle {
        pid: u32,
        spawned_at_ms: i64,
        identity: Identity,
        fd: OwnedFd,
        completion: Mutex<Completion>,
    }
    #[derive(Debug)]
    struct Completion {
        stream: Option<UnixStream>,
        outcome: Option<Result<(), String>>,
    }
    fn confirm_cleanup(completion: &mut Completion, deadline: Instant) -> Result<(), SpawnError> {
        let mut stream = completion.stream.take().ok_or_else(|| {
            SpawnError::SpawnFailed("broker cleanup acknowledgement is unavailable".into())
        })?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(|| SpawnError::SpawnFailed("broker cleanup deadline exceeded".into()))?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|error| SpawnError::SpawnFailed(error.to_string()))?;
        let mut status = [0_u8];
        stream.read_exact(&mut status).map_err(|error| {
            SpawnError::SpawnFailed(format!("broker did not confirm cleanup: {error}"))
        })?;
        if status[0] != 0 {
            return Err(SpawnError::SpawnFailed(
                "broker cleanup failed; inspect its diagnostic stderr".into(),
            ));
        }
        Ok(())
    }
    pub(crate) fn control(command: &mut Command) -> io::Result<(UnixStream, UnixStream, OwnedFd)> {
        let (parent, child) = UnixStream::pair()?;
        // Open the API's kernel identity before forking: neither API death nor
        // PID reuse can make the helper monitor an unrelated replacement.
        let api_parent = pidfd(std::process::id())?;
        send_signal(&api_parent, 0)?;
        parent.set_read_timeout(Some(RECLAIM_DEADLINE))?;
        let fd = child.as_raw_fd();
        let parent_fd = api_parent.as_raw_fd();
        // The only post-fork work is the async-signal-safe fcntl syscall; no Rust
        // allocation, locks, subreaper setup or child management occurs pre_exec.
        unsafe {
            command.pre_exec(move || {
                if fcntl(fd, 2, 0 as c_int) < 0 || fcntl(parent_fd, 2, 0 as c_int) < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        Ok((parent, child, api_parent))
    }
    struct PendingBroker(Option<OwnedFd>);
    impl Drop for PendingBroker {
        fn drop(&mut self) {
            if let Some(fd) = &self.0 {
                // Go was not sent, so no runtime or descendant exists yet.
                let _ = send_signal(fd, SIGKILL);
            }
        }
    }
    pub(crate) fn capture(
        pid: u32,
        spawned_at_ms: i64,
        mut stream: UnixStream,
        deadline: Instant,
    ) -> Result<Arc<ReclaimHandle>, SpawnError> {
        let fd = pidfd(pid).map_err(|error| SpawnError::SpawnFailed(error.to_string()))?;
        let record = identity(pid)
            .filter(|record| record.ppid == std::process::id())
            .ok_or_else(|| SpawnError::SpawnFailed("broker is not our child".into()))?;
        let mut pending = PendingBroker(Some(fd));
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(|| SpawnError::SpawnFailed("broker startup deadline exceeded".into()))?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|error| SpawnError::SpawnFailed(error.to_string()))?;
        let mut ready = [0_u8];
        stream.read_exact(&mut ready).map_err(|error| {
            SpawnError::SpawnFailed(format!("broker startup was not confirmed: {error}"))
        })?;
        if ready[0] != 0 {
            return Err(SpawnError::SpawnFailed(
                "broker initialization failed; inspect its diagnostic stderr".into(),
            ));
        }
        // Complete every fallible identity/handle preparation before Go. Any
        // earlier failure closes this peer, so the helper never starts a CLI.
        let owner = Arc::new(ReclaimHandle {
            pid,
            spawned_at_ms,
            identity: record,
            fd: pending.0.take().unwrap(),
            completion: Mutex::new(Completion {
                stream: Some(stream),
                outcome: None,
            }),
        });
        let go = owner
            .completion
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .stream
            .as_mut()
            .unwrap()
            .write_all(&[0]);
        if let Err(error) = go {
            // A one-byte Go write is atomic; failure means no launch was
            // authorized, and killing only this pinned broker is safe.
            let _ = send_signal(&owner.fd, SIGKILL);
            return Err(SpawnError::SpawnFailed(format!(
                "broker launch was not authorized: {error}"
            )));
        }
        Ok(owner)
    }
    pub(crate) fn executable() -> io::Result<PathBuf> {
        let current = std::env::current_exe()?;
        // Cargo's unit/integration harnesses live in deps; Cargo builds the real
        // API binary beside it for integration tests. `cargo test --lib` callers
        // must first build --bin weblabel. Release uses its own executable.
        if current
            .parent()
            .and_then(|path| path.file_name())
            .is_some_and(|name| name == "deps")
        {
            let candidate = current.parent().unwrap().parent().unwrap().join("weblabel");
            if !candidate.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "build --bin weblabel before Linux library tests",
                ));
            }
            return Ok(candidate);
        }
        Ok(current)
    }

    pub(crate) fn reclaim(root: ReclaimRoot) -> Result<ReclaimReport, SpawnError> {
        let owned = &root.owner;
        if root.root_pid != owned.pid || root.spawned_at_ms != owned.spawned_at_ms {
            return Err(SpawnError::SpawnFailed(
                "Linux root capability does not match the requested process".into(),
            ));
        }
        let deadline = Instant::now() + RECLAIM_DEADLINE;
        let mut completion = owned
            .completion
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(outcome) = &completion.outcome {
            return outcome
                .clone()
                .map(|()| report(root.root_pid))
                .map_err(SpawnError::SpawnFailed);
        }
        let result = reclaim_once(&root, owned, &mut completion, deadline);
        // Cache the whole attempt, including timeouts and signal failures.
        // Drop/independent consumers never retry a failed attempt for another 5s.
        completion.outcome = Some(
            result
                .as_ref()
                .map(|_| ())
                .map_err(|error| error.to_string()),
        );
        result
    }
    fn reclaim_once(
        root: &ReclaimRoot,
        owned: &ReclaimHandle,
        completion: &mut Completion,
        deadline: Instant,
    ) -> Result<ReclaimReport, SpawnError> {
        if let Some(record) = identity(root.root_pid).filter(|record| record.running) {
            if root.root_pid == std::process::id()
                || record.ppid != std::process::id()
                || record.start_ticks != owned.identity.start_ticks
            {
                return Err(SpawnError::SpawnFailed(
                    "Linux broker identity changed; refusing to signal".into(),
                ));
            }
        }
        send_signal(&owned.fd, SIGTERM)
            .map_err(|error| SpawnError::SpawnFailed(error.to_string()))?;
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|duration| !duration.is_zero())
                .ok_or_else(|| {
                    SpawnError::SpawnFailed(
                        "Linux broker has not finished killing and reaping its descendants".into(),
                    )
                })?;
            let mut descriptor = PollFd {
                fd: owned.fd.as_raw_fd(),
                events: 1,
                revents: 0,
            };
            let ready = unsafe {
                poll(
                    &mut descriptor,
                    1,
                    remaining.min(Duration::from_millis(20)).as_millis() as c_int,
                )
            };
            if ready > 0 {
                break;
            }
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(SpawnError::SpawnFailed(error.to_string()));
                }
            }
        }
        confirm_cleanup(completion, deadline)?;
        Ok(report(root.root_pid))
    }
    fn report(root_pid: u32) -> ReclaimReport {
        ReclaimReport {
            root_pid,
            mechanism: "linux per-host subreaper broker + pidfd signals + owned-child reap",
            // Kernel adoption/reaping proves teardown, not a race-prone
            // pre-termination descendant list. Optional reporting must never
            // consume the deadline before mandatory termination.
            descendants_found: Vec::new(),
            killed: vec![root_pid],
        }
    }

    fn check_deadline(deadline: Instant) -> io::Result<()> {
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "owned Linux cleanup deadline exceeded",
            ));
        }
        Ok(())
    }
    fn cleanup() -> io::Result<()> {
        let own_pid = std::process::id();
        let deadline = Instant::now() + RECLAIM_DEADLINE;
        loop {
            // Only this broker's kernel children are targets. Killing a parent
            // makes its detached grandchildren direct adopted children next pass.
            let children = std::fs::read_to_string(format!("/proc/self/task/{own_pid}/children"))?;
            for pid in children
                .split_whitespace()
                .filter_map(|raw| raw.parse::<u32>().ok())
            {
                check_deadline(deadline)?;
                let Some(original) =
                    identity(pid).filter(|record| record.ppid == own_pid && record.running)
                else {
                    continue;
                };
                let fd = match pidfd(pid) {
                    Ok(fd) => fd,
                    Err(error) if error.raw_os_error() == Some(ESRCH) => continue,
                    Err(error) => return Err(error),
                };
                if identity(pid).is_some_and(|current| {
                    current.ppid == own_pid && current.start_ticks == original.start_ticks
                }) {
                    send_signal(&fd, SIGKILL)?;
                }
            }
            loop {
                check_deadline(deadline)?;
                let mut status = 0;
                let waited = unsafe { waitpid(-1, &mut status, WNOHANG) };
                if waited > 0 {
                    continue;
                }
                if waited < 0 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() == Some(ECHILD) {
                        return Ok(());
                    }
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error);
                }
                break;
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "owned Linux descendants did not stop",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Internal CLI dispatch, before constructing any threads, server or auth state.
    /// argv is passed as OS strings, not reconstructed into shell text.
    pub fn run(mut args: impl Iterator<Item = OsString>) -> io::Result<i32> {
        let fd: c_int = args
            .next()
            .and_then(|value| value.to_str().and_then(|raw| raw.parse().ok()))
            .filter(|fd| *fd >= 3)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "broker requires its private control descriptor",
                )
            })?;
        // Prevent the runtime and its descendants from inheriting the completion
        // channel; EOF without the broker's successful acknowledgement is failure.
        if unsafe { fcntl(fd, 2, 1 as c_int) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut completion = unsafe { UnixStream::from_raw_fd(fd) };
        let parent_fd: c_int = args
            .next()
            .and_then(|value| value.to_str().and_then(|raw| raw.parse().ok()))
            .filter(|parent_fd| *parent_fd >= 3 && *parent_fd != fd)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "broker requires its distinct API-parent pidfd",
                )
            })?;
        if unsafe { fcntl(parent_fd, 2, 1 as c_int) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let parent_fd = unsafe { OwnedFd::from_raw_fd(parent_fd) };
        let result = run_child(args, &mut completion, &parent_fd);
        finish(result, &mut completion)
    }
    fn finish(
        result: io::Result<std::process::ExitStatus>,
        completion: &mut UnixStream,
    ) -> io::Result<i32> {
        completion.write_all(&[u8::from(result.is_err())])?;
        let status = result?;
        if let Some(number) = status.signal() {
            unsafe {
                signal(number, 0);
                raise(number);
            }
            return Err(io::Error::other(
                "could not preserve the runtime's signal exit",
            ));
        }
        Ok(status.code().unwrap_or(1))
    }
    fn run_child(
        mut args: impl Iterator<Item = OsString>,
        completion: &mut UnixStream,
        parent_fd: &OwnedFd,
    ) -> io::Result<std::process::ExitStatus> {
        let parent: u32 = args
            .next()
            .and_then(|value| value.to_str().and_then(|raw| raw.parse().ok()))
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "broker requires its parent PID",
                )
            })?;
        let executable = args
            .next()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute() && path.is_file())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "broker requires an absolute executable",
                )
            })?;
        // Subreaper state is local to this helper. Monitor the API's actual
        // process via pidfd, not PR_SET_PDEATHSIG: that signal tracks the
        // creating thread and would cancel runs when a Tokio worker retires.
        for number in [SIGTERM, 2, 1, 3] {
            if unsafe { signal(number, request_stop as *const () as usize) } == usize::MAX {
                return Err(io::Error::last_os_error());
            }
        }
        if unsafe { prctl(36, 1 as c_long, 0 as c_long, 0 as c_long, 0 as c_long) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // Both syscalls must work before Ready/Go can launch a runtime.
        // Signal 0 verifies current support/permission, not future signal policy.
        let self_fd = pidfd(std::process::id())?;
        send_signal(&self_fd, 0)?;
        send_signal(parent_fd, 0)?;
        completion.write_all(&[0])?;
        completion.set_read_timeout(Some(RECLAIM_DEADLINE))?;
        let mut go = [0_u8];
        completion.read_exact(&mut go)?;
        if go[0] == 1 {
            // Cancellation may precede Ready. Stop without ever executing
            // the runtime, but still confirm real ECHILD through normal cleanup.
            cleanup()?;
            return Ok(std::process::ExitStatus::from_raw(0));
        }
        if go[0] != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "broker launch was not authorized",
            ));
        }
        if unsafe { getppid() } as u32 != parent || STOP.load(Ordering::Relaxed) {
            cleanup()?;
            return Ok(std::process::ExitStatus::from_raw(0));
        }
        let mut child = Command::new(executable)
            .args(args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()?;
        let exit_status = loop {
            if STOP.load(Ordering::Relaxed) {
                break std::process::ExitStatus::from_raw(0);
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => match owner_disappeared(parent_fd, completion) {
                    Ok(true) => break std::process::ExitStatus::from_raw(0),
                    Ok(false) => {}
                    Err(error) => {
                        cleanup()?;
                        return Err(error);
                    }
                },
                Err(error) => {
                    cleanup()?;
                    return Err(error);
                }
            }
        };
        cleanup()?;
        Ok(exit_status)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::runtime::host::{spawn_native, NativeProcess};
        use crate::runtime::test_support::{self, scratch};

        fn host(directory: &std::path::Path) -> NativeProcess {
            spawn_native(&test_support::config(
                directory,
                "idle",
                &directory.join("pid"),
            ))
            .unwrap()
        }

        #[tokio::test]
        async fn killed_broker_cannot_confirm_cleanup_and_control_fd_is_private() {
            let directory = scratch();
            let mut host = host(directory.path());
            let marker = directory.path().join("pid");
            let deadline = Instant::now() + RECLAIM_DEADLINE;
            while !marker.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            let pid = test_support::marker(&marker)["pid"].as_u64().unwrap() as u32;
            struct OwnedProgram(OwnedFd);
            impl Drop for OwnedProgram {
                fn drop(&mut self) {
                    let _ = send_signal(&self.0, SIGKILL);
                }
            }
            let program = OwnedProgram(pidfd(pid).unwrap());
            let argv = std::fs::read(format!("/proc/{}/cmdline", host.root.root_pid)).unwrap();
            let descriptor =
                std::str::from_utf8(argv.split(|byte| *byte == 0).nth(2).unwrap()).unwrap();
            let channel =
                std::fs::read_link(format!("/proc/{}/fd/{descriptor}", host.root.root_pid))
                    .unwrap();
            for entry in std::fs::read_dir(format!("/proc/{pid}/fd")).unwrap() {
                if let Ok(target) = std::fs::read_link(entry.unwrap().path()) {
                    assert_ne!(
                        target, channel,
                        "the runtime cannot forge the broker's private cleanup acknowledgement"
                    );
                }
            }
            let retained = host.reclaim_root();
            let broker = std::sync::Arc::clone(&retained.owner);
            send_signal(&broker.fd, SIGKILL).unwrap();
            send_signal(&program.0, SIGKILL).unwrap();
            host.child.wait().await.unwrap();
            assert!(
                host.reclaim().await.is_err(),
                "broker death without successful cleanup acknowledgement must fail"
            );
            assert!(
                host.reclaim().await.is_err(),
                "repeating a failed cleanup must not turn it into success"
            );
            drop(host);
            assert!(
                reclaim(retained).is_err(),
                "independent consumers retain failure after host drop"
            );
            let deadline = Instant::now() + RECLAIM_DEADLINE;
            while identity(pid).is_some_and(|record| record.running) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(
                !identity(pid).is_some_and(|record| record.running),
                "the test's owned program actually stopped"
            );
        }

        #[tokio::test]
        async fn stopped_broker_error_is_shared_by_drop_and_independent_cleanup() {
            let directory = scratch();
            let mut host = host(directory.path());
            let marker = directory.path().join("pid");
            let deadline = Instant::now() + RECLAIM_DEADLINE;
            while !marker.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            let pid = test_support::marker(&marker)["pid"].as_u64().unwrap() as u32;
            let retained = host.reclaim_root();
            struct FaultCleanup {
                root: ReclaimRoot,
                program: OwnedFd,
            }
            impl Drop for FaultCleanup {
                fn drop(&mut self) {
                    let _ = send_signal(&self.root.owner.fd, 18); // SIGCONT
                    let _ = send_signal(&self.root.owner.fd, SIGTERM);
                    let _ = send_signal(&self.program, SIGKILL);
                    let mut status = 0;
                    // This still-unreaped broker is this test's direct child;
                    // its PID cannot be reused before this wait.
                    unsafe {
                        waitpid(self.root.root_pid as c_int, &mut status, 0);
                    }
                }
            }
            let fault_cleanup = FaultCleanup {
                root: retained.clone(),
                program: pidfd(pid).unwrap(),
            };
            send_signal(&retained.owner.fd, 19).unwrap(); // SIGSTOP
            let started = Instant::now();
            assert!(
                host.reclaim().await.is_err(),
                "a stopped broker cannot confirm cleanup"
            );
            let first_attempt = started.elapsed();
            let dropped = Instant::now();
            drop(host);
            let drop_elapsed = dropped.elapsed();
            assert!(
                drop_elapsed < RECLAIM_DEADLINE,
                "Drop must not repeat the failed five-second attempt"
            );
            let independent = Instant::now();
            assert!(
                reclaim(retained).is_err(),
                "a later independent consumer retains the same failure"
            );
            let independent_elapsed = independent.elapsed();
            assert!(
                independent_elapsed < RECLAIM_DEADLINE,
                "independent cleanup must not retry the failed attempt"
            );
            println!(
                "single_attempt_ms={} drop_ms={} independent_ms={} total_ms={}",
                first_attempt.as_millis(),
                drop_elapsed.as_millis(),
                independent_elapsed.as_millis(),
                started.elapsed().as_millis()
            );
            drop(fault_cleanup);
            assert!(
                !identity(pid).is_some_and(|record| record.running),
                "fault probe's owned program actually stopped"
            );
        }

        #[tokio::test]
        async fn rejects_unregistered_process_and_mismatched_spawn_identity() {
            let directory = scratch();
            let mut host = host(directory.path());
            struct Foreign(std::process::Child);
            impl Drop for Foreign {
                fn drop(&mut self) {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
            let mut foreign = Foreign(
                test_support::foreign(directory.path(), &directory.path().join("foreign"))
                    .spawn()
                    .unwrap(),
            );
            let mut unrelated = host.reclaim_root();
            unrelated.root_pid = foreign.0.id();
            unrelated.spawned_at_ms = 0;
            assert!(
                reclaim(unrelated).is_err(),
                "same-parent unrelated processes are not owned brokers"
            );
            assert!(
                foreign.0.try_wait().unwrap().is_none(),
                "unrelated process must remain alive"
            );
            let mut mismatched = host.reclaim_root();
            mismatched.spawned_at_ms += 1;
            assert!(
                reclaim(mismatched).is_err(),
                "a PID alone cannot authorize cleanup"
            );
            assert!(
                host.child.try_wait().unwrap().is_none(),
                "a mismatched identity must not kill the current broker"
            );
            host.reclaim().await.unwrap();
        }
    }
}
