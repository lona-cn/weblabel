use super::{backup, database as db};
use crate::{
    cli::Error,
    server::release::{checked_path, failure, Release},
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io,
    path::Path,
};

/// Own the exact startup sidecar exclusive lock through simulation and final
/// source hashes. Existing lock bytes are never rewritten or removed.
fn stopped_guard(data: &Path) -> Result<File, Error> {
    match fs::symlink_metadata(data.join("runtime.lock")) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        _ => return Err(failure("STOP_SOURCE_BEFORE_PREFLIGHT").into()),
    }
    checked_path(data, "api.sqlite")?;
    match fs::symlink_metadata(data.join("api.sqlite.runtime.lock")) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
        Ok(_) => {
            checked_path(data, "api.sqlite.runtime.lock")?;
        }
    }
    crate::startup::lock_database(&format!("sqlite:{}", data.join("api.sqlite").display())).map_err(
        |error| {
            if error.kind() == io::ErrorKind::WouldBlock {
                failure("STOP_SOURCE_BEFORE_PREFLIGHT").into()
            } else {
                error.into()
            }
        },
    )
}

pub fn run(data: &Path, target: &Path, backup_dir: &Path, scratch_parent: Option<&Path>) -> Value {
    let mut result = json!({"status":"unsupported","readonly_source":true,"rollback":"not-verified","source_schema":null,"target_schema":null,"pending_migrations":[],"support_boundary":"Only exact shipped schemas or an exact migration prefix that applies cleanly on an isolated copy are supported."});
    let operation = (|| -> Result<(), Error> {
        let release = Release::validate(target)?;
        let sql = release.migration_sql()?;
        if sql.is_empty() {
            return Err(failure("TARGET_MIGRATIONS_MISSING").into());
        }
        let data = db::root(data)?;
        let _guard = stopped_guard(&data)?;
        let (backup, backup_hash) =
            backup::validate_prefix(backup_dir, &sql).map_err(|_| failure("BACKUP_INVALID"))?;
        result["backup_manifest_sha256"] = json!(backup_hash);
        let parent = scratch_parent
            .or_else(|| data.parent())
            .ok_or_else(|| failure("SCRATCH_PARENT_REQUIRED"))?;
        let parent = db::root(parent)?;
        if parent.starts_with(&data)
            || parent.starts_with(db::root(backup_dir)?)
            || parent.starts_with(db::root(target)?)
        {
            return Err(failure("SCRATCH_INSIDE_PROTECTED_ROOT").into());
        }
        let scratch = db::Scratch::new(&parent, "weblabel-upgrade-preflight")?;
        let originals = db::copy_database(&data, &scratch.path, None)?;
        let apply = (|| -> Result<(), Error> {
            let source = Connection::open(scratch.path.join("api.sqlite"))?;
            db::validate(&source)?;
            let source_schema = db::schema_hash(&source)?;
            result["source_schema"] = json!(source_schema);
            let applied = db::migrations(&source)?;
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
                return Err(failure("SOURCE_MIGRATIONS_UNSUPPORTED").into());
            }
            let expected = db::reconstructed(&sql, &applied)?;
            if db::schema_hash(&expected)? != source_schema {
                return Err(failure("SOURCE_SCHEMA_UNSUPPORTED").into());
            }
            if backup.migrations != applied || backup.schema_hash != source_schema {
                return Err(failure("BACKUP_SOURCE_SCHEMA_MISMATCH").into());
            }
            let mut pending = Vec::new();
            for (name, sql) in versions.into_iter().skip(applied.len()) {
                expected.execute_batch(sql)?;
                source.execute_batch(sql)?;
                pending.push(name.trim_end_matches(".sql").to_owned());
                result["pending_migrations"] = json!(pending);
            }
            let target_schema = db::schema_hash(&expected)?;
            result["target_schema"] = json!(target_schema);
            db::validate(&source)?;
            if db::schema_hash(&source)? != target_schema {
                return Err(failure("TARGET_SCHEMA_MISMATCH").into());
            }
            source.close().map_err(|(_, error)| error)?;
            Ok(())
        })();
        // Source hashes are checked on failure as well as success. All SQLite
        // recovery/migration work above was confined to this owned scratch.
        db::unchanged(&originals)?;
        apply?;
        result["status"] = json!("compatible");
        Ok(())
    })();
    if let Err(error) = operation {
        let message = error.to_string();
        let known = [
            "TARGET_MIGRATIONS_MISSING",
            "TARGET_CORE_MISSING",
            "STOP_SOURCE_BEFORE_PREFLIGHT",
            "SOURCE_CHANGED",
            "SOURCE_MIGRATIONS_UNSUPPORTED",
            "SOURCE_SCHEMA_UNSUPPORTED",
            "TARGET_SCHEMA_MISMATCH",
            "BACKUP_INVALID",
            "BACKUP_SOURCE_SCHEMA_MISMATCH",
            "SCRATCH_INSIDE_PROTECTED_ROOT",
        ];
        result["code"] = json!(known
            .into_iter()
            .find(|code| *code == message)
            .unwrap_or("PREFLIGHT_FAILED"));
        result["error_kind"] = json!("sqlite-or-filesystem");
    }
    result
}
