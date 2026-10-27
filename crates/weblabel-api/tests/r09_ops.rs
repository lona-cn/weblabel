//! Synthetic business fixtures only. These tests call the real native operations;
//! no model, account, browser, user data, or private configuration is consulted.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::process::Command;
use std::{
    fs,
    path::{Path, PathBuf},
};
use weblabel_api::{
    ops::{backup, database as db, preflight},
    server::release,
};

const SECRET: &str = "synthetic-credential-7bQ";
const BUSINESS_JSON: &str = " { \"note\" : \"business\\u0020bytes\", \"n\" : 1.00 } ";
fn scratch() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/test-artifacts/R09-ops");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}
fn product() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_weblabel"));
    command.env_clear().env("PATH", "");
    for name in ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
}
struct Fixture {
    root: tempfile::TempDir,
    data: PathBuf,
    database: Connection,
    sql: Vec<(String, String)>,
}
impl Fixture {
    fn new() -> Self {
        let root = scratch();
        let data = root.path().join("source");
        fs::create_dir(&data).unwrap();
        let sql =
            db::migration_directory(&Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"))
                .unwrap();
        let database = Connection::open(data.join("api.sqlite")).unwrap();
        database.execute_batch(db::MIGRATION_TABLE).unwrap();
        for (name, sql) in &sql {
            database.execute_batch(sql).unwrap();
            if name != "0001_core.sql" {
                database
                    .execute(
                        "INSERT INTO schema_migrations(version) VALUES(?)",
                        [name.trim_end_matches(".sql")],
                    )
                    .unwrap();
            }
        }
        database.execute_batch("PRAGMA wal_autocheckpoint=0; INSERT INTO users(user_id,username,password_hash,created_at,platform_admin) VALUES('old-user','old-author','synthetic-password-hash','synthetic',1); INSERT INTO projects(project_id,name,description,created_at) VALUES('project','Synthetic project','Business description','synthetic'); INSERT INTO memberships(project_id,user_id,role) VALUES('project','old-user','admin'); INSERT INTO sessions(session_id,user_id,expires_at,created_at,csrf_hash) VALUES('synthetic-session','old-user','9999999999','synthetic','synthetic-csrf');").unwrap();
        database.execute("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,config_json,secret_ref,created_at) VALUES('profile','openai_api','synthetic-model','api_key','{}','ready','not_run',?,NULL,'synthetic')", [format!("{{\"nested\":{{\"api_key\":\"{SECRET}\"}}}}")]).unwrap();
        database.execute("INSERT INTO ontology_versions(ontology_version_id,project_id,version_no,body_json,created_at) VALUES('ontology','project',1,?,'synthetic')", [BUSINESS_JSON]).unwrap();
        let object = b"synthetic canonical object bytes";
        let hash = {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(object))
        };
        let object_file = data.join(db::object_name(&hash));
        fs::create_dir_all(object_file.parent().unwrap()).unwrap();
        fs::write(&object_file, object).unwrap();
        database.execute_batch("INSERT INTO media_assets(asset_id,project_id,created_at) VALUES('asset','project','synthetic');").unwrap();
        database.execute("INSERT INTO media_revisions(asset_revision_id,project_id,asset_id,original_sha256,canonical_sha256,original_name,created_at) VALUES('media','project','asset',?,?,'原图  image.png','synthetic')", params![hash, hash]).unwrap();
        database
            .execute(
                "INSERT INTO media_object_refs(asset_revision_id,sha256) VALUES('media',?)",
                [&hash],
            )
            .unwrap();
        database.execute("INSERT INTO annotation_revisions(annotation_revision_id,project_id,asset_revision_id,ontology_version_id,revision_no,body_json,content_hash,created_by,created_at) VALUES('revision','project','media','ontology',1,?,?,'old-user','synthetic')", params![BUSINESS_JSON, "b".repeat(64)]).unwrap();
        database.execute("INSERT INTO jobs(job_id,project_id,kind,state,payload_json,result_json,created_at,updated_at,worker_id,lease_until,fencing_token,progress_json) VALUES('job','project','synthetic','running',?,?,'synthetic','synthetic','worker','9999999999',37,?)", params![BUSINESS_JSON, BUSINESS_JSON, format!(" {{\"message\":\"starting {SECRET}\"}} ")]).unwrap();
        database.execute("INSERT INTO model_runs(run_id,operation_id,project_id,asset_revision_id,annotation_revision_id,ontology_version_id,actor_id,job_id,profile_id,profile_snapshot_json,provider_id,source,intent,prompt,context_json,input_fingerprint,request_hash,state,cost_display,created_at) VALUES('run','operation','project','media','revision','ontology','old-user','job','profile',?,'openai_api','provider','detect','original prompt',?,'input',?,'running','unknown','synthetic')", params![format!(" {{\"api_key\":\"{SECRET}\",\"note\":\"profile\"}} "), BUSINESS_JSON, "c".repeat(64)]).unwrap();
        database.execute_batch("INSERT INTO review_tasks(task_id,project_id,asset_revision_id,ontology_version_id,assignee_id,created_by,state,created_at) VALUES('task','project','media','ontology','old-user','old-user','open','synthetic'); INSERT INTO task_leases(task_id,holder_id,fencing_token,expires_at,updated_at) VALUES('task','old-user',43,9999999999,17);").unwrap();
        db::validate(&database).unwrap();
        Self {
            root,
            data,
            database,
            sql,
        }
    }
    fn backup_path(&self) -> PathBuf {
        self.root.path().join("backup")
    }
    fn source_bytes(&self) -> Vec<(String, Vec<u8>)> {
        ["api.sqlite", "api.sqlite-wal"]
            .into_iter()
            .filter_map(|name| {
                fs::read(self.data.join(name))
                    .ok()
                    .map(|bytes| (name.to_owned(), bytes))
            })
            .collect()
    }
    fn release(&self) -> PathBuf {
        let target = self.root.path().join("release");
        fs::create_dir_all(target.join("web/wasm")).unwrap();
        fs::create_dir(target.join("migrations")).unwrap();
        let binary = release::executable_name();
        fs::copy(env!("CARGO_BIN_EXE_weblabel"), target.join(binary)).unwrap();
        let mut paths = vec![binary.to_owned()];
        for (name, bytes) in [
            ("web/index.html", b"synthetic".as_slice()),
            ("web/wasm/wasm_bridge.js", b"synthetic".as_slice()),
            (
                "web/wasm/wasm_bridge_bg.wasm",
                b"\0asm\x01\0\0\0".as_slice(),
            ),
        ] {
            fs::write(target.join(name), bytes).unwrap();
            paths.push(name.into());
        }
        for (name, sql) in &self.sql {
            let relative = format!("migrations/{name}");
            fs::write(target.join(&relative), sql).unwrap();
            paths.push(relative);
        }
        let files: Vec<_> = paths.into_iter().map(|path| json!({"size":fs::metadata(target.join(&path)).unwrap().len(),"sha256":db::hash_file(&target.join(&path)).unwrap(),"path":path})).collect();
        fs::write(target.join("release.json"), serde_json::to_vec(&json!({"format":"weblabel-local-release","version":2,"platform":release::platform(),"arch":release::arch(),"source_commit":"c5a9a050b314eda1dfbe19b2288777f5a5f822c0","pins":{"node":"24.16.0","pnpm":"10.34.5","rust":"1.96.0","wasm_bindgen":"0.2.128","wasm_pack":"0.15.0"},"files":files})).unwrap()).unwrap();
        target
    }
}

#[test]
fn backup_scrubs_only_snapshot_and_preserves_pinned_business_bytes_identity_fences_and_schema() {
    let f = Fixture::new();
    let before = f.source_bytes();
    let schema = db::schema_hash(&f.database).unwrap();
    let manifest = backup::create(&f.data, &f.backup_path()).unwrap();
    assert_eq!(f.source_bytes(), before);
    assert_eq!(manifest.schema_hash, schema);
    backup::validate(&f.backup_path(), &f.sql).unwrap();
    let copy = db::read_only(&f.backup_path().join("api.sqlite")).unwrap();
    assert_eq!(
        copy.query_row("SELECT username,password_hash FROM users", [], |r| Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?
        )))
        .unwrap(),
        ("old-author".into(), String::new())
    );
    assert_eq!(
        copy.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    for query in [
        "SELECT body_json FROM ontology_versions",
        "SELECT body_json FROM annotation_revisions",
        "SELECT payload_json FROM jobs",
        "SELECT result_json FROM jobs",
        "SELECT context_json FROM model_runs",
    ] {
        assert_eq!(
            copy.query_row(query, [], |r| r.get::<_, String>(0))
                .unwrap(),
            BUSINESS_JSON
        );
    }
    let progress: String = copy
        .query_row("SELECT progress_json FROM jobs", [], |r| r.get(0))
        .unwrap();
    assert!(!progress.contains(SECRET));
    assert!(progress.contains("[REDACTED]"));
    let snapshot: String = copy
        .query_row("SELECT profile_snapshot_json FROM model_runs", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(!snapshot.contains(SECRET));
    assert_eq!(
        copy.query_row(
            "SELECT state,fencing_token,worker_id,lease_until FROM jobs",
            [],
            |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?
            ))
        )
        .unwrap(),
        ("interrupted".into(), 37, None, None)
    );
    assert_eq!(
        copy.query_row(
            "SELECT holder_id,fencing_token,expires_at,updated_at FROM task_leases",
            [],
            |r| Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?
            ))
        )
        .unwrap(),
        (None, 43, 0, 17)
    );
    assert_eq!(
        copy.query_row("SELECT state,actor_id,prompt FROM model_runs", [], |r| Ok(
            (
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?
            )
        ))
        .unwrap(),
        (
            "interrupted".into(),
            "old-user".into(),
            "original prompt".into()
        )
    );
    assert_eq!(db::schema_hash(&copy).unwrap(), schema);
    drop(copy);
    let target = f.root.path().join("restored");
    backup::restore(&f.backup_path(), &target, &f.sql).unwrap();
    assert!(target.join("restore.json").is_file());
    for entry in &manifest.files {
        assert_eq!(
            db::hash_file(&target.join(&entry.path)).unwrap(),
            entry.sha256
        );
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(!f.backup_path().join(format!("api.sqlite{suffix}")).exists());
    }
    assert_eq!(f.source_bytes(), before);
}

#[test]
fn immutable_raw_decoded_and_unknown_text_collisions_refuse_without_source_changes() {
    for (column, value) in [
        ("name", format!("business {SECRET}")),
        (
            "description",
            format!(
                "{{\"escaped\":\"{}\"}}",
                SECRET
                    .chars()
                    .map(|c| format!("\\u{:04x}", c as u32))
                    .collect::<String>()
            ),
        ),
        (
            "description",
            format!(
                "{{\"{}\":0}}",
                SECRET
                    .chars()
                    .map(|c| format!("\\u{:04x}", c as u32))
                    .collect::<String>()
            ),
        ),
    ] {
        let f = Fixture::new();
        f.database
            .execute(&format!("UPDATE projects SET {column}=?"), [&value])
            .unwrap();
        let before = f.source_bytes();
        let error = backup::create(&f.data, &f.backup_path()).err().unwrap();
        assert!(error
            .to_string()
            .contains("credential_in_immutable_business_data"));
        assert!(!f.backup_path().exists());
        assert_eq!(f.source_bytes(), before);
    }
}

#[test]
fn mutable_diagnostic_decoded_key_and_lifecycle_collision_are_refused_not_renamed_or_erased() {
    for (column, value) in [
        (
            "progress_json",
            format!(
                "{{\"{}\":\"diagnostic\"}}",
                SECRET
                    .chars()
                    .map(|c| format!("\\u{:04x}", c as u32))
                    .collect::<String>()
            ),
        ),
        ("worker_id", SECRET.into()),
    ] {
        let f = Fixture::new();
        f.database
            .execute(&format!("UPDATE jobs SET {column}=?"), [value])
            .unwrap();
        let before = f.source_bytes();
        assert!(backup::create(&f.data, &f.backup_path())
            .err()
            .unwrap()
            .to_string()
            .contains("credential_in_immutable_business_data"));
        assert!(!f.backup_path().exists());
        assert_eq!(f.source_bytes(), before);
    }
}

#[test]
fn recursive_secret_collection_keeps_nonprivate_scalars_and_redaction_order_matches_original() {
    let f = Fixture::new();
    // Only nested objects are traversed under an ordinary key; a string in an
    // array is not a private credential. Ordered replacements overlap on purpose.
    f.database.execute("UPDATE model_profiles SET config_json=?", [r#"{"secret_first":"overlap-long","secret_second":"overlap","ordinary":["Business description",{"access-token":"last-secret"}]}"#]).unwrap();
    f.database
        .execute(
            "UPDATE jobs SET progress_json=?",
            [r#" {"message":"overlap-long overlap last-secret","stable":"Business description"} "#],
        )
        .unwrap();
    backup::create(&f.data, &f.backup_path()).unwrap();
    let copy = db::read_only(&f.backup_path().join("api.sqlite")).unwrap();
    let text: String = copy
        .query_row("SELECT progress_json FROM jobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        json!({"message":"[REDACTED] [REDACTED] [REDACTED]","stable":"Business description"})
    );
}

#[test]
fn restore_rejects_sidecars_corrupt_objects_schema_and_existing_target_before_target_creation() {
    let f = Fixture::new();
    let manifest = backup::create(&f.data, &f.backup_path()).unwrap();
    let target = f.root.path().join("restored");
    for suffix in ["-wal", "-shm", "-journal"] {
        let file = f.backup_path().join(format!("api.sqlite{suffix}"));
        fs::write(&file, b"unmanifested").unwrap();
        assert!(backup::restore(&f.backup_path(), &target, &f.sql)
            .err()
            .unwrap()
            .to_string()
            .contains("backup_sqlite_sidecar"));
        assert!(!target.exists());
        fs::remove_file(file).unwrap();
    }
    let object = manifest
        .files
        .iter()
        .find(|e| e.path.starts_with("objects/"))
        .unwrap();
    let file = f.backup_path().join(&object.path);
    let bytes = fs::read(&file).unwrap();
    fs::write(&file, b"corrupt").unwrap();
    assert!(backup::restore(&f.backup_path(), &target, &f.sql).is_err());
    assert!(!target.exists());
    fs::write(file, bytes).unwrap();
    let mut wrong_sql = f.sql.clone();
    wrong_sql[0]
        .1
        .push_str("\nCREATE TABLE unshipped_table(x TEXT);\n");
    assert!(backup::restore(&f.backup_path(), &target, &wrong_sql).is_err());
    assert!(!target.exists());
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep"), b"untouched").unwrap();
    assert!(backup::restore(&f.backup_path(), &target, &f.sql).is_err());
    assert_eq!(fs::read(target.join("keep")).unwrap(), b"untouched");
    assert!(!target.join("restore.json").exists());
}

#[cfg(unix)]
#[test]
fn failed_copy_retains_new_target_without_completion_marker() {
    use std::os::unix::process::CommandExt;
    let f = Fixture::new();
    backup::create(&f.data, &f.backup_path()).unwrap();
    let target = f.root.path().join("failed-restored");
    let mut command = Command::new(env!("CARGO_BIN_EXE_weblabel"));
    command
        .arg("restore")
        .arg("--backup-dir")
        .arg(f.backup_path())
        .arg("--data-dir")
        .arg(&target)
        .arg("--migrations-dir")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"));
    unsafe {
        command.pre_exec(|| {
            libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
            let limit = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let output = command.output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("restore_failed_target_preserved"));
    assert!(target.is_dir());
    assert!(target.join("api.sqlite").is_file());
    assert!(!target.join("restore.json").exists());
    backup::validate(&f.backup_path(), &f.sql).unwrap();
}

#[test]
fn preflight_inspects_active_os_lock_not_stopped_sidecar_and_preserves_source_db_wal_and_lock() {
    let f = Fixture::new();
    let release = f.release();
    backup::create(&f.data, &f.backup_path()).unwrap();
    let path = f.data.join("api.sqlite.runtime.lock");
    fs::write(&path, b"persistent stopped Rust sidecar").unwrap();
    let bytes = fs::read(&path).unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    lock.lock().unwrap();
    let before = f.source_bytes();
    let blocked = preflight::run(&f.data, &release, &f.backup_path(), Some(f.root.path()));
    assert_eq!(blocked["status"], "unsupported");
    assert_eq!(blocked["code"], "STOP_SOURCE_BEFORE_PREFLIGHT");
    assert_eq!(f.source_bytes(), before);
    lock.unlock().unwrap();
    let result = preflight::run(&f.data, &release, &f.backup_path(), Some(f.root.path()));
    assert_eq!(result["status"], "compatible", "{result}");
    assert_eq!(result["rollback"], "not-verified");
    assert_eq!(f.source_bytes(), before);
    assert_eq!(fs::read(&path).unwrap(), bytes);
    fs::write(f.data.join("runtime.lock"), b"{\"pid\":1}").unwrap();
    let old = preflight::run(&f.data, &release, &f.backup_path(), Some(f.root.path()));
    assert_eq!(old["code"], "STOP_SOURCE_BEFORE_PREFLIGHT");
    assert_eq!(
        fs::read(f.data.join("runtime.lock")).unwrap(),
        b"{\"pid\":1}"
    );
    assert_eq!(f.source_bytes(), before);
}

#[test]
fn preflight_rejects_scratch_inside_source_backup_or_release() {
    let f = Fixture::new();
    let release = f.release();
    let backup = f.backup_path();
    backup::create(&f.data, &backup).unwrap();
    let before = f.source_bytes();
    for parent in [&f.data, &backup, &release] {
        let result = preflight::run(&f.data, &release, &backup, Some(parent));
        assert_eq!(result["status"], "unsupported", "{parent:?}: {result}");
        assert_eq!(result["code"], "SCRATCH_INSIDE_PROTECTED_ROOT");
        assert_eq!(f.source_bytes(), before);
    }
}

#[test]
fn preflight_applies_exact_shipped_prefix_on_scratch_and_rejects_unknown_schema_without_source_writes(
) {
    let f = Fixture::new();
    let release = f.release();
    let prefix = f.root.path().join("prefix");
    fs::create_dir(&prefix).unwrap();
    let source = Connection::open(prefix.join("api.sqlite")).unwrap();
    source.execute_batch(db::MIGRATION_TABLE).unwrap();
    let prefix_count = f.sql.len() - 2;
    for (name, sql) in f.sql.iter().take(prefix_count) {
        source.execute_batch(sql).unwrap();
        if name != "0001_core.sql" {
            source
                .execute(
                    "INSERT INTO schema_migrations(version) VALUES(?)",
                    [name.trim_end_matches(".sql")],
                )
                .unwrap();
        }
    }
    source.execute_batch("PRAGMA wal_autocheckpoint=0; INSERT INTO projects(project_id,name,description,created_at) VALUES('prefix-project','Synthetic prefix','byte-preserved','synthetic');").unwrap();
    let existing_backup = f.root.path().join("prefix-backup");
    backup::create(&prefix, &existing_backup).unwrap();
    let before: Vec<_> = ["api.sqlite", "api.sqlite-wal"]
        .map(|name| fs::read(prefix.join(name)).unwrap())
        .into_iter()
        .collect();
    let result = preflight::run(&prefix, &release, &existing_backup, Some(f.root.path()));
    assert_eq!(result["status"], "compatible", "{result}");
    assert_eq!(result["pending_migrations"].as_array().unwrap().len(), 2);
    assert_eq!(
        ["api.sqlite", "api.sqlite-wal"]
            .map(|name| fs::read(prefix.join(name)).unwrap())
            .to_vec(),
        before
    );
    source
        .execute_batch("CREATE TABLE unsupported_extra(value TEXT)")
        .unwrap();
    let before = db::hash_file(&prefix.join("api.sqlite-wal")).unwrap();
    let result = preflight::run(&prefix, &release, &existing_backup, Some(f.root.path()));
    assert_eq!(result["status"], "unsupported");
    assert_eq!(result["code"], "SOURCE_SCHEMA_UNSUPPORTED");
    assert_eq!(
        db::hash_file(&prefix.join("api.sqlite-wal")).unwrap(),
        before
    );
}

#[test]
fn preflight_requires_a_valid_backup_without_creating_scratch_or_changing_source() {
    let f = Fixture::new();
    let release = f.release();
    let before = f.source_bytes();
    let missing = f.root.path().join("missing-backup");
    let result = preflight::run(&f.data, &release, &missing, Some(f.root.path()));
    assert_eq!(result["status"], "unsupported");
    assert_eq!(result["code"], "BACKUP_INVALID");
    assert_eq!(f.source_bytes(), before);
    assert!(!missing.exists());
}

#[test]
fn javascript_json_encodings_remain_immutable_and_mutable_redaction_keeps_lone_surrogates() {
    let f = Fixture::new();
    let text = r#" {"unpaired":"\ud800","overflow":1e400,"large":9007199254740993} "#;
    f.database
        .execute("UPDATE projects SET description=?", [text])
        .unwrap();
    let diagnostic = format!(
        r#" {{"message":"{SECRET}","unpaired":"\ud800","integral":1.00,"overflow":1e400}} "#
    );
    f.database
        .execute("UPDATE jobs SET progress_json=?", [diagnostic])
        .unwrap();
    let before = f.source_bytes();
    backup::create(&f.data, &f.backup_path()).unwrap();
    let copy = db::read_only(&f.backup_path().join("api.sqlite")).unwrap();
    assert_eq!(
        copy.query_row("SELECT description FROM projects", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        text
    );
    assert_eq!(
        copy.query_row("SELECT progress_json FROM jobs", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        r#"{"message":"[REDACTED]","unpaired":"\ud800","integral":1,"overflow":null}"#
    );
    assert_eq!(f.source_bytes(), before);
}

#[test]
fn storage_diagnostics_deduplicate_export_objects_preserve_source_bytes_and_report_missing_objects()
{
    let fixture = Fixture::new();
    let root = fixture.root.path();
    let release = fixture.release();
    let data = root.join("diagnostic-data");
    fs::create_dir(&data).unwrap();
    let database = data.join("api.sqlite");
    let connection = Connection::open(&database).unwrap();
    connection.execute_batch("CREATE TABLE annotation_exports(object_sha256 TEXT); CREATE TABLE dataset_exports(object_sha256 TEXT);").unwrap();
    let payload = root.join("payload");
    fs::write(&payload, b"actual-export-bytes").unwrap();
    let hash = db::hash_file(&payload).unwrap();
    let object = data.join(db::object_name(&hash));
    fs::create_dir_all(object.parent().unwrap()).unwrap();
    fs::copy(&payload, &object).unwrap();
    for query in [
        "INSERT INTO annotation_exports VALUES(?)",
        "INSERT INTO dataset_exports VALUES(?)",
    ] {
        connection.execute(query, [&hash]).unwrap();
    }
    connection.close().unwrap();
    let before = db::hash_file(&database).unwrap();
    let diagnose = || {
        let output = product()
            .args(["doctor", "--mode", "runtime", "--build-dir"])
            .arg(&release)
            .arg("--data-dir")
            .arg(&data)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut diagnostic: Value = serde_json::from_slice(&output.stdout).unwrap();
        diagnostic["storage"].take()
    };
    let measured = diagnose();
    assert_eq!(measured["exports"]["bytes"], 19);
    assert_eq!(measured["exports"]["objects"], 1);
    assert_eq!(db::hash_file(&database).unwrap(), before);
    fs::remove_file(object).unwrap();
    let missing = diagnose();
    assert_eq!(missing["exports"]["status"], "unknown");
    assert_eq!(missing["exports"]["bytes"], Value::Null);
    assert_eq!(db::hash_file(&database).unwrap(), before);
}

#[test]
fn runtime_doctor_is_tool_free_readonly_and_support_receipt_does_not_disclose_private_paths() {
    let fixture = Fixture::new();
    let release = fixture.release();
    let data = &fixture.data;
    let before = fixture.source_bytes();
    let lock = data.join("runtime.lock");
    let bytes = format!("{{\"pid\":{}}}", std::process::id());
    fs::write(&lock, &bytes).unwrap();
    let receipt = fixture.root.path().join("support.json");
    let output = product()
        .args(["doctor", "--mode", "runtime", "--build-dir"])
        .arg(release)
        .arg("--data-dir")
        .arg(data)
        .arg("--support-receipt")
        .arg(&receipt)
        .env("OPENAI_API_KEY", SECRET)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let diagnostic: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(diagnostic["tools"], json!([]));
    assert_eq!(
        diagnostic["storage"]["lock"]["status"],
        "pid_alive_identity_unknown"
    );
    assert_eq!(fs::read_to_string(&lock).unwrap(), bytes);
    assert_eq!(fixture.source_bytes(), before);
    let support = fs::read_to_string(&receipt).unwrap();
    assert!(!support.contains(SECRET));
    assert!(!support.contains(data.to_string_lossy().as_ref()));
    assert!(!support.contains("source_env"));
}
