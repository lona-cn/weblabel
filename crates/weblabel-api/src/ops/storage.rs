use std::{fs::{self, File}, io, path::Path};
use serde_json::{json, Value};
use crate::server::release::is_redirect;

fn scan(path: &Path) -> Value {
    fn visit(path: &Path, depth: usize, entries: &mut u32, bytes: &mut u64) -> io::Result<()> {
        *entries += 1;
        if *entries > 10000 || depth > 8 { return Err(io::Error::other("SCAN_LIMIT")); }
        let metadata = fs::symlink_metadata(path)?;
        if is_redirect(&metadata) { return Err(io::Error::other("LINK_REFUSED")); }
        if metadata.is_file() { *bytes = bytes.checked_add(metadata.len()).ok_or_else(|| io::Error::other("SCAN_LIMIT"))?; }
        else if metadata.is_dir() { for item in fs::read_dir(path)? { visit(&item?.path(), depth + 1, entries, bytes)?; } }
        else { return Err(io::Error::other("NONREGULAR_REFUSED")); }
        Ok(())
    }
    let (mut entries, mut bytes) = (0, 0);
    match visit(path, 0, &mut entries, &mut bytes) {
        Ok(()) => json!({"status":"measured","bytes":bytes,"entries":entries}),
        Err(error) if entries == 1 && error.kind() == io::ErrorKind::NotFound => json!({"status":"absent","bytes":null}),
        Err(_) => json!({"status":"unknown","bytes":null,"code":"USAGE_PARTIAL_OR_UNKNOWN"}),
    }
}

fn lock(data: &Path) -> Value {
    let database = data.join("api.sqlite");
    let database = if database.exists() { match database.canonicalize() { Ok(path) => path, Err(_) => return json!({"status":"unknown","action":"inspect-only"}) } } else { database };
    let Some(name) = database.file_name() else { return json!({"status":"unknown","action":"inspect-only"}); };
    let mut sidecar = name.to_os_string();
    sidecar.push(".runtime.lock");
    let path = database.with_file_name(sidecar);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return json!({"status":"absent","action":"inspect-only"}),
        Ok(metadata) if metadata.is_file() && !is_redirect(&metadata) => {},
        _ => return json!({"status":"unknown","action":"inspect-only"}),
    }
    // No creation, truncation, deletion, PID interpretation, or database connection.
    match File::open(path).and_then(|file| match file.try_lock_shared() {
        Ok(()) => { file.unlock()?; Ok("available") },
        Err(std::fs::TryLockError::WouldBlock) => Ok("occupied"),
        Err(std::fs::TryLockError::Error(error)) => Err(error),
    }) {
        Ok(status) => json!({"status":status,"action":"do-not-remove-or-kill"}),
        Err(_) => json!({"status":"unknown","action":"inspect-only"}),
    }
}

#[cfg(unix)]
fn capacity(path: &Path) -> io::Result<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: path is NUL terminated and stat points to writable storage for statvfs.
    if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 { return Err(io::Error::last_os_error()); }
    let stat = unsafe { stat.assume_init() };
    let available = (stat.f_bavail as u128) * (stat.f_frsize as u128);
    let total = (stat.f_blocks as u128) * (stat.f_frsize as u128);
    Ok((u64::try_from(available).map_err(|_| io::Error::other("CAPACITY_OVERFLOW"))?, u64::try_from(total).map_err(|_| io::Error::other("CAPACITY_OVERFLOW"))?))
}
#[cfg(windows)]
fn capacity(path: &Path) -> io::Result<(u64, u64)> {
    use std::os::windows::ffi::OsStrExt;
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let (mut available, mut total, mut free) = (0, 0, 0);
    // SAFETY: all outputs are valid u64 pointers; path is a terminated UTF-16 path.
    if unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(path.as_ptr(), &mut available, &mut total, &mut free) } == 0 { return Err(io::Error::last_os_error()); }
    Ok((available, total))
}

pub fn diagnose(path: &Path) -> Value {
    let mut result = json!({"available_bytes":null,"total_bytes":null,"warnings":[],"lock":{"status":"unknown","action":"inspect-only"}});
    let mut warnings = Vec::new();
    let data = match fs::symlink_metadata(path).and_then(|meta| if is_redirect(&meta) || !meta.is_dir() { Err(io::Error::other("DATA_DIRECTORY_INVALID")) } else { path.canonicalize() }) {
        Ok(data) => data,
        Err(_) => { result["code"] = json!("DATA_DIRECTORY_UNAVAILABLE"); result["warnings"] = json!(["CAPACITY_UNKNOWN","IO_SUCCESS_REQUIRED_NO_CAPACITY_GUARANTEE"]); return result; }
    };
    match capacity(&data) {
        Ok((available,total)) => {
            result["available_bytes"] = json!(available.to_string()); result["total_bytes"] = json!(total.to_string());
            if available < 1073741824 || (total > 0 && (available as u128) * 10 < total as u128) { warnings.push("LOW_CAPACITY_IMPORT_BACKUP_EXPORT"); }
        }
        Err(_) => { result["code"] = json!("CAPACITY_SYSCALL_FAILED"); warnings.push("CAPACITY_UNKNOWN"); }
    }
    result["database"] = scan(&data.join("api.sqlite"));
    result["database"]["sidecars"] = json!([scan(&data.join("api.sqlite-wal")),scan(&data.join("api.sqlite-shm"))]);
    result["objects"] = scan(&data.join("objects"));
    // Export objects are content-addressed within this total, not a second copy.
    result["objects"]["scope"] = json!("all object-store files, including exports; no database opened");
    result["lock"] = lock(&data);
    if result["database"]["status"] == "unknown" || result["objects"]["status"] == "unknown" { warnings.push("USAGE_PARTIAL_OR_UNKNOWN"); }
    warnings.push("IO_SUCCESS_REQUIRED_NO_CAPACITY_GUARANTEE"); result["warnings"] = json!(warnings);
    result
}
