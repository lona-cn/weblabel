//! Engineering Mock G2 programmatic sample, not a live provider claim.
//! Actual Router authorization/prediction/save and actual Rust editor undo.
use annotation_domain::{
    object_hash, AnnotationDocument, EditorCommand, OntologyVersion, SuggestionSet,
};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, net::SocketAddr, time::Duration};
use tempfile::tempdir;
use tower::ServiceExt;
use weblabel_api::{
    auth::{hash_launch_code, AuthConfig},
    config::ServerConfig,
    jobs::{
        model_jobs::{process_model_next, MockRunner, MockStep, SubmitCandidates},
        queue::JobQueue,
    },
    router, AppState,
};

const HOST: &str = "127.0.0.1:48125";
const ORIGIN: &str = "http://127.0.0.1:48125";

async fn send(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    cookie: Option<&str>,
    csrf: Option<&str>,
) -> (StatusCode, Value, Option<String>) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", HOST)
        .header("origin", ORIGIN)
        .header("content-type", "application/json");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    if let Some(csrf) = csrf {
        request = request.header("x-csrf-token", csrf);
    }
    let response = app
        .clone()
        .oneshot(
            request
                .body(Body::from(
                    body.map(|value| value.to_string()).unwrap_or_default(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let cookie = response.headers().get("set-cookie").map(|value| {
        value
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    });
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, body, cookie)
}

#[tokio::test]
async fn engineering_mock_attribute_chain_preserves_geometry_and_native_undo_restores_document() {
    let directory = tempdir().unwrap();
    let config = ServerConfig {
        bind: HOST.parse::<SocketAddr>().unwrap(),
        database_url: format!("sqlite:{}", directory.path().join("audit.sqlite").display()),
        object_root: directory.path().join("objects"),
        write_timeout: Duration::from_secs(2),
        production: false,
    };
    let state = AppState::open_with_auth(
        &config,
        AuthConfig {
            bind: config.bind,
            cookie_secure: false,
            allowed_origins: vec![ORIGIN.to_owned()],
            allowed_hosts: vec![HOST.to_owned()],
            launch_code: hash_launch_code("t25-audit-launch"),
            launch_code_expires_at: chrono::Utc::now().timestamp() + 3600,
        },
    )
    .await
    .unwrap();
    let app = router(state.clone());
    let (status, login, cookie) = send(
        &app,
        "POST",
        "/api/session/bootstrap",
        Some(json!({"launch_code":"t25-audit-launch","password":"t25-audit-bootstrap-password"})),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{login}");
    let cookie = cookie.unwrap();
    let csrf = login["csrf_token"].as_str().unwrap();
    let actor = login["user_id"].as_str().unwrap();
    let (status, project, _) = send(&app, "POST", "/api/projects", Some(json!({"name":"Engineering Mock attribute audit", "description":"Synthetic only; G2 not G4", "allow_self_review":false})), Some(&cookie), Some(csrf)).await;
    assert_eq!(status, StatusCode::CREATED, "{project}");
    let project_id = project["project_id"].as_str().unwrap();
    let ontology_request = json!({"labels":[{"label_id":"label-person","name":"Person","color":"#0099ff","shortcut":null,"allowed_geometry_types":["bbox_xyxy"],"attributes":[{"key":"helmet_state","kind":"enum","required":true,"default_value":"unknown","enum_values":["wearing","not_wearing","unknown"],"min":null,"max":null}]}],"guidelines_markdown":"Attribute audit must not change boxes"});
    let (status, ontology, _) = send(
        &app,
        "POST",
        &format!("/api/projects/{project_id}/ontologies"),
        Some(ontology_request),
        Some(&cookie),
        Some(csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{ontology}");
    let ontology: OntologyVersion = serde_json::from_value(ontology).unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image::RgbImage::new(32, 24))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let imported = weblabel_api::media::ingest::import_one(
        &state.repository,
        &weblabel_api::jobs::worker::MediaWorker::new(),
        weblabel_api::media::ingest::ImportInput {
            project_id: project_id.to_owned(),
            ontology_version_id: ontology.ontology_version_id.to_string(),
            actor_id: actor.to_owned(),
            source_group_id: "t25-synthetic".into(),
            original_name: "synthetic.png".into(),
            declared_mime: Some("image/png".into()),
            bytes: png.into_inner(),
        },
    )
    .await
    .unwrap();
    let path = format!("/api/assets/{}/annotation", imported.asset_revision_id);
    let read_path = format!(
        "{path}?ontology_version_id={}",
        &*ontology.ontology_version_id
    );
    let (status, initial, _) = send(&app, "GET", &read_path, None, Some(&cookie), Some(csrf)).await;
    assert_eq!(status, StatusCode::OK, "{initial}");
    let mut document: AnnotationDocument =
        serde_json::from_value(initial["document"].clone()).unwrap();
    document.objects.push(serde_json::from_value(json!({"object_id":"object-person","label_id":"label-person","geometry":{"type":"bbox_xyxy","x_min":2,"y_min":3,"x_max":20,"y_max":21},"attributes":{"helmet_state":"unknown"},"origin":{"type":"manual","prediction_id":null,"model_run_id":null,"import_batch_id":null}})).unwrap());
    let (status, saved, _) = send(&app, "PUT", &path, Some(json!({"operation_id":"audit-manual-save","base_revision_id":initial["annotation_revision_id"],"document":document,"lease":null,"suggestion_decisions":[]})), Some(&cookie), Some(csrf)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (_, original, _) = send(&app, "GET", &read_path, None, Some(&cookie), Some(csrf)).await;
    let document: AnnotationDocument =
        serde_json::from_value(original["document"].clone()).unwrap();
    let geometry_before = document.objects[0].geometry.clone();
    let before_hash = object_hash(&document.objects[0]);
    let mut editor = editor_core::Editor::new(document.clone(), ontology.clone()).unwrap();
    let mut tx = state.repository.begin_write().await.unwrap();
    sqlx::query("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES('t25-audit-mock','mock','weblabel-mock-source-v1','none',?,'ready','mock_only','builtin-mock-1',NULL,'{}',NULL,'2026-10-06T00:00:00Z')")
        .bind(json!({"image_input":true,"tools":false,"structured_output":true,"bbox_output":false,"attributes":true}).to_string()).execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    let request = json!({"operation_id":"audit-run","profile_id":"t25-audit-mock","context":{"project_id":project_id,"asset_revision_id":imported.asset_revision_id,"annotation_revision_id":original["annotation_revision_id"],"ontology_version_id":ontology.ontology_version_id,"draft_generation":0,"canonical_sha256":imported.canonical_sha256,"selected_object_ids":["object-person"],"object_hashes":{"object-person":before_hash},"input_fingerprint":""},"intent":"audit_attributes","prompt":"Engineering Mock: audit helmet, never geometry","consent_id":null});
    let (status, preview, _) = send(&app, "POST", "/api/ai/previews", Some(json!({"request":request,"grants":{"allow_image":true,"allow_object_context":true,"preview_crop":null}})), Some(&cookie), Some(csrf)).await;
    assert_eq!(status, StatusCode::CREATED, "{preview}");
    let (status, consent, _) = send(
        &app,
        "POST",
        "/api/ai/consents",
        Some(json!({"preview_id":preview["preview_id"]})),
        Some(&cookie),
        Some(csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{consent}");
    let mut authorized = preview["request"].clone();
    authorized["consent_id"] = consent["consent_id"].clone();
    let (status, run, _) = send(
        &app,
        "POST",
        "/api/ai/runs",
        Some(authorized),
        Some(&cookie),
        Some(csrf),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{run}");
    assert_eq!(run["source"], "mock");
    assert_eq!(run["verification"], "mock_only");
    let run_id = run["run_id"].as_str().unwrap();
    let runner = MockRunner::with_scripts(BTreeMap::from([(
        run_id.to_owned(),
        vec![
            MockStep::Candidate(SubmitCandidates {
                provider_event_id: "audit-candidate".into(),
                provider_seq: Some(1),
                raw: json!({"changes":[{"kind":"set_attributes","change_id":"audit-change","object_id":"object-person","values":{"helmet_state":"wearing"},"before_hash":before_hash,"reason":"Explicit engineering Mock attribute sample"}],"issues":[],"score":null}),
            }),
            MockStep::Complete,
        ],
    )]));
    assert!(process_model_next(
        &state.repository,
        &JobQueue::new(state.repository.clone()),
        "audit-test-worker",
        Duration::from_secs(30),
        &runner
    )
    .await
    .unwrap()
    .is_some());
    let (status, suggestions, _) = send(
        &app,
        "GET",
        &format!("/api/ai/runs/{run_id}/suggestions"),
        None,
        Some(&cookie),
        Some(csrf),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{suggestions}");
    assert_eq!(suggestions["items"].as_array().unwrap().len(), 1);
    assert_eq!(suggestions["run"]["state"], "succeeded");
    let set: SuggestionSet = serde_json::from_value(suggestions["items"][0].clone()).unwrap();
    assert_eq!(
        serde_json::to_value(&set.context).unwrap(),
        preview["request"]["context"]
    );
    let (_, untouched, _) = send(&app, "GET", &read_path, None, Some(&cookie), Some(csrf)).await;
    assert_eq!(untouched, original, "prediction must not write annotations");
    let mut tx = state.repository.begin_write().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM suggestion_decisions")
        .fetch_one(tx.connection())
        .await
        .unwrap();
    assert_eq!(count, 0);
    tx.commit().await.unwrap();
    let accepted_delta = editor
        .dispatch(EditorCommand::ApplySuggestions {
            set: set.clone(),
            change_ids: vec!["audit-change".into()],
            expected_generation: 0,
        })
        .unwrap();
    let accepted_document = editor.snapshot();
    assert_eq!(accepted_document.objects.len(), 1);
    assert_eq!(accepted_document.objects[0].geometry, geometry_before);
    assert_eq!(
        serde_json::to_value(&accepted_document.objects[0].attributes).unwrap()["helmet_state"],
        "wearing"
    );
    let (status, accepted_save, _) = send(&app, "PUT", &path, Some(json!({"operation_id":"audit-accept-save","base_revision_id":original["annotation_revision_id"],"document":accepted_document,"lease":null,"suggestion_decisions":accepted_delta.suggestion_decisions})), Some(&cookie), Some(csrf)).await;
    assert_eq!(status, StatusCode::OK, "{accepted_save}");
    let (_, accepted, _) = send(&app, "GET", &read_path, None, Some(&cookie), Some(csrf)).await;
    assert_ne!(
        accepted["annotation_revision_id"],
        original["annotation_revision_id"]
    );
    assert_eq!(
        accepted["document"],
        serde_json::to_value(&accepted_document).unwrap()
    );
    let undo_delta = editor.dispatch(EditorCommand::Undo).unwrap();
    assert_eq!(
        editor.snapshot(),
        document,
        "one native undo restores all attributes and geometry"
    );
    assert_eq!(undo_delta.suggestion_decisions.len(), 1);
    let (status, reverted_save, _) = send(&app, "PUT", &path, Some(json!({"operation_id":"audit-revert-save","base_revision_id":accepted["annotation_revision_id"],"document":editor.snapshot(),"lease":null,"suggestion_decisions":undo_delta.suggestion_decisions})), Some(&cookie), Some(csrf)).await;
    assert_eq!(status, StatusCode::OK, "{reverted_save}");
    let (_, reverted, _) = send(&app, "GET", &read_path, None, Some(&cookie), Some(csrf)).await;
    assert_ne!(
        reverted["annotation_revision_id"],
        accepted["annotation_revision_id"]
    );
    assert_eq!(reverted["document"], original["document"]);
    let mut tx = state.repository.begin_write().await.unwrap();
    let journal: Vec<(String, String)> = sqlx::query_as("SELECT decision,bound_revision_id FROM suggestion_decisions WHERE suggestion_set_id=? ORDER BY rowid").bind(set.suggestion_set_id.to_string()).fetch_all(tx.connection()).await.unwrap();
    assert_eq!(
        journal,
        vec![
            (
                "accept".into(),
                accepted["annotation_revision_id"].as_str().unwrap().into()
            ),
            (
                "revert".into(),
                reverted["annotation_revision_id"].as_str().unwrap().into()
            )
        ]
    );
    tx.commit().await.unwrap();
    let (_, immutable_prediction, _) = send(
        &app,
        "GET",
        &format!("/api/ai/runs/{run_id}/suggestions"),
        None,
        Some(&cookie),
        Some(csrf),
    )
    .await;
    assert_eq!(
        immutable_prediction["items"][0]["changes"],
        suggestions["items"][0]["changes"]
    );
}
