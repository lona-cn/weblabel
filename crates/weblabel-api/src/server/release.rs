//! Release-v2 verification shared by serve and the read-only doctor.
use std::{collections::BTreeMap, fs::{self, File}, io::{self, Read, Seek, SeekFrom}, path::{Path, PathBuf}};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const MANIFEST_LIMIT: u64 = 4 * 1024 * 1024;
const FILE_LIMIT: u64 = 512 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 2 * 1024 * 1024 * 1024;

pub fn failure(code: &'static str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, code) }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: String, version: u32, platform: String, arch: String,
    source_commit: String, pins: BTreeMap<String, String>, files: Vec<Entry>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry { pub path: String, pub size: u64, pub sha256: String }

#[derive(Clone)]
pub struct Release { root: PathBuf, pub web: BTreeMap<String, Entry>, pub source_commit: String, pub file_count: usize }

pub fn platform() -> &'static str { match std::env::consts::OS { "windows" => "win32", "macos" => "darwin", other => other } }
pub fn arch() -> &'static str { match std::env::consts::ARCH { "x86_64" => "x64", "aarch64" => "arm64", other => other } }
pub fn executable_name() -> &'static str { if cfg!(windows) { "weblabel.exe" } else { "weblabel" } }

pub fn is_redirect(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; metadata.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))] { metadata.file_type().is_symlink() }
}

pub fn valid_relative(value: &str) -> bool {
    !value.is_empty() && value.len() <= 1024 && !value.contains(['\\', ':', '%', '\0', '?', '#']) &&
    value.split('/').all(|part| {
        !part.is_empty() && part != "." && part != ".." && !part.ends_with(['.', ' ']) &&
        !part.chars().any(char::is_control) && {
            let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
            !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") &&
            !(stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        }
    })
}

/// Refuse redirects at every component, including Windows junctions/reparse points.
pub fn checked_path(root: &Path, relative: &str) -> io::Result<PathBuf> {
    if !valid_relative(relative) { return Err(failure("MANIFEST_PATH_INVALID")); }
    let mut file = root.to_path_buf();
    let mut parts = relative.split('/').peekable();
    while let Some(part) = parts.next() {
        file.push(part);
        let metadata = fs::symlink_metadata(&file)?;
        if is_redirect(&metadata) || (parts.peek().is_some() && !metadata.is_dir()) { return Err(failure("MANIFEST_PATH_ESCAPE")); }
    }
    if !fs::metadata(&file)?.is_file() || !file.canonicalize()?.starts_with(root) { return Err(failure("MANIFEST_PATH_ESCAPE")); }
    Ok(file)
}

fn digest(file: &mut File, expected_size: u64) -> io::Result<String> {
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 { break; }
        total += count as u64;
        if total > expected_size { return Err(failure("RELEASE_HASH_MISMATCH")); }
        hash.update(&buffer[..count]);
    }
    if total != expected_size { return Err(failure("RELEASE_HASH_MISMATCH")); }
    Ok(format!("{:x}", hash.finalize()))
}

impl Release {
    pub fn validate(directory: &Path) -> io::Result<Self> {
        if is_redirect(&fs::symlink_metadata(directory)?) { return Err(failure("MANIFEST_PATH_ESCAPE")); }
        let root = directory.canonicalize()?;
        let manifest_path = checked_path(&root, "release.json")?;
        let mut file = File::open(manifest_path)?;
        if file.metadata()?.len() > MANIFEST_LIMIT { return Err(failure("RELEASE_MANIFEST_TOO_LARGE")); }
        let mut bytes = Vec::new();
        (&mut file).take(MANIFEST_LIMIT + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MANIFEST_LIMIT { return Err(failure("RELEASE_MANIFEST_TOO_LARGE")); }
        let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| failure("RELEASE_MANIFEST_INVALID"))?;
        if manifest.format != "weblabel-local-release" { return Err(failure("RELEASE_FORMAT_INVALID")); }
        if manifest.version != 2 { return Err(failure("RELEASE_VERSION_UNSUPPORTED")); }
        if manifest.platform != platform() || manifest.arch != arch() { return Err(failure("RELEASE_PLATFORM_MISMATCH")); }
        if manifest.source_commit.len() != 40 || !manifest.source_commit.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) { return Err(failure("RELEASE_SOURCE_INVALID")); }
        let expected_pins = [("node", "24.16.0"), ("pnpm", "10.34.5"), ("rust", "1.96.0"), ("wasm_bindgen", "0.2.128"), ("wasm_pack", "0.15.0")];
        if manifest.pins.len() != expected_pins.len() || expected_pins.iter().any(|(key, value)| manifest.pins.get(*key).map(String::as_str) != Some(*value)) { return Err(failure("RELEASE_PINS_INVALID")); }
        if manifest.files.is_empty() || manifest.files.len() > 10000 { return Err(failure("RELEASE_FILE_COUNT_INVALID")); }
        let mut entries = BTreeMap::new();
        let mut total = 0u64;
        for entry in manifest.files {
            total = total.checked_add(entry.size).ok_or_else(|| failure("RELEASE_SIZE_LIMIT"))?;
            if entry.size > FILE_LIMIT || total > TOTAL_LIMIT { return Err(failure("RELEASE_SIZE_LIMIT")); }
            if !valid_relative(&entry.path) || !(entry.path == executable_name() || entry.path.starts_with("web/") || entry.path.starts_with("migrations/") || entry.path.starts_with("runtime/")) || entry.sha256.len() != 64 || !entry.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err(failure("MANIFEST_ENTRY_INVALID")); }
            if let Some(web_path) = entry.path.strip_prefix("web/") {
                if web_path.contains(['{', '}']) || ["api", "internal", "health", "ready"].iter().any(|reserved| web_path == *reserved || web_path.starts_with(&format!("{reserved}/"))) {
                    return Err(failure("RELEASE_ROUTE_COLLISION"));
                }
            }
            // Windows filesystems are case-insensitive; aliases must not create two identities.
            let key = entry.path.to_ascii_lowercase();
            if entries.contains_key(&key) { return Err(failure("MANIFEST_ENTRY_DUPLICATE")); }
            let mut file = File::open(checked_path(&root, &entry.path)?)?;
            if file.metadata()?.len() != entry.size || digest(&mut file, entry.size)? != entry.sha256 { return Err(failure("RELEASE_HASH_MISMATCH")); }
            entries.insert(key, entry);
        }
        for required in [executable_name(), "web/index.html", "web/wasm/wasm_bridge.js", "web/wasm/wasm_bridge_bg.wasm"] {
            if !entries.get(required).is_some_and(|entry| entry.path == required && entry.size > 0) { return Err(failure("RELEASE_REQUIRED_ASSET_MISSING")); }
        }
        if !entries.values().any(|entry| entry.path.starts_with("migrations/") && entry.path.ends_with(".sql") && entry.size > 0) { return Err(failure("RELEASE_MIGRATIONS_MISSING")); }
        let file_count = entries.len();
        let web = entries.into_values().filter_map(|entry| {
            let path = entry.path.strip_prefix("web/").map(|path| format!("/{path}"))?;
            Some((path, entry))
        }).collect();
        Ok(Self { root, web, source_commit: manifest.source_commit, file_count })
    }

    /// Recheck the same opened descriptor before serving; changes after startup fail closed.
    pub fn open_web(&self, entry: &Entry) -> io::Result<File> {
        let mut file = File::open(checked_path(&self.root, &entry.path)?)?;
        if file.metadata()?.len() != entry.size || digest(&mut file, entry.size)? != entry.sha256 { return Err(failure("RELEASE_HASH_MISMATCH")); }
        file.seek(SeekFrom::Start(0))?;
        Ok(file)
    }
}

pub fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8", "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8", "wasm" => "application/wasm", "json" | "map" => "application/json",
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "svg" => "image/svg+xml", "ico" => "image/x-icon",
        "woff" => "font/woff", "woff2" => "font/woff2", "ttf" => "font/ttf", _ => "application/octet-stream",
    }
}
