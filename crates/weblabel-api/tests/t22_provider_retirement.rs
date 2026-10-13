//! Retired execution is refused while persisted provider identity remains readable.
use annotation_domain::{ModelProfile, ProviderId, StartRunRequest};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    pin::Pin,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tower::ServiceExt;
use weblabel_api::{
    ai::runs::{self, RunRecord, RunState},
    auth::{hash_launch_code, AuthConfig},
    config::ServerConfig,
    jobs::model_jobs::{self, RunDriver, RunOutcome, RunRunner, RunnerError},
    media::ingest::{import_one, ImportInput},
    router, AppState,
};
const HOST: &str = "127.0.0.1:48222";
const NOW: &str = "2026-10-11T00:00:00Z";
struct Fixture {
    _dir: tempfile::TempDir,
    state: AppState,
    app: Router,
    cookie: String,
    csrf: String,
    actor: String,
    request: StartRunRequest,
    profile: ModelProfile,
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    value: Value,
    cookie: Option<&str>,
    csrf: Option<&str>,
) -> (StatusCode, Value, Option<String>) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("host", HOST)
        .header("origin", format!("http://{HOST}"))
        .header("content-type", "application/json");
    if let Some(v) = cookie {
        req = req.header("cookie", v);
    }
    if let Some(v) = csrf {
        req = req.header("x-csrf-token", v);
    }
    let res = app
        .clone()
        .oneshot(
            req.body(Body::from(if value.is_null() {
                String::new()
            } else {
                value.to_string()
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let cookie = res
        .headers()
        .get("set-cookie")
        .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_owned());
    let bytes = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        },
        cookie,
    )
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let config = ServerConfig {
            bind: HOST.parse().unwrap(),
            database_url: format!("sqlite:{}", dir.path().join("api.sqlite").display()),
            object_root: dir.path().join("objects"),
            write_timeout: Duration::from_secs(2),
            production: false,
        };
        let state = AppState::open_with_auth(
            &config,
            AuthConfig {
                bind: config.bind,
                cookie_secure: false,
                allowed_origins: vec![format!("http://{HOST}")],
                allowed_hosts: vec![HOST.to_owned()],
                launch_code: hash_launch_code("retirement-fixture"),
                launch_code_expires_at: chrono::Utc::now().timestamp() + 3600,
            },
        )
        .await
        .unwrap();
        let app = router(state.clone());
        let (status, boot, cookie) = call(
            &app,
            "POST",
            "/api/session/bootstrap",
            json!({"launch_code":"retirement-fixture","password":"retirement-fixture-password"}),
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let cookie = cookie.unwrap();
        let csrf = boot["csrf_token"].as_str().unwrap().to_owned();
        let actor = boot["user_id"].as_str().unwrap().to_owned();
        let (status, project, _) = call(&app,"POST","/api/projects",json!({"name":"Retirement fixture","description":"synthetic","allow_self_review":false}),Some(&cookie),Some(&csrf)).await;
        assert_eq!(status, StatusCode::CREATED, "{project}");
        let project_id = project["project_id"].as_str().unwrap();
        let (status, ontology, _) = call(&app,"POST",&format!("/api/projects/{project_id}/ontologies"),json!({"labels":[{"label_id":"label_person","name":"Person","color":"#0099ff","shortcut":null,"allowed_geometry_types":["bbox_xyxy"],"attributes":[]}],"guidelines_markdown":"Synthetic"}),Some(&cookie),Some(&csrf)).await;
        assert_eq!(status, StatusCode::CREATED, "{ontology}");
        let ontology_id = ontology["ontology_version_id"].as_str().unwrap();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::new(32, 24))
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let imported = import_one(
            &state.repository,
            &weblabel_api::jobs::worker::MediaWorker::new(),
            ImportInput {
                project_id: project_id.to_owned(),
                ontology_version_id: ontology_id.to_owned(),
                actor_id: actor.clone(),
                source_group_id: "retirement_source".into(),
                original_name: "synthetic.png".into(),
                declared_mime: Some("image/png".into()),
                bytes: png.into_inner(),
            },
        )
        .await
        .unwrap();
        let mut profile = runs::mock_profile();
        profile.profile_id = "profile_retired".into();
        profile.provider_id = ProviderId::CodexLocal;
        profile.model_id = "historical-model".into();
        profile.auth_kind = annotation_domain::AuthKind::OfficialUserLogin;
        profile.verification = annotation_domain::Verification::NotRun;
        let mut tx = state.repository.begin_write().await.unwrap();
        sqlx::query("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,config_json,created_at) VALUES(?,'codex_local',?,'official_user_login',?,'ready','not_run',?,'{}',?)")
            .bind(&*profile.profile_id).bind(&profile.model_id).bind(serde_json::to_string(&profile.capabilities).unwrap()).bind(&profile.runtime_version).bind(NOW).execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO model_profiles SELECT 'profile_active','claude_local',model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at FROM model_profiles WHERE profile_id='profile_retired'").execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
        let request = serde_json::from_value(json!({"operation_id":"retirement_operation","profile_id":profile.profile_id,"context":{"project_id":project_id,"asset_revision_id":imported.asset_revision_id,"annotation_revision_id":imported.annotation_revision_id,"ontology_version_id":ontology_id,"canonical_sha256":imported.canonical_sha256,"draft_generation":0,"selected_object_ids":[],"object_hashes":{},"input_fingerprint":"retirement-fingerprint"},"intent":"find_issues","prompt":"Synthetic historical request","consent_id":null})).unwrap();
        Self {
            _dir: dir,
            state,
            app,
            cookie,
            csrf,
            actor,
            request,
            profile,
        }
    }
    async fn http(&self, method: &str, path: &str, value: Value) -> (StatusCode, Value) {
        let (s, v, _) = call(
            &self.app,
            method,
            path,
            value,
            Some(&self.cookie),
            Some(&self.csrf),
        )
        .await;
        (s, v)
    }
    async fn count(&self, table: &str) -> i64 {
        let mut tx = self.state.repository.begin_write().await.unwrap();
        let n = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        n
    }
    async fn historical(&self, id: &str, operation: &str, state: RunState) -> RunRecord {
        let queue = weblabel_api::jobs::queue::JobQueue::new(self.state.repository.clone());
        let job = model_jobs::enqueue_run_job(
            &queue,
            &self.request.context.project_id,
            operation,
            &[id.to_owned()],
        )
        .await
        .unwrap();
        let mut request = self.request.clone();
        request.operation_id = operation.into();
        let hash = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!({"profile_snapshot":self.profile,"request":request}))
                    .unwrap()
            )
        );
        let record = RunRecord {
            run_id: id.into(),
            operation_id: operation.into(),
            project_id: request.context.project_id.to_string(),
            asset_revision_id: request.context.asset_revision_id.to_string(),
            annotation_revision_id: request.context.annotation_revision_id.to_string(),
            ontology_version_id: request.context.ontology_version_id.to_string(),
            actor_id: self.actor.clone(),
            job_id: job.job_id,
            profile_id: request.profile_id.to_string(),
            profile_snapshot_json: serde_json::to_string(&self.profile).unwrap(),
            provider_id: "codex_local".into(),
            source: "provider".into(),
            intent: serde_json::to_value(request.intent)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned(),
            prompt: request.prompt.clone(),
            context_json: serde_json::to_string(&request.context).unwrap(),
            input_fingerprint: request.context.input_fingerprint.clone(),
            request_hash: hash.clone(),
            state,
            cancel_requested: false,
            cost_display: "none".into(),
            created_at: NOW.into(),
            started_at: None,
            finished_at: None,
        };
        let mut tx = self.state.repository.begin_write().await.unwrap();
        sqlx::query("INSERT INTO model_runs(run_id,operation_id,project_id,asset_revision_id,annotation_revision_id,ontology_version_id,actor_id,job_id,profile_id,profile_snapshot_json,provider_id,source,intent,prompt,context_json,input_fingerprint,request_hash,state,cost_display,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&record.run_id).bind(operation).bind(&record.project_id).bind(&record.asset_revision_id).bind(&record.annotation_revision_id).bind(&record.ontology_version_id).bind(&self.actor).bind(&record.job_id).bind(&record.profile_id).bind(&record.profile_snapshot_json).bind(&record.provider_id).bind(&record.source).bind(&record.intent).bind(&record.prompt).bind(&record.context_json).bind(&record.input_fingerprint).bind(&hash).bind(state.as_str()).bind(&record.cost_display).bind(NOW).execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO idempotency_keys(actor_id,operation_id,operation_kind,request_hash,response_json,created_at) VALUES(?,?,'ai_run_start',?,?,?)").bind(&self.actor).bind(operation).bind(format!("{:x}",Sha256::digest(hash.as_bytes()))).bind(json!({"runs":[record.summary()]}).to_string()).bind(NOW).execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
        record
    }
}
struct CountingRunner(AtomicUsize);
impl RunRunner for CountingRunner {
    fn execute<'a>(
        &'a self,
        _driver: &'a RunDriver,
    ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, RunnerError>> + Send + 'a>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(RunOutcome::Completed) })
    }
}
#[tokio::test]
async fn retired_profiles_are_hidden_and_preview_start_create_nothing() {
    let f = Fixture::new().await;
    let (status, list) = f.http("GET", "/api/model-profiles", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        list["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["profile_id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["profile_active"]
    );
    let before = [
        f.count("model_profiles").await,
        f.count("ai_run_previews").await,
        f.count("consents").await,
        f.count("model_runs").await,
        f.count("jobs").await,
    ];
    for (path, body) in [
        (
            "/api/ai/previews",
            json!({"request":f.request,"grants":{"allow_image":false,"allow_object_context":false,"preview_crop":null}}),
        ),
        ("/api/ai/runs", serde_json::to_value(&f.request).unwrap()),
    ] {
        let (status, error) = f.http("POST", path, body).await;
        assert_eq!(status, StatusCode::CONFLICT, "{error}");
        assert_eq!(error["code"], "PROVIDER_RETIRED");
        assert!(error["request_id"].is_string());
    }
    assert_eq!(
        before,
        [
            f.count("model_profiles").await,
            f.count("ai_run_previews").await,
            f.count("consents").await,
            f.count("model_runs").await,
            f.count("jobs").await
        ]
    );
}
#[tokio::test]
async fn queued_retired_run_fails_without_invoking_runner_and_replay_preserves_identity() {
    let f = Fixture::new().await;
    let old = f
        .historical("run_retired", "retirement_operation", RunState::Queued)
        .await;
    let runner = CountingRunner(AtomicUsize::new(0));
    let queue = weblabel_api::jobs::queue::JobQueue::new(f.state.repository.clone());
    model_jobs::process_model_next(
        &f.state.repository,
        &queue,
        "retirement_worker",
        Duration::from_secs(30),
        &runner,
    )
    .await
    .unwrap();
    assert_eq!(runner.0.load(Ordering::SeqCst), 0);
    let (status, history) = f
        .http("GET", "/api/ai/runs/run_retired/suggestions", Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    assert_eq!(history["run"]["state"], "failed");
    assert_eq!(history["run"]["provider_id"], "codex_local");
    assert_eq!(history["run"]["model_id"], "historical-model");
    let mut tx = f.state.repository.begin_write().await.unwrap();
    let snapshot: String = sqlx::query_scalar(
        "SELECT profile_snapshot_json FROM model_runs WHERE run_id='run_retired'",
    )
    .fetch_one(tx.connection())
    .await
    .unwrap();
    assert_eq!(snapshot, old.profile_snapshot_json);
    let event: String = sqlx::query_scalar(
        "SELECT data_json FROM run_events WHERE run_id='run_retired' AND event_type='failed'",
    )
    .fetch_one(tx.connection())
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&event).unwrap()["code"],
        "PROVIDER_RETIRED"
    );
    tx.commit().await.unwrap();
    let (status, replay) = f
        .http(
            "POST",
            "/api/ai/runs",
            serde_json::to_value(&f.request).unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{replay}");
    assert_eq!(replay["run_id"], old.run_id);
    assert_eq!(replay["provider_id"], "codex_local");
    assert_eq!(replay["idempotent_replay"], true);
    let mut changed = f.request.clone();
    changed.prompt = "Different payload".into();
    let (status, error) = f
        .http(
            "POST",
            "/api/ai/runs",
            serde_json::to_value(changed).unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "IDEMPOTENCY_KEY_REUSE");
    assert_eq!(f.count("model_runs").await, 1);
    assert_eq!(f.count("jobs").await, 1);
}
#[tokio::test]
async fn terminal_history_predictions_and_decisions_survive_retirement() {
    let f = Fixture::new().await;
    let old = f
        .historical("run_history", "history_operation", RunState::Succeeded)
        .await;
    let mut tx = f.state.repository.begin_write().await.unwrap();
    sqlx::query(r#"INSERT INTO predictions(prediction_id,run_id,project_id,asset_revision_id,source,raw_output_json,raw_output_bytes,created_at) VALUES('prediction_history',?,?,?,'provider','{"changes":[],"issues":[],"score":null}',39,?)"#).bind(&old.run_id).bind(&old.project_id).bind(&old.asset_revision_id).bind(NOW).execute(tx.connection()).await.unwrap();
    sqlx::query("INSERT INTO suggestion_sets(suggestion_set_id,run_id,prediction_id,project_id,asset_revision_id,changes_json,issues_json,created_at) VALUES('set_history',?,'prediction_history',?,?,'[]','[]',?)").bind(&old.run_id).bind(&old.project_id).bind(&old.asset_revision_id).bind(NOW).execute(tx.connection()).await.unwrap();
    sqlx::query("INSERT INTO suggestion_set_states VALUES('set_history','accepted',?)")
        .bind(NOW)
        .execute(tx.connection())
        .await
        .unwrap();
    sqlx::query("INSERT INTO suggestion_decisions(decision_id,suggestion_set_id,change_id,decision,bound_revision_id,actor_id,created_at) VALUES('decision_history','set_history','change_history','accept',?,?,?)").bind(&old.annotation_revision_id).bind(&f.actor).bind(NOW).execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    let queue = weblabel_api::jobs::queue::JobQueue::new(f.state.repository.clone());
    let runner = CountingRunner(AtomicUsize::new(0));
    model_jobs::process_model_next(
        &f.state.repository,
        &queue,
        "history_worker",
        Duration::from_secs(30),
        &runner,
    )
    .await
    .unwrap();
    assert_eq!(runner.0.load(Ordering::SeqCst), 0);
    let (status, history) = f
        .http("GET", "/api/ai/runs/run_history/suggestions", Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    assert_eq!(history["run"]["state"], "succeeded");
    assert_eq!(history["run"]["provider_id"], "codex_local");
    assert_eq!(history["items"][0]["state"], "accepted");
    assert_eq!(history["items"][0]["prediction_id"], "prediction_history");
    assert_eq!(f.count("predictions").await, 1);
    assert_eq!(f.count("suggestion_decisions").await, 1);
    let (status, error) = f
        .http(
            "POST",
            "/api/ai/suggestions/set_history/decision",
            json!({"decision":"accept"}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "ACCEPT_REQUIRES_SAVE");
}

#[tokio::test]
async fn historical_candidate_accept_and_revert_keep_original_provider_identity() {
    let mut f = Fixture::new().await;
    f.request.intent = annotation_domain::RunIntent::Detect;
    let old = f
        .historical("run_accept", "accept_operation", RunState::Succeeded)
        .await;
    let object = json!({"object_id":"historical_object","label_id":"label_person","geometry":{"type":"bbox_xyxy","x_min":2.0,"y_min":3.0,"x_max":20.0,"y_max":18.0},"attributes":{},"origin":{"type":"prediction","prediction_id":"prediction_accept","model_run_id":old.run_id,"import_batch_id":null}});
    let change = json!({"kind":"create","change_id":"historical_change","object":object,"before_hash":null,"reason":"historical candidate"});
    let mut tx = f.state.repository.begin_write().await.unwrap();
    sqlx::query("INSERT INTO predictions(prediction_id,run_id,project_id,asset_revision_id,source,raw_output_json,raw_output_bytes,created_at) VALUES('prediction_accept',?,?,?,'provider','{}',2,?)").bind(&old.run_id).bind(&old.project_id).bind(&old.asset_revision_id).bind(NOW).execute(tx.connection()).await.unwrap();
    sqlx::query("INSERT INTO suggestion_sets(suggestion_set_id,run_id,prediction_id,project_id,asset_revision_id,changes_json,issues_json,created_at) VALUES('set_accept',?,'prediction_accept',?,?,?,'[]',?)").bind(&old.run_id).bind(&old.project_id).bind(&old.asset_revision_id).bind(json!([change]).to_string()).bind(NOW).execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    let mut document = json!({"schema_version":1,"asset_revision_id":old.asset_revision_id,"ontology_version_id":old.ontology_version_id,"coordinate_space":{"type":"canonical_image_pixels","width":32,"height":24},"completion":"in_progress","objects":[object]});
    let path = format!("/api/assets/{}/annotation", old.asset_revision_id);
    let request = json!({"operation_id":"historical_accept_save","base_revision_id":old.annotation_revision_id,"document":document,"lease":null,"suggestion_decisions":[{"suggestion_set_id":"set_accept","change_ids":["historical_change"],"decision":"accept"}]});
    let (status, saved) = f.http("PUT", &path, request.clone()).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (status, replay) = f.http("PUT", &path, request).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["idempotent_replay"], true);
    assert_eq!(f.count("suggestion_decisions").await, 1);
    document["objects"] = json!([]);
    let (status,undone) = f.http("PUT",&path,json!({"operation_id":"historical_revert_save","base_revision_id":saved["revision"]["annotation_revision_id"],"document":document,"lease":null,"suggestion_decisions":[{"suggestion_set_id":"set_accept","change_ids":["historical_change"],"decision":"revert"}]})).await;
    assert_eq!(status, StatusCode::OK, "{undone}");
    let mut tx = f.state.repository.begin_write().await.unwrap();
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT decision,bound_revision_id FROM suggestion_decisions ORDER BY rowid",
    )
    .fetch_all(tx.connection())
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            (
                "accept".into(),
                saved["revision"]["annotation_revision_id"]
                    .as_str()
                    .unwrap()
                    .into()
            ),
            (
                "revert".into(),
                undone["revision"]["annotation_revision_id"]
                    .as_str()
                    .unwrap()
                    .into()
            )
        ]
    );
    let snapshot: String = sqlx::query_scalar(
        "SELECT profile_snapshot_json FROM model_runs WHERE run_id='run_accept'",
    )
    .fetch_one(tx.connection())
    .await
    .unwrap();
    assert_eq!(snapshot, old.profile_snapshot_json);
    let raw: String = sqlx::query_scalar(
        "SELECT raw_output_json FROM predictions WHERE prediction_id='prediction_accept'",
    )
    .fetch_one(tx.connection())
    .await
    .unwrap();
    assert_eq!(raw, "{}");
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn cancellation_has_priority_over_retirement_and_terminal_runs_are_unchanged() {
    let f = Fixture::new().await;
    f.historical("run_cancel", "cancel_operation", RunState::Queued)
        .await;
    let (status, cancelled) = f
        .http(
            "POST",
            "/api/ai/runs/run_cancel/cancel",
            json!({"reason":"synthetic cancellation"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    let queue = weblabel_api::jobs::queue::JobQueue::new(f.state.repository.clone());
    let runner = CountingRunner(AtomicUsize::new(0));
    model_jobs::process_model_next(
        &f.state.repository,
        &queue,
        "cancel_worker",
        Duration::from_secs(30),
        &runner,
    )
    .await
    .unwrap();
    assert_eq!(runner.0.load(Ordering::SeqCst), 0);
    let (status, history) = f
        .http("GET", "/api/ai/runs/run_cancel/suggestions", Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(history["run"]["state"], "cancelled");
    let mut tx = f.state.repository.begin_write().await.unwrap();
    let failures: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM run_events WHERE run_id='run_cancel' AND event_type='failed'",
    )
    .fetch_one(tx.connection())
    .await
    .unwrap();
    assert_eq!(failures, 0);
    tx.commit().await.unwrap();
}
