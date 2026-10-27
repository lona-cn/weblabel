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

// C06: a valid lease for an asset does not authorize a different immutable ontology.
async fn commercial_task_on_other_ontology(fixture: &Fixture) {
    let (status, ontology) = fixture.request("POST", &format!("/api/projects/{}/ontologies", fixture.project_id), Some(json!({
        "labels": [{"label_id":"vehicle","name":"Vehicle v2","color":"#0099ff","attributes":[],"shortcut":null,"allowed_geometry_types":["bbox_xyxy"]}],
        "guidelines_markdown":"Task is fixed to this new version, not the original annotation head."
    }))).await;
    assert_eq!(status, StatusCode::CREATED, "{ontology}");
    let (status, session) = fixture.request("GET", "/api/session", None).await;
    assert_eq!(status, StatusCode::OK, "{session}");
    let (status, task) = fixture
        .request(
            "POST",
            &format!("/api/projects/{}/tasks", fixture.project_id),
            Some(json!({
                "asset_revision_id":fixture.asset_revision_id,
                "ontology_version_id":ontology["ontology_version_id"],
                "assignee_id":session["user_id"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{task}");
}

async fn commercial_claim_task(fixture: &Fixture) -> Value {
    let (status, tasks) = fixture
        .request(
            "GET",
            &format!("/api/projects/{}/tasks", fixture.project_id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{tasks}");
    let task_id = tasks["items"][0]["task_id"].as_str().unwrap();
    let (status, lease) = fixture
        .request(
            "POST",
            &format!("/api/tasks/{task_id}/lease"),
            Some(json!({"action":"acquire"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{lease}");
    json!({"task_id":task_id,"fencing_token":lease["fencing_token"]})
}

async fn commercial_annotation_storage(
    fixture: &Fixture,
) -> (Vec<(String, String)>, i64, i64, i64) {
    let mut tx = fixture.repository.begin_write().await.unwrap();
    let heads = sqlx::query_as::<_, (String, String)>("SELECT ontology_version_id,annotation_revision_id FROM annotation_heads WHERE asset_revision_id=? ORDER BY ontology_version_id")
        .bind(&fixture.asset_revision_id).fetch_all(tx.connection()).await.unwrap();
    let revisions =
        sqlx::query_scalar("SELECT COUNT(*) FROM annotation_revisions WHERE asset_revision_id=?")
            .bind(&fixture.asset_revision_id)
            .fetch_one(tx.connection())
            .await
            .unwrap();
    let decisions = sqlx::query_scalar("SELECT COUNT(*) FROM suggestion_decisions")
        .fetch_one(tx.connection())
        .await
        .unwrap();
    let operations = sqlx::query_scalar("SELECT COUNT(*) FROM idempotency_keys")
        .fetch_one(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    (heads, revisions, decisions, operations)
}

#[tokio::test]
async fn commercial_task_ontology_save_rejects_without_mutating_storage() {
    let fixture = fixture().await;
    commercial_task_on_other_ontology(&fixture).await;
    let lease = commercial_claim_task(&fixture).await;
    let before = commercial_annotation_storage(&fixture).await;
    let mut document = fixture.document();
    document["completion"] = json!("complete");
    document["objects"] = json!([{"object_id":"c06-manual","label_id":"vehicle","geometry":{"type":"bbox_xyxy","x_min":1,"y_min":2,"x_max":10,"y_max":12},"attributes":{},"origin":{"type":"manual","prediction_id":null,"model_run_id":null,"import_batch_id":null}}]);
    let mut request = fixture.save_request(
        "c06-wrong-ontology-save",
        &fixture.initial_revision_id,
        document,
    );
    request["lease"] = lease;
    let (status, error) = fixture
        .request("PUT", &fixture.annotation_path(), Some(request))
        .await;
    let after = commercial_annotation_storage(&fixture).await;
    assert_eq!(
        (status, error["code"].clone(), after),
        (
            StatusCode::CONFLICT,
            json!("TASK_ONTOLOGY_MISMATCH"),
            before
        ),
        "{error}"
    );
}

#[tokio::test]
async fn commercial_task_ontology_import_rejects_without_mutating_storage() {
    let fixture = fixture().await;
    // Preview is a genuine read-only parser operation for the existing v1 head.
    let boundary = "c06-import-boundary";
    let data = json!({"images":[{"id":17,"file_name":"fixture.png","width":32,"height":24}],"categories":[{"id":90,"name":"Vehicle","label_id":"vehicle"}],"annotations":[{"id":1,"image_id":17,"category_id":90,"bbox":[1,2,9,10],"iscrowd":0}]});
    let body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"format\"\r\n\r\ncoco\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"ontology_version_id\"\r\n\r\n{}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"data\"; filename=\"annotations.json\"\r\nContent-Type: application/json\r\n\r\n{data}\r\n--{boundary}--\r\n", fixture.ontology_id);
    let response = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/assets/{}/annotation-import-previews",
                    fixture.asset_revision_id
                ))
                .header("host", HOST)
                .header("origin", ORIGIN)
                .header("cookie", &fixture.cookie)
                .header("x-csrf-token", &fixture.csrf)
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let preview: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["base_revision_id"], fixture.initial_revision_id);
    commercial_task_on_other_ontology(&fixture).await;
    let lease = commercial_claim_task(&fixture).await;
    let before = commercial_annotation_storage(&fixture).await;
    let (status, error) = fixture.request("POST", &format!("/api/annotation-import-previews/{}/commit", preview["import_batch_id"].as_str().unwrap()), Some(json!({"loss_ack":true,"operation_id":"bd6cd77d-9b47-4a92-a7db-0b40be560006","lease":lease}))).await;
    let after = commercial_annotation_storage(&fixture).await;
    assert_eq!(
        (status, error["code"].clone(), after),
        (
            StatusCode::CONFLICT,
            json!("TASK_ONTOLOGY_MISMATCH"),
            before
        ),
        "{error}"
    );
}

struct Fixture {
    app: Router,
    state: AppState,
    repository: weblabel_api::storage::Repository,
    _directory: tempfile::TempDir,
    cookie: String,
    csrf: String,
    project_id: String,
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
            project_id: project_id.clone(),
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
        repository: state.repository.clone(),
        state,
        _directory: directory,
        cookie,
        csrf,
        project_id,
        ontology_id,
        asset_revision_id: imported.asset_revision_id,
        initial_revision_id: imported.annotation_revision_id,
    }
}

async fn setup_route_pool_and_acquisition(
    fixture: &Fixture,
) -> (Router, tokio::sync::mpsc::UnboundedReceiver<usize>) {
    let database = fixture._directory.path().join("api.sqlite");
    let acquisitions = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = acquisitions.clone();
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&database)
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(2));
    // Observe the transaction acquisition after the two authentication reads
    // and project-role read. No production hooks or timing-only start signal.
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .test_before_acquire(false)
        .before_acquire(move |_, _| {
            let count = count.clone();
            let sender = sender.clone();
            Box::pin(async move {
                let number = count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                sender.send(number).unwrap();
                Ok(true)
            })
        })
        .connect_with(options)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while pool.num_idle() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    acquisitions.store(0, std::sync::atomic::Ordering::SeqCst);
    while receiver.try_recv().is_ok() {}
    let mut state = fixture.state.clone();
    state.auth.pool = pool.clone();
    let app = router(state);
    (app, receiver)
}

#[tokio::test]
async fn ontology_publish_waits_for_writer_before_allocating_next_version() {
    let fixture = fixture().await;
    let (app, mut receiver) = setup_route_pool_and_acquisition(&fixture).await;
    let path = format!("/api/projects/{}/ontologies", fixture.project_id);
    let competing_ontology = json!({
        "ontology_version_id": "competing-ontology",
        "project_id": fixture.project_id,
        "version_no": 2,
        "labels": [],
        "guidelines_markdown": "Committed by the competing writer.",
        "allow_out_of_bounds": false
    });
    let mut competitor = fixture.repository.begin_write().await.unwrap();
    sqlx::query("INSERT INTO ontology_versions(ontology_version_id,project_id,version_no,body_json,created_at) VALUES(?,?,?,?,?)")
        .bind("competing-ontology")
        .bind(&fixture.project_id)
        .bind(2_i64)
        .bind(competing_ontology.to_string())
        .bind("2026-10-08T00:00:00Z")
        .execute(competitor.connection())
        .await
        .unwrap();
    let request_app = app.clone();
    let request_path = path.clone();
    let cookie = fixture.cookie.clone();
    let csrf = fixture.csrf.clone();
    let mut request = tokio::spawn(async move {
        send(
            &request_app,
            "POST",
            &request_path,
            Some(json!({"labels": [{"label_id":"published-label","name":"Published label","color":"#123456","attributes":[],"shortcut":null,"allowed_geometry_types":["bbox_xyxy"]}], "guidelines_markdown": "Published after the writer."})),
            Some(&cookie),
            Some(&csrf),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while receiver.recv().await.unwrap() != 4 {}
    })
    .await
    .expect("authenticated ontology request did not reach transaction acquisition");
    let blocked = tokio::time::timeout(Duration::from_millis(200), &mut request).await;
    assert!(
        blocked.is_err(),
        "ontology publish must wait for the held writer, not return: {blocked:?}"
    );

    competitor.commit().await.unwrap();
    let (status, published) = tokio::time::timeout(Duration::from_secs(5), request)
        .await
        .expect("ontology publish did not finish after writer release")
        .unwrap();
    assert_eq!(status, StatusCode::CREATED, "{published}");
    assert_eq!(published["version_no"], 3);
    let (status, listed) = fixture.request("GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    let items = listed["items"].as_array().unwrap();
    assert_eq!(
        items
            .iter()
            .map(|item| item["version_no"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![3, 2, 1]
    );
    assert_eq!(items[0], published);
    assert_eq!(items[1], competing_ontology);
    assert_eq!(items[2]["ontology_version_id"], fixture.ontology_id);
}

#[tokio::test]
async fn ontology_publish_rechecks_admin_after_waiting_for_membership_revocation() {
    for (revoke_sql, expected_status, expected_code) in [
        (
            "UPDATE memberships SET role='viewer' WHERE project_id=?",
            StatusCode::FORBIDDEN,
            "PROJECT_ADMIN_REQUIRED",
        ),
        (
            "DELETE FROM memberships WHERE project_id=?",
            StatusCode::NOT_FOUND,
            "PROJECT_NOT_FOUND",
        ),
    ] {
        let fixture = fixture().await;
        let (app, mut receiver) = setup_route_pool_and_acquisition(&fixture).await;
        let path = format!("/api/projects/{}/ontologies", fixture.project_id);
        let mut competitor = fixture.repository.begin_write().await.unwrap();
        let revoked = sqlx::query(revoke_sql)
            .bind(&fixture.project_id)
            .execute(competitor.connection())
            .await
            .unwrap();
        assert_eq!(revoked.rows_affected(), 1);
        let cookie = fixture.cookie.clone();
        let csrf = fixture.csrf.clone();
        let mut request = tokio::spawn(async move {
            send(
                &app,
                "POST",
                &path,
                Some(json!({"labels": [{"label_id":"revoked-label","name":"Revoked label","color":"#123456","attributes":[],"shortcut":null,"allowed_geometry_types":["bbox_xyxy"]}], "guidelines_markdown": "Must not be published."})),
                Some(&cookie),
                Some(&csrf),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while receiver.recv().await.unwrap() != 4 {}
        })
        .await
        .expect("authenticated ontology request did not reach transaction acquisition");
        let blocked = tokio::time::timeout(Duration::from_millis(200), &mut request).await;
        assert!(
            blocked.is_err(),
            "ontology publish must wait for the revoking writer, not return: {blocked:?}"
        );

        competitor.commit().await.unwrap();
        let (status, rejected) = tokio::time::timeout(Duration::from_secs(5), request)
            .await
            .expect("ontology publish did not finish after revocation committed")
            .unwrap();
        assert_eq!(status, expected_status, "{rejected}");
        assert_eq!(rejected["code"], expected_code);
        let versions = sqlx::query_as::<_, (i64, String)>(
            "SELECT version_no,ontology_version_id FROM ontology_versions ORDER BY version_no",
        )
        .fetch_all(&fixture.state.auth.pool)
        .await
        .unwrap();
        assert_eq!(versions, vec![(1, fixture.ontology_id.clone())]);
    }
}

#[tokio::test]
async fn t14_import_preview_commit_export_and_download_are_bound_to_revision() {
    let fixture = fixture().await;
    let (status, ontology) = fixture
        .request(
            "POST",
            &format!("/api/projects/{}/ontologies", fixture.project_id),
            Some(json!({
                "labels": [{
                    "label_id": "vehicle",
                    "name": "Vehicle",
                    "color": "#0099ff",
                    "attributes": [],
                    "shortcut": null,
                    "allowed_geometry_types": ["bbox_xyxy"]
                }],
                "guidelines_markdown": "T14 ontology without an annotation head."
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{ontology}");
    let target_ontology_id = ontology["ontology_version_id"].as_str().unwrap();
    let boundary = "t14-boundary";
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"format\"\r\n\r\ncoco\r\n\
         --{boundary}\r\nContent-Disposition: form-data; name=\"ontology_version_id\"\r\n\r\n{target_ontology_id}\r\n\
         --{boundary}\r\nContent-Disposition: form-data; name=\"data\"; filename=\"annotations.json\"\r\nContent-Type: application/json\r\n\r\n"
    );
    body.push_str(
        &json!({
            "images":[{"id":17,"file_name":"same.png","width":32,"height":24}],
            "categories":[{"id":90,"name":"Vehicle","label_id":"vehicle","custom_attribute":"present"}],
            "annotations":[{"id":1,"image_id":17,"category_id":90,"bbox":[8.0,6.0,16.0,12.0],"segmentation":[[8,6,24,6,24,18,8,18]],"iscrowd":0}]
        })
        .to_string(),
    );
    body.push_str(&format!("\r\n--{boundary}--\r\n"));
    let response = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/assets/{}/annotation-import-previews",
                    fixture.asset_revision_id
                ))
                .header("host", HOST)
                .header("origin", ORIGIN)
                .header("cookie", &fixture.cookie)
                .header("x-csrf-token", &fixture.csrf)
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let preview: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(status, StatusCode::OK, "{preview}");
    let batch_id = preview["import_batch_id"].as_str().unwrap();
    assert!(preview["base_revision_id"].is_null());
    assert_eq!(preview["document"]["completion"], "in_progress");
    assert_eq!(
        preview["document"]["objects"][0]["origin"]["type"],
        "import"
    );
    assert_eq!(
        preview["document"]["objects"][0]["origin"]["import_batch_id"],
        batch_id
    );

    assert_eq!(
        preview["loss_report"]["losses"][0]["field"],
        "unsupported_fields"
    );
    assert!(preview["loss_report"]["losses"]
        .as_array()
        .unwrap()
        .iter()
        .any(|loss| loss["field"] == "segmentation"));
    let operation_id = "b7d69d86-0d8e-4b75-b1fd-59e3cd3e0845";
    let commit_path = format!("/api/annotation-import-previews/{batch_id}/commit");
    let (missing_status, _) = fixture
        .request(
            "POST",
            &commit_path,
            Some(json!({"loss_ack":true,"operation_id":operation_id})),
        )
        .await;
    assert_eq!(missing_status, StatusCode::BAD_REQUEST);
    let (rejected_status, rejected) = fixture
        .request(
            "POST",
            &commit_path,
            Some(json!({"loss_ack":false,"operation_id":operation_id,"lease":null})),
        )
        .await;
    assert_eq!(
        rejected_status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{rejected}"
    );
    assert_eq!(rejected["code"], "LOSS_ACK_REQUIRED");
    let mut tx = fixture.repository.begin_write().await.unwrap();
    let actor: String =
        sqlx::query_scalar("SELECT user_id FROM users WHERE username='local-admin'")
            .fetch_one(tx.connection())
            .await
            .unwrap();
    sqlx::query("INSERT INTO review_tasks(task_id,project_id,asset_revision_id,ontology_version_id,assignee_id,created_by,state,created_at) VALUES('import-task',?,?,?,?,?,'open','2026-01-01T00:00:00Z')")
        .bind(&fixture.project_id).bind(&fixture.asset_revision_id).bind(target_ontology_id).bind(&actor).bind(&actor).execute(tx.connection()).await.unwrap();
    sqlx::query("INSERT INTO task_leases(task_id,holder_id,fencing_token,expires_at,updated_at) VALUES('import-task',?,2,?,0)")
        .bind(&actor).bind(chrono::Utc::now().timestamp()+300).execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    for (lease, expected) in [
        (Value::Null, "LEASE_REQUIRED"),
        (
            json!({"task_id":"import-task","fencing_token":1}),
            "STALE_FENCING_TOKEN",
        ),
    ] {
        let (status, error) = fixture
            .request(
                "POST",
                &commit_path,
                Some(json!({"loss_ack":true,"operation_id":operation_id,"lease":lease})),
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "{error}");
        assert_eq!(error["code"], expected);
        let (status, unchanged) = fixture
            .request("GET", &fixture.annotation_path(), None)
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            unchanged["annotation_revision_id"],
            fixture.initial_revision_id
        );
    }
    for (state, holder, expiry, expected) in [
        (
            "open",
            None,
            chrono::Utc::now().timestamp() + 300,
            "LEASE_NOT_HELD",
        ),
        ("open", Some(actor.as_str()), 0, "LEASE_EXPIRED"),
        (
            "submitted",
            Some(actor.as_str()),
            chrono::Utc::now().timestamp() + 300,
            "TASK_NOT_OPEN",
        ),
    ] {
        let mut tx = fixture.repository.begin_write().await.unwrap();
        sqlx::query("UPDATE review_tasks SET state=? WHERE task_id='import-task'")
            .bind(state)
            .execute(tx.connection())
            .await
            .unwrap();
        sqlx::query("UPDATE task_leases SET holder_id=?,expires_at=? WHERE task_id='import-task'")
            .bind(holder)
            .bind(expiry)
            .execute(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let (status,error)=fixture.request("POST", &commit_path, Some(json!({"loss_ack":true,"operation_id":operation_id,"lease":{"task_id":"import-task","fencing_token":2}}))).await;
        assert_eq!(status, StatusCode::CONFLICT, "{error}");
        assert_eq!(error["code"], expected);
        let mut tx = fixture.repository.begin_write().await.unwrap();
        let revisions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM annotation_revisions WHERE ontology_version_id=?",
        )
        .bind(target_ontology_id)
        .fetch_one(tx.connection())
        .await
        .unwrap();
        assert_eq!(revisions, 0);
        tx.rollback().await.unwrap();
    }
    let mut tx = fixture.repository.begin_write().await.unwrap();
    sqlx::query("UPDATE review_tasks SET state='open' WHERE task_id='import-task'")
        .execute(tx.connection())
        .await
        .unwrap();
    sqlx::query("UPDATE task_leases SET holder_id=?,expires_at=? WHERE task_id='import-task'")
        .bind(&actor)
        .bind(chrono::Utc::now().timestamp() + 300)
        .execute(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (status, committed) = fixture
        .request(
            "POST",
            &commit_path,
            Some(json!({"loss_ack":true,"operation_id":operation_id,"lease":{"task_id":"import-task","fencing_token":2}})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{committed}");
    assert_eq!(committed["revision"]["revision_no"], 1);
    assert!(committed["revision"]["parent_revision_id"].is_null());
    assert_eq!(
        committed["revision"]["document"]["objects"][0]["origin"]["type"],
        "import"
    );
    let (replay_status, replay) = fixture
        .request(
            "POST",
            &commit_path,
            Some(json!({"loss_ack":true,"operation_id":operation_id,"lease":{"task_id":"import-task","fencing_token":2}})),
        )
        .await;
    assert_eq!(replay_status, StatusCode::OK, "{replay}");
    assert_eq!(
        replay["revision"]["annotation_revision_id"],
        committed["revision"]["annotation_revision_id"]
    );
    let (status, error) = fixture
        .request(
            "POST",
            &commit_path,
            Some(json!({"loss_ack":true,"operation_id":operation_id,"lease":null})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["code"], "IDEMPOTENCY_CONFLICT");
    let mut tx = fixture.repository.begin_write().await.unwrap();
    sqlx::query("DELETE FROM task_leases WHERE task_id='import-task'")
        .execute(tx.connection())
        .await
        .unwrap();
    sqlx::query("DELETE FROM review_tasks WHERE task_id='import-task'")
        .execute(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut cursor = String::new();
    let mut heads = Vec::new();
    loop {
        let (status, page) = fixture
            .request(
                "GET",
                &format!(
                    "/api/assets/{}/annotation-heads?limit=1{}",
                    fixture.asset_revision_id, cursor
                ),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        heads.push(
            page["items"][0]["annotation_revision_id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
        match page["next_cursor"].as_str() {
            Some(next) => cursor = format!("&cursor={next}"),
            None => break,
        }
    }
    heads.sort();
    let mut expected = vec![
        fixture.initial_revision_id.clone(),
        committed["revision"]["annotation_revision_id"]
            .as_str()
            .unwrap()
            .to_owned(),
    ];
    expected.sort();
    assert_eq!(heads, expected);

    let revision_id = committed["revision"]["annotation_revision_id"]
        .as_str()
        .unwrap();
    let (status, rejected) = fixture
        .request(
            "POST",
            &format!("/api/annotation-revisions/{revision_id}/exports"),
            Some(json!({
                "format":"coco",
                "loss_ack":false,
                "operation_id":"b7d69d86-0d8e-4b75-b1fd-59e3cd3e0846"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{rejected}");
    assert_eq!(rejected["code"], "LOSS_ACK_REQUIRED");
    let failure: annotation_domain::ApiError = serde_json::from_value(rejected).unwrap();
    assert_eq!(failure.code, "LOSS_ACK_REQUIRED");

    let details = failure
        .details
        .as_ref()
        .expect("Loss acknowledgement error requires details");
    assert_eq!(details["loss_report"]["losses"][0]["field"], "object_ids");
    let mut tx = fixture.repository.begin_write().await.unwrap();
    let exports: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM annotation_exports")
        .fetch_one(tx.connection())
        .await
        .unwrap();
    assert_eq!(exports, 0);
    tx.rollback().await.unwrap();
    let (status, exported) = fixture
        .request(
            "POST",
            &format!("/api/annotation-revisions/{revision_id}/exports"),
            Some(json!({
                "format":"coco",
                "loss_ack":true,
                "operation_id":"b7d69d86-0d8e-4b75-b1fd-59e3cd3e0847"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{exported}");
    let (status, downloaded) = fixture
        .request("GET", exported["download_url"].as_str().unwrap(), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{downloaded}");
    assert_eq!(downloaded["images"][0]["width"], 32);
    assert_eq!(
        downloaded["annotations"][0]["bbox"],
        json!([8.0, 6.0, 16.0, 12.0])
    );
    let report_response = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(exported["download_url"].as_str().unwrap())
                .header("host", HOST)
                .header("origin", ORIGIN)
                .header("cookie", &fixture.cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let report: Value = serde_json::from_str(
        report_response
            .headers()
            .get("x-weblabel-loss-report")
            .unwrap()
            .to_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(report["losses"][0]["field"], "object_ids");
    let next_save = fixture.save_request(
        "b7d69d86-0d8e-4b75-b1fd-59e3cd3e0848",
        revision_id,
        committed["revision"]["document"].clone(),
    );
    let (save_status, saved) = fixture
        .request("PUT", &fixture.annotation_path(), Some(next_save))
        .await;
    assert_eq!(save_status, StatusCode::OK, "{saved}");
    let saved_revision_id = saved["revision"]["annotation_revision_id"]
        .as_str()
        .unwrap();
    let mut unverified_import = saved["revision"]["document"].clone();
    unverified_import["objects"][0]["origin"]["import_batch_id"] =
        json!("b7d69d86-0d8e-4b75-b1fd-59e3cd3e08ff");
    let unverified_save = fixture.save_request(
        "b7d69d86-0d8e-4b75-b1fd-59e3cd3e0852",
        saved_revision_id,
        unverified_import,
    );
    let (unverified_status, unverified_error) = fixture
        .request("PUT", &fixture.annotation_path(), Some(unverified_save))
        .await;
    assert_eq!(
        unverified_status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{unverified_error}"
    );
    assert_eq!(unverified_error["code"], "UNVERIFIED_PROVENANCE");
    let (status, native_export) = fixture
        .request(
            "POST",
            &format!("/api/annotation-revisions/{saved_revision_id}/exports"),
            Some(json!({
                "format":"native",
                "loss_ack":false,
                "operation_id":"b7d69d86-0d8e-4b75-b1fd-59e3cd3e0850"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{native_export}");
    let download = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(native_export["download_url"].as_str().unwrap())
                .header("host", HOST)
                .header("origin", ORIGIN)
                .header("cookie", &fixture.cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(download.status(), StatusCode::OK);
    let native_bytes = to_bytes(download.into_body(), 32 * 1024 * 1024)
        .await
        .unwrap();
    let native_boundary = "t14-native-boundary";
    let mut native_body = format!(
        "--{native_boundary}\r\nContent-Disposition: form-data; name=\"format\"\r\n\r\nnative\r\n\
         --{native_boundary}\r\nContent-Disposition: form-data; name=\"ontology_version_id\"\r\n\r\n{target_ontology_id}\r\n\
         --{native_boundary}\r\nContent-Disposition: form-data; name=\"data\"; filename=\"bundle.zip\"\r\nContent-Type: application/zip\r\n\r\n"
    )
    .into_bytes();
    native_body.extend_from_slice(&native_bytes);
    native_body.extend_from_slice(format!("\r\n--{native_boundary}--\r\n").as_bytes());
    let native_preview_response = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/assets/{}/annotation-import-previews",
                    fixture.asset_revision_id
                ))
                .header("host", HOST)
                .header("origin", ORIGIN)
                .header("cookie", &fixture.cookie)
                .header("x-csrf-token", &fixture.csrf)
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={native_boundary}"),
                )
                .body(Body::from(native_body))
                .unwrap(),
        )
        .await
        .unwrap();
    let native_preview_status = native_preview_response.status();
    let native_preview: Value = serde_json::from_slice(
        &to_bytes(native_preview_response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(native_preview_status, StatusCode::OK, "{native_preview}");
    assert!(native_preview["loss_report"]["losses"]
        .as_array()
        .unwrap()
        .iter()
        .any(|loss| loss["field"] == "provenance"));
    assert!(native_preview["loss_report"]["losses"]
        .as_array()
        .unwrap()
        .iter()
        .any(|loss| loss["field"] == "revision_history"));
    let native_batch_id = native_preview["import_batch_id"].as_str().unwrap();
    let native_commit_path = format!("/api/annotation-import-previews/{native_batch_id}/commit");
    let (native_rejected_status, native_rejected) = fixture
        .request(
            "POST",
            &native_commit_path,
            Some(json!({
                "loss_ack":false,
                "lease":null,
                "operation_id":"b7d69d86-0d8e-4b75-b1fd-59e3cd3e0851"
            })),
        )
        .await;
    assert_eq!(
        native_rejected_status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{native_rejected}"
    );
    assert_eq!(native_rejected["code"], "LOSS_ACK_REQUIRED");
    let (native_commit_status, native_committed) = fixture
        .request(
            "POST",
            &native_commit_path,
            Some(json!({
                "loss_ack":true,
                "lease":null,
                "operation_id":"b7d69d86-0d8e-4b75-b1fd-59e3cd3e0851"
            })),
        )
        .await;
    assert_eq!(native_commit_status, StatusCode::OK, "{native_committed}");
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
async fn save_rejects_invalid_domain_data_and_unknown_decisions() {
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
    assert_eq!(status, StatusCode::NOT_FOUND, "{error}");
    assert_eq!(error["code"], "SUGGESTION_SET_NOT_FOUND");

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

#[tokio::test]
async fn save_journals_decisions_with_the_revision_atomically_and_idempotently() {
    use sqlx::Row;

    // Seed the AI rows directly: the job engine fixtures live in t17, this
    // test exercises the real save handler with real decision intents.
    let fixture = fixture().await;
    let path = fixture.annotation_path();
    let mut tx = fixture.repository.begin_write().await.unwrap();
    let user_id: String = sqlx::query_scalar("SELECT user_id FROM users LIMIT 1")
        .fetch_one(tx.connection())
        .await
        .unwrap();
    let canonical_sha256: String = sqlx::query_scalar(
        "SELECT canonical_sha256 FROM media_revisions WHERE asset_revision_id=?",
    )
    .bind(&fixture.asset_revision_id)
    .fetch_one(tx.connection())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO jobs(job_id, project_id, kind, state, payload_json, created_at, updated_at) \
         VALUES ('job-e2e', ?, 'model', 'succeeded', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    )
    .bind(&fixture.project_id)
    .execute(tx.connection())
    .await
    .unwrap();
    let profile = json!({
        "profile_id": "profile-e2e",
        "provider_id": "detector_local",
        "model_id": "detector-e2e",
        "auth_kind": "local_weights",
        "capabilities": {
            "image_input": true, "tools": false, "structured_output": true,
            "bbox_output": true, "attributes": true
        },
        "availability": "ready",
        "verification": "mock_only",
        "runtime_version": null,
        "verified_at": null
    });
    let context = json!({
        "project_id": fixture.project_id,
        "asset_revision_id": fixture.asset_revision_id,
        "annotation_revision_id": fixture.initial_revision_id,
        "ontology_version_id": fixture.ontology_id,
        "draft_generation": 0,
        "canonical_sha256": canonical_sha256,
        "selected_object_ids": [],
        "object_hashes": {},
        "input_fingerprint": "fp-e2e"
    });
    sqlx::query(
        "INSERT INTO model_runs(run_id, operation_id, project_id, asset_revision_id, annotation_revision_id, \
         ontology_version_id, actor_id, job_id, profile_id, profile_snapshot_json, provider_id, source, intent, \
         prompt, consent_id, context_json, input_fingerprint, request_hash, state, cancel_requested, cost_display, \
         usage_json, created_at, started_at, finished_at) \
         VALUES ('run-e2e','op-run-e2e',?,?,?,? ,?,'job-e2e','profile-e2e',?,'detector_local','mock','detect', \
         'detect vehicles',NULL,?,'fp-e2e',?,'succeeded',0,'none',NULL, \
         '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
    )
    .bind(&fixture.project_id)
    .bind(&fixture.asset_revision_id)
    .bind(&fixture.initial_revision_id)
    .bind(&fixture.ontology_id)
    .bind(&user_id)
    .bind(profile.to_string())
    .bind(context.to_string())
    .bind("2222222222222222222222222222222222222222222222222222222222222222")
    .execute(tx.connection())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO predictions(prediction_id, run_id, project_id, asset_revision_id, source, raw_output_json, \
         raw_output_bytes, usage_json, created_at) \
         VALUES ('prediction-e2e','run-e2e',?,?,'mock','{}',2,NULL,'2026-01-01T00:00:00.000Z')",
    )
    .bind(&fixture.project_id)
    .bind(&fixture.asset_revision_id)
    .execute(tx.connection())
    .await
    .unwrap();
    let created_object = json!({
        "object_id": "object_pred_1",
        "label_id": "vehicle",
        "geometry": {"type": "bbox_xyxy", "x_min": 2.0, "y_min": 3.0, "x_max": 20.0, "y_max": 18.0},
        "attributes": {},
        "origin": {"type": "prediction", "prediction_id": "prediction-e2e", "model_run_id": "run-e2e", "import_batch_id": null}
    });
    let change = json!({
        "kind": "create",
        "change_id": "change-e2e",
        "object": created_object,
        "before_hash": null,
        "reason": "detector candidate"
    });
    sqlx::query(
        "INSERT INTO suggestion_sets(suggestion_set_id, run_id, prediction_id, project_id, asset_revision_id, \
         changes_json, issues_json, score, created_at) \
         VALUES ('suggestion-e2e','run-e2e','prediction-e2e',?,?,?,'[]',NULL,'2026-01-01T00:00:00.000Z')",
    )
    .bind(&fixture.project_id)
    .bind(&fixture.asset_revision_id)
    .bind(json!([change]).to_string())
    .execute(tx.connection())
    .await
    .unwrap();
    tx.commit().await.unwrap();

    // Accept: the journal row, the new revision and the head move commit
    // together in one save transaction.
    let mut accepted_document = fixture.document();
    accepted_document["objects"] = json!([created_object.clone()]);
    let mut request = fixture.save_request(
        "op-e2e-accept",
        &fixture.initial_revision_id,
        accepted_document,
    );
    request["suggestion_decisions"] = json!([{
        "suggestion_set_id": "suggestion-e2e",
        "change_ids": ["change-e2e"],
        "decision": "accept"
    }]);
    let (status, saved) = fixture.request("PUT", &path, Some(request.clone())).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["idempotent_replay"], false);
    let revision_id = saved["revision"]["annotation_revision_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let mut tx = fixture.repository.begin_write().await.unwrap();
    let rows: Vec<(String, String)> =
        sqlx::query("SELECT decision, bound_revision_id FROM suggestion_decisions ORDER BY rowid")
            .map(|row: sqlx::sqlite::SqliteRow| {
                (
                    row.try_get::<String, _>(0).unwrap(),
                    row.try_get::<String, _>(1).unwrap(),
                )
            })
            .fetch_all(tx.connection())
            .await
            .unwrap();
    assert_eq!(rows, vec![("accept".to_owned(), revision_id.clone())]);
    let head: String = sqlx::query_scalar(
        "SELECT annotation_revision_id FROM annotation_heads WHERE asset_revision_id=?",
    )
    .bind(&fixture.asset_revision_id)
    .fetch_one(tx.connection())
    .await
    .unwrap();
    assert_eq!(head, revision_id);
    let predictions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM predictions")
        .fetch_one(tx.connection())
        .await
        .unwrap();
    assert_eq!(predictions, 1, "the source prediction is immutable");
    let state: String = sqlx::query_scalar(
        "SELECT state FROM suggestion_set_states WHERE suggestion_set_id='suggestion-e2e'",
    )
    .fetch_one(tx.connection())
    .await
    .unwrap();
    assert_eq!(state, "accepted");
    tx.commit().await.unwrap();

    // Idempotent replay by operation must not write a second journal row.
    let (status, replay) = fixture.request("PUT", &path, Some(request)).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["idempotent_replay"], true);
    let mut tx = fixture.repository.begin_write().await.unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM suggestion_decisions")
        .fetch_one(tx.connection())
        .await
        .unwrap();
    assert_eq!(rows, 1, "replays must not duplicate decision rows");
    tx.commit().await.unwrap();

    // A manual delete is a plain save without decisions and produces a new
    // revision; the original accept stays journaled.
    let mut deleted = fixture.document();
    deleted["objects"] = json!([]);
    let delete_request = fixture.save_request("op-e2e-delete", &revision_id, deleted);
    let (status, removed) = fixture.request("PUT", &path, Some(delete_request)).await;
    assert_eq!(status, StatusCode::OK, "{removed}");
    let after_delete = removed["revision"]["annotation_revision_id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Repeating the accept must not create the object twice: the journal
    // already records this change as accepted.
    let mut repeat_document = fixture.document();
    repeat_document["objects"] = json!([created_object]);
    let mut repeat = fixture.save_request("op-e2e-repeat", &after_delete, repeat_document);
    repeat["suggestion_decisions"] = json!([{
        "suggestion_set_id": "suggestion-e2e",
        "change_ids": ["change-e2e"],
        "decision": "accept"
    }]);
    let (status, error) = fixture.request("PUT", &path, Some(repeat)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
    assert_eq!(error["code"], "ALREADY_ACCEPTED");

    // Undo of the accept is a revert intent bound to the new revision and the
    // source prediction history stays intact.
    let mut undo = fixture.save_request("op-e2e-undo", &after_delete, fixture.document());
    undo["suggestion_decisions"] = json!([{
        "suggestion_set_id": "suggestion-e2e",
        "change_ids": ["change-e2e"],
        "decision": "revert"
    }]);
    let (status, undone) = fixture.request("PUT", &path, Some(undo)).await;
    assert_eq!(status, StatusCode::OK, "{undone}");
    let revert_revision = undone["revision"]["annotation_revision_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let mut tx = fixture.repository.begin_write().await.unwrap();
    let rows: Vec<(String, String)> =
        sqlx::query("SELECT decision, bound_revision_id FROM suggestion_decisions ORDER BY rowid")
            .map(|row: sqlx::sqlite::SqliteRow| {
                (
                    row.try_get::<String, _>(0).unwrap(),
                    row.try_get::<String, _>(1).unwrap(),
                )
            })
            .fetch_all(tx.connection())
            .await
            .unwrap();
    assert_eq!(
        rows,
        vec![
            ("accept".to_owned(), revision_id),
            ("revert".to_owned(), revert_revision),
        ],
        "accept -> revert must be journaled in save order without dedup"
    );
    let predictions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM predictions")
        .fetch_one(tx.connection())
        .await
        .unwrap();
    assert_eq!(predictions, 1, "undo must never delete prediction history");
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn commercial_empty_publish_and_head_summary_boundaries() {
    let fixture = fixture().await;
    let (status, _) = fixture
        .request(
            "POST",
            &format!("/api/projects/{}/ontologies", fixture.project_id),
            Some(json!({"labels":[],"guidelines_markdown":""})),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, page) = fixture
        .request(
            "GET",
            &format!(
                "/api/assets/{}/annotation-heads?limit=1",
                fixture.asset_revision_id
            ),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(
        page["items"][0]["annotation_revision_id"],
        fixture.initial_revision_id
    );
    assert_eq!(page["items"][0]["object_count"], 0);
    assert!(page["items"][0].get("objects").is_none());
    assert_eq!(
        page["items"][0].get("approved_review_id"),
        Some(&Value::Null)
    );
    let (status, project_page) = fixture
        .request(
            "GET",
            &format!(
                "/api/projects/{}/annotation-heads?ontology_version_id={}&limit=1",
                fixture.project_id, fixture.ontology_id
            ),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{project_page}");
    assert_eq!(
        project_page["items"][0]["head"]["annotation_revision_id"],
        fixture.initial_revision_id
    );
    for endpoint in [
        format!(
            "/api/assets/{}/annotation-heads?limit=101",
            fixture.asset_revision_id
        ),
        format!("/api/projects/{}/members?limit=0", fixture.project_id),
    ] {
        assert_eq!(
            fixture.request("GET", &endpoint, None).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let (status, members) = fixture
        .request(
            "GET",
            &format!("/api/projects/{}/members?limit=1", fixture.project_id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{members}");
    assert_eq!(members["items"][0]["username"], "local-admin");
    assert_eq!(members["items"][0]["role"], "admin");
    assert_eq!(members.get("next_cursor"), Some(&Value::Null));
}

#[tokio::test]
async fn commercial_project_pages_preserve_missing_heads_and_member_privacy() {
    let fixture = fixture().await;
    let (status, ontologies) = fixture
        .request(
            "GET",
            &format!("/api/projects/{}/ontologies", fixture.project_id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let mut ontology = ontologies["items"][0].clone();
    ontology["ontology_version_id"] = json!("z-new-ontology");
    ontology["version_no"] = json!(2);
    let mut tx = fixture.repository.begin_write().await.unwrap();
    sqlx::query("INSERT INTO ontology_versions(ontology_version_id,project_id,version_no,body_json,created_at) VALUES('z-new-ontology',?,2,?,'2026-01-01T00:00:00Z')").bind(&fixture.project_id).bind(ontology.to_string()).execute(tx.connection()).await.unwrap();
    let actor: String =
        sqlx::query_scalar("SELECT user_id FROM users WHERE username='local-admin'")
            .fetch_one(tx.connection())
            .await
            .unwrap();
    for id in ["member-a", "member-b"] {
        sqlx::query("INSERT INTO users(user_id,username,password_hash,created_at) VALUES(?,?,'','2026-01-01T00:00:00Z')").bind(id).bind(id).execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,'viewer')")
            .bind(&fixture.project_id)
            .bind(id)
            .execute(tx.connection())
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::new(32, 24))
        .write_to(&mut png, ImageFormat::Png)
        .unwrap();
    let imported = import_one(
        &fixture.repository,
        &MediaWorker::new(),
        ImportInput {
            project_id: fixture.project_id.clone(),
            ontology_version_id: "z-new-ontology".into(),
            actor_id: actor.clone(),
            source_group_id: "second-source".into(),
            original_name: "second.png".into(),
            declared_mime: Some("image/png".into()),
            bytes: png.into_inner(),
        },
    )
    .await
    .unwrap();
    let mut cursor = String::new();
    let mut assets = Vec::new();
    loop {
        let (status, page) = fixture
            .request(
                "GET",
                &format!(
                    "/api/projects/{}/annotation-heads?ontology_version_id={}&limit=1{}",
                    fixture.project_id, fixture.ontology_id, cursor
                ),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        let item = &page["items"][0];
        let asset = item["media"]["asset_revision_id"].as_str().unwrap();
        if asset == imported.asset_revision_id {
            assert_eq!(item.get("head"), Some(&Value::Null));
        } else {
            assert_eq!(
                item["head"]["annotation_revision_id"],
                fixture.initial_revision_id
            );
        }
        assets.push(asset.to_owned());
        match page["next_cursor"].as_str() {
            Some(next) => cursor = format!("&cursor={next}"),
            None => break,
        }
    }
    let mut expected = vec![
        fixture.asset_revision_id.clone(),
        imported.asset_revision_id,
    ];
    expected.sort();
    assert_eq!(assets, expected);
    let mut members = Vec::new();
    cursor.clear();
    loop {
        let (status, page) = fixture
            .request(
                "GET",
                &format!(
                    "/api/projects/{}/members?limit=1{}",
                    fixture.project_id, cursor
                ),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        members.push(page["items"][0]["user_id"].as_str().unwrap().to_owned());
        match page["next_cursor"].as_str() {
            Some(next) => cursor = format!("&cursor={next}"),
            None => break,
        }
    }
    let mut expected = vec![actor.clone(), "member-a".into(), "member-b".into()];
    expected.sort();
    assert_eq!(members, expected);
    for role in ["annotator", "reviewer", "viewer"] {
        let mut tx = fixture.repository.begin_write().await.unwrap();
        sqlx::query("UPDATE memberships SET role=? WHERE project_id=? AND user_id=?")
            .bind(role)
            .bind(&fixture.project_id)
            .bind(&actor)
            .execute(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            fixture
                .request(
                    "GET",
                    &format!("/api/projects/{}/members", fixture.project_id),
                    None
                )
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    let mut tx = fixture.repository.begin_write().await.unwrap();
    sqlx::query("DELETE FROM memberships WHERE project_id=? AND user_id=?")
        .bind(&fixture.project_id)
        .bind(&actor)
        .execute(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        fixture
            .request(
                "GET",
                &format!("/api/projects/{}/members", fixture.project_id),
                None
            )
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        fixture
            .request(
                "GET",
                &format!("/api/assets/{}/annotation-heads", fixture.asset_revision_id),
                None
            )
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn commercial_summary_approval_is_exact_and_corruption_is_not_missing() {
    let fixture = fixture().await;
    let mut tx = fixture.repository.begin_write().await.unwrap();
    let actor: String =
        sqlx::query_scalar("SELECT user_id FROM users WHERE username='local-admin'")
            .fetch_one(tx.connection())
            .await
            .unwrap();
    sqlx::query("INSERT INTO review_tasks(task_id,project_id,asset_revision_id,ontology_version_id,assignee_id,created_by,state,created_at) VALUES('summary-task',?,?,?,?,?,'closed','2026-01-01T00:00:00Z')").bind(&fixture.project_id).bind(&fixture.asset_revision_id).bind(&fixture.ontology_id).bind(&actor).bind(&actor).execute(tx.connection()).await.unwrap();
    let revisions = json!([fixture.initial_revision_id]).to_string();
    sqlx::query("INSERT INTO review_submissions(review_id,task_id,project_id,submitted_by,revision_ids_json,state,created_at) VALUES('exact-review','summary-task',?,?,?,'approved','2026-01-01T00:00:00Z')").bind(&fixture.project_id).bind(&actor).bind(&revisions).execute(tx.connection()).await.unwrap();
    sqlx::query("INSERT INTO review_decisions(review_id,decided_by,decision,reason,revision_ids_json,created_at) VALUES('exact-review',?,'approve','accepted',?,'2026-01-01T00:00:00Z')").bind(&actor).bind(&revisions).execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    let asset_path = format!("/api/assets/{}/annotation-heads", fixture.asset_revision_id);
    let project_path = format!(
        "/api/projects/{}/annotation-heads?ontology_version_id={}",
        fixture.project_id, fixture.ontology_id
    );
    let (status, page) = fixture.request("GET", &asset_path, None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"][0]["approved_review_id"], "exact-review");
    let mut tx = fixture.repository.begin_write().await.unwrap();
    let mut document = fixture.document();
    document["completion"] = json!("invalid_completion");
    sqlx::query("INSERT INTO annotation_revisions(annotation_revision_id,project_id,asset_revision_id,ontology_version_id,parent_revision_id,revision_no,body_json,content_hash,created_by,created_at) VALUES('corrupt-summary',?,?,?,?,2,?,'bad',?,'2026-01-01T00:00:00Z')").bind(&fixture.project_id).bind(&fixture.asset_revision_id).bind(&fixture.ontology_id).bind(&fixture.initial_revision_id).bind(document.to_string()).bind(&actor).execute(tx.connection()).await.unwrap();
    sqlx::query("UPDATE annotation_heads SET annotation_revision_id='corrupt-summary' WHERE project_id=? AND asset_revision_id=? AND ontology_version_id=?").bind(&fixture.project_id).bind(&fixture.asset_revision_id).bind(&fixture.ontology_id).execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    for path in [&asset_path, &project_path] {
        let (status, error) = fixture.request("GET", path, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{error}");
        assert_eq!(error["code"], "ANNOTATION_HEAD_READ_FAILED");
    }
}

#[tokio::test]
async fn commercial_required_null_defaults_publish_and_require_key_presence() {
    let fixture = fixture().await;
    let ontology_path = format!("/api/projects/{}/ontologies", fixture.project_id);
    let (status, before) = fixture.request("GET", &ontology_path, None).await;
    assert_eq!(status, StatusCode::OK);
    let original = before["items"][0].clone();
    let attributes = json!([
        {"key":"category","kind":"enum","required":true,"default_value":null,"enum_values":["visible","hidden"],"min":null,"max":null},
        {"key":"flag","kind":"boolean","required":true,"default_value":null,"enum_values":[],"min":null,"max":null},
        {"key":"score","kind":"number","required":true,"default_value":null,"enum_values":[],"min":0,"max":10},
        {"key":"note","kind":"text","required":true,"default_value":null,"enum_values":[],"min":null,"max":null}
    ]);
    let body = json!({"labels":[{"label_id":"vehicle","name":"Vehicle","color":"#0099ff","attributes":attributes,"shortcut":null,"allowed_geometry_types":["bbox_xyxy"]}],"guidelines_markdown":"Required means key presence, including explicit null."});
    let (status, published) = fixture
        .request("POST", &ontology_path, Some(body.clone()))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{published}");
    assert_eq!(published["labels"][0]["attributes"], attributes);
    assert_ne!(
        published["ontology_version_id"],
        original["ontology_version_id"]
    );
    let (status, listed) = fixture.request("GET", &ontology_path, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["items"], json!([published.clone(), original]));
    for key in ["required", "default_value", "enum_values", "min", "max"] {
        let mut invalid = body.clone();
        invalid["labels"][0]["attributes"][0]
            .as_object_mut()
            .unwrap()
            .remove(key);
        assert_eq!(
            fixture
                .request("POST", &ontology_path, Some(invalid))
                .await
                .0,
            StatusCode::UNPROCESSABLE_ENTITY,
            "missing {key}"
        );
    }
    for (field, value) in [
        ("required", json!(null)),
        ("required", json!("true")),
        ("kind", json!("unknown")),
    ] {
        let mut invalid = body.clone();
        invalid["labels"][0]["attributes"][0][field] = value;
        assert_eq!(
            fixture
                .request("POST", &ontology_path, Some(invalid))
                .await
                .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    for (index, field, value) in [
        (0, "default_value", json!("outside-enum")),
        (1, "default_value", json!("not-boolean")),
        (2, "default_value", json!(11)),
        (3, "default_value", json!(false)),
        (0, "enum_values", json!([])),
        (2, "min", json!(11)),
    ] {
        let mut invalid = body.clone();
        invalid["labels"][0]["attributes"][index][field] = value;
        assert_eq!(
            fixture
                .request("POST", &ontology_path, Some(invalid))
                .await
                .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let mut png = std::io::Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::new(32, 24))
        .write_to(&mut png, ImageFormat::Png)
        .unwrap();
    let mut tx = fixture.repository.begin_write().await.unwrap();
    let actor: String =
        sqlx::query_scalar("SELECT user_id FROM users WHERE username='local-admin'")
            .fetch_one(tx.connection())
            .await
            .unwrap();
    tx.rollback().await.unwrap();
    let imported = import_one(
        &fixture.repository,
        &MediaWorker::new(),
        ImportInput {
            project_id: fixture.project_id.clone(),
            ontology_version_id: published["ontology_version_id"]
                .as_str()
                .unwrap()
                .to_owned(),
            actor_id: actor,
            source_group_id: "required-null-source".into(),
            original_name: "required-null.png".into(),
            declared_mime: Some("image/png".into()),
            bytes: png.into_inner(),
        },
    )
    .await
    .unwrap();
    let mut document = fixture.document();
    document["asset_revision_id"] = json!(imported.asset_revision_id);
    document["ontology_version_id"] = published["ontology_version_id"].clone();
    document["objects"] = json!([{"object_id":"required-null-object","label_id":"vehicle","geometry":{"type":"bbox_xyxy","x_min":1,"y_min":1,"x_max":20,"y_max":20},"attributes":{"category":null,"flag":null,"score":null,"note":null},"origin":{"type":"manual","prediction_id":null,"model_run_id":null,"import_batch_id":null}}]);
    let annotation_path = format!(
        "/api/assets/{}/annotation?ontology_version_id={}",
        imported.asset_revision_id,
        published["ontology_version_id"].as_str().unwrap()
    );
    let request = fixture.save_request(
        "required-null-save",
        &imported.annotation_revision_id,
        document.clone(),
    );
    let (status, saved) = fixture
        .request("PUT", &annotation_path, Some(request))
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(
        saved["revision"]["document"]["objects"][0]["attributes"],
        document["objects"][0]["attributes"]
    );
    let revision_id = saved["revision"]["annotation_revision_id"]
        .as_str()
        .unwrap();
    for key in ["category", "flag", "score", "note"] {
        let mut missing = document.clone();
        missing["objects"][0]["attributes"]
            .as_object_mut()
            .unwrap()
            .remove(key);
        let request =
            fixture.save_request(&format!("required-missing-{key}"), revision_id, missing);
        let (status, error) = fixture
            .request("PUT", &annotation_path, Some(request))
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
        assert_eq!(error["code"], "MISSING_REQUIRED_ATTRIBUTE");
    }
    let (status, head) = fixture.request("GET", &annotation_path, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(head["annotation_revision_id"], revision_id);
    let (status, historical) = fixture
        .request("GET", &fixture.annotation_path(), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        historical["annotation_revision_id"],
        fixture.initial_revision_id
    );
    let (status, final_list) = fixture.request("GET", &ontology_path, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(final_list, listed);
}
