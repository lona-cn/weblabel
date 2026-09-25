use std::{net::SocketAddr, time::Duration};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use image::{DynamicImage, ImageFormat, RgbImage};
use serde_json::{json, Value};
use tempfile::tempdir;
use tokio::sync::Barrier;
use tower::ServiceExt;
use weblabel_api::{
    auth::{hash_launch_code, AuthConfig},
    config::ServerConfig,
    jobs::worker::MediaWorker,
    media::ingest::{import_one, ImportInput},
    router, AppState,
};

const HOST: &str = "127.0.0.1:48100";
const ORIGIN: &str = "http://127.0.0.1:48100";

struct Fixture {
    app: Router,
    repository: weblabel_api::storage::Repository,
    _directory: tempfile::TempDir,
    cookie: String,
    csrf: String,
    ontology_id: String,
    asset_revision_id: String,
    initial_revision_id: String,
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

    fn document(&self) -> Value {
        json!({
            "schema_version": 1,
            "asset_revision_id": self.asset_revision_id,
            "ontology_version_id": self.ontology_id,
            "coordinate_space": {"type":"canonical_image_pixels", "width":32, "height":24},
            "completion": "in_progress",
            "objects": []
        })
    }

    fn save_request(&self, operation_id: &str, base_revision_id: &str, document: Value) -> Value {
        json!({
            "operation_id": operation_id,
            "base_revision_id": base_revision_id,
            "document": document,
            "lease": null,
            "suggestion_decisions": []
        })
    }

    fn annotation_path(&self) -> String {
        format!(
            "/api/assets/{}/annotation?ontology_version_id={}",
            self.asset_revision_id, self.ontology_id
        )
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
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, value)
}

async fn fixture() -> Fixture {
    let directory = tempdir().unwrap();
    let config = ServerConfig {
        bind: HOST.parse::<SocketAddr>().unwrap(),
        database_url: format!("sqlite:{}", directory.path().join("api.sqlite").display()),
        object_root: directory.path().join("objects"),
        write_timeout: Duration::from_secs(2),
        production: true,
    };
    let launch_code = "t11-one-time-launch-code";
    let state = AppState::open_with_auth(
        &config,
        AuthConfig {
            bind: config.bind,
            cookie_secure: false,
            allowed_origins: vec![ORIGIN.to_owned()],
            allowed_hosts: vec![HOST.to_owned()],
            launch_code: hash_launch_code(launch_code),
            launch_code_expires_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64
                + 3600,
        },
    )
    .await
    .unwrap();
    let app = router(state.clone());
    let bootstrap_request = Request::builder()
        .method("POST")
        .uri("/api/session/bootstrap")
        .header("host", HOST)
        .header("origin", ORIGIN)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "launch_code": launch_code,
                "password": "t11-test-bootstrap-password"
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

    let (status, project) = send(
        &app,
        "POST",
        "/api/projects",
        Some(json!({
            "name": "T11 transactional save fixture",
            "description": "isolated integration fixture",
            "allow_self_review": false
        })),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{project}");
    let project_id = project["project_id"].as_str().unwrap().to_owned();
    let (status, ontology) = send(
        &app,
        "POST",
        &format!("/api/projects/{project_id}/ontologies"),
        Some(json!({
            "labels": [{
                "label_id": "vehicle",
                "name": "Vehicle",
                "color": "#0099ff",
                "attributes": [],
                "shortcut": null,
                "allowed_geometry_types": ["bbox_xyxy"]
            }],
            "guidelines_markdown": "Label visible vehicles."
        })),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{ontology}");
    let ontology_id = ontology["ontology_version_id"].as_str().unwrap().to_owned();

    let mut png = std::io::Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::new(32, 24))
        .write_to(&mut png, ImageFormat::Png)
        .unwrap();
    let imported = import_one(
        &state.repository,
        &MediaWorker::new(),
        ImportInput {
            project_id,
            ontology_version_id: ontology_id.clone(),
            actor_id: boot["user_id"].as_str().unwrap().to_owned(),
            source_group_id: "t11-fixture-source".to_owned(),
            original_name: "fixture.png".to_owned(),
            declared_mime: Some("image/png".to_owned()),
            bytes: png.into_inner(),
        },
    )
    .await
    .unwrap();
    Fixture {
        app,
        repository: state.repository,
        _directory: directory,
        cookie,
        csrf,
        ontology_id,
        asset_revision_id: imported.asset_revision_id,
        initial_revision_id: imported.annotation_revision_id,
    }
}

#[tokio::test]
async fn save_cas_replay_conflict_and_history_are_atomic() {
    let fixture = fixture().await;
    let path = fixture.annotation_path();
    let mut document = fixture.document();
    document["completion"] = json!("complete");
    document["objects"] = json!([{
        "object_id": "saved-object",
        "label_id": "vehicle",
        "geometry": {
            "type": "bbox_xyxy",
            "x_min": 2.0,
            "y_min": 3.0,
            "x_max": 20.0,
            "y_max": 18.0
        },
        "attributes": {},
        "origin": {
            "type": "manual",
            "prediction_id": null,
            "model_run_id": null,
            "import_batch_id": null
        }
    }]);
    let request = fixture.save_request("op-save-a", &fixture.initial_revision_id, document.clone());
    let (status, saved) = fixture.request("PUT", &path, Some(request.clone())).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["operation_id"], "op-save-a");
    assert_eq!(saved["revision"]["revision_no"], 2);
    assert_eq!(
        saved["revision"]["parent_revision_id"],
        fixture.initial_revision_id
    );
    assert_eq!(saved["revision"]["document"]["completion"], "complete");
    assert_eq!(
        saved["revision"]["document"]["objects"][0]["object_id"],
        "saved-object"
    );
    assert_eq!(
        saved["revision"]["document"]["objects"][0]["geometry"]["x_max"],
        20.0
    );
    assert_eq!(saved["idempotent_replay"], false);

    let (status, replay) = fixture.request("PUT", &path, Some(request)).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["idempotent_replay"], true);
    assert_eq!(
        replay["revision"]["annotation_revision_id"],
        saved["revision"]["annotation_revision_id"]
    );

    document["completion"] = json!("in_progress");
    let changed_reuse =
        fixture.save_request("op-save-a", &fixture.initial_revision_id, document.clone());
    let (status, error) = fixture.request("PUT", &path, Some(changed_reuse)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["code"], "IDEMPOTENCY_KEY_REUSE");

    let stale = fixture.save_request("op-save-b", &fixture.initial_revision_id, document);
    let (status, error) = fixture.request("PUT", &path, Some(stale)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["code"], "REVISION_CONFLICT");

    let (status, head) = fixture.request("GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{head}");
    assert_eq!(
        head["annotation_revision_id"],
        saved["revision"]["annotation_revision_id"]
    );
    let history_path = format!(
        "/api/annotation-revisions/{}",
        saved["revision"]["annotation_revision_id"]
            .as_str()
            .unwrap()
    );
    let (status, historical) = fixture.request("GET", &history_path, None).await;
    assert_eq!(status, StatusCode::OK, "{historical}");
    assert_eq!(historical, saved["revision"]);
}

#[tokio::test]
async fn save_rejects_invalid_domain_data_and_unavailable_decisions() {
    let fixture = fixture().await;
    let path = fixture.annotation_path();
    let object = json!({
        "object_id": "object-1",
        "label_id": "vehicle",
        "geometry": {
            "type": "bbox_xyxy",
            "x_min": 2.0,
            "y_min": 3.0,
            "x_max": 20.0,
            "y_max": 18.0
        },
        "attributes": {},
        "origin": {
            "type": "manual",
            "prediction_id": null,
            "model_run_id": null,
            "import_batch_id": null
        }
    });

    let mut invalid = fixture.document();
    let mut invalid_object = object.clone();
    invalid_object["label_id"] = json!("unknown-label");
    invalid["objects"] = json!([invalid_object]);
    let request = fixture.save_request("op-bad-label", &fixture.initial_revision_id, invalid);
    let (status, error) = fixture.request("PUT", &path, Some(request)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
    assert_eq!(error["code"], "UNKNOWN_LABEL");

    let mut invalid = fixture.document();
    let mut invalid_object = object.clone();
    invalid_object["geometry"] = json!({
        "type": "bbox_xyxy",
        "x_min": 20.0,
        "y_min": 3.0,
        "x_max": 2.0,
        "y_max": 18.0
    });
    invalid["objects"] = json!([invalid_object]);
    let request = fixture.save_request("op-bad-geometry", &fixture.initial_revision_id, invalid);
    let (status, error) = fixture.request("PUT", &path, Some(request)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
    assert_eq!(error["code"], "INVALID_GEOMETRY");

    let mut invalid = fixture.document();
    invalid["completion"] = json!("confirmed_negative");
    invalid["objects"] = json!([object]);
    let request = fixture.save_request("op-bad-negative", &fixture.initial_revision_id, invalid);
    let (status, error) = fixture.request("PUT", &path, Some(request)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
    assert_eq!(error["code"], "INVALID_COMPLETION");

    let mut invalid = fixture.document();
    invalid["asset_revision_id"] = json!("different-asset");
    let request = fixture.save_request("op-bad-asset", &fixture.initial_revision_id, invalid);
    let (status, error) = fixture.request("PUT", &path, Some(request)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
    assert_eq!(error["code"], "ASSET_REVISION_MISMATCH");

    let mut invalid = fixture.document();
    invalid["ontology_version_id"] = json!("unpublished-ontology");
    let request = fixture.save_request("op-bad-ontology", &fixture.initial_revision_id, invalid);
    let (status, error) = fixture.request("PUT", &path, Some(request)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
    assert_eq!(error["code"], "ONTOLOGY_NOT_FOUND");

    let mut invalid = fixture.document();
    let mut invalid_object = object.clone();
    invalid_object["origin"] = json!({
        "type": "prediction",
        "prediction_id": "forged-prediction",
        "model_run_id": "forged-run",
        "import_batch_id": null
    });
    invalid["objects"] = json!([invalid_object]);
    let request = fixture.save_request("op-forged-origin", &fixture.initial_revision_id, invalid);
    let (status, error) = fixture.request("PUT", &path, Some(request)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
    assert_eq!(error["code"], "UNVERIFIED_PROVENANCE");

    let request = fixture.save_request(
        "op-unavailable-decision",
        &fixture.initial_revision_id,
        fixture.document(),
    );
    let mut request = request;
    request["suggestion_decisions"] = json!([{
        "suggestion_set_id": "suggestion-set",
        "change_ids": ["change-1"],
        "decision": "accept"
    }]);
    let (status, error) = fixture.request("PUT", &path, Some(request)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
    assert_eq!(error["code"], "SUGGESTION_DECISIONS_UNSUPPORTED");

    let (status, head) = fixture.request("GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{head}");
    assert_eq!(head["annotation_revision_id"], fixture.initial_revision_id);
}
#[tokio::test]
async fn same_base_concurrent_saves_create_only_one_revision() {
    let fixture = fixture().await;
    let path = fixture.annotation_path();
    let first = fixture.save_request(
        "op-concurrent-a",
        &fixture.initial_revision_id,
        fixture.document(),
    );
    let second = fixture.save_request(
        "op-concurrent-b",
        &fixture.initial_revision_id,
        fixture.document(),
    );
    let barrier = Barrier::new(2);
    let first_call = async {
        barrier.wait().await;
        fixture.request("PUT", &path, Some(first)).await
    };
    let second_call = async {
        barrier.wait().await;
        fixture.request("PUT", &path, Some(second)).await
    };
    let (a, b) = tokio::join!(first_call, second_call);
    let success_count = usize::from(a.0 == StatusCode::OK) + usize::from(b.0 == StatusCode::OK);
    let conflict_count =
        usize::from(a.0 == StatusCode::CONFLICT) + usize::from(b.0 == StatusCode::CONFLICT);
    assert_eq!(
        (success_count, conflict_count),
        (1, 1),
        "a={:?} b={:?}",
        a,
        b
    );
    let mut transaction = fixture.repository.begin_write().await.unwrap();
    let revision_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM annotation_revisions WHERE asset_revision_id=?")
            .bind(&fixture.asset_revision_id)
            .fetch_one(transaction.connection())
            .await
            .unwrap();
    transaction.commit().await.unwrap();
    assert_eq!(revision_count, 2);
}
