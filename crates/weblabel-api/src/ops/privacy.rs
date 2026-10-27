//! Preserve every collision-free business TEXT byte. Only two mutable projections
//! may be redacted; decoded keys, immutable values and unsafe encodings fail closed.
use super::database::quote;
use crate::{cli::Error, server::release::failure};
use rusqlite::Connection;

use super::privacy_json::{encode, parse, Json};

struct Secret {
    units: Vec<u16>,
    text: Option<String>,
}
fn private_key(key: &[u16]) -> bool {
    let key = String::from_utf16_lossy(key).to_ascii_lowercase();
    [
        "apikey",
        "api_key",
        "api-key",
        "secret",
        "password",
        "authorization",
        "credential",
        "accesstoken",
        "access_token",
        "access-token",
        "refreshtoken",
        "refresh_token",
        "refresh-token",
        "sessiontoken",
        "session_token",
        "session-token",
    ]
    .iter()
    .any(|part| key.contains(part))
}
fn add(secrets: &mut Vec<Secret>, value: &[u16]) {
    if !value.is_empty() && !secrets.iter().any(|v| v.units == value) {
        secrets.push(Secret {
            units: value.to_owned(),
            text: String::from_utf16(value).ok(),
        });
    }
}
fn collect(value: &Json, secrets: &mut Vec<Secret>) {
    match value {
        Json::String(value) => add(secrets, value),
        Json::Object(items) => {
            for (key, value) in items {
                if private_key(key) || matches!(value, Json::Object(_) | Json::Array(_)) {
                    collect(value, secrets);
                }
            }
        }
        Json::Array(items) => {
            for value in items {
                if matches!(value, Json::Object(_) | Json::Array(_)) {
                    collect(value, secrets);
                }
            }
        }
        _ => {}
    }
}
fn text_secret(value: &str, secrets: &[Secret]) -> bool {
    secrets.iter().any(|secret| match &secret.text {
        Some(secret) => value.contains(secret),
        None => {
            // JS includes() can match half of a non-BMP character when a
            // credential itself contains an unpaired UTF-16 surrogate.
            let mut units = value.encode_utf16();
            while let Some(first) = units.next() {
                if first == secret.units[0]
                    && units
                        .clone()
                        .take(secret.units.len() - 1)
                        .eq(secret.units[1..].iter().copied())
                {
                    return true;
                }
            }
            false
        }
    })
}
fn units_secret(value: &[u16], secrets: &[Secret]) -> bool {
    secrets
        .iter()
        .any(|secret| value.windows(secret.units.len()).any(|v| v == secret.units))
}
fn contains(value: &Json, secrets: &[Secret]) -> bool {
    match value {
        Json::String(v) => units_secret(v, secrets),
        Json::Array(v) => v
            .iter()
            .enumerate()
            .any(|(i, v)| text_secret(&i.to_string(), secrets) || contains(v, secrets)),
        Json::Object(v) => v
            .iter()
            .any(|(k, v)| units_secret(k, secrets) || contains(v, secrets)),
        _ => false,
    }
}
fn secret_key(value: &Json, secrets: &[Secret]) -> bool {
    match value {
        Json::Array(v) => v
            .iter()
            .enumerate()
            .any(|(i, v)| text_secret(&i.to_string(), secrets) || secret_key(v, secrets)),
        Json::Object(v) => v
            .iter()
            .any(|(k, v)| units_secret(k, secrets) || secret_key(v, secrets)),
        _ => false,
    }
}
fn redact(value: &mut Json, secrets: &[Secret]) -> bool {
    match value {
        Json::String(v) => {
            let mut changed = false;
            for secret in secrets {
                if !v
                    .windows(secret.units.len())
                    .any(|part| part == secret.units)
                {
                    continue;
                }
                let mut out = Vec::with_capacity(v.len());
                let mut i = 0;
                while i < v.len() {
                    if v[i..].starts_with(&secret.units) {
                        out.extend("[REDACTED]".encode_utf16());
                        i += secret.units.len();
                    } else {
                        out.push(v[i]);
                        i += 1;
                    }
                }
                *v = out;
                changed = true;
            }
            changed
        }
        Json::Array(v) => v
            .iter_mut()
            .fold(false, |changed, v| redact(v, secrets) | changed),
        Json::Object(v) => v
            .iter_mut()
            .fold(false, |changed, (_, v)| redact(v, secrets) | changed),
        _ => false,
    }
}
fn collision() -> Error {
    failure(
        "credential_in_immutable_business_data: cannot scrub persisted business data or JSON keys",
    )
    .into()
}

pub fn scrub(db: &Connection) -> Result<(), Error> {
    let mut secrets = Vec::new();
    for row in db
        .prepare("SELECT config_json,secret_ref FROM model_profiles")?
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })?
    {
        let (config, secret_ref) = row?;
        collect(&parse(&config)?, &mut secrets);
        if let Some(secret) = secret_ref {
            add(&mut secrets, &secret.encode_utf16().collect::<Vec<_>>());
        }
    }
    let triggers = db
        .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    db.execute_batch("PRAGMA foreign_keys=OFF; PRAGMA secure_delete=ON; BEGIN IMMEDIATE")?;
    let transaction = (|| -> Result<(), Error> {
        for (name, _) in &triggers {
            db.execute_batch(&format!("DROP TRIGGER {}", quote(name)))?;
        }
        db.execute_batch("DELETE FROM sessions; UPDATE users SET password_hash=''; UPDATE model_profiles SET config_json='{}',secret_ref=NULL,availability='needs_configuration',verification='not_run',verified_at=NULL; DELETE FROM model_run_authorizations; DELETE FROM consents; DELETE FROM ai_run_previews;")?;
        let tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'")?.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for table in tables {
            let columns = db
                .prepare(&format!("PRAGMA table_info({})", quote(&table)))?
                .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (column, kind) in columns {
                if !kind.eq_ignore_ascii_case("TEXT") {
                    continue;
                }
                let mutable = matches!(
                    (table.as_str(), column.as_str()),
                    ("jobs", "progress_json") | ("model_runs", "profile_snapshot_json")
                );
                let query = format!(
                    "SELECT rowid,{} FROM {} WHERE {} IS NOT NULL",
                    quote(&column),
                    quote(&table),
                    quote(&column)
                );
                let rows = db
                    .prepare(&query)?
                    .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                for (rowid, raw) in rows {
                    if !mutable {
                        if text_secret(&raw, &secrets) {
                            return Err(collision());
                        }
                        let decoded = if column.ends_with("_json") {
                            Some(parse(&raw)?)
                        } else {
                            parse(&raw).ok()
                        };
                        if decoded.as_ref().is_some_and(|v| contains(v, &secrets)) {
                            return Err(collision());
                        }
                        continue;
                    }
                    let mut value = parse(&raw)?;
                    if secret_key(&value, &secrets) {
                        return Err(collision());
                    }
                    let changed = redact(&mut value, &secrets);
                    let encoded = encode(&value);
                    if text_secret(&encoded, &secrets) || contains(&value, &secrets) {
                        return Err(collision());
                    }
                    if changed {
                        db.execute(
                            &format!(
                                "UPDATE {} SET {}=? WHERE rowid=?",
                                quote(&table),
                                quote(&column)
                            ),
                            rusqlite::params![encoded, rowid],
                        )?;
                    } else if text_secret(&raw, &secrets) {
                        return Err(collision());
                    }
                }
            }
        }
        db.execute_batch("UPDATE model_runs SET state='interrupted' WHERE state IN ('queued','running'); UPDATE jobs SET state='interrupted',worker_id=NULL,lease_until=NULL WHERE state IN ('queued','running'); UPDATE task_leases SET holder_id=NULL,expires_at=0;")?;
        for (_, sql) in &triggers {
            db.execute_batch(sql)?;
        }
        db.execute_batch("COMMIT")?;
        Ok(())
    })();
    if transaction.is_err() {
        let _ = db.execute_batch("ROLLBACK");
    }
    transaction?;
    db.execute_batch("PRAGMA foreign_keys=ON; VACUUM; PRAGMA wal_checkpoint(TRUNCATE)")?;
    Ok(())
}
