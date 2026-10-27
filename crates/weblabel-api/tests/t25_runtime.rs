//! Native production factory + real API/queue boundary; synthetic loopback HTTP.
//! No detector, official CLI, account, or paid model is exercised.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    routing::post,
    Router,
};
use image::{DynamicImage, ImageFormat, RgbImage};
use serde_json::{json, Value};
use std::{net::SocketAddr, path::Path, time::Duration};
use tower::ServiceExt;
use weblabel_api::{
    auth::{hash_launch_code, AuthConfig},
    config::ServerConfig,
    jobs::{model_jobs::process_model_next, queue::JobQueue},
    media::ingest::{import_one, ImportInput},
    router,
    runtime::runner::ProductionRunner,
    AppState,
};

const HOST: &str = "127.0.0.1:48225";
async fn call(
    app: &Router,
    path: &str,
    body: Value,
    cookie: Option<&str>,
    csrf: Option<&str>,
) -> (StatusCode, Value, Option<String>) {
    let mut request = Request::builder()
        .method(if path.ends_with("/external-processing-policy") {
            "PUT"
        } else {
            "POST"
        })
        .uri(path)
        .header("host", HOST)
        .header("origin", format!("http://{HOST}"))
        .header("content-type", "application/json");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    if let Some(csrf) = csrf {
        request = request.header("x-csrf-token", csrf);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_owned());
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap(), cookie)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn native_factory_submits_validated_predictions_and_reclaims_tokens() {
    scenario("success").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn timeout_revokes_token_without_retry() {
    scenario("timeout").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancellation_stops_silent_provider() {
    scenario("cancel").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn crop_only_run_never_requests_or_sends_full_image() {
    scenario("crop").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unconfigured_real_profile_fails_without_mock_or_model_call() {
    scenario("unconfigured").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn changed_native_parameters_cannot_reuse_approved_configuration() {
    scenario("changed_config").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn expired_capability_cannot_start_provider_or_issue_new_token() {
    scenario("expired").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn policy_revocation_stops_silent_provider_and_revokes_token() {
    scenario("policy_revoke").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn membership_demotion_stops_silent_provider_before_deadline() {
    scenario("membership_revoke").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn malformed_native_output_never_publishes_or_adopts_candidates() {
    scenario("invalid_output").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn truncated_native_stream_never_publishes_or_retries() {
    scenario("truncated_output").await;
}
async fn scenario(scenario: &'static str) {
    // Give only this fixture process a synthetic credential, without mutating
    // the parallel test harness environment or inspecting any user credential.
    if std::env::var("R09_SYNTHETIC_CONSUMER").as_deref() != Ok(scenario) {
        let name = match scenario {
            "success" => "native_factory_submits_validated_predictions_and_reclaims_tokens",
            "timeout" => "timeout_revokes_token_without_retry",
            "cancel" => "cancellation_stops_silent_provider",
            "crop" => "crop_only_run_never_requests_or_sends_full_image",
            "unconfigured" => "unconfigured_real_profile_fails_without_mock_or_model_call",
            "changed_config" => "changed_native_parameters_cannot_reuse_approved_configuration",
            "expired" => "expired_capability_cannot_start_provider_or_issue_new_token",
            "policy_revoke" => "policy_revocation_stops_silent_provider_and_revokes_token",
            "membership_revoke" => "membership_demotion_stops_silent_provider_before_deadline",
            "invalid_output" => "malformed_native_output_never_publishes_or_adopts_candidates",
            "truncated_output" => "truncated_native_stream_never_publishes_or_retries",
            _ => unreachable!(),
        };
        let output = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", name, "--nocapture"])
            .env("R09_SYNTHETIC_CONSUMER", scenario)
            .env("SYNTHETIC_KEY", "engineering-synthetic-key")
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("1 passed"),
            "the isolated consumer must actually execute exactly one test"
        );
        return;
    }
    let root =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/test-artifacts/R09-runtime");
    std::fs::create_dir_all(&root).unwrap();
    let temp = tempfile::tempdir_in(root).unwrap();
    let config = ServerConfig {
        bind: HOST.parse::<SocketAddr>().unwrap(),
        database_url: format!("sqlite:{}", temp.path().join("runtime.sqlite").display()),
        object_root: temp.path().join("objects"),
        write_timeout: Duration::from_secs(2),
        production: true,
    };
    let state = AppState::open_with_auth(
        &config,
        AuthConfig {
            bind: config.bind,
            cookie_secure: false,
            allowed_origins: vec![format!("http://{HOST}")],
            allowed_hosts: vec![HOST.to_owned()],
            launch_code: hash_launch_code("runtime-synthetic-launch"),
            launch_code_expires_at: chrono::Utc::now().timestamp() + 3600,
        },
    )
    .await
    .unwrap();
    let app = router(state.clone());
    let (status, login, cookie) = call(
        &app,
        "/api/session/bootstrap",
        json!({"launch_code":"runtime-synthetic-launch","password":"runtime-synthetic-password"}),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cookie = cookie.unwrap();
    let csrf = login["csrf_token"].as_str().unwrap();
    let actor = login["user_id"].as_str().unwrap();
    let (status, project, _) = call(&app, "/api/projects", json!({"name":"Synthetic runtime","description":"engineering only","allow_self_review":false}), Some(&cookie), Some(csrf)).await;
    assert_eq!(status, StatusCode::CREATED, "{project}");
    let project = project["project_id"].as_str().unwrap();
    let (status, ontology, _) = call(
        &app,
        &format!("/api/projects/{project}/ontologies"),
        json!({"labels":[{"label_id":"runtime-bbox","name":"Synthetic runtime bbox","color":"#33AA66","shortcut":null,"allowed_geometry_types":["bbox_xyxy"],"attributes":[]}],"guidelines_markdown":"Synthetic engineering smoke"}),
        Some(&cookie),
        Some(csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{ontology}");
    let ontology = ontology["ontology_version_id"].as_str().unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::new(32, 24))
        .write_to(&mut png, ImageFormat::Png)
        .unwrap();
    let asset = import_one(
        &state.repository,
        &weblabel_api::jobs::worker::MediaWorker::new(),
        ImportInput {
            project_id: project.to_owned(),
            ontology_version_id: ontology.to_owned(),
            actor_id: actor.to_owned(),
            source_group_id: "runtime-synthetic".to_owned(),
            original_name: "synthetic.png".to_owned(),
            declared_mime: Some("image/png".to_owned()),
            bytes: png.into_inner(),
        },
    )
    .await
    .unwrap();
    let capabilities = json!({"image_input":true,"tools":true,"structured_output":true,"bbox_output":true,"attributes":true});
    let model_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let model_base = format!("http://{}", model_listener.local_addr().unwrap());
    let execution_config = json!({"profile_id":"runtime-profile","model_id":"engineering-synthetic-model","credential":{"secret_ref":"env:SYNTHETIC_KEY"},"account_model_verified":true,"capabilities":capabilities,"api_base":model_base,"base_approval":{"approved":true,"approved_by":"engineering-admin","approved_at":"2026-10-06T00:00:00Z","allow_private_network":true,"allow_insecure_http":true},"local_admins":["engineering-admin"]});
    let (status, policy, _) = call(
        &app,
        &format!("/api/projects/{project}/external-processing-policy"),
        json!({"allow_external_processing":true}),
        Some(&cookie),
        Some(csrf),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{policy}");
    let mut tx = state.repository.begin_write().await.unwrap();
    sqlx::query("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES('runtime-profile','mimo_api','engineering-synthetic-model','api_key',?,'ready','not_run',NULL,NULL,?,'env:SYNTHETIC_KEY','2026-10-06T00:00:00Z')").bind(capabilities.to_string()).bind(execution_config.to_string()).execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    let request = json!({"operation_id":"runtime-operation","profile_id":"runtime-profile","context":{"project_id":project,"asset_revision_id":asset.asset_revision_id,"annotation_revision_id":asset.annotation_revision_id,"ontology_version_id":ontology,"draft_generation":0,"canonical_sha256":asset.canonical_sha256,"selected_object_ids":[],"object_hashes":{},"input_fingerprint":"not-trusted"},"intent":"find_issues","prompt":"synthetic fixture only","consent_id":null});
    let crop = if scenario == "crop" {
        json!({"type":"bbox_xyxy","x_min":4.0,"y_min":4.0,"x_max":20.0,"y_max":20.0})
    } else {
        Value::Null
    };
    let (status, preview, _) = call(&app, "/api/ai/previews", json!({"request":request,"grants":{"allow_image":scenario=="crop","allow_object_context":false,"preview_crop":crop}}), Some(&cookie), Some(csrf)).await;
    assert_eq!(status, StatusCode::CREATED, "{preview}");
    let (status, consent, _) = call(
        &app,
        "/api/ai/consents",
        json!({"preview_id":preview["preview_id"]}),
        Some(&cookie),
        Some(csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{consent}");
    let mut request = preview["request"].clone();
    request["consent_id"] = consent["consent_id"].clone();
    let (status, created, _) = call(&app, "/api/ai/runs", request, Some(&cookie), Some(csrf)).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let run_id = created["run_id"].as_str().unwrap();
    if scenario == "expired" {
        let mut tx = state.repository.begin_write().await.unwrap();
        // Seed an already-expired immutable authorization in this synthetic repository.
        sqlx::query("INSERT OR REPLACE INTO model_run_authorizations(run_id,preview_id,grants_json,profile_configuration_hash,capability_expires_at) SELECT run_id,preview_id,grants_json,profile_configuration_hash,'2020-01-01T00:00:00.000Z' FROM model_run_authorizations WHERE run_id=?").bind(run_id).execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
    }
    let model_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = model_calls.clone();
    let model = Router::new().route("/chat/completions", post(move |axum::Json(body): axum::Json<Value>| {
        let counter = counter.clone();
        async move {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(body.to_string().contains("data:image/png;base64,"), scenario == "crop");
            if !matches!(scenario, "success" | "crop" | "invalid_output" | "truncated_output") {
                std::future::pending::<()>().await;
            }
            let draft = json!({"changes":[],"issues":[{"issue_id":"runtime-issue","object_id":null,"code":"synthetic_review","message":"Engineering fixture only","region":null}],"score":null});
            let text = if scenario == "invalid_output" { "not candidate JSON".to_owned() } else { draft.to_string() };
            let frame = json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":"stop"}]});
            let response = if scenario == "truncated_output" { "data: {\"choices\":".to_owned() } else { format!("data: {frame}\n\ndata: [DONE]\n\n") };
            ([("content-type", "text/event-stream")], response)
        }
    }));
    let model_server = tokio::spawn(async move {
        axum::serve(model_listener, model).await.unwrap();
    });
    // Native HTTP invokes the shared authorized tool service in-process. The
    // API address is used only by providers that actually spawn MCP children.
    let api_address = config.bind;
    let native_config = temp.path().join("runtime.json");
    let mut native_execution = execution_config.clone();
    if scenario == "changed_config" {
        native_execution["budgets"] = json!({"max_tool_turns":500});
    }
    std::fs::write(&native_config, json!({"schema_version":1,"timeout_ms":10000,"providers":[{"provider":"mimo_api","config":native_execution}]}).to_string()).unwrap();
    let runner = if scenario == "unconfigured" {
        ProductionRunner::unconfigured(state.run_tokens.clone())
    } else {
        ProductionRunner::new(
            state.repository.clone(),
            api_address,
            &native_config.canonicalize().unwrap(),
            &["SYNTHETIC_KEY".to_owned()],
            state.run_tokens.clone(),
            Duration::from_secs(if scenario == "timeout" { 2 } else { 10 }),
        )
        .unwrap()
    };
    let queue = JobQueue::new(state.repository.clone());
    let cancel = async {
        if !matches!(scenario, "cancel" | "policy_revoke" | "membership_revoke") {
            return;
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while model_calls.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "provider was not contacted"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        if scenario == "membership_revoke" {
            let (status, membership, _) = call(
                &app,
                &format!("/api/projects/{project}/members"),
                json!({"user_id":actor,"role":"viewer"}),
                Some(&cookie),
                Some(csrf),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{membership}");
            return;
        }
        if scenario == "policy_revoke" {
            let (status, policy, _) = call(
                &app,
                &format!("/api/projects/{project}/external-processing-policy"),
                json!({"allow_external_processing":false}),
                Some(&cookie),
                Some(csrf),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{policy}");
            assert_eq!(policy["allow_external_processing"], false);
            return;
        }
        weblabel_api::ai::runs::cancel(
            &state.repository,
            &state.run_tokens,
            run_id,
            actor,
            "synthetic cancellation",
        )
        .await
        .unwrap();
    };
    let (execution, _) = tokio::join!(
        process_model_next(
            &state.repository,
            &queue,
            "runtime-worker",
            Duration::from_secs(30),
            &runner
        ),
        cancel
    );
    assert!(execution.unwrap().is_some());
    runner.shutdown().await.unwrap();
    let mut tx = state.repository.begin_write().await.unwrap();
    let status: String = sqlx::query_scalar("SELECT state FROM model_runs WHERE run_id=?")
        .bind(run_id)
        .fetch_one(tx.connection())
        .await
        .unwrap();
    let predictions: i64 = sqlx::query_scalar("SELECT count(*) FROM predictions WHERE run_id=?")
        .bind(run_id)
        .fetch_one(tx.connection())
        .await
        .unwrap();
    let events: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT event_type,message,data_json FROM run_events WHERE run_id=? ORDER BY seq",
    )
    .bind(run_id)
    .fetch_all(tx.connection())
    .await
    .unwrap();
    let revisions: i64 =
        sqlx::query_scalar("SELECT count(*) FROM annotation_revisions WHERE project_id=?")
            .bind(project)
            .fetch_one(tx.connection())
            .await
            .unwrap();
    assert_eq!(
        revisions, 1,
        "provider output must never adopt itself into a human revision"
    );
    let decisions: i64 = sqlx::query_scalar("SELECT count(*) FROM suggestion_decisions d JOIN suggestion_sets s ON s.suggestion_set_id=d.suggestion_set_id WHERE s.run_id=?")
        .bind(run_id).fetch_one(tx.connection()).await.unwrap();
    assert_eq!(
        decisions, 0,
        "generation cannot create an adoption journal entry"
    );
    let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM suggestion_sets s JOIN suggestion_set_states st ON st.suggestion_set_id=s.suggestion_set_id JOIN predictions p ON p.prediction_id=s.prediction_id WHERE s.run_id=? AND st.state='pending' AND p.source='provider'")
        .bind(run_id).fetch_one(tx.connection()).await.unwrap();
    assert_eq!(
        pending, predictions,
        "only validated, transactionally published provider candidates remain pending"
    );
    tx.commit().await.unwrap();
    assert_eq!(
        status,
        match scenario {
            "success" | "crop" => "succeeded",
            "cancel" | "policy_revoke" | "membership_revoke" => "cancelled",
            _ => "failed",
        },
        "events={events:?}"
    );
    assert_eq!(
        predictions,
        if matches!(scenario, "success" | "crop") {
            1
        } else {
            0
        }
    );
    assert_eq!(
        model_calls.load(std::sync::atomic::Ordering::SeqCst),
        if matches!(scenario, "unconfigured" | "changed_config" | "expired") {
            0
        } else {
            1
        }
    );
    assert_eq!(state.run_tokens.active_tokens_for_run(run_id), 0);
    println!("synthetic scenario={scenario} state={status} predictions={predictions} model_calls={} active_tokens={}", model_calls.load(std::sync::atomic::Ordering::SeqCst), state.run_tokens.active_tokens_for_run(run_id));
    if scenario == "expired" {
        assert!(events.iter().any(|(_, _, data)| data
            .as_deref()
            .is_some_and(|data| data.contains("RUN_CAPABILITY_EXPIRED"))));
    }
    if scenario == "timeout" {
        assert!(events.iter().any(|(_, _, data)| {
            data.as_deref().is_some_and(|data| {
                serde_json::from_str::<Value>(data).unwrap()["code"] == "timeout"
            })
        }));
    }
    if scenario == "changed_config" {
        assert!(events.iter().any(|(_, _, data)| data
            .as_deref()
            .is_some_and(|data| data.contains("PROFILE_CONFIGURATION_CONFLICT"))));
    }
    if scenario == "crop" {
        assert!(events
            .iter()
            .filter_map(|(_, _, data)| data.as_ref())
            .map(|data| serde_json::from_str::<Value>(data).unwrap())
            .any(|data| data["kind"] == "crop" && data["pixel_count"] == 256));
    }
    model_server.abort();
}
