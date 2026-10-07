//! T17: persistent model runs, immutable predictions, monotonic event streams,
//! idempotent create/cancel and restart recovery with interrupted + cost unknown.

use std::{
    collections::BTreeMap, future::Future, net::SocketAddr, path::PathBuf, pin::Pin, time::Duration,
};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use image::{DynamicImage, ImageFormat, RgbImage};
use serde_json::{json, Value};
use sqlx::Row;
use tempfile::tempdir;
use tower::ServiceExt;
use weblabel_api::{
    ai::runs::{self, RunState},
    auth::{hash_launch_code, AuthConfig},
    config::ServerConfig,
    jobs::{
        model_jobs::{
            self, MockRunner, MockStep, ProviderEvent, RunOutcome, RunRunner, SubmitCandidates,
        },
        queue::JobQueue,
    },
    media::ingest::{import_one, ImportInput},
    router, AppState,
};

const HOST: &str = "127.0.0.1:48100";
const ORIGIN: &str = "http://127.0.0.1:48100";
const BOOTSTRAP_PASSWORD: &str = "t17-test-bootstrap-password";
const MOCK_PROFILE: &str = "profile_mock_local";

struct AssetRef {
    asset_revision_id: String,
    annotation_revision_id: String,
    canonical_sha256: String,
}

struct Fixture {
    app: Router,
    repository: weblabel_api::storage::Repository,
    state: AppState,
    directory: tempfile::TempDir,
    directory_path: PathBuf,
    cookie: String,
    csrf: String,
    user_id: String,
    project_id: String,
    ontology_id: String,
    assets: Vec<AssetRef>,
    authorizations: std::sync::Mutex<BTreeMap<String, Value>>,
}

impl Fixture {
    async fn request(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        send(
            &self.app,
            method,
            path,
            body,
            Some(&self.cookie),
            Some(&self.csrf),
        )
        .await
    }

    fn asset(&self) -> &AssetRef {
        &self.assets[0]
    }

    fn start_run_body(&self, operation_id: &str, prompt: &str, asset: &AssetRef) -> Value {
        json!({
            "operation_id": operation_id,
            "profile_id": MOCK_PROFILE,
            "context": {
                "project_id": self.project_id,
                "asset_revision_id": asset.asset_revision_id,
                "annotation_revision_id": asset.annotation_revision_id,
                "ontology_version_id": self.ontology_id,
                "draft_generation": 0,
                "canonical_sha256": asset.canonical_sha256,
                "selected_object_ids": [],
                "object_hashes": {},
                "input_fingerprint": "t17-input-fingerprint-0001"
            },
            "intent": "find_issues",
            "prompt": prompt,
            "consent_id": null
        })
    }

    async fn create_run(&self, operation_id: &str, prompt: &str) -> (StatusCode, Value) {
        let body = self
            .authorize(self.start_run_body(operation_id, prompt, self.asset()))
            .await;
        self.request("POST", "/api/ai/runs", Some(body)).await
    }

    async fn authorize(&self, body: Value) -> Value {
        let key = body.to_string();
        if let Some(fixed) = self.authorizations.lock().unwrap().get(&key).cloned() {
            return fixed;
        }
        let (status,preview)=self.request("POST","/api/ai/previews",Some(json!({"request":body,"grants":{"allow_image":true,"allow_object_context":true,"preview_crop":null}}))).await;
        assert_eq!(status, StatusCode::CREATED, "{preview}");
        let (status, consent) = self
            .request(
                "POST",
                "/api/ai/consents",
                Some(json!({"preview_id":preview["preview_id"]})),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{consent}");
        let mut body = preview["request"].clone();
        body["consent_id"] = consent["consent_id"].clone();
        self.authorizations
            .lock()
            .unwrap()
            .insert(key, body.clone());
        body
    }

    async fn db_scalar(&self, sql: &str, binds: &[&str]) -> i64 {
        let mut tx = self.repository.begin_write().await.unwrap();
        let mut query = sqlx::query(sql);
        for bind in binds {
            query = query.bind(*bind);
        }
        let row = query.fetch_one(tx.connection()).await.unwrap();
        let count: i64 = row.try_get(0).unwrap();
        tx.commit().await.unwrap();
        count
    }

    async fn db_text(&self, sql: &str, binds: &[&str]) -> Option<String> {
        let mut tx = self.repository.begin_write().await.unwrap();
        let mut query = sqlx::query(sql);
        for bind in binds {
            query = query.bind(*bind);
        }
        let row = query.fetch_optional(tx.connection()).await.unwrap();
        let value = row
            .map(|row| {
                row.try_get::<Option<String>, _>(0)
                    .unwrap()
                    .unwrap_or_default()
            })
            .filter(|value| !value.is_empty());
        tx.commit().await.unwrap();
        value
    }
}

async fn send(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    cookie: Option<&str>,
    csrf: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("host", HOST)
        .header("origin", ORIGIN)
        .header("content-type", "application/json");
    if let Some(cookie) = cookie {
        builder = builder.header("cookie", cookie);
    }
    if let Some(csrf) = csrf {
        builder = builder.header("x-csrf-token", csrf);
    }
    let body = body.map(|value| value.to_string()).unwrap_or_default();
    let request = builder.body(Body::from(body)).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, value)
}

fn server_config(directory: &std::path::Path, production: bool) -> ServerConfig {
    ServerConfig {
        bind: HOST.parse::<SocketAddr>().unwrap(),
        database_url: format!("sqlite:{}", directory.join("api.sqlite").display()),
        object_root: directory.join("objects"),
        write_timeout: Duration::from_secs(2),
        production,
    }
}

fn auth_config() -> AuthConfig {
    AuthConfig {
        bind: HOST.parse::<SocketAddr>().unwrap(),
        cookie_secure: false,
        allowed_origins: vec![ORIGIN.to_owned()],
        allowed_hosts: vec![HOST.to_owned()],
        launch_code: hash_launch_code("t17-one-time-launch-code"),
        launch_code_expires_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 3600,
    }
}

async fn bootstrap_cookie(app: &Router) -> (String, String, String) {
    let bootstrap_request = Request::builder()
        .method("POST")
        .uri("/api/session/bootstrap")
        .header("host", HOST)
        .header("origin", ORIGIN)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "launch_code": "t17-one-time-launch-code",
                "password": BOOTSTRAP_PASSWORD
            })
            .to_string(),
        ))
        .unwrap();
    let bootstrap = app.clone().oneshot(bootstrap_request).await.unwrap();
    assert_eq!(bootstrap.status(), StatusCode::OK);
    let cookie = bootstrap
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let boot_bytes = to_bytes(bootstrap.into_body(), 4096).await.unwrap();
    let boot: Value = serde_json::from_slice(&boot_bytes).unwrap();
    let csrf = boot["csrf_token"].as_str().unwrap().to_owned();
    let user_id = boot["user_id"].as_str().unwrap().to_owned();
    (cookie, csrf, user_id)
}

async fn login(app: &Router, username: &str, password: &str) -> (String, String) {
    let request = Request::builder()
        .method("POST")
        .uri("/api/session/login")
        .header("host", HOST)
        .header("origin", ORIGIN)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"username": username, "password": password}).to_string(),
        ))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    (cookie, body["csrf_token"].as_str().unwrap().to_owned())
}

fn progress_event(id: &str, seq: i64, message: &str) -> ProviderEvent {
    ProviderEvent {
        provider_event_id: id.to_owned(),
        provider_seq: Some(seq),
        event_type: weblabel_api::ai::events::RunEventType::Progress,
        message: message.to_owned(),
        data: None,
    }
}

fn candidate(id: &str, seq: i64, raw: Value) -> SubmitCandidates {
    SubmitCandidates {
        provider_event_id: id.to_owned(),
        provider_seq: Some(seq),
        raw,
    }
}

fn issue_candidate(id: &str, seq: i64, issue_id: &str, message: &str) -> SubmitCandidates {
    candidate(
        id,
        seq,
        json!({
            "changes": [],
            "issues": [{
                "issue_id": issue_id,
                "object_id": null,
                "code": "mock_review",
                "message": message,
                "region": null
            }],
            "score": null
        }),
    )
}

async fn fixture() -> Fixture {
    fixture_with_assets(1).await
}

async fn fixture_with_assets(asset_count: usize) -> Fixture {
    let directory = tempdir().unwrap();
    let directory_path = directory.path().to_path_buf();
    let config = server_config(directory.path(), false);
    let state = AppState::open_with_auth(&config, auth_config())
        .await
        .unwrap();
    let app = router(state.clone());
    let (cookie, csrf, user_id) = bootstrap_cookie(&app).await;
    let profile = runs::mock_profile();
    let mut tx = state.repository.begin_write().await.unwrap();
    sqlx::query("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES(?,'mock',?,'none',?,'ready','mock_only',?,NULL,'{}',NULL,'2026-10-06T00:00:00Z')")
        .bind(&*profile.profile_id).bind(&profile.model_id).bind(serde_json::to_string(&profile.capabilities).unwrap()).bind(&profile.runtime_version).execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();

    let (status, project) = send(
        &app,
        "POST",
        "/api/projects",
        Some(json!({
            "name": "T17 model jobs fixture",
            "description": "isolated integration fixture",
            "allow_self_review": false
        })),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{project}");
    let project_id = project["project_id"].as_str().unwrap().to_owned();
    let mut tx = state.repository.begin_write().await.unwrap();
    sqlx::query("UPDATE projects SET allow_external_processing=1 WHERE project_id=?")
        .bind(&project_id)
        .execute(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (status, ontology) = send(
        &app,
        "POST",
        &format!("/api/projects/{project_id}/ontologies"),
        Some(json!({
            "labels": [{
                "label_id": "label_person",
                "name": "Person",
                "color": "#0099ff",
                "shortcut": null,
                "allowed_geometry_types": ["bbox_xyxy"],
                "attributes": [{
                    "key": "helmet_state",
                    "kind": "enum",
                    "required": false,
                    "default_value": "unknown",
                    "enum_values": ["wearing", "not_wearing", "unknown"],
                    "min": null,
                    "max": null
                }]
            }],
            "guidelines_markdown": "Label visible persons."
        })),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{ontology}");
    let ontology_id = ontology["ontology_version_id"].as_str().unwrap().to_owned();

    let mut assets = Vec::with_capacity(asset_count);
    for index in 0..asset_count {
        let mut png = std::io::Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(RgbImage::new(32, 24))
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        let imported = import_one(
            &state.repository,
            &weblabel_api::jobs::worker::MediaWorker::new(),
            ImportInput {
                project_id: project_id.clone(),
                ontology_version_id: ontology_id.clone(),
                actor_id: user_id.clone(),
                source_group_id: format!("t17-fixture-source-{index}"),
                original_name: format!("fixture-{index}.png"),
                declared_mime: Some("image/png".to_owned()),
                bytes: png.into_inner(),
            },
        )
        .await
        .unwrap();
        assets.push(AssetRef {
            asset_revision_id: imported.asset_revision_id,
            annotation_revision_id: imported.annotation_revision_id,
            canonical_sha256: imported.canonical_sha256,
        });
    }

    Fixture {
        app,
        repository: state.repository.clone(),
        state,
        directory,
        directory_path,
        cookie,
        csrf,
        user_id,
        project_id,
        ontology_id,
        assets,
        authorizations: std::sync::Mutex::new(BTreeMap::new()),
    }
}

fn scripted_runner(scripts: BTreeMap<String, Vec<MockStep>>) -> MockRunner {
    MockRunner::with_scripts(scripts)
}

#[test]
fn terminal_run_cannot_restart_from_late_event() {
    use weblabel_api::ai::runs::transition;
    assert!(transition(RunState::Cancelled, RunState::Running).is_err());
    assert!(transition(RunState::Succeeded, RunState::Running).is_err());
    assert!(transition(RunState::Running, RunState::Succeeded).is_ok());
    assert!(transition(RunState::Failed, RunState::Running).is_err());
    assert!(transition(RunState::Interrupted, RunState::Running).is_err());
    assert!(transition(RunState::Queued, RunState::Running).is_ok());
    assert!(transition(RunState::Running, RunState::Cancelled).is_ok());
    assert!(transition(RunState::Running, RunState::Interrupted).is_ok());
    assert!(transition(RunState::Queued, RunState::Cancelled).is_ok());
    assert!(transition(RunState::Cancelled, RunState::Succeeded).is_err());
    assert!(transition(RunState::Succeeded, RunState::Succeeded).is_err());
    assert!(transition(RunState::Queued, RunState::Succeeded).is_err());
}

#[tokio::test]
async fn start_run_replay_is_idempotent_and_conflicts_on_payload_reuse() {
    let fixture = fixture().await;
    let (status, created) = fixture
        .create_run("t17-op-idempotent", "check the helmet attribute")
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let run_id = created["run_id"].as_str().unwrap();
    let job_id = created["job_id"].as_str().unwrap();
    assert_eq!(created["idempotent_replay"], false);
    assert_eq!(created["state"], "queued");
    assert_eq!(created["source"], "mock");

    let (status, replay) = fixture
        .create_run("t17-op-idempotent", "check the helmet attribute")
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{replay}");
    assert_eq!(replay["run_id"].as_str().unwrap(), run_id);
    assert_eq!(replay["job_id"].as_str().unwrap(), job_id);
    assert_eq!(replay["idempotent_replay"], true);

    let (status, conflict) = fixture
        .create_run("t17-op-idempotent", "a different prompt entirely")
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
    assert_eq!(conflict["code"], "IDEMPOTENCY_KEY_REUSE");

    // One billing run and one job: the replay did not create a second run.
    assert_eq!(
        fixture
            .db_scalar(
                "SELECT COUNT(*) FROM model_runs WHERE operation_id=?",
                &["t17-op-idempotent"],
            )
            .await,
        1
    );
    assert_eq!(
        fixture
            .db_scalar(
                "SELECT COUNT(*) FROM jobs WHERE kind='model_run' AND job_id=?",
                &[job_id],
            )
            .await,
        1
    );
    assert_eq!(
        fixture
            .db_scalar(
                "SELECT COUNT(*) FROM run_events WHERE run_id=? AND event_type='queued'",
                &[run_id],
            )
            .await,
        1
    );
}

#[tokio::test]
async fn start_run_pins_profile_snapshot_and_input_hash() {
    let fixture = fixture().await;
    // Arrange: a mutable profile row that the run must pin at creation time.
    let mut tx = fixture.repository.begin_write().await.unwrap();
    sqlx::query(
        "INSERT INTO model_profiles(profile_id, provider_id, model_id, auth_kind, capabilities_json, \
         availability, verification, runtime_version, verified_at, config_json, secret_ref, created_at) \
         VALUES ('profile-det-1','detector_local','detector-demo-v1','local_weights', \
         '{\"image_input\":true,\"tools\":false,\"structured_output\":true,\"bbox_output\":true,\"attributes\":true}', \
         'ready','not_run',NULL,NULL,'{\"weights\":\"sha256-demo\"}',NULL,'2026-01-01T00:00:00.000Z')",
    )
    .execute(tx.connection())
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let asset = fixture.asset();
    let body = json!({
        "operation_id": "t17-op-pinned",
        "profile_id": "profile-det-1",
        "context": {
            "project_id": fixture.project_id,
            "asset_revision_id": asset.asset_revision_id,
            "annotation_revision_id": asset.annotation_revision_id,
            "ontology_version_id": fixture.ontology_id,
            "draft_generation": 3,
            "canonical_sha256": asset.canonical_sha256,
            "selected_object_ids": [],
            "object_hashes": {},
            "input_fingerprint": "t17-fingerprint-pinned"
        },
        "intent": "detect",
        "prompt": "detect persons",
        "consent_id": null
    });
    let body = fixture.authorize(body).await;
    let fixed_fingerprint = body["context"]["input_fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, created) = fixture.request("POST", "/api/ai/runs", Some(body)).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    assert_eq!(created["source"], "provider");
    assert_eq!(created["provider_id"], "detector_local");
    let run_id = created["run_id"].as_str().unwrap();

    // Mutate the profile after the run was created; the run must keep its snapshot.
    let mut tx = fixture.repository.begin_write().await.unwrap();
    sqlx::query(
        "UPDATE model_profiles SET model_id='detector-demo-v2' WHERE profile_id='profile-det-1'",
    )
    .execute(tx.connection())
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let snapshot = fixture
        .db_text(
            "SELECT profile_snapshot_json FROM model_runs WHERE run_id=?",
            &[run_id],
        )
        .await
        .unwrap();
    let snapshot: Value = serde_json::from_str(&snapshot).unwrap();
    assert_eq!(snapshot["model_id"], "detector-demo-v1");
    let fingerprint = fixture
        .db_text(
            "SELECT input_fingerprint FROM model_runs WHERE run_id=?",
            &[run_id],
        )
        .await
        .unwrap();
    assert_eq!(fingerprint, fixed_fingerprint);
    let request_hash = fixture
        .db_text(
            "SELECT request_hash FROM model_runs WHERE run_id=?",
            &[run_id],
        )
        .await
        .unwrap();
    assert_eq!(request_hash.len(), 64);
    let context_json = fixture
        .db_text(
            "SELECT context_json FROM model_runs WHERE run_id=?",
            &[run_id],
        )
        .await
        .unwrap();
    let context: Value = serde_json::from_str(&context_json).unwrap();
    assert_eq!(context["draft_generation"], 3);
    assert_eq!(context["canonical_sha256"], asset.canonical_sha256);

    // A tampered media hash must be rejected before any run is created.
    let mut tampered = fixture.start_run_body("t17-op-tampered", "detect persons", asset);
    tampered["context"]["canonical_sha256"] = json!("0".repeat(64));
    let (status, rejected) = fixture
        .request("POST", "/api/ai/runs", Some(tampered))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{rejected}");
    assert_eq!(rejected["code"], "INPUT_HASH_MISMATCH");
    assert_eq!(
        fixture
            .db_scalar(
                "SELECT COUNT(*) FROM model_runs WHERE operation_id=?",
                &["t17-op-tampered"]
            )
            .await,
        0
    );
}

#[tokio::test]
async fn provider_events_normalize_to_monotonic_seq_and_page_by_after() {
    let fixture = fixture().await;
    let (status, created) = fixture
        .create_run("t17-op-events", "normalize events")
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let run_id = created["run_id"].as_str().unwrap().to_owned();

    // Provider events arrive out of order and with duplicates.
    let mut scripts = BTreeMap::new();
    scripts.insert(
        run_id.clone(),
        vec![
            MockStep::Emit(progress_event("pev-3", 3, "provider progress 3")),
            MockStep::Emit(progress_event("pev-1", 1, "provider progress 1")),
            MockStep::Emit(progress_event("pev-3", 3, "duplicate of provider event 3")),
            MockStep::Candidate(issue_candidate(
                "pev-4",
                4,
                "issue-1",
                "synthetic mock observation",
            )),
            MockStep::Complete,
        ],
    );
    let queue = JobQueue::new(fixture.repository.clone());
    let processed = model_jobs::process_next(
        &fixture.repository,
        &queue,
        "t17-worker",
        Duration::from_secs(30),
        &scripted_runner(scripts),
    )
    .await
    .unwrap();
    assert_eq!(
        processed,
        Some(created["job_id"].as_str().unwrap().to_owned())
    );

    // Server-assigned sequence numbers are strictly monotonic; duplicates collapse.
    let mut tx = fixture.repository.begin_write().await.unwrap();
    let rows = sqlx::query("SELECT seq, message FROM run_events WHERE run_id=? ORDER BY seq")
        .bind(&run_id)
        .fetch_all(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let seqs: Vec<i64> = rows
        .iter()
        .map(|row| row.try_get::<i64, _>("seq").unwrap())
        .collect();
    assert_eq!(
        seqs,
        vec![1, 2, 3, 4, 5, 6],
        "server-assigned event sequence numbers"
    );
    for window in seqs.windows(2) {
        assert!(window[0] < window[1]);
    }
    assert!(
        !rows
            .iter()
            .any(|row| row.try_get::<String, _>("message").unwrap()
                == "duplicate of provider event 3"),
        "duplicate provider event must be dropped"
    );

    // Polling pages by after=seq and never re-submits the run.
    let (status, page) = fixture
        .request(
            "GET",
            &format!("/api/ai/runs/{run_id}/events?after=0&limit=3"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(items[0]["seq"], 1);
    assert_eq!(items[0]["type"], "queued");
    assert_eq!(page["next_cursor"], "3");
    assert_eq!(page["run"]["run_id"], run_id);

    let (status, rest) = fixture
        .request(
            "GET",
            &format!("/api/ai/runs/{run_id}/events?after=3"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{rest}");
    let rest_items = rest["items"].as_array().unwrap();
    assert_eq!(rest_items.len(), 3);
    assert_eq!(rest_items[0]["seq"], 4);
    assert_eq!(rest["next_cursor"], Value::Null);
    let events_before = fixture
        .db_scalar(
            "SELECT COUNT(*) FROM run_events WHERE run_id=?",
            &[run_id.as_str()],
        )
        .await;
    let (status, empty) = fixture
        .request(
            "GET",
            &format!("/api/ai/runs/{run_id}/events?after=7"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{empty}");
    assert!(empty["items"].as_array().unwrap().is_empty());
    assert_eq!(
        fixture
            .db_scalar(
                "SELECT COUNT(*) FROM run_events WHERE run_id=?",
                &[run_id.as_str()]
            )
            .await,
        events_before
    );

    let (status, bad) = fixture
        .request(
            "GET",
            &format!("/api/ai/runs/{run_id}/events?after=-1"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
    let (status, bad) = fixture
        .request(
            "GET",
            &format!("/api/ai/runs/{run_id}/events?limit=0"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");

    // The suggestion set is persisted once and stays readable and pending.
    let (status, suggestions) = fixture
        .request("GET", &format!("/api/ai/runs/{run_id}/suggestions"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{suggestions}");
    let sets = suggestions["items"].as_array().unwrap();
    assert_eq!(sets.len(), 1);
    assert_eq!(sets[0]["state"], "pending");
    assert_eq!(sets[0]["issues"][0]["code"], "mock_review");
}

#[tokio::test]
async fn cancel_is_idempotent_and_quarantines_late_candidates() {
    struct CancelMidRun {
        repository: weblabel_api::storage::Repository,
        run_tokens: weblabel_api::runtime::run_tokens::RunTokenStore,
        actor_id: String,
    }
    impl RunRunner for CancelMidRun {
        fn execute<'a>(
            &'a self,
            driver: &'a model_jobs::RunDriver,
        ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, model_jobs::RunnerError>> + Send + 'a>>
        {
            Box::pin(async move {
                driver
                    .submit_candidates(issue_candidate(
                        "cand-before-cancel",
                        1,
                        "issue-before",
                        "candidate delivered before cancel",
                    ))
                    .await
                    .map_err(model_jobs::RunnerError::from)?;
                // The user cancels while the provider is still streaming.
                runs::cancel(
                    &self.repository,
                    &self.run_tokens,
                    driver.run_id(),
                    &self.actor_id,
                    "user cancelled",
                )
                .await
                .map_err(|failure| {
                    model_jobs::RunnerError::new("CANCEL_FAILED", &failure.message)
                })?;
                // Late output arrives after the run is already terminal.
                driver
                    .submit_candidates(issue_candidate(
                        "cand-after-cancel",
                        2,
                        "issue-after",
                        "candidate delivered after cancel",
                    ))
                    .await
                    .map_err(model_jobs::RunnerError::from)?;
                Ok(RunOutcome::Completed)
            })
        }
    }

    let fixture = fixture().await;
    let (status, created) = fixture
        .create_run("t17-op-cancel", "cancel while streaming")
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let run_id = created["run_id"].as_str().unwrap().to_owned();
    let job_id = created["job_id"].as_str().unwrap().to_owned();

    let head_before = fixture
        .db_text(
            "SELECT content_hash FROM annotation_revisions WHERE annotation_revision_id=?",
            &[fixture.asset().annotation_revision_id.as_str()],
        )
        .await
        .unwrap();

    let queue = JobQueue::new(fixture.repository.clone());
    let runner = CancelMidRun {
        repository: fixture.repository.clone(),
        run_tokens: fixture.state.run_tokens.clone(),
        actor_id: fixture.user_id.clone(),
    };
    let processed = model_jobs::process_next(
        &fixture.repository,
        &queue,
        "t17-worker",
        Duration::from_secs(30),
        &runner,
    )
    .await
    .unwrap();
    assert_eq!(processed, Some(job_id.clone()));

    // The run stays cancelled even though the provider later reported completion.
    let (status, summary) = fixture
        .request(
            "GET",
            &format!("/api/ai/runs/{run_id}/events?after=0"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(summary["run"]["state"], "cancelled");
    assert_eq!(summary["run"]["cancel_requested"], true);

    // Exactly one cancelled event; the late completion never moved the state.
    let cancelled_events = fixture
        .db_scalar(
            "SELECT COUNT(*) FROM run_events WHERE run_id=? AND event_type='cancelled'",
            &[run_id.as_str()],
        )
        .await;
    assert_eq!(cancelled_events, 1);
    let succeeded_events = fixture
        .db_scalar(
            "SELECT COUNT(*) FROM run_events WHERE run_id=? AND event_type='succeeded'",
            &[run_id.as_str()],
        )
        .await;
    assert_eq!(succeeded_events, 0);

    // The pre-cancel candidate is stored as an appliable suggestion; the late one
    // is quarantined into the isolated audit store and never applied.
    let (status, suggestions) = fixture
        .request("GET", &format!("/api/ai/runs/{run_id}/suggestions"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{suggestions}");
    let sets = suggestions["items"].as_array().unwrap();
    assert_eq!(sets.len(), 1);
    assert_eq!(sets[0]["issues"][0]["issue_id"], "issue-before");
    assert_eq!(sets[0]["state"], "pending");
    assert_eq!(
        fixture
            .db_scalar(
                "SELECT COUNT(*) FROM predictions WHERE run_id=?",
                &[run_id.as_str()]
            )
            .await,
        1
    );
    let quarantined = fixture
        .db_scalar(
            "SELECT COUNT(*) FROM prediction_audit WHERE run_id=? AND raw_output_json LIKE '%issue-after%'",
            &[run_id.as_str()],
        )
        .await;
    assert_eq!(quarantined, 1);
    assert_eq!(
        fixture
            .db_scalar(
                "SELECT COUNT(*) FROM predictions WHERE run_id=? AND raw_output_json LIKE '%issue-after%'",
                &[run_id.as_str()],
            )
            .await,
        0
    );

    // Nothing was applied to the annotation and no follow-up work was queued.
    let head_after = fixture
        .db_text(
            "SELECT content_hash FROM annotation_revisions WHERE annotation_revision_id=?",
            &[fixture.asset().annotation_revision_id.as_str()],
        )
        .await
        .unwrap();
    assert_eq!(head_before, head_after);
    assert_eq!(
        fixture
            .db_scalar("SELECT COUNT(*) FROM jobs WHERE kind='model_run'", &[])
            .await,
        1
    );

    // Cancel is idempotent over HTTP: the same summary, no second cancelled event.
    let (status, first_cancel) = fixture
        .request(
            "POST",
            &format!("/api/ai/runs/{run_id}/cancel"),
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{first_cancel}");
    let (status, second_cancel) = fixture
        .request(
            "POST",
            &format!("/api/ai/runs/{run_id}/cancel"),
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{second_cancel}");
    assert_eq!(first_cancel, second_cancel);
    assert_eq!(
        fixture
            .db_scalar(
                "SELECT COUNT(*) FROM run_events WHERE run_id=? AND event_type='cancelled'",
                &[run_id.as_str()],
            )
            .await,
        1
    );
}

#[tokio::test]
async fn restart_recovery_marks_running_runs_interrupted_and_never_resends() {
    struct ParkRunner {
        started: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    }
    impl RunRunner for ParkRunner {
        fn execute<'a>(
            &'a self,
            _driver: &'a model_jobs::RunDriver,
        ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, model_jobs::RunnerError>> + Send + 'a>>
        {
            Box::pin(async move {
                if let Some(sender) = self.started.lock().unwrap().take() {
                    let _ = sender.send(());
                }
                // Simulate a provider call that never returns before the crash.
                std::future::pending::<()>().await;
                unreachable!()
            })
        }
    }
    #[derive(Default)]
    struct CountingRunner {
        calls: std::sync::atomic::AtomicUsize,
    }
    impl RunRunner for CountingRunner {
        fn execute<'a>(
            &'a self,
            _driver: &'a model_jobs::RunDriver,
        ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, model_jobs::RunnerError>> + Send + 'a>>
        {
            Box::pin(async move {
                self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(RunOutcome::Completed)
            })
        }
    }

    let fixture = fixture().await;
    let (status, running_run) = fixture
        .create_run("t17-op-crash", "runs into a crash")
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{running_run}");
    let running_id = running_run["run_id"].as_str().unwrap().to_owned();
    let running_job = running_run["job_id"].as_str().unwrap().to_owned();

    // A second run stays queued and must survive the restart untouched.
    let (status, queued_run) = fixture
        .create_run("t17-op-survivor", "still queued at restart")
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{queued_run}");
    let queued_id = queued_run["run_id"].as_str().unwrap().to_owned();

    // Crash mid-run: the worker dies while the provider call is in flight.
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let queue = JobQueue::new(fixture.repository.clone());
    let task = tokio::spawn({
        let repository = fixture.repository.clone();
        let queue = queue.clone();
        async move {
            model_jobs::process_next(
                &repository,
                &queue,
                "t17-crash-worker",
                Duration::from_secs(30),
                &ParkRunner {
                    started: std::sync::Mutex::new(Some(started_tx)),
                },
            )
            .await
        }
    });
    started_rx.await.unwrap();
    task.abort();
    let _ = task.await;

    let state_before = fixture
        .db_text(
            "SELECT state FROM model_runs WHERE run_id=?",
            &[running_id.as_str()],
        )
        .await
        .unwrap();
    assert_eq!(state_before, "running");

    // Restart: drop every handle and open the same database again.
    drop(queue);
    let Fixture {
        app,
        repository,
        state,
        directory,
        directory_path,
        cookie: _,
        csrf: _,
        user_id: _,
        project_id: _,
        ontology_id: _,
        assets: _,
        authorizations: _,
    } = fixture;
    drop(app);
    drop(repository);
    drop(state);
    let config = server_config(&directory_path, false);
    let state = AppState::open_with_auth(&config, auth_config())
        .await
        .unwrap();
    let app = router(state.clone());
    let (cookie, csrf) = login(&app, "local-admin", BOOTSTRAP_PASSWORD).await;

    // Recovery marked the in-flight run interrupted with unknown cost.
    let (status, events) = send(
        &app,
        "GET",
        &format!("/api/ai/runs/{running_id}/events?after=0"),
        None,
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{events}");
    assert_eq!(events["run"]["state"], "interrupted");
    assert_eq!(events["run"]["cost_display"], "unknown");
    let items = events["items"].as_array().unwrap();
    let last = items.last().unwrap();
    assert_eq!(last["type"], "failed");
    assert_eq!(last["data"]["interrupted"], true);
    assert_eq!(last["data"]["cost_display"], "unknown");

    let mut tx = state.repository.begin_write().await.unwrap();
    let row = sqlx::query("SELECT state, cost_display, usage_json FROM model_runs WHERE run_id=?")
        .bind(&running_id)
        .fetch_one(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(row.try_get::<String, _>("state").unwrap(), "interrupted");
    assert_eq!(row.try_get::<String, _>("cost_display").unwrap(), "unknown");
    // Unknown cost is never displayed as zero.
    assert!(row
        .try_get::<Option<String>, _>("usage_json")
        .unwrap()
        .is_none());

    let job_status = send(
        &app,
        "GET",
        &format!("/api/jobs/{running_job}"),
        None,
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(job_status.0, StatusCode::OK, "{}", job_status.1);
    assert_eq!(job_status.1["state"], "interrupted");

    // The queued run survived and still executes; the interrupted one is never resent.
    let queue = JobQueue::new(state.repository.clone());
    let counter = CountingRunner::default();
    let processed = model_jobs::process_next(
        &state.repository,
        &queue,
        "t17-post-restart-worker",
        Duration::from_secs(30),
        &counter,
    )
    .await
    .unwrap();
    assert_eq!(
        processed,
        Some(queued_run["job_id"].as_str().unwrap().to_owned())
    );
    assert_eq!(
        counter.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "exactly the surviving queued run executes once"
    );
    let mut tx = state.repository.begin_write().await.unwrap();
    let rows = sqlx::query("SELECT run_id, state FROM model_runs ORDER BY run_id")
        .fetch_all(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut states = BTreeMap::new();
    for row in &rows {
        states.insert(
            row.try_get::<String, _>("run_id").unwrap(),
            row.try_get::<String, _>("state").unwrap(),
        );
    }
    assert_eq!(states[&running_id], "interrupted");
    assert_eq!(states[&queued_id], "succeeded");
    drop(directory);
}

#[tokio::test]
async fn single_asset_failure_keeps_successful_batch_items() {
    struct FailOneRunner {
        fail_run_id: String,
    }
    impl RunRunner for FailOneRunner {
        fn execute<'a>(
            &'a self,
            driver: &'a model_jobs::RunDriver,
        ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, model_jobs::RunnerError>> + Send + 'a>>
        {
            Box::pin(async move {
                if driver.run_id() == self.fail_run_id {
                    return Ok(RunOutcome::Failed {
                        code: "PROVIDER_ASSET_ERROR".to_owned(),
                        message: "the provider failed on this single image".to_owned(),
                    });
                }
                driver
                    .submit_candidates(issue_candidate(
                        &format!("cand-{}", driver.run_id()),
                        1,
                        &format!("issue-{}", driver.run_id()),
                        "synthetic mock observation",
                    ))
                    .await
                    .map_err(model_jobs::RunnerError::from)?;
                Ok(RunOutcome::Completed)
            })
        }
    }

    let fixture = fixture_with_assets(3).await;
    let mut requests = Vec::new();
    for (index, asset) in fixture.assets.iter().enumerate() {
        let mut body =
            fixture.start_run_body("t17-op-batch", &format!("batch item {index}"), asset);
        body["operation_id"] = json!("t17-op-batch");
        requests.push(fixture.authorize(body).await);
    }
    let queue = JobQueue::new(fixture.repository.clone());
    let parsed: Vec<annotation_domain::StartRunRequest> = requests
        .iter()
        .map(|body| serde_json::from_value(body.clone()).unwrap())
        .collect();
    let outcome = runs::create_batch(
        &fixture.repository,
        &queue,
        &fixture.user_id,
        "t17-op-batch",
        parsed,
        true,
    )
    .await
    .unwrap();
    assert!(!outcome.idempotent_replay);
    let summaries = outcome.runs;
    assert_eq!(summaries.len(), 3);
    let job_id = summaries[0].job_id.clone();
    assert!(summaries.iter().all(|summary| summary.job_id == job_id));

    let fail_run_id = summaries[1].run_id.clone();
    let runner = FailOneRunner {
        fail_run_id: fail_run_id.clone(),
    };
    let processed = model_jobs::process_next(
        &fixture.repository,
        &queue,
        "t17-worker",
        Duration::from_secs(30),
        &runner,
    )
    .await
    .unwrap();
    assert_eq!(processed, Some(job_id.clone()));

    // The job reports per-item results: one failure does not drop the successes.
    let (status, job) = fixture
        .request("GET", &format!("/api/jobs/{job_id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{job}");
    assert_eq!(job["state"], "failed");
    let items = job["result"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    let item_states: Vec<&str> = items
        .iter()
        .map(|item| item["state"].as_str().unwrap())
        .collect();
    assert_eq!(item_states, vec!["succeeded", "failed", "succeeded"]);

    for summary in [&summaries[0], &summaries[2]] {
        let (status, suggestions) = fixture
            .request(
                "GET",
                &format!("/api/ai/runs/{}/suggestions", summary.run_id),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{suggestions}");
        assert_eq!(suggestions["run"]["state"], "succeeded");
        assert_eq!(suggestions["items"].as_array().unwrap().len(), 1);
    }
    assert_eq!(
        fixture
            .db_scalar(
                "SELECT COUNT(*) FROM predictions WHERE run_id=?",
                &[fail_run_id.as_str()]
            )
            .await,
        0
    );
    let (status, failed_events) = fixture
        .request(
            "GET",
            &format!("/api/ai/runs/{fail_run_id}/events?after=0"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{failed_events}");
    assert_eq!(failed_events["run"]["state"], "failed");
    let last = failed_events["items"].as_array().unwrap().last().unwrap();
    assert_eq!(last["type"], "failed");
    assert_eq!(last["data"]["code"], "PROVIDER_ASSET_ERROR");
}

#[tokio::test]
async fn lease_claim_never_hands_one_model_job_to_two_workers() {
    #[derive(Default)]
    struct CountingRunner {
        calls: std::sync::atomic::AtomicUsize,
    }
    impl RunRunner for CountingRunner {
        fn execute<'a>(
            &'a self,
            _driver: &'a model_jobs::RunDriver,
        ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, model_jobs::RunnerError>> + Send + 'a>>
        {
            Box::pin(async move {
                self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(RunOutcome::Completed)
            })
        }
    }

    let fixture = fixture().await;
    let (status, created) = fixture
        .create_run("t17-op-double-claim", "single claim only")
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let job_id = created["job_id"].as_str().unwrap().to_owned();

    let queue = JobQueue::new(fixture.repository.clone());
    let runner = std::sync::Arc::new(CountingRunner::default());
    let first = tokio::spawn({
        let repository = fixture.repository.clone();
        let queue = queue.clone();
        let runner = runner.clone();
        async move {
            model_jobs::process_next(
                &repository,
                &queue,
                "t17-worker-a",
                Duration::from_secs(30),
                &*runner,
            )
            .await
        }
    });
    let second = tokio::spawn({
        let repository = fixture.repository.clone();
        let queue = queue.clone();
        let runner = runner.clone();
        async move {
            model_jobs::process_next(
                &repository,
                &queue,
                "t17-worker-b",
                Duration::from_secs(30),
                &*runner,
            )
            .await
        }
    });
    let outcomes = tokio::join!(first, second);
    let mut claims = vec![outcomes.0.unwrap().unwrap(), outcomes.1.unwrap().unwrap()];
    claims.sort();
    let distinct: Vec<&String> = claims.iter().flatten().collect();
    assert_eq!(
        distinct.len(),
        1,
        "exactly one worker may claim the model job, got {claims:?}"
    );
    assert_eq!(distinct[0], &job_id);
    assert_eq!(
        runner.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the model request is executed exactly once"
    );
}

#[tokio::test]
async fn predictions_are_immutable_and_suggestion_state_is_separate() {
    let fixture = fixture().await;
    let (status, created) = fixture.create_run("t17-op-immutable", "immutability").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let run_id = created["run_id"].as_str().unwrap().to_owned();
    let queue = JobQueue::new(fixture.repository.clone());
    model_jobs::process_next(
        &fixture.repository,
        &queue,
        "t17-worker",
        Duration::from_secs(30),
        &MockRunner::standard(),
    )
    .await
    .unwrap();

    let prediction_id = fixture
        .db_text(
            "SELECT prediction_id FROM predictions WHERE run_id=?",
            &[run_id.as_str()],
        )
        .await
        .unwrap();
    let suggestion_set_id = fixture
        .db_text(
            "SELECT suggestion_set_id FROM suggestion_sets WHERE run_id=?",
            &[run_id.as_str()],
        )
        .await
        .unwrap();

    // Predictions and suggestion content are immutable at the storage layer.
    let mut tx = fixture.repository.begin_write().await.unwrap();
    let updated = sqlx::query("UPDATE predictions SET raw_output_json='{}' WHERE prediction_id=?")
        .bind(&prediction_id)
        .execute(tx.connection())
        .await;
    assert!(updated.is_err(), "predictions must not be updatable");
    let deleted = sqlx::query("DELETE FROM predictions WHERE prediction_id=?")
        .bind(&prediction_id)
        .execute(tx.connection())
        .await;
    assert!(deleted.is_err(), "predictions must not be deletable");
    let updated =
        sqlx::query("UPDATE suggestion_sets SET changes_json='[]' WHERE suggestion_set_id=?")
            .bind(&suggestion_set_id)
            .execute(tx.connection())
            .await;
    assert!(updated.is_err(), "suggestion content must not be updatable");
    tx.commit().await.unwrap();

    // Suggestion state lives in its own table and does change explicitly.
    let mut tx = fixture.repository.begin_write().await.unwrap();
    sqlx::query("UPDATE suggestion_set_states SET state='rejected' WHERE suggestion_set_id=?")
        .bind(&suggestion_set_id)
        .execute(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (status, suggestions) = fixture
        .request("GET", &format!("/api/ai/runs/{run_id}/suggestions"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{suggestions}");
    assert_eq!(suggestions["items"][0]["state"], "rejected");
    // The prediction behind the set is untouched by the state change.
    assert_eq!(
        fixture
            .db_scalar(
                "SELECT COUNT(*) FROM predictions WHERE prediction_id=?",
                &[prediction_id.as_str()]
            )
            .await,
        1
    );
}

#[tokio::test]
async fn raw_provider_output_is_size_capped_and_secrets_are_redacted() {
    let fixture = fixture().await;
    let mut scripts = BTreeMap::new();
    let (status, secret_run) = fixture.create_run("t17-op-redact", "redaction").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{secret_run}");
    let secret_id = secret_run["run_id"].as_str().unwrap().to_owned();
    scripts.insert(
        secret_id.clone(),
        vec![
            MockStep::Candidate(issue_candidate(
                "cand-secret",
                1,
                "issue-secret",
                "provider leaked sk-secret-value-12345 and Bearer deadbeefcafe",
            )),
            MockStep::Complete,
        ],
    );
    let queue = JobQueue::new(fixture.repository.clone());
    model_jobs::process_next(
        &fixture.repository,
        &queue,
        "t17-worker",
        Duration::from_secs(30),
        &scripted_runner(scripts),
    )
    .await
    .unwrap();
    let raw = fixture
        .db_text(
            "SELECT raw_output_json FROM predictions WHERE run_id=?",
            &[secret_id.as_str()],
        )
        .await
        .unwrap();
    assert!(
        !raw.contains("sk-secret-value-12345"),
        "raw output must be redacted: {raw}"
    );
    assert!(
        !raw.contains("deadbeefcafe"),
        "raw output must be redacted: {raw}"
    );
    assert!(
        raw.contains("[REDACTED]"),
        "redaction must be visible: {raw}"
    );

    // Oversized raw provider output fails only its own item.
    let (status, huge_run) = fixture.create_run("t17-op-huge", "oversized output").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{huge_run}");
    let huge_id = huge_run["run_id"].as_str().unwrap().to_owned();
    let mut scripts = BTreeMap::new();
    let huge_raw = json!({
        "changes": [],
        "issues": [{
            "issue_id": "issue-huge",
            "object_id": null,
            "code": "mock_review",
            "message": "x".repeat(300 * 1024),
            "region": null
        }],
        "score": null
    });
    scripts.insert(
        huge_id.clone(),
        vec![
            MockStep::Candidate(candidate("cand-huge", 1, huge_raw)),
            MockStep::Complete,
        ],
    );
    model_jobs::process_next(
        &fixture.repository,
        &queue,
        "t17-worker",
        Duration::from_secs(30),
        &scripted_runner(scripts),
    )
    .await
    .unwrap();
    assert_eq!(
        fixture
            .db_scalar(
                "SELECT COUNT(*) FROM predictions WHERE run_id=?",
                &[huge_id.as_str()]
            )
            .await,
        0
    );
    let (status, events) = fixture
        .request(
            "GET",
            &format!("/api/ai/runs/{huge_id}/events?after=0"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{events}");
    assert_eq!(events["run"]["state"], "failed");
    let last = events["items"].as_array().unwrap().last().unwrap();
    assert_eq!(last["type"], "failed");
    assert_eq!(last["data"]["code"], "PREDICTION_TOO_LARGE");
}

async fn worker_callbacks_after_authority_loss(fenced: bool) {
    struct LoseAuthority {
        repository: weblabel_api::storage::Repository,
        job_id: String,
        fenced: bool,
        callbacks_exercised: std::sync::atomic::AtomicBool,
    }
    impl RunRunner for LoseAuthority {
        fn execute<'a>(
            &'a self,
            driver: &'a model_jobs::RunDriver,
        ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, model_jobs::RunnerError>> + Send + 'a>>
        {
            Box::pin(async move {
                driver
                    .emit(progress_event("callback-owned-event", 1, "owned event"))
                    .await
                    .unwrap();
                driver
                    .submit_candidates(issue_candidate(
                        "callback-owned-candidate", 2, "owned-issue", "owned candidate",
                    ))
                    .await
                    .unwrap();
                let mut tx = self.repository.begin_write().await.unwrap();
                let before: (i64, i64, i64) = sqlx::query_as(
                    "SELECT (SELECT COUNT(*) FROM run_events WHERE run_id=?), \
                     (SELECT COUNT(*) FROM predictions WHERE run_id=?), \
                     (SELECT COUNT(*) FROM suggestion_sets WHERE run_id=?)",
                )
                .bind(driver.run_id()).bind(driver.run_id()).bind(driver.run_id())
                .fetch_one(tx.connection()).await.unwrap();
                assert_eq!(before, (4, 1, 1), "valid callbacks must persist their output");
                let update = if self.fenced {
                    "UPDATE jobs SET worker_id='callback-replacement',fencing_token=fencing_token+1 \
                     WHERE job_id=?"
                } else {
                    "UPDATE jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE job_id=?"
                };
                sqlx::query(update).bind(&self.job_id).execute(tx.connection()).await.unwrap();
                let authority_before: (String, String, i64, String, i64, i64, Option<String>, String) =
                    sqlx::query_as(
                        "SELECT state,worker_id,fencing_token,lease_until,progress_completed, \
                         progress_total,result_json,updated_at FROM jobs WHERE job_id=?",
                    )
                    .bind(&self.job_id).fetch_one(tx.connection()).await.unwrap();
                tx.commit().await.unwrap();

                // Fresh provider identities and a domain-valid candidate arrive
                // immediately after loss, without waiting for the next heartbeat.
                let event = driver
                    .emit(progress_event("callback-stale-event", 3, "stale event"))
                    .await;
                let candidate = driver
                    .submit_candidates(issue_candidate(
                        "callback-stale-candidate", 4, "stale-issue", "stale candidate",
                    ))
                    .await;
                let mut tx = self.repository.begin_write().await.unwrap();
                let after: (i64, i64, i64) = sqlx::query_as(
                    "SELECT (SELECT COUNT(*) FROM run_events WHERE run_id=?), \
                     (SELECT COUNT(*) FROM predictions WHERE run_id=?), \
                     (SELECT COUNT(*) FROM suggestion_sets WHERE run_id=?)",
                )
                .bind(driver.run_id()).bind(driver.run_id()).bind(driver.run_id())
                .fetch_one(tx.connection()).await.unwrap();
                let authority_after: (String, String, i64, String, i64, i64, Option<String>, String) =
                    sqlx::query_as(
                        "SELECT state,worker_id,fencing_token,lease_until,progress_completed, \
                         progress_total,result_json,updated_at FROM jobs WHERE job_id=?",
                    )
                    .bind(&self.job_id).fetch_one(tx.connection()).await.unwrap();
                tx.commit().await.unwrap();
                eprintln!(
                    "callback authority fenced={}: before={before:?} after={after:?} event={event:?} candidate={candidate:?}",
                    self.fenced
                );
                assert!(
                    matches!(event, Err(model_jobs::ModelJobError::Queue(
                        weblabel_api::jobs::queue::QueueError::InvalidRequest
                    ))),
                    "stale event must fail closed: {event:?}"
                );
                assert!(
                    matches!(candidate, Err(model_jobs::ModelJobError::Queue(
                        weblabel_api::jobs::queue::QueueError::InvalidRequest
                    ))),
                    "stale candidate must fail closed: {candidate:?}"
                );
                assert_eq!(after, before, "stale callbacks must not persist any output");
                assert_eq!(authority_after, authority_before, "foreign authority must be untouched");
                self.callbacks_exercised.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(RunOutcome::Completed)
            })
        }
    }
    let fixture = fixture().await;
    let (status, created) = fixture.create_run("t17-op-callback-loss", "callback fencing").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let queue = JobQueue::new(fixture.repository.clone());
    let runner = LoseAuthority {
        repository: fixture.repository.clone(),
        job_id: created["job_id"].as_str().unwrap().to_owned(),
        fenced,
        callbacks_exercised: std::sync::atomic::AtomicBool::new(false),
    };
    let result = model_jobs::process_model_next(
        &fixture.repository, &queue, "t17-callback-worker", Duration::from_secs(30), &runner,
    ).await;
    assert!(runner.callbacks_exercised.load(std::sync::atomic::Ordering::SeqCst));
    assert!(matches!(
        result,
        Err(model_jobs::ModelJobError::Queue(
            weblabel_api::jobs::queue::QueueError::InvalidRequest
        ))
    ), "lost worker must not conclude the run: {result:?}");
    let run_id = created["run_id"].as_str().unwrap();
    let (status, events) = fixture
        .request("GET", &format!("/api/ai/runs/{run_id}/events?after=0"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{events}");
    assert_eq!(events["run"]["state"], "running");
    assert_eq!(events["items"].as_array().unwrap().len(), 4);
    assert_eq!(events["items"][2]["message"], "owned event");
    assert_eq!(events["items"][3]["type"], "candidate");
}

#[tokio::test]
async fn expired_worker_callbacks_cannot_persist_output() {
    worker_callbacks_after_authority_loss(false).await;
}

#[tokio::test]
async fn fenced_worker_callbacks_cannot_persist_output() {
    worker_callbacks_after_authority_loss(true).await;
}

#[tokio::test]
async fn silent_model_run_retains_lease_until_completion() {
    struct SilentRunner {
        started: tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: tokio::sync::Notify,
    }
    impl RunRunner for SilentRunner {
        fn execute<'a>(
            &'a self,
            _driver: &'a model_jobs::RunDriver,
        ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, model_jobs::RunnerError>> + Send + 'a>>
        {
            Box::pin(async move {
                self.started.lock().await.take().unwrap().send(()).unwrap();
                self.release.notified().await;
                Ok(RunOutcome::Completed)
            })
        }
    }

    let fixture = fixture().await;
    let (status, created) = fixture.create_run("t17-op-silent", "silent provider").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let job_id = created["job_id"].as_str().unwrap();
    let queue = JobQueue::new(fixture.repository.clone());
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let runner = std::sync::Arc::new(SilentRunner {
        started: tokio::sync::Mutex::new(Some(started_tx)),
        release: tokio::sync::Notify::new(),
    });
    let execution = tokio::spawn({
        let repository = fixture.repository.clone();
        let queue = queue.clone();
        let runner = runner.clone();
        async move {
            model_jobs::process_model_next(
                &repository,
                &queue,
                "t17-silent-worker",
                Duration::from_millis(300),
                &*runner,
            )
            .await
        }
    });
    started_rx.await.unwrap();
    // Intentionally cross the initial lease, with no provider event or item
    // completion that could incidentally report progress on the worker's behalf.
    tokio::time::sleep(Duration::from_millis(400)).await;
    let stolen = queue
        .lease_next_kind(
            "t17-competing-worker",
            Duration::from_secs(30),
            Some("model_run"),
        )
        .await
        .unwrap();
    runner.release.notify_one();
    let result = execution.await.unwrap();
    assert!(stolen.is_none(), "silent in-flight job was reclaimed: {stolen:?}");
    assert_eq!(result.unwrap().as_deref(), Some(job_id));
    let job = queue
        .status(&fixture.project_id, job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.state, "succeeded");
    assert_eq!((job.progress_completed, job.progress_total), (1, 1));
}

#[tokio::test]
async fn heartbeat_keeps_polling_an_item_that_holds_the_writer() {
    struct HoldWriter {
        repository: weblabel_api::storage::Repository,
    }
    impl RunRunner for HoldWriter {
        fn execute<'a>(
            &'a self,
            _driver: &'a model_jobs::RunDriver,
        ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, model_jobs::RunnerError>> + Send + 'a>>
        {
            Box::pin(async move {
                let writer = self.repository.begin_write().await.unwrap();
                // A renewal becomes due before this async operation can release
                // its transaction. It must not stop the item from being polled.
                tokio::time::sleep(Duration::from_millis(400)).await;
                writer.commit().await.unwrap();
                Ok(RunOutcome::Completed)
            })
        }
    }
    let fixture = fixture().await;
    let (status, created) = fixture.create_run("t17-op-held-writer", "held writer").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let queue = JobQueue::new(fixture.repository.clone());
    let result = model_jobs::process_model_next(
        &fixture.repository,
        &queue,
        "t17-held-writer",
        Duration::from_millis(300),
        &HoldWriter { repository: fixture.repository.clone() },
    )
    .await;
    assert!(
        result.is_ok(),
        "heartbeat must keep polling the item that can release its writer: {result:?}"
    );
    let job = queue
        .status(&fixture.project_id, created["job_id"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.state, "succeeded");
    assert_eq!((job.progress_completed, job.progress_total), (1, 1));
}

#[tokio::test]
async fn queue_rechecks_expiry_after_waiting_for_writer() {
    let fixture = fixture().await;
    let queue = JobQueue::new(fixture.repository.clone());
    for finishing in [false, true] {
        let queued = queue
            .enqueue(
                Some(&fixture.project_id),
                "lease_clock_probe",
                if finishing { "finish-clock" } else { "progress-clock" },
                &json!({}),
            )
            .await
            .unwrap();
        let lease = queue
            .lease_next_kind("clock-worker", Duration::from_secs(30), Some("lease_clock_probe"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(lease.job_id, queued.job_id);
        let mut writer = fixture.repository.begin_write().await.unwrap();
        let operation = async {
            if finishing {
                queue.finish(&lease, true, &json!({"succeeded":1})).await
            } else {
                queue.report_progress(&lease, 1, 1, &json!({"succeeded":1})).await
            }
        };
        tokio::pin!(operation);
        // Poll exactly once while BEGIN IMMEDIATE is held. This guarantees
        // the request has entered the wait, without scheduling guesses.
        std::future::poll_fn(|cx| {
            assert!(operation.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        let expired_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query("UPDATE jobs SET lease_until=? WHERE job_id=?")
            .bind(&expired_at)
            .bind(&queued.job_id)
            .execute(writer.connection())
            .await
            .unwrap();
        writer.commit().await.unwrap();
        let result = operation.await;
        assert!(
            matches!(result, Err(weblabel_api::jobs::queue::QueueError::InvalidRequest)),
            "waiting {finishing:?} request must recheck server time: {result:?}"
        );
        let job = queue.status(&fixture.project_id, &queued.job_id).await.unwrap().unwrap();
        assert_eq!(job.state, "running");
        assert_eq!(job.progress_completed, 0);
        assert_eq!(job.result, None);
        assert_eq!(
            fixture.db_text("SELECT lease_until FROM jobs WHERE job_id=?", &[&queued.job_id]).await,
            Some(expired_at)
        );
        // Do not let this deliberately expired probe become the next case's claim.
        queue.lease_next_kind("clock-reclaimer", Duration::from_secs(30), Some("lease_clock_probe"))
            .await.unwrap().unwrap();
    }
    let queued = queue
        .enqueue(Some(&fixture.project_id), "claim_clock_probe", "claim-clock", &json!({}))
        .await
        .unwrap();
    let writer = fixture.repository.begin_write().await.unwrap();
    let claim = queue.lease_next_kind(
        "fresh-clock-worker",
        Duration::from_secs(30),
        Some("claim_clock_probe"),
    );
    tokio::pin!(claim);
    std::future::poll_fn(|cx| {
        assert!(claim.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    tokio::time::sleep(Duration::from_millis(10)).await;
    let released_at = chrono::Utc::now();
    writer.commit().await.unwrap();
    let lease = claim.await.unwrap().unwrap();
    assert_eq!(lease.job_id, queued.job_id);
    let until = chrono::DateTime::parse_from_rfc3339(&lease.lease_until).unwrap();
    assert!(
        until >= released_at + chrono::Duration::seconds(30) - chrono::Duration::milliseconds(1),
        "new claim's original lease budget must start after acquiring the writer"
    );
}

#[tokio::test]
async fn model_job_heartbeat_drops_runner_on_expiry_or_fence_loss() {
    struct PendingRunner {
        started: tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        dropped: std::sync::atomic::AtomicBool,
    }
    struct RunnerGuard<'a>(&'a std::sync::atomic::AtomicBool);
    impl Drop for RunnerGuard<'_> {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    impl RunRunner for PendingRunner {
        fn execute<'a>(
            &'a self,
            _driver: &'a model_jobs::RunDriver,
        ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, model_jobs::RunnerError>> + Send + 'a>>
        {
            Box::pin(async move {
                let _guard = RunnerGuard(&self.dropped);
                self.started.lock().await.take().unwrap().send(()).unwrap();
                std::future::pending().await
            })
        }
    }

    for fenced in [false, true] {
        let fixture = fixture().await;
        let (status, created) = fixture.create_run("t17-op-heartbeat-loss", "lease loss").await;
        assert_eq!(status, StatusCode::ACCEPTED, "{created}");
        let job_id = created["job_id"].as_str().unwrap();
        let run_id = created["run_id"].as_str().unwrap();
        let queue = JobQueue::new(fixture.repository.clone());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let runner = std::sync::Arc::new(PendingRunner {
            started: tokio::sync::Mutex::new(Some(started_tx)),
            dropped: std::sync::atomic::AtomicBool::new(false),
        });
        let execution = tokio::spawn({
            let repository = fixture.repository.clone();
            let queue = queue.clone();
            let runner = runner.clone();
            async move {
                model_jobs::process_model_next(
                    &repository,
                    &queue,
                    "t17-lost-worker",
                    Duration::from_millis(300),
                    &*runner,
                )
                .await
            }
        });
        match tokio::time::timeout(Duration::from_secs(5), started_rx).await {
            Ok(started) => started.unwrap(),
            Err(_) => {
                execution.abort();
                let _ = execution.await;
                panic!("trusted heartbeat must not starve runner startup");
            }
        }
        let mut tx = fixture.repository.begin_write().await.unwrap();
        let update = if fenced {
            "UPDATE jobs SET worker_id='replacement-worker',fencing_token=fencing_token+1 \
             WHERE job_id=?"
        } else {
            "UPDATE jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE job_id=?"
        };
        sqlx::query(update).bind(job_id).execute(tx.connection()).await.unwrap();
        let before: (String, i64, String, String, i64, Option<String>) = sqlx::query_as(
            "SELECT worker_id,fencing_token,lease_until,state,progress_completed,result_json \
             FROM jobs WHERE job_id=?",
        )
        .bind(job_id)
        .fetch_one(tx.connection())
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), execution)
            .await
            .expect("lost authority must stop a silent runner")
            .unwrap();
        assert!(matches!(
            result,
            Err(model_jobs::ModelJobError::Queue(
                weblabel_api::jobs::queue::QueueError::InvalidRequest
            ))
        ));
        assert!(runner.dropped.load(std::sync::atomic::Ordering::SeqCst));
        let mut tx = fixture.repository.begin_write().await.unwrap();
        let after: (String, i64, String, String, i64, Option<String>) = sqlx::query_as(
            "SELECT worker_id,fencing_token,lease_until,state,progress_completed,result_json \
             FROM jobs WHERE job_id=?",
        )
        .bind(job_id)
        .fetch_one(tx.connection())
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(after, before, "a stale heartbeat cannot revive ownership");
        let (status, events) = fixture
            .request("GET", &format!("/api/ai/runs/{run_id}/events?after=0"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{events}");
        assert_eq!(events["run"]["state"], "running");
        assert_eq!(events["items"].as_array().unwrap().len(), 2);
        assert_eq!(events["items"][1]["type"], "started");
    }
}

#[tokio::test]
async fn model_job_progress_rejects_expired_authority() {
    struct ExpireLease {
        repository: weblabel_api::storage::Repository,
        job_id: String,
    }
    impl RunRunner for ExpireLease {
        fn execute<'a>(
            &'a self,
            driver: &'a model_jobs::RunDriver,
        ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, model_jobs::RunnerError>> + Send + 'a>>
        {
            Box::pin(async move {
                driver
                    .emit(progress_event("expiry-event", 0, "persisted before expiry"))
                    .await
                    .unwrap();
                // Move only this fixture's durable lease past the server clock,
                // without changing its worker, fence, state or progress budget.
                let mut tx = self.repository.begin_write().await.unwrap();
                sqlx::query(
                    "UPDATE jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE job_id=?",
                )
                .bind(&self.job_id)
                .execute(tx.connection())
                .await
                .unwrap();
                tx.commit().await.unwrap();
                Ok(RunOutcome::Completed)
            })
        }
    }

    let fixture = fixture().await;
    let (status, created) = fixture.create_run("t17-op-expiry", "lease expiry").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let job_id = created["job_id"].as_str().unwrap().to_owned();
    let run_id = created["run_id"].as_str().unwrap();
    let queue = JobQueue::new(fixture.repository.clone());
    let result = model_jobs::process_next(
        &fixture.repository,
        &queue,
        "t17-worker",
        Duration::from_secs(30),
        &ExpireLease {
            repository: fixture.repository.clone(),
            job_id: job_id.clone(),
        },
    )
    .await;
    assert!(
        matches!(
            result,
            Err(model_jobs::ModelJobError::Queue(
                weblabel_api::jobs::queue::QueueError::InvalidRequest
            ))
        ),
        "expired producer must lose job authority: {result:?}"
    );
    let job = queue
        .status(&fixture.project_id, &job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.state, "running");
    assert_eq!(job.progress_completed, 0);
    assert_eq!(job.result, None);
    let (status, events) = fixture
        .request("GET", &format!("/api/ai/runs/{run_id}/events?after=0"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{events}");
    assert_eq!(events["items"][2]["message"], "persisted before expiry");
    assert_eq!(events["items"].as_array().unwrap().len(), 3);
    assert_eq!(events["run"]["state"], "running");
}

#[tokio::test]
async fn event_retention_is_explicitly_bounded() {
    struct RetentionProducer;
    impl RunRunner for RetentionProducer {
        fn execute<'a>(
            &'a self,
            driver: &'a model_jobs::RunDriver,
        ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, model_jobs::RunnerError>> + Send + 'a>>
        {
            Box::pin(async move {
                for index in 0..2100_i64 {
                    driver
                        .emit(progress_event(
                            &format!("pev-{index}"),
                            index,
                            &format!("progress {index}"),
                        ))
                        .await
                        .map_err(model_jobs::RunnerError::from)?;
                    // Bound each poll's work, like an async provider channel,
                    // so the trusted worker can heartbeat independently.
                    if index % 100 == 99 {
                        tokio::task::yield_now().await;
                    }
                }
                Ok(RunOutcome::Completed)
            })
        }
    }

    let fixture = fixture().await;
    let (status, created) = fixture.create_run("t17-op-retention", "retention").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let run_id = created["run_id"].as_str().unwrap().to_owned();
    let job_id = created["job_id"].as_str().unwrap().to_owned();
    let (status, other) = fixture.create_run("t17-op-retention-other", "other run").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{other}");
    let other_run_id = other["run_id"].as_str().unwrap();
    let other_job_id = other["job_id"].as_str().unwrap();
    let (status, other_events_before) = fixture
        .request(
            "GET",
            &format!("/api/ai/runs/{other_run_id}/events?after=0"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{other_events_before}");
    let queue = JobQueue::new(fixture.repository.clone());
    let other_job_before = queue
        .status(&fixture.project_id, other_job_id)
        .await
        .unwrap()
        .unwrap();
    let processed = model_jobs::process_next(
        &fixture.repository,
        &queue,
        "t17-worker",
        Duration::from_secs(30),
        &RetentionProducer,
    )
    .await
    .unwrap();
    assert_eq!(processed.as_deref(), Some(job_id.as_str()));

    let total = fixture
        .db_scalar(
            "SELECT COUNT(*) FROM run_events WHERE run_id=?",
            &[run_id.as_str()],
        )
        .await;
    assert_eq!(
        total, 2000,
        "event retention keeps the most recent 2000 events per run"
    );
    let oldest = fixture
        .db_scalar(
            "SELECT MIN(seq) FROM run_events WHERE run_id=?",
            &[run_id.as_str()],
        )
        .await;
    let newest = fixture
        .db_scalar(
            "SELECT MAX(seq) FROM run_events WHERE run_id=?",
            &[run_id.as_str()],
        )
        .await;
    assert_eq!(
        newest, 2103,
        "sequence numbers stay monotonic across pruning"
    );
    assert!(
        oldest > 1,
        "the oldest events were pruned, min seq {oldest}"
    );
    assert_eq!(oldest, 104, "retention preserves the exact newest window");
    let mut after = 0_i64;
    let mut retained = Vec::new();
    loop {
        let (status, page) = fixture
            .request(
                "GET",
                &format!("/api/ai/runs/{run_id}/events?after={after}&limit=200"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(page["run"]["state"], "succeeded");
        let items = page["items"].as_array().unwrap();
        for item in items {
            let seq = item["seq"].as_i64().unwrap();
            assert_eq!(seq, 104 + retained.len() as i64);
            assert_eq!(item["run_id"], run_id);
            if seq < 2103 {
                assert_eq!(item["type"], "progress");
                assert_eq!(item["message"], format!("progress {}", seq - 3));
            } else {
                assert_eq!(item["type"], "succeeded");
            }
            retained.push(item.clone());
        }
        match page["next_cursor"].as_str() {
            Some(cursor) => {
                let next = cursor.parse::<i64>().unwrap();
                assert!(next > after);
                assert_eq!(items.last().unwrap()["seq"], next);
                after = next;
            }
            None => break,
        }
    }
    assert_eq!(retained.len(), 2000);
    // A cursor older than the retained window exposes the gap, and replay
    // returns the same newest events rather than resetting sequence numbers.
    let (status, replay) = fixture
        .request(
            "GET",
            &format!("/api/ai/runs/{run_id}/events?after=1&limit=200"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["items"].as_array().unwrap(), &retained[..200]);
    let (status, other_events_after) = fixture
        .request(
            "GET",
            &format!("/api/ai/runs/{other_run_id}/events?after=0"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{other_events_after}");
    assert_eq!(other_events_after, other_events_before);
    assert_eq!(
        queue.status(&fixture.project_id, other_job_id).await.unwrap(),
        Some(other_job_before)
    );
    let job = queue
        .status(&fixture.project_id, &job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.state, "succeeded");
    assert_eq!((job.progress_completed, job.progress_total), (1, 1));
}

#[tokio::test]
async fn mock_sources_are_labeled_and_never_available_in_production() {
    let fixture = fixture().await;
    let (status, created) = fixture.create_run("t17-op-label", "label the source").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    assert_eq!(created["source"], "mock");
    assert_eq!(created["provider_id"], "mock");
    assert_eq!(created["verification"], "mock_only");
    let run_id = created["run_id"].as_str().unwrap().to_owned();
    let queue = JobQueue::new(fixture.repository.clone());
    model_jobs::process_next(
        &fixture.repository,
        &queue,
        "t17-worker",
        Duration::from_secs(30),
        &MockRunner::standard(),
    )
    .await
    .unwrap();
    let (status, suggestions) = fixture
        .request("GET", &format!("/api/ai/runs/{run_id}/suggestions"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{suggestions}");
    assert_eq!(suggestions["run"]["source"], "mock");
    assert_eq!(suggestions["run"]["verification"], "mock_only");
    assert_eq!(
        suggestions["run"]["model_id"]
            .as_str()
            .unwrap()
            .contains("mock"),
        true,
        "the mock model id must be self-describing"
    );

    // Mock is refused by source, not just by the built-in profile id: a stored
    // row can never claim live verification.
    let mut tx = fixture.repository.begin_write().await.unwrap();
    sqlx::query(
        "INSERT INTO model_profiles(profile_id, provider_id, model_id, auth_kind, capabilities_json, \
         availability, verification, runtime_version, verified_at, config_json, secret_ref, created_at) \
         VALUES ('profile-mock-stored','mock','mock-stored-v1','none', \
         '{\"image_input\":true,\"tools\":false,\"structured_output\":true,\"bbox_output\":true,\"attributes\":true}', \
         'ready','live_passed',NULL,NULL,'{}',NULL,'2026-01-01T00:00:00.000Z')",
    )
    .execute(tx.connection())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut stored_body =
        fixture.start_run_body("t17-op-mock-stored", "stored mock row", fixture.asset());
    stored_body["profile_id"] = json!("profile-mock-stored");
    let (status, stored) = fixture
        .request(
            "POST",
            "/api/ai/runs",
            Some(fixture.authorize(stored_body).await),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{stored}");
    assert_eq!(stored["source"], "mock");
    assert_eq!(
        stored["verification"], "mock_only",
        "a stored mock row must never surface live verification"
    );

    // Production mode refuses to register or run the mock profile at all.
    let directory = tempdir().unwrap();
    let config = server_config(directory.path(), true);
    let state = AppState::open_with_auth(&config, auth_config())
        .await
        .unwrap();
    let app = router(state.clone());
    let (cookie, csrf, bootstrap_user_id) = bootstrap_cookie(&app).await;
    let (status, project) = send(
        &app,
        "POST",
        "/api/projects",
        Some(json!({"name": "T17 production mode", "description": "", "allow_self_review": false})),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{project}");
    let project_id = project["project_id"].as_str().unwrap();
    let (status, ontology) = send(
        &app,
        "POST",
        &format!("/api/projects/{project_id}/ontologies"),
        Some(json!({
            "labels": [{
                "label_id": "label_person",
                "name": "Person",
                "color": "#0099ff",
                "shortcut": null,
                "allowed_geometry_types": ["bbox_xyxy"],
                "attributes": []
            }],
            "guidelines_markdown": ""
        })),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{ontology}");
    let ontology_id = ontology["ontology_version_id"].as_str().unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::new(32, 24))
        .write_to(&mut png, ImageFormat::Png)
        .unwrap();
    let imported = import_one(
        &state.repository,
        &weblabel_api::jobs::worker::MediaWorker::new(),
        ImportInput {
            project_id: project_id.to_owned(),
            ontology_version_id: ontology_id.to_owned(),
            actor_id: bootstrap_user_id,
            source_group_id: "t17-production-source".to_owned(),
            original_name: "production-fixture.png".to_owned(),
            declared_mime: Some("image/png".to_owned()),
            bytes: png.into_inner(),
        },
    )
    .await
    .unwrap();
    let body = json!({
        "operation_id": "t17-op-production",
        "profile_id": MOCK_PROFILE,
        "context": {
            "project_id": project_id,
            "asset_revision_id": imported.asset_revision_id,
            "annotation_revision_id": imported.annotation_revision_id,
            "ontology_version_id": ontology_id,
            "draft_generation": 0,
            "canonical_sha256": imported.canonical_sha256,
            "selected_object_ids": [],
            "object_hashes": {},
            "input_fingerprint": "t17-production-fingerprint"
        },
        "intent": "find_issues",
        "prompt": "mock must not run in production",
        "consent_id": null
    });
    let (status, rejected) = send(
        &app,
        "POST",
        "/api/ai/runs",
        Some(body),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{rejected}");
    assert_eq!(rejected["code"], "PROFILE_NOT_FOUND");

    // The same refusal applies to a stored mock row, not just the built-in id.
    let mut tx = state.repository.begin_write().await.unwrap();
    sqlx::query(
        "INSERT INTO model_profiles(profile_id, provider_id, model_id, auth_kind, capabilities_json, \
         availability, verification, runtime_version, verified_at, config_json, secret_ref, created_at) \
         VALUES ('profile-mock-stored','mock','mock-stored-v1','none', \
         '{\"image_input\":true,\"tools\":false,\"structured_output\":true,\"bbox_output\":true,\"attributes\":true}', \
         'ready','mock_only',NULL,NULL,'{}',NULL,'2026-01-01T00:00:00.000Z')",
    )
    .execute(tx.connection())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let stored_production = json!({
        "operation_id": "t17-op-production-stored",
        "profile_id": "profile-mock-stored",
        "context": {
            "project_id": project_id,
            "asset_revision_id": imported.asset_revision_id,
            "annotation_revision_id": imported.annotation_revision_id,
            "ontology_version_id": ontology_id,
            "draft_generation": 0,
            "canonical_sha256": imported.canonical_sha256,
            "selected_object_ids": [],
            "object_hashes": {},
            "input_fingerprint": "t17-production-stored-fingerprint"
        },
        "intent": "find_issues",
        "prompt": "stored mock must not run in production",
        "consent_id": null
    });
    let (status, rejected) = send(
        &app,
        "POST",
        "/api/ai/runs",
        Some(stored_production),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{rejected}");
    assert_eq!(rejected["code"], "PROFILE_NOT_FOUND");
}

#[tokio::test]
async fn ai_routes_enforce_project_membership_and_roles() {
    let fixture = fixture().await;
    let (status, created) = fixture.create_run("t17-op-authz", "authorization").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let run_id = created["run_id"].as_str().unwrap().to_owned();
    let job_id = created["job_id"].as_str().unwrap().to_owned();

    // A user with no membership sees nothing on every route.
    let (status, body) = fixture
        .request(
            "POST",
            "/api/users",
            Some(json!({"username": "t17-outsider", "password": "t17-outsider-password"})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (outsider_cookie, outsider_csrf) =
        login(&fixture.app, "t17-outsider", "t17-outsider-password").await;
    for (method, path) in [
        ("GET", format!("/api/ai/runs/{run_id}/events?after=0")),
        ("GET", format!("/api/ai/runs/{run_id}/suggestions")),
        ("GET", format!("/api/jobs/{job_id}")),
        ("POST", format!("/api/ai/runs/{run_id}/cancel")),
    ] {
        let (status, body) = send(
            &fixture.app,
            method,
            &path,
            if method == "POST" {
                Some(json!({}))
            } else {
                None
            },
            Some(&outsider_cookie),
            Some(&outsider_csrf),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path} -> {body}");
    }

    // A viewer of the project may read but never start or cancel runs.
    let (status, body) = fixture
        .request(
            "POST",
            "/api/users",
            Some(json!({"username": "t17-viewer", "password": "t17-viewer-password"})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let viewer_id = body["user_id"].as_str().unwrap();
    let (status, body) = fixture
        .request(
            "POST",
            &format!("/api/projects/{}/members", fixture.project_id),
            Some(json!({"user_id": viewer_id, "role": "viewer"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (viewer_cookie, viewer_csrf) =
        login(&fixture.app, "t17-viewer", "t17-viewer-password").await;
    let (status, body) = send(
        &fixture.app,
        "GET",
        &format!("/api/ai/runs/{run_id}/events?after=0"),
        None,
        Some(&viewer_cookie),
        Some(&viewer_csrf),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = send(
        &fixture.app,
        "POST",
        "/api/ai/runs",
        Some(fixture.start_run_body("t17-op-viewer", "viewer start", fixture.asset())),
        Some(&viewer_cookie),
        Some(&viewer_csrf),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["code"], "PROJECT_WRITE_REQUIRED");
    let (status, body) = send(
        &fixture.app,
        "POST",
        &format!("/api/ai/runs/{run_id}/cancel"),
        Some(json!({})),
        Some(&viewer_cookie),
        Some(&viewer_csrf),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // Unauthenticated access is rejected before any lookup.
    let (status, body) = send(
        &fixture.app,
        "GET",
        &format!("/api/ai/runs/{run_id}/events?after=0"),
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");

    // Malformed and hostile run requests fail closed before anything is stored.
    let (status, body) = fixture
        .request("POST", "/api/ai/runs", Some(json!({"nope": true})))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let mut unknown_profile =
        fixture.start_run_body("t17-op-unknown-profile", "x", fixture.asset());
    unknown_profile["profile_id"] = json!("profile-does-not-exist");
    let (status, body) = fixture
        .request("POST", "/api/ai/runs", Some(unknown_profile))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["code"], "PROFILE_NOT_FOUND");
    let mut long_prompt = fixture.start_run_body("t17-op-long-prompt", "x", fixture.asset());
    long_prompt["prompt"] = json!("p".repeat(9000));
    let (status, body) = fixture
        .request("POST", "/api/ai/runs", Some(long_prompt))
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
}

#[tokio::test]
async fn restart_recovery_concludes_runs_of_a_crashed_claimed_job() {
    #[derive(Default)]
    struct CountingRunner {
        calls: std::sync::atomic::AtomicUsize,
    }
    impl RunRunner for CountingRunner {
        fn execute<'a>(
            &'a self,
            _driver: &'a model_jobs::RunDriver,
        ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, model_jobs::RunnerError>> + Send + 'a>>
        {
            Box::pin(async move {
                self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(RunOutcome::Completed)
            })
        }
    }

    // Restart recovery may conclude a run that never started.
    assert!(runs::transition(RunState::Queued, RunState::Interrupted).is_ok());

    let fixture = fixture().await;
    let (status, created) = fixture
        .create_run("t17-op-claimed-crash", "claimed but never started")
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let run_id = created["run_id"].as_str().unwrap().to_owned();
    let job_id = created["job_id"].as_str().unwrap().to_owned();

    // The worker claims the batch job and dies before the run starts.
    let queue = JobQueue::new(fixture.repository.clone());
    let lease = queue
        .lease_next("t17-crash-worker", Duration::from_secs(30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lease.job_id, job_id);
    assert_eq!(
        fixture
            .db_text(
                "SELECT state FROM model_runs WHERE run_id=?",
                &[run_id.as_str()]
            )
            .await
            .unwrap(),
        "queued"
    );

    drop(lease);
    drop(queue);
    let Fixture {
        app,
        repository,
        state,
        directory,
        directory_path,
        cookie: _,
        csrf: _,
        user_id: _,
        project_id: _,
        ontology_id: _,
        assets: _,
        authorizations: _,
    } = fixture;
    drop(app);
    drop(repository);
    drop(state);
    let config = server_config(&directory_path, false);
    // The recovery used to abort startup for exactly this state.
    let state = AppState::open_with_auth(&config, auth_config())
        .await
        .unwrap();

    let mut tx = state.repository.begin_write().await.unwrap();
    let row = sqlx::query(
        "SELECT state, cost_display, started_at, usage_json FROM model_runs WHERE run_id=?",
    )
    .bind(&run_id)
    .fetch_one(tx.connection())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(row.try_get::<String, _>("state").unwrap(), "interrupted");
    assert_eq!(row.try_get::<String, _>("cost_display").unwrap(), "none");
    assert!(row
        .try_get::<Option<String>, _>("started_at")
        .unwrap()
        .is_none());
    assert!(row
        .try_get::<Option<String>, _>("usage_json")
        .unwrap()
        .is_none());
    let mut tx = state.repository.begin_write().await.unwrap();
    let job_state: String = sqlx::query("SELECT state FROM jobs WHERE job_id=?")
        .bind(&job_id)
        .fetch_one(tx.connection())
        .await
        .unwrap()
        .try_get(0)
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(job_state, "interrupted");

    // A run that never invoked the provider is still never resent automatically.
    let queue = JobQueue::new(state.repository.clone());
    let counter = CountingRunner::default();
    let processed = model_jobs::process_next(
        &state.repository,
        &queue,
        "t17-post-crash-worker",
        Duration::from_secs(30),
        &counter,
    )
    .await
    .unwrap();
    assert_eq!(processed, None, "the interrupted job must not be re-driven");
    assert_eq!(
        counter.calls.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "the provider must not be called again"
    );
    drop(directory);
}

#[tokio::test]
async fn capability_gates_reject_changes_the_profile_cannot_produce() {
    struct SubmitRunner(SubmitCandidates);
    impl RunRunner for SubmitRunner {
        fn execute<'a>(
            &'a self,
            driver: &'a model_jobs::RunDriver,
        ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, model_jobs::RunnerError>> + Send + 'a>>
        {
            Box::pin(async move {
                driver
                    .submit_candidates(self.0.clone())
                    .await
                    .map_err(model_jobs::RunnerError::from)?;
                Ok(RunOutcome::Completed)
            })
        }
    }

    let fixture = fixture().await;
    // A VLM-style profile: no bbox output and no attribute output.
    let mut tx = fixture.repository.begin_write().await.unwrap();
    sqlx::query(
        "INSERT INTO model_profiles(profile_id, provider_id, model_id, auth_kind, capabilities_json, \
         availability, verification, runtime_version, verified_at, config_json, secret_ref, created_at) \
         VALUES ('profile-vlm-1','openai_api','vlm-demo-v1','api_key', \
         '{\"image_input\":true,\"tools\":false,\"structured_output\":true,\"bbox_output\":false,\"attributes\":false}', \
         'ready','not_run',NULL,NULL,'{}',NULL,'2026-01-01T00:00:00.000Z')",
    )
    .execute(tx.connection())
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let asset = fixture.asset();
    let create_body = json!({
        "operation_id": "t17-op-cap-create",
        "profile_id": "profile-vlm-1",
        "context": {
            "project_id": fixture.project_id,
            "asset_revision_id": asset.asset_revision_id,
            "annotation_revision_id": asset.annotation_revision_id,
            "ontology_version_id": fixture.ontology_id,
            "draft_generation": 0,
            "canonical_sha256": asset.canonical_sha256,
            "selected_object_ids": [],
            "object_hashes": {},
            "input_fingerprint": "t17-cap-create-fingerprint"
        },
        "intent": "detect",
        "prompt": "detect persons",
        "consent_id": null
    });
    let (status, created) = fixture
        .request(
            "POST",
            "/api/ai/runs",
            Some(fixture.authorize(create_body).await),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let run_id = created["run_id"].as_str().unwrap().to_owned();
    let create_change = candidate(
        "cand-cap-create",
        1,
        json!({
            "changes": [{
                "kind": "create",
                "change_id": "cap-change-1",
                "object": {
                    "object_id": "cap-object-1",
                    "label_id": "label_person",
                    "geometry": {"type": "bbox_xyxy", "x_min": 0.0, "y_min": 0.0, "x_max": 8.0, "y_max": 8.0},
                    "attributes": {},
                    "origin": {"type": "manual", "prediction_id": null, "model_run_id": null, "import_batch_id": null}
                },
                "before_hash": null,
                "reason": "a profile without bbox output must not create boxes"
            }],
            "issues": [],
            "score": null
        }),
    );
    let queue = JobQueue::new(fixture.repository.clone());
    model_jobs::process_next(
        &fixture.repository,
        &queue,
        "t17-worker",
        Duration::from_secs(30),
        &SubmitRunner(create_change),
    )
    .await
    .unwrap();
    let (status, events) = fixture
        .request(
            "GET",
            &format!("/api/ai/runs/{run_id}/events?after=0"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{events}");
    assert_eq!(events["run"]["state"], "failed");
    let last = events["items"].as_array().unwrap().last().unwrap();
    assert_eq!(last["type"], "failed");
    assert_eq!(last["data"]["code"], "INVALID_CHANGE_KIND");
    assert_eq!(
        fixture
            .db_scalar(
                "SELECT COUNT(*) FROM predictions WHERE run_id=?",
                &[&run_id]
            )
            .await,
        0
    );

    // Pin an existing object before authorizing this run, so an otherwise
    // valid attribute proposal reaches the profile capability gate.
    let mut tx = fixture.repository.begin_write().await.unwrap();
    let mut document: annotation_domain::AnnotationDocument = serde_json::from_str(
        &sqlx::query_scalar::<_, String>(
            "SELECT body_json FROM annotation_revisions WHERE annotation_revision_id=?",
        )
        .bind(&asset.annotation_revision_id)
        .fetch_one(tx.connection())
        .await
        .unwrap(),
    )
    .unwrap();
    let object:annotation_domain::AnnotationObject=serde_json::from_value(json!({"object_id":"cap-object-1","label_id":"label_person","geometry":{"type":"bbox_xyxy","x_min":0,"y_min":0,"x_max":1,"y_max":1},"attributes":{"helmet_state":"unknown"},"origin":{"type":"manual","prediction_id":null,"model_run_id":null,"import_batch_id":null}})).unwrap();
    let pinned_hash = annotation_domain::object_hash(&object);
    document.objects.push(object);
    let serialized = annotation_domain::hash::serialize_document(&document).unwrap();
    sqlx::query(
        "UPDATE annotation_revisions SET body_json=?,content_hash=? WHERE annotation_revision_id=?",
    )
    .bind(serialized.json)
    .bind(serialized.content_hash)
    .bind(&asset.annotation_revision_id)
    .execute(tx.connection())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let audit_body = json!({
        "operation_id": "t17-op-cap-audit",
        "profile_id": "profile-vlm-1",
        "context": {
            "project_id": fixture.project_id,
            "asset_revision_id": asset.asset_revision_id,
            "annotation_revision_id": asset.annotation_revision_id,
            "ontology_version_id": fixture.ontology_id,
            "draft_generation": 0,
            "canonical_sha256": asset.canonical_sha256,
            "selected_object_ids": [],
            "object_hashes": {"cap-object-1": pinned_hash},
            "input_fingerprint": "t17-cap-audit-fingerprint"
        },
        "intent": "audit_attributes",
        "prompt": "audit helmet attributes",
        "consent_id": null
    });
    let (status, created) = fixture
        .request(
            "POST",
            "/api/ai/runs",
            Some(fixture.authorize(audit_body).await),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let audit_id = created["run_id"].as_str().unwrap().to_owned();
    let audit_change = candidate(
        "cand-cap-audit",
        1,
        json!({
            "changes": [{
                "kind": "set_attributes",
                "change_id": "cap-change-2",
                "object_id": "cap-object-1",
                "values": {"helmet_state": "wearing"},
                "before_hash": pinned_hash,
                "reason": "a profile without attribute output must not edit attributes"
            }],
            "issues": [],
            "score": null
        }),
    );
    model_jobs::process_next(
        &fixture.repository,
        &queue,
        "t17-worker",
        Duration::from_secs(30),
        &SubmitRunner(audit_change),
    )
    .await
    .unwrap();
    let (status, events) = fixture
        .request(
            "GET",
            &format!("/api/ai/runs/{audit_id}/events?after=0"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{events}");
    assert_eq!(events["run"]["state"], "failed");
    let last = events["items"].as_array().unwrap().last().unwrap();
    assert_eq!(last["type"], "failed");
    assert_eq!(last["data"]["code"], "INVALID_CHANGE_KIND");
}
