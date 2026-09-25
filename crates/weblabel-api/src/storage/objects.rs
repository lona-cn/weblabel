use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use sha2::{Digest, Sha256};

static NEXT_STAGING_FILE_ID: AtomicU64 = AtomicU64::new(0);
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredObject {
    pub sha256: String,
    pub path: PathBuf,
    pub size_bytes: u64,
}

#[derive(Debug)]
pub struct StagedObject {
    stored: StoredObject,
    temporary_path: Option<PathBuf>,
    published: bool,
}

impl StagedObject {
    pub fn publish(mut self) -> io::Result<StoredObject> {
        if self.published {
            return Ok(self.stored.clone());
        }
        let temporary_path = self.temporary_path.as_ref().expect("staged file missing");
        if self.stored.path.is_file() {
            sync_directory(
                self.stored
                    .path
                    .parent()
                    .expect("object destination has a parent"),
            )?;
            fs::remove_file(temporary_path)?;
            self.published = true;
            return Ok(self.stored.clone());
        }
        match rename_durably(temporary_path, &self.stored.path) {
            Ok(()) => {
                self.published = true;
                Ok(self.stored.clone())
            }
            Err(_error) if self.stored.path.is_file() => {
                sync_directory(
                    self.stored
                        .path
                        .parent()
                        .expect("object destination has a parent"),
                )?;
                fs::remove_file(temporary_path)?;
                self.published = true;
                Ok(self.stored.clone())
            }
            Err(error) => Err(error),
        }
    }
}

impl Drop for StagedObject {
    fn drop(&mut self) {
        if !self.published {
            if let Some(temporary_path) = &self.temporary_path {
                let _ = fs::remove_file(temporary_path);
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct ObjectStore {
    root: PathBuf,
}

impl ObjectStore {
    pub fn new(root: impl Into<PathBuf>) -> io::Result<Self> {
        let root = root.into();
        let root = if root.is_absolute() {
            root
        } else {
            std::env::current_dir()?.join(root)
        };
        create_dir_all_durably(&root)?;
        if let Some(parent) = root.parent() {
            sync_directory(parent)?;
        }
        Ok(Self { root })
    }
    pub fn put_bytes(&self, filename: &str, bytes: &[u8]) -> io::Result<StoredObject> {
        self.stage_bytes(filename, bytes)?.publish()
    }

    pub fn stage_bytes(&self, _filename: &str, bytes: &[u8]) -> io::Result<StagedObject> {
        let digest = Sha256::digest(bytes);
        let mut sha256 = String::with_capacity(64);
        for &byte in &digest {
            let digits = b"0123456789abcdef";
            sha256.push(digits[(byte >> 4) as usize] as char);
            sha256.push(digits[(byte & 0x0f) as usize] as char);
        }
        let shard_directory = self.root.join(&sha256[..2]);
        let directory = shard_directory.join(&sha256[2..4]);
        create_child_directory_durably(&shard_directory)?;
        create_child_directory_durably(&directory)?;
        let destination = directory.join(&sha256);

        if destination.is_file() {
            sync_directory(&directory)?;
            return Ok(StagedObject {
                stored: StoredObject {
                    sha256,
                    path: destination,
                    size_bytes: bytes.len() as u64,
                },
                temporary_path: None,
                published: true,
            });
        }

        let (temporary_path, mut file) = loop {
            let sequence = NEXT_STAGING_FILE_ID.fetch_add(1, Ordering::Relaxed);
            let candidate = directory.join(format!(".tmp-{}-{sequence}", std::process::id()));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(file) => break (candidate, file),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        };
        if let Err(error) = write_and_sync(&mut file, bytes) {
            let _ = fs::remove_file(&temporary_path);
            return Err(error);
        }
        drop(file);
        Ok(StagedObject {
            stored: StoredObject {
                sha256,
                path: destination,
                size_bytes: bytes.len() as u64,
            },
            temporary_path: Some(temporary_path),
            published: false,
        })
    }

    pub fn path_for_hash(&self, sha256: &str) -> Option<PathBuf> {
        if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let hash = sha256.to_ascii_lowercase();
        Some(self.root.join(&hash[..2]).join(&hash[2..4]).join(hash))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

fn write_and_sync(file: &mut File, bytes: &[u8]) -> io::Result<()> {
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()
}
fn create_dir_all_durably(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .filter(|parent| *parent != path);
    if path.is_dir() {
        return parent.map_or(Ok(()), sync_directory);
    }
    let parent = parent.ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "directory path has no parent")
    })?;
    create_dir_all_durably(parent)?;
    match fs::create_dir(path) {
        Ok(()) => sync_directory(parent),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => {
            sync_directory(parent)
        }
        Err(error) => Err(error),
    }
}

fn create_child_directory_durably(path: &Path) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "directory path has no parent")
    })?;
    match fs::create_dir(path) {
        Ok(()) => sync_directory(parent),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => {
            sync_directory(parent)
        }
        Err(error) => Err(error),
    }
}
#[cfg(unix)]
fn rename_durably(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)?;
    sync_directory(
        destination
            .parent()
            .expect("object destination has a parent"),
    )
}

#[cfg(windows)]
fn rename_durably(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source_wide: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        sync_directory(
            destination
                .parent()
                .expect("object destination has a parent"),
        )
    }
}

#[cfg(not(any(unix, windows)))]
fn rename_durably(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)?;
    sync_directory(
        destination
            .parent()
            .expect("object destination has a parent"),
    )
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(windows)]
fn sync_directory(path: &Path) -> io::Result<()> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt};

    type Handle = *mut c_void;

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            file_name: *const u16,
            desired_access: u32,
            share_mode: u32,
            security_attributes: *const c_void,
            creation_disposition: u32,
            flags_and_attributes: u32,
            template_file: Handle,
        ) -> Handle;
        fn FlushFileBuffers(file: Handle) -> i32;
        fn CloseHandle(object: Handle) -> i32;
    }

    const GENERIC_WRITE: u32 = 0x4000_0000;
    const FILE_SHARE_READ_WRITE_DELETE: u32 = 0x0000_0007;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const INVALID_HANDLE_VALUE: Handle = -1_isize as Handle;

    let path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ_WRITE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let flush_result = unsafe { FlushFileBuffers(handle) };
    let flush_error = (flush_result == 0).then(io::Error::last_os_error);
    let close_result = unsafe { CloseHandle(handle) };
    if let Some(error) = flush_error {
        return Err(error);
    }
    if close_result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
