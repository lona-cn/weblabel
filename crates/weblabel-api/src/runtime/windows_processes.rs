//! Checked Windows process enumeration and retained creation identities.
use std::{
    collections::HashMap,
    ffi::c_void,
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
};

type Handle = *mut c_void;
#[repr(C)]
struct ProcessEntry {
    size: u32,
    usage: u32,
    pid: u32,
    heap: usize,
    module: u32,
    threads: u32,
    parent: u32,
    priority: i32,
    flags: u32,
    executable: [u16; 260],
}
#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}
impl FileTime {
    fn ticks(&self) -> u64 {
        (u64::from(self.high) << 32) | u64::from(self.low)
    }
}
#[link(name = "Kernel32")]
unsafe extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
    fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
    fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn GetProcessTimes(
        process: Handle,
        creation: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
}
const INVALID_HANDLE: Handle = -1isize as Handle;
const PROCESS_QUERY_LIMITED_INFORMATION_AND_SYNCHRONIZE: u32 = 0x0010_1000;

/// Enumeration failure is never interpreted as an empty successful process table.
pub(super) fn snapshot() -> io::Result<HashMap<u32, super::ProcessRecord>> {
    snapshot_with_flags(2)
}
fn snapshot_with_flags(flags: u32) -> io::Result<HashMap<u32, super::ProcessRecord>> {
    // SAFETY: documented Toolhelp process snapshot, no pointers supplied.
    let raw = unsafe { CreateToolhelp32Snapshot(flags, 0) };
    if raw == INVALID_HANDLE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: success transfers a unique valid kernel handle to OwnedHandle.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut entry = ProcessEntry {
        size: size_of::<ProcessEntry>() as u32,
        usage: 0,
        pid: 0,
        heap: 0,
        module: 0,
        threads: 0,
        parent: 0,
        priority: 0,
        flags: 0,
        executable: [0; 260],
    };
    // SAFETY: correctly sized writable PROCESSENTRY32W; handle remains open.
    if unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut table = HashMap::new();
    loop {
        table.insert(
            entry.pid,
            super::ProcessRecord {
                ppid: entry.parent,
                created_ms: None,
            },
        );
        // SAFETY: same valid snapshot and initialized entry layout.
        if unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(18) {
                return Ok(table);
            }
            return Err(error);
        }
    }
}

pub(super) struct Target {
    pub pid: u32,
    handle: OwnedHandle,
    creation: u64,
}
impl Target {
    /// Only a genuinely vanished PID is absence; access/identity errors fail closed.
    pub fn open(pid: u32) -> io::Result<Option<Self>> {
        // SAFETY: limited query and synchronize rights, no inheritance.
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION_AND_SYNCHRONIZE, 0, pid) };
        if raw.is_null() {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(87) {
                return Ok(None);
            }
            return Err(error);
        }
        // SAFETY: unique valid handle returned by OpenProcess.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut creation = FileTime::default();
        let mut exit = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        // SAFETY: all FILETIME pointers writable, handle held throughout.
        if unsafe {
            GetProcessTimes(
                handle.as_raw_handle(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Some(Self {
            pid,
            handle,
            creation: creation.ticks(),
        }))
    }
    pub fn created_ms(&self) -> io::Result<i64> {
        const UNIX_EPOCH_FILETIME: u64 = 116_444_736_000_000_000;
        let ticks = self
            .creation
            .checked_sub(UNIX_EPOCH_FILETIME)
            .ok_or_else(|| io::Error::other("invalid process creation time"))?;
        i64::try_from(ticks / 10_000)
            .map_err(|_| io::Error::other("process creation time overflow"))
    }
    pub fn alive(&self) -> io::Result<bool> {
        // SAFETY: retained valid process handle; zero-time observation only.
        match unsafe { WaitForSingleObject(self.handle.as_raw_handle(), 0) } {
            0 => Ok(false),
            258 => Ok(true),
            _ => Err(io::Error::last_os_error()),
        }
    }
    /// Immediate pre-kill check against exact 100ns creation identity, not PID alone.
    pub fn still_current(&self) -> io::Result<bool> {
        if !self.alive()? {
            return Ok(false);
        }
        match Self::open(self.pid)? {
            Some(current) => Ok(current.creation == self.creation && current.alive()?),
            None => Ok(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_process_enumeration_is_an_error() {
        let error = snapshot_with_flags(0).expect_err("no process snapshot requested");
        assert_eq!(error.raw_os_error(), Some(18));
    }
    #[test]
    fn creation_mismatch_rejects_live_pid_without_touching_it() {
        let mut target = Target::open(std::process::id()).unwrap().unwrap();
        assert!(target.alive().unwrap());
        target.creation += 1; // identity-mismatch surrogate, not natural PID recycling.
        assert!(!target.still_current().unwrap());
        assert!(
            target.alive().unwrap(),
            "mismatched live process is untouched"
        );
    }
}
