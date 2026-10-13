use std::{
    collections::{BTreeMap, HashSet},
    io::{Cursor, Read},
};

use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use crate::FormatError;
const MAX_ZIP_BYTES: u64 = 96 * 1024 * 1024;

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
    if bytes.len() as u64 > MAX_ZIP_BYTES {
        return Err(FormatError::Invalid("archive input exceeds its ZIP size limit".to_owned()));
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
    if limits.max_entries == 0 || limits.max_uncompressed_bytes == 0 || files.is_empty()
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
    if bytes.len() as u64 > MAX_ZIP_BYTES {
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

#[cfg(test)]
mod commercial_d_private_tests {
    use super::*;
    use std::io::Write;
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    const ZIP_CAP: usize = 96 * 1024 * 1024;

    fn raw_zip(files: &[(String, Vec<u8>)], directories: usize, compressed: bool) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let method = if compressed { CompressionMethod::Deflated } else { CompressionMethod::Stored };
        let options = SimpleFileOptions::default().compression_method(method);
        for index in 0..directories {
            writer.add_directory(format!("dir-{index}/"), options).unwrap();
        }
        for (name, bytes) in files {
            writer.start_file(name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    // A gap before the relocated central directory, not trailing garbage.
    // The directory still points at the valid local record at offset zero.
    fn padded_zip(total: usize) -> Vec<u8> {
        let mut bytes = raw_zip(&[("a.bin".into(), vec![7])], 0, false);
        let eocd = bytes.len() - 22;
        assert_eq!(&bytes[eocd..eocd + 4], b"PK\x05\x06");
        let central = u32::from_le_bytes(bytes[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
        let tail = bytes.split_off(central);
        let relocated = total - tail.len();
        bytes.resize(relocated, 0);
        bytes.extend_from_slice(&tail);
        let eocd = bytes.len() - 22;
        bytes[eocd + 16..eocd + 20].copy_from_slice(&(relocated as u32).to_le_bytes());
        bytes
    }

    #[test]
    fn zip_input_budget_is_independent_of_tiny_unpacked_content() {
        let limits = ArchiveLimits::default();
        let expected = BTreeMap::from([("a.bin".to_owned(), vec![7])]);
        assert_eq!(extract_safe_zip(&padded_zip(1024), &limits).unwrap(), expected);
        let bytes = padded_zip(ZIP_CAP);
        assert_eq!(bytes.len(), ZIP_CAP);
        assert_eq!(extract_safe_zip(&bytes, &limits).unwrap(), expected);
        drop(bytes);
        let bytes = padded_zip(ZIP_CAP + 1);
        let mut reader = ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let mut contents = Vec::new();
        reader.by_index(0).unwrap().read_to_end(&mut contents).unwrap();
        assert_eq!(contents, vec![7]);
        assert!(matches!(extract_safe_zip(&bytes, &limits), Err(FormatError::Invalid(_))));
    }

    #[test]
    fn small_unpacked_cap_does_not_charge_zip_metadata() {
        let limits = ArchiveLimits { max_entries: 1, max_uncompressed_bytes: 1 };
        let files = [("a.bin".into(), vec![7])];
        let bytes = create_safe_zip(&files, &limits).expect("metadata belongs to the independent ZIP budget");
        assert!(bytes.len() > 1 && bytes.len() < ZIP_CAP);
        assert_eq!(extract_safe_zip(&bytes, &limits).unwrap()["a.bin"], vec![7]);
    }

    #[test]
    fn stored_output_exact_zip_byte_boundary() {
        let overhead = raw_zip(&[("a.bin".into(), Vec::new())], 0, false).len();
        for extra in [0, 1] {
            let files = [("a.bin".into(), vec![7; ZIP_CAP - overhead + extra])];
            let result = create_safe_zip(&files, &ArchiveLimits::default());
            if extra == 0 {
                let bytes = result.unwrap();
                assert_eq!(bytes.len(), ZIP_CAP);
                assert_eq!(extract_safe_zip(&bytes, &ArchiveLimits::default()).unwrap()["a.bin"], files[0].1);
            } else {
                assert!(matches!(result, Err(FormatError::Invalid(_))));
            }
        }
    }

    #[test]
    fn unpacked_boundary_uses_compression_to_stay_below_zip_cap() {
        for extra in [0, 1] {
            let bytes = raw_zip(&[("a.bin".into(), vec![7; ZIP_CAP + extra])], 0, true);
            assert!(bytes.len() < ZIP_CAP);
            let result = extract_safe_zip(&bytes, &ArchiveLimits::default());
            if extra == 0 {
                assert_eq!(result.unwrap()["a.bin"], vec![7; ZIP_CAP]);
            } else {
                assert!(matches!(result, Err(FormatError::Invalid(_))));
            }
        }
    }

    #[test]
    fn member_boundary_counts_directories_and_creation_files() {
        let limits = ArchiveLimits::default();
        let mut files: Vec<_> = (0..4096).map(|index| (format!("file-{index}"), vec![7])).collect();
        let bytes = create_safe_zip(&files, &limits).unwrap();
        assert_eq!(extract_safe_zip(&bytes, &limits).unwrap(), files.iter().cloned().collect());
        files.push(("file-4096".into(), vec![7]));
        assert!(create_safe_zip(&files, &limits).is_err());
        let one = [("a.bin".into(), vec![7])];
        assert_eq!(extract_safe_zip(&raw_zip(&one, 4095, false), &limits).unwrap()["a.bin"], vec![7]);
        assert!(extract_safe_zip(&raw_zip(&one, 4096, false), &limits).is_err());
    }

    #[test]
    fn zero_limits_reject_empty_members_on_both_paths() {
        let files = [("a.bin".into(), Vec::new())];
        let bytes = raw_zip(&files, 0, false);
        for limits in [
            ArchiveLimits { max_entries: 0, max_uncompressed_bytes: 1 },
            ArchiveLimits { max_entries: 1, max_uncompressed_bytes: 0 },
        ] {
            assert!(create_safe_zip(&files, &limits).is_err());
            assert!(extract_safe_zip(&bytes, &limits).is_err());
        }
    }
}
