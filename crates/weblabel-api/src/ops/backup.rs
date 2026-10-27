use super::{
    database::{self as db, Migration},
    privacy,
};
use crate::{
    cli::Error,
    server::release::{checked_path, failure, is_redirect, Entry},
};
use rusqlite::{backup::Backup, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

pub fn boundary() -> Value {
    json!({"scope":"sensitive-whole-server-database","encryption":"none","integrity":"sha256-not-a-signature","browser_drafts":"not-included","preservation":["Before backup, export unresolved/unknown/foreign-author browser drafts from each browser without replaying writes.","Keep backup and draft rescue packages private; neither is a support receipt."]})
}
pub fn checklist() -> Value {
    json!([
    "Start with --data-dir pointing to the NEW restored directory; terminal bootstrap creates a new local administrator ID with fresh credentials, retaining historical account IDs.",
    "Inspect accounts and project members as the new administrator; explicitly re-establish historical account credentials and confirm role access without replacing historical user IDs.",
    "Open each old-author browser draft under its original identity; otherwise export it read-only. New credentials do not grant old-author draft write authority.",
    "Reconfigure AI profiles and secrets explicitly, then inspect availability; restoration does not authorize external calls or restart interrupted runs.",
    "Verify revisions, media, snapshots and exports before handing over; preserve the original backup and draft packages."
])
}
pub fn print_boundary() {
    let mut value = boundary();
    value["format"] = json!("weblabel-backup-boundary");
    println!("{value}");
}
#[derive(Serialize, Deserialize)]
pub struct Manifest {
    pub format: String,
    pub version: u32,
    pub created_at: String,
    pub schema_hash: String,
    pub migrations: Vec<Migration>,
    pub authentication: String,
    pub boundary: Value,
    pub files: Vec<Entry>,
}
const AUTHENTICATION: &str = "scrubbed-fresh-local-bootstrap-required";

fn destination(path: &Path) -> io::Result<PathBuf> {
    let absolute = std::path::absolute(path)?;
    // Resolve existing ancestors before comparing source/destination containment.
    let mut ancestor = absolute.as_path();
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => break,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                missing.push(
                    ancestor
                        .file_name()
                        .ok_or_else(|| failure("destination_invalid"))?
                        .to_owned(),
                );
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| failure("destination_invalid"))?;
            }
            Err(e) => return Err(e),
        }
    }
    let mut physical = ancestor.canonicalize()?;
    for part in missing.into_iter().rev() {
        physical.push(part);
    }
    Ok(physical)
}
fn entries(directory: &Path) -> Result<Vec<Entry>, Error> {
    fn visit(root: &Path, relative: &str, result: &mut Vec<Entry>) -> Result<(), Error> {
        let directory = if relative.is_empty() {
            root.to_path_buf()
        } else {
            root.join(relative)
        };
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| failure("manifest_path_invalid"))?;
            let path = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let meta = fs::symlink_metadata(entry.path())?;
            if is_redirect(&meta) {
                return Err(failure("link_refused").into());
            }
            if meta.is_dir() {
                visit(root, &path, result)?;
            } else {
                let file = checked_path(root, &path)?;
                result.push(Entry {
                    path,
                    size: meta.len(),
                    sha256: db::hash_file(&file)?,
                });
            }
        }
        Ok(())
    }
    let mut result = Vec::new();
    visit(directory, "", &mut result)?;
    result.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

pub fn create(data: &Path, backup: &Path) -> Result<Manifest, Error> {
    let data = db::root(data)?;
    let backup = destination(backup)?;
    if backup.starts_with(&data) {
        return Err(failure("backup_destination_inside_data").into());
    }
    if fs::symlink_metadata(&backup).is_ok() {
        return Err(failure("backup_directory_exists").into());
    }
    let source = checked_path(&data, "api.sqlite")?;
    fs::create_dir_all(
        backup
            .parent()
            .ok_or_else(|| failure("destination_invalid"))?,
    )?;
    db::private_directory(&backup)?;
    let action = (|| -> Result<Manifest, Error> {
        let source = db::read_only(&source)?;
        let mut copy = Connection::open(backup.join("api.sqlite"))?;
        Backup::new(&source, &mut copy)?.run_to_completion(256, Duration::from_millis(10), None)?;
        drop(source);
        db::validate(&copy)?;
        let schema_hash = db::schema_hash(&copy)?;
        let migrations = db::migrations(&copy)?;
        privacy::scrub(&copy)?;
        db::validate(&copy)?;
        let mode: String = copy.query_row("PRAGMA journal_mode=DELETE", [], |r| r.get(0))?;
        if mode != "delete" {
            return Err(failure("backup_journal_mode_invalid").into());
        }
        if db::schema_hash(&copy)? != schema_hash {
            return Err(failure("schema_changed").into());
        }
        for hash in db::object_hashes(&copy)? {
            let relative = db::object_name(&hash);
            let source = checked_path(&data, &relative)?;
            if db::hash_file(&source)? != hash {
                return Err(failure("object_hash_mismatch").into());
            }
            let target = backup.join(&relative);
            fs::create_dir_all(
                target
                    .parent()
                    .ok_or_else(|| failure("destination_invalid"))?,
            )?;
            db::copy_exclusive(
                &source,
                &target,
                &Entry {
                    path: relative,
                    size: fs::metadata(&source)?.len(),
                    sha256: hash,
                },
            )?;
        }
        copy.close().map_err(|(_, error)| error)?;
        for suffix in ["-wal", "-shm", "-journal"] {
            if fs::symlink_metadata(backup.join(format!("api.sqlite{suffix}"))).is_ok() {
                return Err(failure("backup_sqlite_sidecar").into());
            }
        }
        let manifest = Manifest {
            format: "weblabel-backup".into(),
            version: 1,
            created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            schema_hash,
            migrations,
            authentication: AUTHENTICATION.into(),
            boundary: boundary(),
            files: entries(&backup)?,
        };
        db::exclusive_json(&backup.join("backup.json"), &manifest)?;
        Ok(manifest)
    })();
    if action.is_err() {
        fs::remove_dir_all(&backup)?;
    }
    action
}

pub fn validate(source: &Path, sql: &[(String, String)]) -> Result<(Manifest, String), Error> {
    validate_schema(source, sql, false)
}

/// Preflight may validate a backup at an exact shipped migration prefix, but
/// restore still requires the complete current shipped schema.
pub fn validate_prefix(
    source: &Path,
    sql: &[(String, String)],
) -> Result<(Manifest, String), Error> {
    validate_schema(source, sql, true)
}

fn validate_schema(
    source: &Path,
    sql: &[(String, String)],
    prefix: bool,
) -> Result<(Manifest, String), Error> {
    let source = db::root(source)?;
    let manifest_path = checked_path(&source, "backup.json")?;
    let manifest: Manifest = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    if manifest.format != "weblabel-backup"
        || manifest.version != 1
        || manifest.authentication != AUTHENTICATION
    {
        return Err(failure("backup_incompatible").into());
    }
    if manifest.files.is_empty() {
        return Err(failure("manifest_files_missing").into());
    }
    let mut names = BTreeSet::new();
    let mut aliases = BTreeSet::new();
    for entry in &manifest.files {
        if !db::hash_valid(&entry.sha256)
            || entry.size > 9_007_199_254_740_991
            || !names.insert(entry.path.clone())
            || !aliases.insert(entry.path.to_ascii_lowercase())
        {
            return Err(failure("manifest_entry_invalid").into());
        }
        if entry.path != "api.sqlite" {
            let hash = entry.path.rsplit('/').next().unwrap_or("");
            if !db::hash_valid(hash) || db::object_name(hash) != entry.path {
                return Err(failure("backup_unexpected_file").into());
            }
        }
        let file = checked_path(&source, &entry.path)?;
        if fs::metadata(&file)?.len() != entry.size || db::hash_file(&file)? != entry.sha256 {
            return Err(failure("hash_mismatch").into());
        }
    }
    if !names.contains("api.sqlite") {
        return Err(failure("backup_database_missing").into());
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        match fs::symlink_metadata(source.join(format!("api.sqlite{suffix}"))) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            _ => return Err(failure("backup_sqlite_sidecar").into()),
        }
    }
    let database = db::read_only(&checked_path(&source, "api.sqlite")?)?;
    db::validate(&database)?;
    if db::schema_hash(&database)? != manifest.schema_hash
        || db::migrations(&database)? != manifest.migrations
    {
        return Err(failure("backup_schema_mismatch").into());
    }
    if !prefix
        && sql
            .iter()
            .filter(|(name, _)| name != "0001_core.sql")
            .count()
            != manifest.migrations.len()
    {
        return Err(failure("schema_incompatible").into());
    }
    let expected = db::reconstructed(sql, &manifest.migrations)?;
    if db::schema_hash(&expected)? != manifest.schema_hash {
        return Err(
            failure("schema_incompatible: actual schema differs from shipped migrations").into(),
        );
    }
    for query in [
        "SELECT COUNT(*) FROM users WHERE password_hash<>''",
        "SELECT COUNT(*) FROM sessions",
        "SELECT COUNT(*) FROM model_profiles WHERE config_json<>'{}' OR secret_ref IS NOT NULL",
    ] {
        if database.query_row(query, [], |r| r.get::<_, i64>(0))? != 0 {
            return Err(failure("backup_authentication_not_scrubbed").into());
        }
    }
    for hash in db::object_hashes(&database)? {
        let name = db::object_name(&hash);
        if !names.contains(&name) || db::hash_file(&checked_path(&source, &name)?)? != hash {
            return Err(failure("backup_object_missing_or_corrupt").into());
        }
    }
    Ok((manifest, db::hash_file(&manifest_path)?))
}

pub fn restore(source: &Path, target: &Path, sql: &[(String, String)]) -> Result<PathBuf, Error> {
    let source = db::root(source)?;
    let target = destination(target)?;
    if fs::symlink_metadata(&target).is_ok() {
        return Err(failure("restore_directory_exists: restore only to a NEW directory").into());
    }
    let (manifest, manifest_sha256) = validate(&source, sql)?;
    db::private_directory(&target)?;
    let action = (|| -> Result<(), Error> {
        for entry in &manifest.files {
            let original = checked_path(&source, &entry.path)?;
            let output = target.join(&entry.path);
            fs::create_dir_all(
                output
                    .parent()
                    .ok_or_else(|| failure("destination_invalid"))?,
            )?;
            db::copy_exclusive(&original, &output, entry)?;
        }
        fs::create_dir_all(target.join("objects"))?;
        db::exclusive_json(
            &target.join("restore.json"),
            &json!({"format":"weblabel-restored-data","version":1,"backup_manifest_sha256":manifest_sha256,"authentication":manifest.authentication}),
        )?;
        Ok(())
    })();
    action
        .map_err(|error| io::Error::other(format!("restore_failed_target_preserved: {error}")))?;
    Ok(target)
}

/// Native serve consumes this completion marker only; the auth service must
/// still recheck scrubbed credentials/sessions transactionally before bootstrap.
pub fn restore_marker_present(data: &Path) -> Result<bool, Error> {
    let data = db::root(data)?;
    match fs::symlink_metadata(data.join("restore.json")) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    let marker: Value = serde_json::from_slice(&fs::read(checked_path(&data, "restore.json")?)?)
        .map_err(|_| failure("restore_marker_invalid"))?;
    if marker["format"] != "weblabel-restored-data"
        || marker["version"] != 1
        || marker["authentication"] != AUTHENTICATION
        || !marker["backup_manifest_sha256"]
            .as_str()
            .is_some_and(db::hash_valid)
    {
        return Err(failure("restore_marker_invalid").into());
    }
    Ok(true)
}
