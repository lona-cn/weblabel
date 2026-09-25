use std::{
    collections::{BTreeMap, HashSet},
    io::{Cursor, Read},
};

use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use crate::FormatError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveLimits {
    pub max_entries: usize,
    pub max_uncompressed_bytes: u64,
}

impl Default for ArchiveLimits {
    fn default() -> Self {
        Self {
            max_entries: 4096,
            max_uncompressed_bytes: 96 * 1024 * 1024,
        }
    }
}

/// Reads ZIP members into memory only after validating portable paths, entry count, and sizes.
pub fn extract_safe_zip(
    bytes: &[u8],
    limits: &ArchiveLimits,
) -> Result<BTreeMap<String, Vec<u8>>, FormatError> {
    if limits.max_entries == 0 || limits.max_uncompressed_bytes == 0 {
        return Err(FormatError::Invalid(
            "archive limits must be positive".to_owned(),
        ));
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;
    if archive.len() > limits.max_entries {
        return Err(FormatError::Invalid(
            "archive contains too many entries".to_owned(),
        ));
    }

    let mut files = BTreeMap::new();
    let mut folded_paths = HashSet::with_capacity(archive.len());
    let mut total_size = 0_u64;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        let raw_name = std::str::from_utf8(file.name_raw())
            .map_err(|_| FormatError::Invalid("archive entry path is not UTF-8".to_owned()))?;
        let name = raw_name.to_owned();
        validate_archive_path(&name, file.is_dir())?;
        if file.enclosed_name().is_none() || file.is_symlink() {
            return Err(FormatError::Invalid(
                "archive contains an unsafe path or symlink".to_owned(),
            ));
        }
        let folded_name = name.trim_end_matches('/').to_lowercase();
        if !folded_paths.insert(folded_name) {
            return Err(FormatError::Invalid(
                "archive contains duplicate case-insensitive paths".to_owned(),
            ));
        }
        if file.is_dir() {
            continue;
        }
        if !file.is_file() {
            return Err(FormatError::Invalid(
                "archive contains a non-regular entry".to_owned(),
            ));
        }

        let declared_size = file.size();
        total_size = total_size
            .checked_add(declared_size)
            .filter(|size| *size <= limits.max_uncompressed_bytes)
            .ok_or_else(|| {
                FormatError::Invalid("archive exceeds its uncompressed size limit".to_owned())
            })?;
        let capacity = usize::try_from(declared_size).map_err(|_| {
            FormatError::Invalid("archive entry is too large for this platform".to_owned())
        })?;
        let mut contents = Vec::with_capacity(capacity);
        let mut bounded = (&mut file).take(declared_size.saturating_add(1));
        bounded.read_to_end(&mut contents)?;
        if contents.len() != capacity {
            return Err(FormatError::Invalid(
                "archive entry size does not match its directory record".to_owned(),
            ));
        }
        files.insert(name, contents);
    }
    Ok(files)
}

/// Creates a bounded ZIP using portable, non-colliding member names.
pub fn create_safe_zip(
    files: &[(String, Vec<u8>)],
    limits: &ArchiveLimits,
) -> Result<Vec<u8>, FormatError> {
    use std::io::Write;
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    let total_size = files.iter().try_fold(0_u64, |total, (_, bytes)| {
        total.checked_add(bytes.len() as u64)
    });
    if files.is_empty()
        || files.len() > limits.max_entries
        || total_size.is_none_or(|size| size > limits.max_uncompressed_bytes)
    {
        return Err(FormatError::Invalid(
            "archive output exceeds its limits".to_owned(),
        ));
    }
    let mut names = HashSet::with_capacity(files.len());
    let cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    for (name, bytes) in files {
        validate_archive_path(name, false)?;
        if !names.insert(name.to_lowercase()) {
            return Err(FormatError::Invalid(
                "archive output contains duplicate paths".to_owned(),
            ));
        }
        writer.start_file(name, options)?;
        writer.write_all(bytes)?;
    }
    let bytes = writer.finish()?.into_inner();
    if bytes.len() as u64 > limits.max_uncompressed_bytes {
        return Err(FormatError::Invalid(
            "archive output exceeds its limits".to_owned(),
        ));
    }
    Ok(bytes)
}

fn validate_archive_path(name: &str, is_dir: bool) -> Result<(), FormatError> {
    if name.is_empty()
        || !name.is_ascii()
        || name.starts_with('/')
        || name.starts_with('\\')
        || name.contains('\\')
        || name.contains('\0')
        || name.contains(':')
    {
        return Err(FormatError::Invalid(
            "archive contains an absolute or non-portable path".to_owned(),
        ));
    }
    let trimmed = if is_dir {
        name.strip_suffix('/').unwrap_or(name)
    } else {
        name
    };
    if trimmed.is_empty()
        || trimmed
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(FormatError::Invalid(
            "archive contains a traversal or ambiguous path".to_owned(),
        ));
    }
    Ok(())
}
