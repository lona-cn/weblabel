//! SQLite wire-v1 algorithms. SQL text is normalized only for CRLF in schema hashes.
use crate::{
    cli::Error,
    server::release::{checked_path, digest, failure, is_redirect, Entry},
};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

pub const MIGRATION_TABLE: &str = "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)";
pub fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
pub fn hash_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn object_name(hash: &str) -> String {
    format!("objects/{}/{}/{hash}", &hash[..2], &hash[2..4])
}
pub fn root(path: &Path) -> io::Result<PathBuf> {
    let meta = fs::symlink_metadata(path)?;
    if is_redirect(&meta) || !meta.is_dir() {
        return Err(failure("DIRECTORY_INVALID"));
    }
    path.canonicalize()
}
pub fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    digest(&mut file, size)
}
pub fn read_only(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
}
pub fn validate(db: &Connection) -> Result<(), Error> {
    let mut statement = db.prepare("PRAGMA integrity_check")?;
    let mut rows = statement.query([])?;
    let ok = rows
        .next()?
        .is_some_and(|row| matches!(row.get_ref(0), Ok(rusqlite::types::ValueRef::Text(b"ok"))));
    if !ok
        || rows.next()?.is_some()
        || db
            .prepare("PRAGMA foreign_key_check")?
            .query([])?
            .next()?
            .is_some()
    {
        return Err(failure("database_invalid").into());
    }
    Ok(())
}
#[derive(Serialize)]
struct SchemaRow<'a> {
    r#type: &'a str,
    name: &'a str,
    tbl_name: &'a str,
    sql: Option<Cow<'a, str>>,
}
struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub fn schema_hash(db: &Connection) -> Result<String, Error> {
    let mut statement = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")?;
    let mut rows = statement.query([])?;
    let mut hash = HashWriter(Sha256::new());
    hash.write_all(b"[")?;
    let mut first = true;
    while let Some(row) = rows.next()? {
        if !first {
            hash.write_all(b",")?;
        }
        first = false;
        let sql = match row.get_ref(3)? {
            rusqlite::types::ValueRef::Null => None,
            value => {
                let text = value.as_str()?;
                Some(if text.contains("\r\n") {
                    Cow::Owned(text.replace("\r\n", "\n"))
                } else {
                    Cow::Borrowed(text)
                })
            }
        };
        serde_json::to_writer(
            &mut hash,
            &SchemaRow {
                r#type: row.get_ref(0)?.as_str()?,
                name: row.get_ref(1)?.as_str()?,
                tbl_name: row.get_ref(2)?.as_str()?,
                sql,
            },
        )?;
    }
    hash.write_all(b"]")?;
    Ok(format!("{:x}", hash.0.finalize()))
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Migration {
    pub version: String,
}
pub fn migrations(db: &Connection) -> Result<Vec<Migration>, Error> {
    Ok(db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")?
        .query_map([], |r| Ok(Migration { version: r.get(0)? }))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}
pub fn object_hashes(db: &Connection) -> Result<BTreeSet<String>, Error> {
    let mut hashes = BTreeSet::new();
    for (table, column) in [
        ("media_object_refs", "sha256"),
        ("annotation_exports", "object_sha256"),
        ("dataset_exports", "object_sha256"),
    ] {
        for hash in db
            .prepare(&format!("SELECT {} FROM {}", quote(column), quote(table)))?
            .query_map([], |r| r.get::<_, String>(0))?
        {
            let hash = hash?;
            if !hash_valid(&hash) {
                return Err(failure("object_hash_invalid").into());
            }
            hashes.insert(hash);
        }
    }
    Ok(hashes)
}
pub fn migration_name(name: &str) -> bool {
    let Some((prefix, suffix)) = name.split_once('_') else {
        return false;
    };
    !prefix.is_empty()
        && prefix.bytes().all(|b| b.is_ascii_digit())
        && suffix.ends_with(".sql")
        && suffix.len() > 4
        && !name.contains(['/', '\\'])
}
pub fn migration_directory(path: &Path) -> Result<Vec<(String, String)>, Error> {
    let path = root(path)?;
    let mut files = Vec::new();
    for entry in fs::read_dir(&path)? {
        let name = entry?
            .file_name()
            .into_string()
            .map_err(|_| failure("migration_name_invalid"))?;
        if migration_name(&name) {
            files.push((
                name.clone(),
                fs::read_to_string(checked_path(&path, &name)?)?,
            ));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    if files.is_empty() {
        return Err(failure("schema_incompatible").into());
    }
    Ok(files)
}
pub fn reconstructed(sql: &[(String, String)], applied: &[Migration]) -> Result<Connection, Error> {
    let versions: Vec<_> = sql
        .iter()
        .filter(|(name, _)| name != "0001_core.sql")
        .collect();
    if applied.len() > versions.len()
        || applied
            .iter()
            .zip(&versions)
            .any(|(a, (name, _))| a.version != name.trim_end_matches(".sql"))
    {
        return Err(failure("schema_incompatible").into());
    }
    let db = Connection::open_in_memory()?;
    db.execute_batch(MIGRATION_TABLE)?;
    let core = sql
        .iter()
        .find(|(name, _)| name == "0001_core.sql")
        .ok_or_else(|| failure("TARGET_CORE_MISSING"))?;
    db.execute_batch(&core.1)?;
    for (_, sql) in versions.into_iter().take(applied.len()) {
        db.execute_batch(sql)?;
    }
    Ok(db)
}
pub fn exclusive_json(path: &Path, value: &impl Serialize) -> Result<(), Error> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}
pub fn private_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder
    };
    #[cfg(not(unix))]
    let builder = fs::DirBuilder::new();
    builder.create(path)
}
/// Copies through an exclusive descriptor; rechecks size/hash after copying.
pub fn copy_exclusive(source: &Path, target: &Path, expected: &Entry) -> Result<(), Error> {
    let mut input = File::open(source)?;
    if !input.metadata()?.is_file() || input.metadata()?.len() != expected.size {
        return Err(failure("restore_copy_hash_mismatch").into());
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(target)?;
    io::copy(&mut input, &mut output)?;
    output.sync_all()?;
    if fs::metadata(target)?.len() != expected.size || hash_file(target)? != expected.sha256 {
        return Err(failure("restore_copy_hash_mismatch").into());
    }
    Ok(())
}
/// Filesystem snapshots never connect SQLite to the original. The owned scratch is
/// next to caller data (or explicitly supplied), never a cache or user temp area.
pub struct Scratch {
    pub path: PathBuf,
}
impl Scratch {
    pub fn new(parent: &Path, purpose: &str) -> io::Result<Self> {
        let parent = root(parent)?;
        let path = parent.join(format!(".{purpose}-{}", uuid::Uuid::new_v4()));
        private_directory(&path)?;
        Ok(Self { path })
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
pub fn copy_database(
    data: &Path,
    scratch: &Path,
    limit: Option<u64>,
) -> Result<Vec<(PathBuf, String)>, Error> {
    let mut originals = Vec::new();
    for suffix in ["", "-wal"] {
        let name = format!("api.sqlite{suffix}");
        if suffix != ""
            && fs::symlink_metadata(data.join(&name))
                .is_err_and(|e| e.kind() == io::ErrorKind::NotFound)
        {
            continue;
        }
        let source = checked_path(data, &name)?;
        let size = fs::metadata(&source)?.len();
        if limit.is_some_and(|limit| size > limit) {
            return Err(failure("database_scan_limit_or_link").into());
        }
        let hash = hash_file(&source)?;
        copy_exclusive(
            &source,
            &scratch.join(&name),
            &Entry {
                path: name,
                size,
                sha256: hash.clone(),
            },
        )?;
        originals.push((source, hash));
    }
    unchanged(&originals)?;
    Ok(originals)
}
pub fn unchanged(originals: &[(PathBuf, String)]) -> Result<(), Error> {
    for (path, hash) in originals {
        if hash_file(path)? != *hash {
            return Err(failure("SOURCE_CHANGED").into());
        }
    }
    Ok(())
}
