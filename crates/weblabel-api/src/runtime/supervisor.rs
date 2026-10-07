//! Run supervision and process-tree reclamation.
//!
//! Windows mechanism (exercised for real on this workstation):
//!   1. a PowerShell `Get-CimInstance Win32_Process` snapshot (pid, ppid,
//!      creation time); orphaned children keep their stale parent pid, so
//!      descendants of a crashed child are still discovered;
//!   2. pid-reuse guard: a root pid whose creation time is newer than our
//!      spawn record is a recycled pid and is never touched;
//!   3. `taskkill /pid <root> /T /F` reclaims the live tree, including children
//!      created in new process groups (detached);
//!   4. `taskkill /pid <orphan> /F` for each surviving descendant, identity
//!      re-checked right before the kill;
//!   5. a bounded resnapshot proves that no same-identity target pid remains.
//!
//! Linux uses a per-host subreaper broker and pidfds. Other POSIX platforms
//! retain the `ps`/signal mechanism; Linux never attributes an orphan by stale PPID.

use std::collections::HashMap;
#[cfg(any(not(target_os = "linux"), test))]
use std::collections::HashSet;
#[cfg(any(not(target_os = "linux"), test))]
use std::process::Command;
#[cfg(not(target_os = "linux"))]
use std::process::Stdio;
#[cfg(any(not(target_os = "linux"), test))]
use std::thread;
use std::time::{Duration, Instant};

use crate::runtime::host::{spawn_host, HostConfig, HostProcess, SpawnError};
use crate::runtime::{ProtocolError, RuntimeEnvelope};

const RECLAIM_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct ReclaimReport {
    pub root_pid: u32,
    pub mechanism: &'static str,
    pub descendants_found: Vec<u32>,
    pub killed: Vec<u32>,
}

/// Identity of the process tree being reclaimed.
#[derive(Debug, Clone)]
pub struct ReclaimRoot {
    pub root_pid: u32,
    /// Epoch milliseconds taken right after the root process was spawned.
    pub spawned_at_ms: i64,
    /// Epoch milliseconds when the root's exit was observed, when known.
    /// Descendants created after it cannot belong to the tree (pid reuse) and
    /// are leaked rather than killed.
    pub exited_at_ms: Option<i64>,
    #[cfg(target_os = "linux")]
    pub(crate) owner: std::sync::Arc<linux_broker::ReclaimHandle>,
}

#[derive(Debug, Clone, Copy)]
pub struct ProcessRecord {
    pub ppid: u32,
    /// Epoch milliseconds of process creation; None when the platform hides it.
    pub created_ms: Option<i64>,
}

#[cfg(any(not(target_os = "linux"), test))]
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(not(target_os = "linux"))]
fn system_tool(name: &str) -> String {
    if cfg!(windows) {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned());
        let candidates = [
            format!("{system_root}\\System32\\{name}"),
            format!("{system_root}\\System32\\WindowsPowerShell\\v1.0\\{name}"),
        ];
        if let Some(found) = candidates
            .iter()
            .find(|candidate| std::path::Path::new(candidate).exists())
        {
            return found.clone();
        }
    }
    name.to_owned()
}

#[cfg(not(target_os = "linux"))]
fn run_tool(executable: &str, args: &[&str]) {
    let _ = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(all(target_os = "linux", test))]
pub(crate) fn snapshot_records() -> HashMap<u32, ProcessRecord> {
    linux_broker::snapshot_records()
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn snapshot_records() -> HashMap<u32, ProcessRecord> {
    let output = if cfg!(windows) {
        Command::new(system_tool("powershell.exe"))
            .args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToUniversalTime().ToString('o'))\" }",
            ])
            .output()
    } else {
        Command::new("ps").args(["-A", "-o", "pid=,ppid="]).output()
    };
    let stdout = match output {
        Ok(result) => result.stdout,
        Err(_) => return HashMap::new(),
    };
    let text = String::from_utf8_lossy(&stdout);
    let mut records = HashMap::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (parts.next(), parts.next()) else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) else {
            continue;
        };
        let created_ms = parts
            .next()
            .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
            .map(|when| when.timestamp_millis());
        records.insert(pid, ProcessRecord { ppid, created_ms });
    }
    records
}

#[cfg(test)]
pub(crate) fn snapshot_pids() -> HashSet<u32> {
    snapshot_records().into_keys().collect()
}

#[cfg(not(target_os = "linux"))]
fn find_descendants(root: u32, table: &HashMap<u32, ProcessRecord>) -> Vec<u32> {
    let mut found = Vec::new();
    let mut queue = vec![root];
    let mut seen = HashSet::from([root]);
    while let Some(current) = queue.pop() {
        for (&pid, record) in table {
            if record.ppid != current || !seen.insert(pid) {
                continue;
            }
            found.push(pid);
            queue.push(pid);
        }
    }
    found
}

/// A target counts as reclaimed when its pid is gone or now names a different process.
#[cfg(not(target_os = "linux"))]
fn still_same_process(
    target_pid: u32,
    target_created: Option<i64>,
    table: &HashMap<u32, ProcessRecord>,
) -> bool {
    match table.get(&target_pid) {
        None => false,
        Some(record) => match (record.created_ms, target_created) {
            (Some(current), Some(original)) => current == original,
            _ => true,
        },
    }
}

#[cfg(target_os = "linux")]
pub fn reclaim_process_tree(root: ReclaimRoot) -> Result<ReclaimReport, SpawnError> {
    linux_broker::reclaim(root)
}

#[cfg(not(target_os = "linux"))]
pub fn reclaim_process_tree(root: ReclaimRoot) -> Result<ReclaimReport, SpawnError> {
    let cutoff_ms = now_ms();
    let table = snapshot_records();
    let root_is_ours = table.get(&root.root_pid).is_none_or(|record| {
        record
            .created_ms
            .is_none_or(|created| created <= root.spawned_at_ms)
    });
    let descendants: Vec<u32> = find_descendants(root.root_pid, &table)
        .into_iter()
        .filter(|pid| {
            table
                .get(pid)
                .and_then(|record| record.created_ms)
                .is_none_or(|created| {
                    created >= root.spawned_at_ms
                        && created <= root.exited_at_ms.unwrap_or(cutoff_ms)
                })
        })
        .collect();
    let mut targets: Vec<(u32, Option<i64>)> = Vec::new();
    if root_is_ours {
        targets.push((
            root.root_pid,
            table
                .get(&root.root_pid)
                .and_then(|record| record.created_ms),
        ));
    }
    for pid in &descendants {
        targets.push((*pid, table.get(pid).and_then(|record| record.created_ms)));
    }
    let mechanism = if cfg!(windows) {
        "windows taskkill /T + CIM descendant sweep (creation-time identity checked)"
    } else {
        "posix kill -9 + ps snapshot sweep (ps exposes no creation time, so creation identity is unavailable on POSIX)"
    };
    if cfg!(windows) {
        if root_is_ours {
            run_tool(
                &system_tool("taskkill.exe"),
                &["/pid", &root.root_pid.to_string(), "/T", "/F"],
            );
        }
        for (pid, created) in &targets {
            if *pid == root.root_pid {
                continue;
            }
            if still_same_process(*pid, *created, &snapshot_records()) {
                run_tool(
                    &system_tool("taskkill.exe"),
                    &["/pid", &pid.to_string(), "/F"],
                );
            }
        }
    } else {
        for (pid, _) in &targets {
            run_tool("/bin/kill", &["-9", &pid.to_string()]);
        }
    }
    let deadline = Instant::now() + RECLAIM_DEADLINE;
    loop {
        let alive: Vec<u32> = targets
            .iter()
            .filter(|(pid, created)| still_same_process(*pid, *created, &snapshot_records()))
            .map(|(pid, _)| *pid)
            .collect();
        if alive.is_empty() {
            break;
        }
        if Instant::now() >= deadline {
            return Err(SpawnError::SpawnFailed(format!(
                "reclaim incomplete: pids still alive: {alive:?}"
            )));
        }
        thread::sleep(Duration::from_millis(250));
    }
    Ok(ReclaimReport {
        root_pid: root.root_pid,
        mechanism,
        descendants_found: descendants,
        killed: targets.into_iter().map(|(pid, _)| pid).collect(),
    })
}

pub struct RunEntry {
    pub run_id: String,
    pub started_at: Instant,
    pub deadline: Option<Instant>,
    pub host: HostProcess,
}

pub struct Supervisor {
    config: HostConfig,
    run_timeout: Option<Duration>,
    runs: HashMap<String, RunEntry>,
}

impl Supervisor {
    pub fn new(config: HostConfig, run_timeout: Option<Duration>) -> Self {
        Self {
            config,
            run_timeout,
            runs: HashMap::new(),
        }
    }

    /// Identity for independent teardown while a blocking pipe read is active.
    pub fn reclaim_root(&self, run_id: &str) -> Option<ReclaimRoot> {
        self.runs.get(run_id).map(|entry| entry.host.reclaim_root())
    }

    pub fn start_run(&mut self, run_id: &str) -> Result<(), SpawnError> {
        if self.runs.contains_key(run_id) {
            return Err(SpawnError::SpawnFailed(format!(
                "run {run_id} already exists"
            )));
        }
        let host = spawn_host(&self.config)?;
        let started_at = Instant::now();
        let deadline = self.run_timeout.map(|timeout| started_at + timeout);
        self.runs.insert(
            run_id.to_owned(),
            RunEntry {
                run_id: run_id.to_owned(),
                started_at,
                deadline,
                host,
            },
        );
        Ok(())
    }

    pub fn send(&mut self, run_id: &str, envelope: &RuntimeEnvelope) -> Result<(), SpawnError> {
        let entry = self
            .runs
            .get_mut(run_id)
            .ok_or_else(|| SpawnError::SpawnFailed(format!("unknown run {run_id}")))?;
        entry.host.send(envelope)
    }

    pub fn recv(&mut self, run_id: &str) -> Result<Option<RuntimeEnvelope>, ProtocolError> {
        let entry = self.runs.get_mut(run_id).ok_or(ProtocolError::Truncated)?;
        entry.host.recv()
    }

    pub fn cancel_run(&mut self, run_id: &str) -> Result<ReclaimReport, SpawnError> {
        let mut entry = self
            .runs
            .remove(run_id)
            .ok_or_else(|| SpawnError::SpawnFailed(format!("unknown run {run_id}")))?;
        entry.host.kill_tree()
    }

    /// Reclaim every run that outlived its deadline. A possibly billed request
    /// is never resent: a timed-out run is terminated, not retried.
    pub fn enforce_deadlines(&mut self) -> Vec<String> {
        let now = Instant::now();
        let expired: Vec<String> = self
            .runs
            .values()
            .filter(|entry| entry.deadline.is_some_and(|deadline| now >= deadline))
            .map(|entry| entry.run_id.clone())
            .collect();
        for run_id in &expired {
            let _ = self.cancel_run(run_id);
        }
        expired
    }

    pub fn shutdown(&mut self) -> Vec<ReclaimReport> {
        let run_ids: Vec<String> = self.runs.keys().cloned().collect();
        run_ids
            .iter()
            .filter_map(|run_id| self.cancel_run(run_id).ok())
            .collect()
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
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
    pub const NODE_MODE: &str = "--weblabel-node-runtime-broker";
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
        // must first build --bin weblabel-api. Release uses its own executable.
        if current
            .parent()
            .and_then(|path| path.file_name())
            .is_some_and(|name| name == "deps")
        {
            let candidate = current
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("weblabel-api");
            if !candidate.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "build --bin weblabel-api before Linux library tests",
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

    /// Node has no pidfd syscall API. Pin its verified kernel parent here before
    /// Ready; a dead/replaced parent must never authorize a runtime launch.
    pub fn run_node(mut args: impl Iterator<Item = OsString>) -> io::Result<i32> {
        let fd: c_int = args
            .next()
            .and_then(|value| value.to_str().and_then(|raw| raw.parse().ok()))
            .filter(|fd| *fd >= 3)
            .ok_or_else(|| io::Error::other("Node broker requires a private control descriptor"))?;
        if unsafe { fcntl(fd, 2, 1 as c_int) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut completion = unsafe { UnixStream::from_raw_fd(fd) };
        let parent_arg = args
            .next()
            .ok_or_else(|| io::Error::other("Node broker requires its parent PID"))?;
        let parent: u32 = parent_arg
            .to_str()
            .and_then(|raw| raw.parse().ok())
            .ok_or_else(|| io::Error::other("Node broker requires its parent PID"))?;
        let start_ticks: u64 = args
            .next()
            .and_then(|value| value.to_str().and_then(|raw| raw.parse().ok()))
            .ok_or_else(|| io::Error::other("Node broker requires its parent's start identity"))?;
        let parent_matches = || {
            (unsafe { getppid() }) as u32 == parent
                && identity(parent).is_some_and(|record| {
                    record.running && record.start_ticks == start_ticks
                })
        };
        if !parent_matches() {
            return Err(io::Error::other("Node broker parent identity changed before pidfd"));
        }
        let parent_fd = pidfd(parent)?;
        send_signal(&parent_fd, 0)?;
        if !parent_matches() {
            return Err(io::Error::other("Node broker parent identity changed after pidfd"));
        }
        let result = run_child(
            std::iter::once(parent_arg).chain(args),
            &mut completion,
            &parent_fd,
        );
        finish(result, &mut completion)
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
            // Node cancellation may precede Ready. Stop without ever executing
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
        use crate::runtime::host::{spawn_host, HostConfig};
        use crate::runtime::test_support::node_executable;

        fn host(directory: &std::path::Path) -> crate::runtime::host::HostProcess {
            let node = node_executable();
            let script = format!(
                "require('fs').writeFileSync({},String(process.pid));setInterval(()=>{{}},1000)",
                serde_json::to_string(&directory.join("pid").to_string_lossy()).unwrap()
            );
            spawn_host(&HostConfig {
                trusted_executable_roots: vec![node.parent().unwrap().to_path_buf()],
                executable: node,
                argv: vec!["-e".into(), script],
                cwd: directory.to_path_buf(),
                trusted_cwd_roots: vec![directory.to_path_buf()],
                allowed_env: Vec::new(),
                source_env: Default::default(),
                extra_env: Default::default(),
            })
            .unwrap()
        }

        #[test]
        fn killed_broker_cannot_confirm_cleanup_and_control_fd_is_private() {
            let directory = tempfile::tempdir().unwrap();
            let mut host = host(directory.path());
            let marker = directory.path().join("pid");
            let deadline = Instant::now() + RECLAIM_DEADLINE;
            while !marker.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            let pid: u32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
            struct OwnedProgram(OwnedFd);
            impl Drop for OwnedProgram {
                fn drop(&mut self) {
                    let _ = send_signal(&self.0, SIGKILL);
                }
            }
            let program = OwnedProgram(pidfd(pid).unwrap());
            let argv = std::fs::read(format!("/proc/{}/cmdline", host.pid())).unwrap();
            let descriptor =
                std::str::from_utf8(argv.split(|byte| *byte == 0).nth(2).unwrap()).unwrap();
            let channel =
                std::fs::read_link(format!("/proc/{}/fd/{descriptor}", host.pid())).unwrap();
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
            host.child.wait().unwrap();
            assert!(
                host.kill_tree().is_err(),
                "broker death without successful cleanup acknowledgement must fail"
            );
            assert!(
                host.kill_tree().is_err(),
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

        #[test]
        fn stopped_broker_error_is_shared_by_drop_and_independent_cleanup() {
            let directory = tempfile::tempdir().unwrap();
            let mut host = host(directory.path());
            let marker = directory.path().join("pid");
            let deadline = Instant::now() + RECLAIM_DEADLINE;
            while !marker.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            let pid: u32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
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
                host.kill_tree().is_err(),
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

        #[test]
        fn rejects_unregistered_process_and_mismatched_spawn_identity() {
            let directory = tempfile::tempdir().unwrap();
            let mut host = host(directory.path());
            struct Foreign(std::process::Child);
            impl Drop for Foreign {
                fn drop(&mut self) {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
            let mut foreign = Foreign(
                Command::new(node_executable())
                    .args(["-e", "setInterval(()=>{},1000)"])
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
            host.kill_tree().unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::Duration;

    use super::*;
    use crate::runtime::host::HostConfig;
    use crate::runtime::test_support::{fake_runtime, node_executable, process_alive};
    use crate::runtime::{EnvelopeMethod, RuntimeEnvelope};

    fn system_env() -> BTreeMap<String, String> {
        // std::process::Command with env_clear builds a truly bare environment
        // block (no libuv-style baseline), so system essentials must be part of
        // the explicit allowlist like any other variable.
        let names = ["SystemRoot", "SystemDrive", "WINDIR", "TEMP", "TMP", "PATH"];
        names
            .iter()
            .filter_map(|name| {
                std::env::var(name)
                    .ok()
                    .map(|value| ((*name).to_owned(), value))
            })
            .collect()
    }

    fn spawn_config(mut extra: BTreeMap<String, String>, cwd: &std::path::Path) -> HostConfig {
        let node = node_executable();
        let node_root = node.parent().expect("node parent").to_path_buf();
        for (key, value) in system_env() {
            extra.entry(key).or_insert(value);
        }
        let allowed_env: Vec<String> = extra.keys().cloned().collect();
        HostConfig {
            executable: node,
            argv: vec![fake_runtime().to_string_lossy().into_owned()],
            cwd: cwd.to_path_buf(),
            allowed_env,
            source_env: BTreeMap::new(),
            extra_env: extra,
            trusted_executable_roots: vec![node_root],
            trusted_cwd_roots: vec![cwd.to_path_buf()],
        }
    }

    fn wait_for_file(path: &std::path::Path) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {}",
                path.display()
            );
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn reclaims_detached_orphans_left_by_a_crashed_child() {
        let temp = tempfile::tempdir().expect("tempdir");
        let pid_file = temp.path().join("pids.json");
        let mut extra = BTreeMap::new();
        extra.insert("TEST_SCENARIO".to_owned(), "crash".to_owned());
        extra.insert("FAKE_RUNTIME_SPAWN_CHILD".to_owned(), "1".to_owned());
        extra.insert(
            "FAKE_RUNTIME_PID_FILE".to_owned(),
            pid_file.to_string_lossy().into_owned(),
        );
        let config = spawn_config(extra, temp.path());
        let mut host = spawn_host(&config).expect("spawn host");
        wait_for_file(&pid_file);
        let pids: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&pid_file).expect("pid file"))
                .expect("pid json");
        let grandchild = pids["grandchild_pid"].as_u64().expect("grandchild pid") as u32;
        wait_for_file(&pid_file.with_extension("json.heartbeat"));
        assert!(
            process_alive(grandchild),
            "detached grandchild is actually running before the crash"
        );
        host.send(&RuntimeEnvelope::request(
            "req-1",
            EnvelopeMethod::StartRun,
            serde_json::json!({}),
        ))
        .expect("send start_run");
        let status = host.child.wait().expect("wait for crash");
        assert_eq!(
            status.code(),
            Some(7),
            "fake runtime crash scenario exits 7"
        );

        let mut root = host.reclaim_root();
        root.exited_at_ms = Some(now_ms());
        reclaim_process_tree(root).expect("reclaim");
        assert!(!process_alive(grandchild), "detached orphan reclaimed");
    }

    #[test]
    fn enforce_deadlines_reclaims_the_tree_of_a_stuck_run() {
        let temp = tempfile::tempdir().expect("tempdir");
        let pid_file = temp.path().join("pids.json");
        let mut extra = BTreeMap::new();
        extra.insert("TEST_SCENARIO".to_owned(), "slow".to_owned());
        extra.insert("FAKE_RUNTIME_SPAWN_CHILD".to_owned(), "1".to_owned());
        extra.insert(
            "FAKE_RUNTIME_PID_FILE".to_owned(),
            pid_file.to_string_lossy().into_owned(),
        );
        let config = spawn_config(extra, temp.path());
        let mut supervisor = Supervisor::new(config, Some(Duration::from_millis(300)));
        supervisor.start_run("run-slow").expect("start run");
        supervisor
            .send(
                "run-slow",
                &RuntimeEnvelope::request("req-1", EnvelopeMethod::StartRun, serde_json::json!({})),
            )
            .expect("send start_run");
        wait_for_file(&pid_file);
        let pids: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&pid_file).expect("pid file"))
                .expect("pid json");
        let grandchild = pids["grandchild_pid"].as_u64().expect("grandchild pid") as u32;

        thread::sleep(Duration::from_millis(500));
        let expired = supervisor.enforce_deadlines();
        assert_eq!(
            expired,
            vec!["run-slow".to_owned()],
            "stuck run reclaimed at its deadline"
        );
        assert!(
            !process_alive(grandchild),
            "grandchild reclaimed with the timed-out run"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn immediately_cancelled_host_is_initialized_without_a_heartbeat_wait() {
        let temp = tempfile::tempdir().unwrap();
        let mut supervisor = Supervisor::new(spawn_config(BTreeMap::new(), temp.path()), None);
        supervisor.start_run("immediate").unwrap();
        let root = supervisor.reclaim_root("immediate").unwrap();
        supervisor
            .cancel_run("immediate")
            .expect("cancel immediately after ready/go initialization");
        assert!(
            !process_alive(root.root_pid),
            "the actual initialized broker exited and was reaped"
        );
        reclaim_process_tree(root).expect("independent cleanup retains the same completed outcome");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn independent_reclaim_handle_survives_terminal_reader_drop() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("pids.json");
        let config = spawn_config(
            BTreeMap::from([
                ("TEST_SCENARIO".into(), "normal".into()),
                ("FAKE_RUNTIME_SPAWN_CHILD".into(), "1".into()),
                (
                    "FAKE_RUNTIME_PID_FILE".into(),
                    marker.to_string_lossy().into_owned(),
                ),
            ]),
            temp.path(),
        );
        let mut supervisor = Supervisor::new(config, None);
        supervisor.start_run("terminal").unwrap();
        let root = supervisor.reclaim_root("terminal").unwrap();
        wait_for_file(&marker.with_extension("json.heartbeat"));
        let pids: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&marker).unwrap()).unwrap();
        let descendant = pids["grandchild_pid"].as_u64().unwrap() as u32;
        assert!(
            process_alive(descendant),
            "the detached descendant is actually running"
        );
        thread::spawn(move || {
            supervisor
                .send(
                    "terminal",
                    &RuntimeEnvelope::request(
                        "terminal-request",
                        EnvelopeMethod::StartRun,
                        serde_json::json!({}),
                    ),
                )
                .unwrap();
            loop {
                let message = supervisor.recv("terminal").unwrap().unwrap();
                if message.kind == crate::runtime::EnvelopeKind::Response {
                    break;
                }
            }
            // The real reader owns and drops Supervisor before the async
            // consumer persists earlier events and finally reclaims its root.
        })
        .join()
        .unwrap();
        assert!(
            !process_alive(descendant),
            "reader teardown actually cleaned the detached descendant"
        );
        reclaim_process_tree(root)
            .expect("late independent consumer retains successful cleanup proof");
    }

    #[test]
    fn cancelling_one_run_preserves_other_run_and_unrelated_process() {
        let temp = tempfile::tempdir().expect("tempdir");
        let first_file = temp.path().join("first.json");
        let second_file = temp.path().join("second.json");
        let config_for = |path: &std::path::Path| {
            spawn_config(
                BTreeMap::from([
                    ("TEST_SCENARIO".into(), "slow".into()),
                    ("FAKE_RUNTIME_SPAWN_CHILD".into(), "1".into()),
                    (
                        "FAKE_RUNTIME_PID_FILE".into(),
                        path.to_string_lossy().into_owned(),
                    ),
                ]),
                temp.path(),
            )
        };
        let mut first = Supervisor::new(config_for(&first_file), None);
        let mut second = Supervisor::new(config_for(&second_file), None);
        let unrelated = Command::new(node_executable())
            .args(["-e", "setInterval(() => {}, 1000)"])
            .spawn()
            .expect("unrelated process");
        // A local guard reaps only this test's own foreign process on failure.
        struct Foreign(std::process::Child);
        impl Drop for Foreign {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut unrelated = Foreign(unrelated);
        first.start_run("first").expect("first run");
        second.start_run("second").expect("second run");
        wait_for_file(&first_file);
        wait_for_file(&second_file);
        let read_pid = |path: &std::path::Path| {
            serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(path).unwrap())
                .unwrap()["grandchild_pid"]
                .as_u64()
                .unwrap() as u32
        };
        let first_pid = read_pid(&first_file);
        let second_pid = read_pid(&second_file);
        wait_for_file(&first_file.with_extension("json.heartbeat"));
        wait_for_file(&second_file.with_extension("json.heartbeat"));
        assert!(
            process_alive(first_pid) && process_alive(second_pid),
            "both detached descendants are running"
        );
        first.cancel_run("first").expect("cancel first");
        assert!(
            !process_alive(first_pid),
            "cancel stops its running detached descendant"
        );
        assert!(
            process_alive(second_pid),
            "other run's detached descendant survives"
        );
        assert!(
            unrelated.0.try_wait().expect("foreign state").is_none(),
            "unrelated process survives"
        );
        second.cancel_run("second").expect("cancel second");
        assert!(
            !process_alive(second_pid),
            "second descendant stops only with its own cancellation"
        );
    }
}
