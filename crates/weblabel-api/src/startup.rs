use std::{
    env,
    fs::{File, OpenOptions},
    io,
    path::Path,
};

pub struct AdminRecoveryOptions {
    pub request_id: String,
    pub username: String,
}
impl AdminRecoveryOptions {
    pub fn from_env() -> Result<Option<Self>, io::Error> {
        let request = optional_env("WEBLABEL_ADMIN_RECOVERY_REQUEST_ID")?;
        let username = optional_env("WEBLABEL_ADMIN_RECOVERY_USERNAME")?;
        match (request, username) {
            (None, None) => Ok(None),
            (Some(request_id), Some(username)) => {
                let valid_request = uuid::Uuid::parse_str(&request_id)
                    .is_ok_and(|id| !id.is_nil() && id.to_string() == request_id);
                let valid_username = (3..=64).contains(&username.len())
                    && username.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));
                if !valid_request || !valid_username {
                    return Err(io::Error::new(io::ErrorKind::InvalidInput, "INVALID_ADMIN_RECOVERY_CONFIGURATION: canonical non-nil UUID and exact administrator username required"));
                }
                Ok(Some(Self { request_id, username }))
            }
            _ => Err(io::Error::new(io::ErrorKind::InvalidInput, "INVALID_ADMIN_RECOVERY_CONFIGURATION: request ID and username must be supplied together")),
        }
    }
}
fn optional_env(name: &str) -> Result<Option<String>, io::Error> {
    match env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "INVALID_ADMIN_RECOVERY_CONFIGURATION: values must be UTF-8",
        )),
    }
}

/// Keep the OS lock alive for the entire API process, including pool shutdown.
/// The sidecar is never unlinked: deleting a locked inode allows a second owner.
/// Canonicalize database/parent paths so junction and symbolic-link aliases agree.
pub fn lock_database(database_url: &str) -> Result<File, io::Error> {
    let database = Path::new(database_url.strip_prefix("sqlite:").unwrap_or(database_url));
    let resolved = if database.exists() {
        database.canonicalize()?
    } else {
        let parent = database
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        parent.canonicalize()?.join(
            database.file_name().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "INVALID_DATABASE_PATH")
            })?,
        )
    };
    let mut filename = resolved
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "INVALID_DATABASE_PATH"))?
        .to_os_string();
    filename.push(".runtime.lock");
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(resolved.with_file_name(filename))?;
    file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => io::Error::new(
            io::ErrorKind::WouldBlock,
            "DATABASE_IN_USE: stop the existing API before opening this data directory",
        ),
        std::fs::TryLockError::Error(error) => {
            io::Error::new(error.kind(), format!("DATABASE_LOCK_FAILED: {error}"))
        }
    })?;
    Ok(file)
}
