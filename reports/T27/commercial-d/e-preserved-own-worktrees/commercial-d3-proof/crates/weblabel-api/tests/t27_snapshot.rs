use std::{net::SocketAddr, time::Duration};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tempfile::tempdir;
use tower::ServiceExt;
use weblabel_api::{
    auth::{hash_launch_code, AuthConfig},
    config::ServerConfig,
    datasets::{
        snapshot::verify_media_object,
        split::{grouped, validate_explicit_group_splits, Split},
    },
    router,
    storage::ObjectStore,
    AppState,
};

const HOST: &str = "127.0.0.1:48100";
const ORIGIN: &str = "http://127.0.0.1:48100";

#[test]
fn snapshot_media_objects_reject_missing_and_corrupt_content() {
    let directory = tempdir().unwrap();
    let store = ObjectStore::new(directory.path().join("objects")).unwrap();
    let missing = store.put_bytes("media", b"missing").unwrap();
    std::fs::remove_file(&missing.path).unwrap();
    assert_eq!(
        verify_media_object(&store, &missing.sha256),
        Err("MEDIA_OBJECT_MISSING")
    );
    let corrupt = store.put_bytes("media", b"expected bytes").unwrap();
    std::fs::write(&corrupt.path, b"corrupted bytes").unwrap();
    assert_eq!(
        verify_media_object(&store, &corrupt.sha256),
        Err("MEDIA_OBJECT_INVALID")
    );
}

#[test]
fn snapshot_completion_rejects_empty_complete_and_nonempty_negative() {
    let document = |completion: &str, objects: Value| {
        serde_json::from_value(json!({
            "schema_version": 1,
            "asset_revision_id": "asset-1",
            "ontology_version_id": "ontology-1",
            "coordinate_space": { "type": "canonical_image_pixels", "width": 640, "height": 480 },
            "completion": completion,
            "objects": objects,
        }))
        .unwrap()
    };
    assert_eq!(
        weblabel_api::datasets::snapshot::validate_snapshot_document(&document(
            "unprocessed",
            json!([])
        )),
        Err("SNAPSHOT_NOT_READY")
    );
    assert_eq!(
        weblabel_api::datasets::snapshot::validate_snapshot_document(&document(
            "complete",
            json!([])
        )),
        Err("SNAPSHOT_COMPLETION_INVALID")
    );
    assert_eq!(
        weblabel_api::datasets::snapshot::validate_snapshot_document(&document(
            "confirmed_negative",
            json!([{
                "object_id": "object-1",
                "label_id": "label-1",
                "geometry": { "type": "bbox_xyxy", "x_min": 1.0, "y_min": 1.0, "x_max": 2.0, "y_max": 2.0 },
                "attributes": {},
                "origin": { "type": "manual", "prediction_id": null, "model_run_id": null, "import_batch_id": null },
            }])
        )),
        Err("SNAPSHOT_COMPLETION_INVALID")
    );
    assert_eq!(
        weblabel_api::datasets::snapshot::validate_snapshot_document(&document(
            "confirmed_negative",
            json!([])
        )),
        Ok(())
    );
}
#[test]
fn deterministic_split_keeps_source_groups_stable() {
    let groups = [
        "capture-a".to_owned(),
        "capture-b".to_owned(),
        "capture-c".to_owned(),
        "capture-d".to_owned(),
    ];
    let first = grouped("task-t27-seed-v1", groups.clone(), [70, 20, 10]).unwrap();
    let retry = grouped("task-t27-seed-v1", groups.clone(), [70, 20, 10]).unwrap();
    assert_eq!(first, retry);
    assert_eq!(first.len(), groups.len());
    assert!(first
        .values()
        .all(|split| matches!(split, Split::Train | Split::Val | Split::Test)));
}

#[test]
fn explicit_splits_keep_same_source_group_together() {
    assert_eq!(
        validate_explicit_group_splits([
            ("capture-a".to_owned(), Split::Train),
            ("capture-a".to_owned(), Split::Train),
            ("capture-b".to_owned(), Split::Val),
        ]),
        Ok(())
    );
    assert_eq!(
        validate_explicit_group_splits([
            ("capture-a".to_owned(), Split::Train),
            ("capture-a".to_owned(), Split::Test),
        ]),
        Err("SOURCE_GROUP_SPLIT")
    );
}

#[test]
fn deterministic_split_rejects_empty_ratio_total() {
    assert_eq!(
        grouped("seed", ["group".to_owned()], [0, 0, 0]),
        Err("SPLIT_RATIOS_INVALID")
    );
}

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
    let cookie = response
        .headers()
        .get("set-cookie")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or_default().to_owned());
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024).await.unwrap();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, json, cookie)
}

#[tokio::test]
async fn guessed_dataset_export_id_is_non_disclosing() {
    let directory = tempdir().unwrap();
    let config = ServerConfig {
        bind: HOST.parse::<SocketAddr>().unwrap(),
        database_url: format!("sqlite:{}", directory.path().join("t27.sqlite").display()),
        object_root: directory.path().join("objects"),
        write_timeout: Duration::from_secs(2),
        production: true,
    };
    let launch_code = "t27-api-launch";
    let state = AppState::open_with_auth(
        &config,
        AuthConfig {
            bind: config.bind,
            cookie_secure: false,
            allowed_origins: vec![ORIGIN.to_owned()],
            allowed_hosts: vec![HOST.to_owned()],
            launch_code: hash_launch_code(launch_code),
            launch_code_expires_at: chrono::Utc::now().timestamp() + 3600,
        },
    )
    .await
    .unwrap();
    let app = router(state);
    let (status, bootstrap, cookie) = send(
        &app,
        "POST",
        "/api/session/bootstrap",
        Some(json!({"launch_code":launch_code,"password":"t27-bootstrap-password"})),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cookie = cookie.unwrap();
    let csrf = bootstrap["csrf_token"].as_str().unwrap();
    let (status, project, _) = send(&app, "POST", "/api/projects", Some(json!({"name":"T27 guessed-ID test","description":"project-scoped export lookup","allow_self_review":true})), Some(&cookie), Some(csrf)).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, body, _) = send(&app, "POST", &format!("/api/dataset-versions/{}/exports", uuid::Uuid::new_v4()), Some(json!({"format":"native","loss_ack":false,"operation_id":uuid::Uuid::new_v4().to_string()})), Some(&cookie), Some(csrf)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "DATASET_NOT_FOUND");
    assert!(!body
        .to_string()
        .contains(&project["project_id"].as_str().unwrap_or_default()));
}

// Public-router fixtures seed owned migrated rows, never private handler DTOs or hooks.
struct SnapshotFixture {
    _directory: tempfile::TempDir,
    state: AppState,
    app: Router,
    cookie: String,
    csrf: String,
    actor: String,
    project: String,
    ontology: String,
    assets: Vec<String>,
    revisions: Vec<String>,
}

fn new_id() -> String { uuid::Uuid::new_v4().to_string() }

impl SnapshotFixture {
    async fn new(count: usize, approved: bool, same_group: bool, corrupt_hash: bool) -> Self {
        let directory = tempdir().unwrap();
        let config = ServerConfig {
            bind: HOST.parse().unwrap(),
            database_url: format!("sqlite:{}", directory.path().join("fixture.sqlite").display()),
            object_root: directory.path().join("objects"),
            write_timeout: Duration::from_secs(10),
            production: true,
        };
        let state = AppState::open_with_auth(&config, AuthConfig {
            bind: config.bind, cookie_secure: false,
            allowed_origins: vec![ORIGIN.to_owned()], allowed_hosts: vec![HOST.to_owned()],
            launch_code: hash_launch_code("snapshot-fixture-code"),
            launch_code_expires_at: chrono::Utc::now().timestamp() + 3600,
        }).await.unwrap();
        let app = router(state.clone());
        let (status, ack, cookie) = send(&app, "POST", "/api/session/bootstrap",
            Some(json!({"launch_code":"snapshot-fixture-code","password":"snapshot-fixture-password"})), None, None).await;
        assert_eq!(status, StatusCode::OK);
        let cookie = cookie.unwrap();
        let csrf = ack["csrf_token"].as_str().unwrap().to_owned();
        let actor = ack["user_id"].as_str().unwrap().to_owned();
        let (status, body, _) = send(&app, "POST", "/api/projects", Some(json!({"name":"Public snapshot boundary","description":"Owned synthetic fixture","allow_self_review":false})), Some(&cookie), Some(&csrf)).await;
        assert_eq!(status, StatusCode::CREATED);
        let project = body["project_id"].as_str().unwrap().to_owned();
        let ontology = new_id();
        let ontology_body: annotation_domain::OntologyVersion = serde_json::from_value(json!({
            "ontology_version_id":ontology,"project_id":project,"version_no":1,
            "labels":[{"label_id":"label_one","name":"One","color":"#ffcc00","shortcut":null,"allowed_geometry_types":["bbox_xyxy"],"attributes":[]}],
            "guidelines_markdown":"Synthetic boundary fixture","allow_out_of_bounds":false
        })).unwrap();
        ontology_body.validate().unwrap();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let object = state.repository.object_store().stage_bytes("canonical.png", png.get_ref()).unwrap().publish().unwrap();
        let time = "2026-01-01T00:00:00.000Z";
        let reviewer = new_id();
        let mut tx = state.repository.begin_write().await.unwrap();
        sqlx::query("INSERT INTO users(user_id,username,password_hash,created_at) VALUES(?,?,?,?)")
            .bind(&reviewer).bind(format!("reviewer-{reviewer}")).bind("").bind(time).execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,'reviewer')")
            .bind(&project).bind(&reviewer).execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO ontology_versions(ontology_version_id,project_id,version_no,body_json,created_at) VALUES(?,?,1,?,?)")
            .bind(&ontology).bind(&project).bind(serde_json::to_string(&ontology_body).unwrap()).bind(time).execute(tx.connection()).await.unwrap();
        let mut assets = Vec::with_capacity(count);
        let mut revisions = Vec::with_capacity(count);
        let shared_group = new_id();
        for index in 0..count {
            let asset = new_id();
            let media = new_id();
            let revision = new_id();
            let document: annotation_domain::AnnotationDocument = serde_json::from_value(json!({
                "schema_version":1,"asset_revision_id":asset,"ontology_version_id":ontology,
                "coordinate_space":{"type":"canonical_image_pixels","width":2,"height":2},
                "completion":"confirmed_negative","objects":[]
            })).unwrap();
            annotation_domain::validate_document(&document, &ontology_body).unwrap();
            let serialized = annotation_domain::hash::serialize_document(&document).unwrap();
            sqlx::query("INSERT INTO media_assets(asset_id,project_id,created_at) VALUES(?,?,?)")
                .bind(&media).bind(&project).bind(time).execute(tx.connection()).await.unwrap();
            sqlx::query("INSERT INTO media_revisions(asset_revision_id,project_id,asset_id,original_sha256,canonical_sha256,original_name,created_at) VALUES(?,?,?,?,?,?,?)")
                .bind(&asset).bind(&project).bind(&media).bind(&object.sha256).bind(&object.sha256).bind(format!("synthetic-{index}.png")).bind(time).execute(tx.connection()).await.unwrap();
            sqlx::query("INSERT INTO media_object_refs(asset_revision_id,sha256) VALUES(?,?)")
                .bind(&asset).bind(&object.sha256).execute(tx.connection()).await.unwrap();
            sqlx::query("INSERT INTO media_metadata(asset_revision_id,canonical_width,canonical_height,exif_orientation,original_to_canonical_json,source_group_id,original_object_sha256,canonical_object_sha256,preview_object_sha256) VALUES(?,2,2,1,'[1,0,0,0,1,0,0,0,1]',?,?,?,?)")
                .bind(&asset).bind(if same_group { shared_group.clone() } else { new_id() }).bind(&object.sha256).bind(&object.sha256).bind(&object.sha256).execute(tx.connection()).await.unwrap();
            sqlx::query("INSERT INTO annotation_revisions(annotation_revision_id,project_id,asset_revision_id,ontology_version_id,parent_revision_id,revision_no,body_json,content_hash,created_by,created_at) VALUES(?,?,?,?,NULL,1,?,?,?,?)")
                .bind(&revision).bind(&project).bind(&asset).bind(&ontology).bind(&serialized.json)
                .bind(if corrupt_hash && index == 0 { "0".repeat(64) } else { serialized.content_hash })
                .bind(&actor).bind(time).execute(tx.connection()).await.unwrap();
            sqlx::query("INSERT INTO annotation_heads(project_id,asset_revision_id,ontology_version_id,annotation_revision_id) VALUES(?,?,?,?)")
                .bind(&project).bind(&asset).bind(&ontology).bind(&revision).execute(tx.connection()).await.unwrap();
            assets.push(asset);
            revisions.push(revision);
        }
        if approved {
          for (asset, revision) in assets.iter().zip(&revisions) {
            let task = new_id();
            let review = new_id();
            sqlx::query("INSERT INTO review_tasks(task_id,project_id,asset_revision_id,ontology_version_id,assignee_id,created_by,state,created_at) VALUES(?,?,?,?,?,?,'closed',?)")
            .bind(&task).bind(&project).bind(asset).bind(&ontology).bind(&actor).bind(&reviewer).bind(time).execute(tx.connection()).await.unwrap();
            let ids = serde_json::to_string(&[revision]).unwrap();
            sqlx::query("INSERT INTO review_submissions(review_id,task_id,project_id,submitted_by,revision_ids_json,state,created_at) VALUES(?,?,?,?,?,'approved',?)")
                .bind(&review).bind(&task).bind(&project).bind(&actor).bind(&ids).bind(time).execute(tx.connection()).await.unwrap();
            sqlx::query("INSERT INTO review_decisions(review_id,decided_by,decision,reason,revision_ids_json,created_at) VALUES(?,?,'approve','Owned fixture approval',?,?)")
                .bind(&review).bind(&reviewer).bind(ids).bind(time).execute(tx.connection()).await.unwrap();
          }
        }
        tx.commit().await.unwrap();
        Self { _directory: directory, state, app, cookie, csrf, actor, project, ontology, assets, revisions }
    }

    fn request(&self, included: usize, total: usize) -> Value {
        json!({"operation_id":new_id(),"ontology_version_id":self.ontology,
            "items":(0..included).map(|i| json!({"asset_revision_id":self.assets[i],"annotation_revision_id":self.revisions[i],"split":"train"})).collect::<Vec<_>>(),
            "excluded":(included..total).map(|i| json!({"asset_revision_id":self.assets[i],"reason":"Not selected for this training snapshot"})).collect::<Vec<_>>(),
            "split_seed":null,"split_ratios":null})
    }

    async fn snapshot(&self, request: Value) -> (StatusCode, Value) {
        let (status, body, _) = send(&self.app, "POST", &format!("/api/projects/{}/dataset-versions", self.project), Some(request), Some(&self.cookie), Some(&self.csrf)).await;
        (status, body)
    }

    async fn assert_not_published(&self) {
        let mut tx = self.state.repository.begin_write().await.unwrap();
        let datasets: i64 = sqlx::query_scalar("SELECT count(*) FROM dataset_versions WHERE project_id=?").bind(&self.project).fetch_one(tx.connection()).await.unwrap();
        let replays: i64 = sqlx::query_scalar("SELECT count(*) FROM idempotency_keys WHERE actor_id=? AND operation_kind='dataset_snapshot'").bind(&self.actor).fetch_one(tx.connection()).await.unwrap();
        assert_eq!((datasets, replays), (0, 0));
        tx.rollback().await.unwrap();
    }
}

async fn assert_snapshot_capacity(included: usize, total: usize) {
    let fixture = SnapshotFixture::new(total, true, false, false).await;
    let (status, body) = fixture.snapshot(fixture.request(included, total)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["items"].as_array().unwrap().len(), included);
    assert_eq!(body["excluded"].as_array().unwrap().len(), total - included);
    let mut tx = fixture.state.repository.begin_write().await.unwrap();
    let manifest: String = sqlx::query_scalar("SELECT manifest_json FROM dataset_versions WHERE dataset_version_id=?")
        .bind(body["dataset_version_id"].as_str().unwrap()).fetch_one(tx.connection()).await.unwrap();
    let frozen: Value = serde_json::from_str(&manifest).unwrap();
    for (index, item) in frozen["items"].as_array().unwrap().iter().enumerate() {
        assert_eq!(item["media_revision"]["asset_revision_id"], fixture.assets[index]);
        assert_eq!(item["revision"]["annotation_revision_id"], fixture.revisions[index]);
        assert_eq!(item["revision"]["document"]["completion"], "confirmed_negative");
    }
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn snapshot_accepts_513_included_logical_assets() { assert_snapshot_capacity(513, 513).await; }
#[tokio::test]
async fn snapshot_accepts_1024_included_logical_assets() { assert_snapshot_capacity(1024, 1024).await; }
#[tokio::test]
async fn snapshot_accepts_513_total_with_exclusions() { assert_snapshot_capacity(1, 513).await; }
#[tokio::test]
async fn snapshot_accepts_1024_total_with_exclusions() { assert_snapshot_capacity(1, 1024).await; }

#[tokio::test]
async fn snapshot_rejects_1025_total_including_exclusions_without_publication() {
    let fixture = SnapshotFixture::new(1025, true, false, false).await;
    let (status, body) = fixture.snapshot(fixture.request(1, 1025)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "DATASET_REQUEST_INVALID");
    let (status, body) = fixture.snapshot(fixture.request(1025, 1025)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "DATASET_REQUEST_INVALID");
    fixture.assert_not_published().await;
}

#[tokio::test]
async fn snapshot_rejects_zero_included_duplicate_and_overlapping_assets() {
    let fixture = SnapshotFixture::new(2, true, false, false).await;
    let (status, body) = fixture.snapshot(fixture.request(0, 2)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "DATASET_REQUEST_INVALID");
    let mut duplicate = fixture.request(2, 2);
    duplicate["items"][1] = duplicate["items"][0].clone();
    let (status, body) = fixture.snapshot(duplicate).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "DATASET_ITEMS_INVALID");
    let mut overlap = fixture.request(1, 2);
    overlap["excluded"][0]["asset_revision_id"] = json!(fixture.assets[0]);
    let (status, body) = fixture.snapshot(overlap).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "DATASET_ITEMS_INVALID");
    let mut duplicate_excluded = fixture.request(1, 2);
    let excluded_copy = duplicate_excluded["excluded"][0].clone();
    duplicate_excluded["excluded"].as_array_mut().unwrap().push(excluded_copy);
    let (status, body) = fixture.snapshot(duplicate_excluded).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "DATASET_ITEMS_INVALID");
    fixture.assert_not_published().await;
}

#[tokio::test]
async fn snapshot_requires_exact_approval_consistent_hash_and_group_split() {
    for (approved, same_group, corrupt_hash, code, expected_status) in [
        (false, false, false, "SNAPSHOT_NOT_APPROVED", StatusCode::UNPROCESSABLE_ENTITY),
        (true, false, true, "ANNOTATION_CORRUPT", StatusCode::INTERNAL_SERVER_ERROR),
        (true, true, false, "SOURCE_GROUP_SPLIT", StatusCode::UNPROCESSABLE_ENTITY),
    ] {
        let fixture = SnapshotFixture::new(2, approved, same_group, corrupt_hash).await;
        let mut request = fixture.request(2, 2);
        request["items"][1]["split"] = json!("val");
        let (status, body) = fixture.snapshot(request).await;
        assert_eq!(status, expected_status, "{body}");
        assert_eq!(body["code"], code);
        fixture.assert_not_published().await;
    }
}

#[tokio::test]
async fn snapshot_accepts_approved_history_after_head_changes() {
    let fixture = SnapshotFixture::new(1, true, false, false).await;
    let later = new_id();
    let mut tx = fixture.state.repository.begin_write().await.unwrap();
    let old_json: String = sqlx::query_scalar("SELECT body_json FROM annotation_revisions WHERE annotation_revision_id=?")
        .bind(&fixture.revisions[0]).fetch_one(tx.connection()).await.unwrap();
    let mut changed: Value = serde_json::from_str(&old_json).unwrap();
    changed["completion"] = json!("complete");
    changed["objects"] = json!([{"object_id":new_id(),"label_id":"label_one","geometry":{"type":"bbox_xyxy","x_min":0,"y_min":0,"x_max":1,"y_max":1},"attributes":{},"origin":{"type":"manual","prediction_id":null,"model_run_id":null,"import_batch_id":null}}]);
    let document: annotation_domain::AnnotationDocument = serde_json::from_value(changed).unwrap();
    let serialized = annotation_domain::hash::serialize_document(&document).unwrap();
    sqlx::query("INSERT INTO annotation_revisions(annotation_revision_id,project_id,asset_revision_id,ontology_version_id,parent_revision_id,revision_no,body_json,content_hash,created_by,created_at) SELECT ?,project_id,asset_revision_id,ontology_version_id,annotation_revision_id,2,?,?,created_by,'2026-01-02T00:00:00.000Z' FROM annotation_revisions WHERE annotation_revision_id=?")
        .bind(&later).bind(serialized.json).bind(serialized.content_hash).bind(&fixture.revisions[0]).execute(tx.connection()).await.unwrap();
    sqlx::query("UPDATE annotation_heads SET annotation_revision_id=? WHERE asset_revision_id=?")
        .bind(&later).bind(&fixture.assets[0]).execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    let mut unapproved = fixture.request(1, 1);
    unapproved["items"][0]["annotation_revision_id"] = json!(later);
    let (status, body) = fixture.snapshot(unapproved).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "SNAPSHOT_NOT_APPROVED");
    let (status, body) = fixture.snapshot(fixture.request(1, 1)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["items"][0]["annotation_revision_id"], fixture.revisions[0]);
}


async fn raw_authenticated_request(fixture: &SnapshotFixture, cookie: &str, method: &str, path: &str, body: Vec<u8>) -> axum::response::Response {
    fixture.app.clone().oneshot(Request::builder().method(method).uri(path)
        .header("host", HOST).header("origin", ORIGIN).header("cookie", cookie)
        .header("x-csrf-token", &fixture.csrf).header("content-type", "application/json")
        .body(Body::from(body)).unwrap()).await.unwrap()
}

#[tokio::test]
async fn snapshot_http_json_limit_accepts_exact_2_mib_and_rejects_one_more_byte() {
    const LIMIT: usize = 2 * 1024 * 1024;
    let fixture = SnapshotFixture::new(2, true, false, false).await;
    let mut request = fixture.request(1, 2);
    // Retained UTF-8 and escaping are counted by the actual wire serializer.
    let prefix = "中文\"\\";
    request["excluded"][0]["reason"] = json!(prefix);
    let baseline = serde_json::to_vec(&request).unwrap().len();
    request["excluded"][0]["reason"] = json!(format!("{prefix}{}", "x".repeat(LIMIT - baseline)));
    let exact = serde_json::to_vec(&request).unwrap();
    assert_eq!(exact.len(), LIMIT);
    let path = format!("/api/projects/{}/dataset-versions", fixture.project);
    let response = raw_authenticated_request(&fixture, &fixture.cookie, "POST", &path, exact).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let bytes = to_bytes(response.into_body(), 4 * LIMIT).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["excluded"][0]["reason"], request["excluded"][0]["reason"]);
    request["operation_id"] = json!(new_id());
    let reason = request["excluded"][0]["reason"].as_str().unwrap().to_owned();
    request["excluded"][0]["reason"] = json!(format!("{reason}x"));
    let over = serde_json::to_vec(&request).unwrap();
    assert_eq!(over.len(), LIMIT + 1);
    let response = raw_authenticated_request(&fixture, &fixture.cookie, "POST", &path, over).await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let mut tx = fixture.state.repository.begin_write().await.unwrap();
    let datasets: i64 = sqlx::query_scalar("SELECT count(*) FROM dataset_versions WHERE project_id=?")
        .bind(&fixture.project).fetch_one(tx.connection()).await.unwrap();
    let replays: i64 = sqlx::query_scalar("SELECT count(*) FROM idempotency_keys WHERE actor_id=? AND operation_kind='dataset_snapshot'")
        .bind(&fixture.actor).fetch_one(tx.connection()).await.unwrap();
    assert_eq!((datasets, replays), (1, 1));
    tx.rollback().await.unwrap();
}

async fn seed_download(fixture: &SnapshotFixture, snapshot: &Value, job_state: &str, kind: &str, job_project: &str) -> (String, Vec<u8>, String) {
    // A complete valid ZIP is test-owned; download admission is independent of worker dispatch.
    let bytes = vec![0x50,0x4b,0x05,0x06,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
    let object = fixture.state.repository.object_store().stage_bytes("fixture.zip", &bytes).unwrap().publish().unwrap();
    let export = new_id();
    let now = "2026-01-01T00:00:00.000Z";
    let result = json!({"export_id":export,"format":"native","download_url":format!("/api/exports/{export}/download"),"byte_size":bytes.len(),"object_sha256":object.sha256,"loss_report":{"losses":[]}});
    let payload = json!({"project_id":fixture.project,"dataset_version_id":snapshot["dataset_version_id"],"manifest_sha256":snapshot["manifest_sha256"],"actor_id":fixture.actor,"format":"native"});
    let mut tx = fixture.state.repository.begin_write().await.unwrap();
    sqlx::query("INSERT INTO jobs(job_id,project_id,kind,state,payload_json,result_json,created_at,updated_at,worker_id,fencing_token,lease_until) VALUES(?,?,?,?,?,?,?,?,?,1,?)")
        .bind(&export).bind(job_project).bind(kind).bind(job_state).bind(payload.to_string())
        .bind(if job_state == "succeeded" { Some(result.to_string()) } else { None })
        .bind(now).bind(now).bind("owned-download-worker").bind("2099-01-01T00:00:00.000Z")
        .execute(tx.connection()).await.unwrap();
    sqlx::query("INSERT INTO dataset_exports(export_id,project_id,dataset_version_id,manifest_sha256,actor_id,format,object_sha256,byte_size,loss_report_json,created_at) VALUES(?,?,?,?,?,'native',?,?,?,?)")
        .bind(&export).bind(&fixture.project).bind(snapshot["dataset_version_id"].as_str().unwrap())
        .bind(snapshot["manifest_sha256"].as_str().unwrap()).bind(&fixture.actor).bind(&object.sha256)
        .bind(bytes.len() as i64).bind("{\"losses\":[]}").bind(now).execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    (export, bytes, object.sha256)
}

async fn download_fixture_and_snapshot() -> (SnapshotFixture, Value) {
    let fixture = SnapshotFixture::new(1, true, false, false).await;
    let (status, snapshot) = fixture.snapshot(fixture.request(1, 1)).await;
    assert_eq!(status, StatusCode::CREATED, "{snapshot}");
    (fixture, snapshot)
}

async fn assert_download_denied(job_state: &str, kind: &str, wrong_project: bool) {
    let (fixture, snapshot) = download_fixture_and_snapshot().await;
    let job_project = if wrong_project {
        let (status, body, _) = send(&fixture.app, "POST", "/api/projects", Some(json!({"name":"Foreign job project","description":"Owned scope boundary","allow_self_review":false})), Some(&fixture.cookie), Some(&fixture.csrf)).await;
        assert_eq!(status, StatusCode::CREATED);
        body["project_id"].as_str().unwrap().to_owned()
    } else { fixture.project.clone() };
    let (export, _, _) = seed_download(&fixture, &snapshot, job_state, kind, &job_project).await;
    let response = raw_authenticated_request(&fixture, &fixture.cookie, "GET", &format!("/api/exports/{export}/download"), Vec::new()).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND, "state={job_state}, kind={kind}, wrong_project={wrong_project}");
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["code"], "EXPORT_NOT_FOUND");
    assert!(!body.to_string().contains(&export));
}

#[tokio::test]
async fn dataset_download_denies_queued_job_even_with_owned_object_and_export_row() { assert_download_denied("queued", "dataset_export", false).await; }
#[tokio::test]
async fn dataset_download_denies_running_job_even_with_owned_object_and_export_row() { assert_download_denied("running", "dataset_export", false).await; }
#[tokio::test]
async fn dataset_download_denies_failed_job_even_with_owned_object_and_export_row() { assert_download_denied("failed", "dataset_export", false).await; }
#[tokio::test]
async fn dataset_download_denies_succeeded_wrong_kind_job() { assert_download_denied("succeeded", "media_import", false).await; }
#[tokio::test]
async fn dataset_download_denies_succeeded_wrong_project_job() { assert_download_denied("succeeded", "dataset_export", true).await; }

#[tokio::test]
async fn dataset_download_succeeded_control_has_exact_bytes_hash_type_and_nonmember_denial() {
    use sha2::{Digest, Sha256};
    let (fixture, snapshot) = download_fixture_and_snapshot().await;
    let (export, expected, hash) = seed_download(&fixture, &snapshot, "succeeded", "dataset_export", &fixture.project).await;
    let path = format!("/api/exports/{export}/download");
    let response = raw_authenticated_request(&fixture, &fixture.cookie, "GET", &path, Vec::new()).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "application/zip");
    assert_eq!(response.headers()["content-length"].to_str().unwrap(), expected.len().to_string());
    let report: Value = serde_json::from_str(response.headers()["x-weblabel-loss-report"].to_str().unwrap()).unwrap();
    assert_eq!(report, json!({"losses":[]}));
    let actual = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    assert_eq!(actual.as_ref(), expected.as_slice());
    assert_eq!(format!("{:x}", Sha256::digest(&actual)), hash);
    let (status, _, _) = send(&fixture.app, "POST", "/api/users", Some(json!({"username":"download-outsider","password":"download-outsider-password"})), Some(&fixture.cookie), Some(&fixture.csrf)).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _, outsider_cookie) = send(&fixture.app, "POST", "/api/session/login", Some(json!({"username":"download-outsider","password":"download-outsider-password"})), None, None).await;
    assert_eq!(status, StatusCode::OK);
    let outsider_cookie = outsider_cookie.unwrap();
    for job_state in ["succeeded", "queued", "running", "failed"] {
        let (id, _, _) = seed_download(&fixture, &snapshot, job_state, "dataset_export", &fixture.project).await;
        let response = raw_authenticated_request(&fixture, &outsider_cookie, "GET", &format!("/api/exports/{id}/download"), Vec::new()).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], "EXPORT_NOT_FOUND");
    }
    let (status, body, _) = send(&fixture.app, "GET", &format!("/api/exports/{}/download", new_id()), None, Some(&fixture.cookie), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "EXPORT_NOT_FOUND");
}


#[tokio::test]
async fn snapshot_http_rejects_missing_and_corrupt_owned_media_without_publication() {
    for missing in [true, false] {
        let fixture = SnapshotFixture::new(1, true, false, false).await;
        let mut tx = fixture.state.repository.begin_write().await.unwrap();
        let hash: String = sqlx::query_scalar("SELECT canonical_sha256 FROM media_revisions WHERE asset_revision_id=?")
            .bind(&fixture.assets[0]).fetch_one(tx.connection()).await.unwrap();
        tx.rollback().await.unwrap();
        let path = fixture.state.repository.object_store().path_for_hash(&hash).unwrap();
        if missing { std::fs::remove_file(path).unwrap(); }
        else { std::fs::write(path, b"corrupt synthetic media").unwrap(); }
        let (status, body) = fixture.snapshot(fixture.request(1, 1)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["code"], if missing { "MEDIA_OBJECT_MISSING" } else { "MEDIA_OBJECT_INVALID" });
        fixture.assert_not_published().await;
    }
}

#[tokio::test]
async fn snapshot_replay_preserves_inventory_and_conflicting_split_cannot_replace_it() {
    let fixture = SnapshotFixture::new(2, true, false, false).await;
    let request = fixture.request(1, 2);
    let (status, original) = fixture.snapshot(request.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{original}");
    let (status, replay) = fixture.snapshot(request.clone()).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay, original);
    let mut changed = request;
    changed["items"][0]["split"] = json!("val");
    let (status, body) = fixture.snapshot(changed).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "IDEMPOTENCY_KEY_REUSE");
    let mut tx = fixture.state.repository.begin_write().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM dataset_versions WHERE project_id=?")
        .bind(&fixture.project).fetch_one(tx.connection()).await.unwrap();
    assert_eq!(count, 1);
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn snapshot_unknown_revision_and_excluded_identity_leave_no_durable_state() {
    for excluded in [false, true] {
        let fixture = SnapshotFixture::new(2, true, false, false).await;
        let mut request = fixture.request(1, 2);
        if excluded { request["excluded"][0]["asset_revision_id"] = json!(new_id()); }
        else { request["items"][0]["annotation_revision_id"] = json!(new_id()); }
        let (status, body) = fixture.snapshot(request).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["code"], if excluded { "SNAPSHOT_EXCLUSION_INVALID" } else { "SNAPSHOT_REVISION_INVALID" });
        fixture.assert_not_published().await;
    }
}

#[tokio::test]
async fn snapshot_unauthenticated_request_cannot_publish_approved_inventory() {
    let fixture = SnapshotFixture::new(1, true, false, false).await;
    let (status, _, _) = send(&fixture.app, "POST", &format!("/api/projects/{}/dataset-versions", fixture.project), Some(fixture.request(1, 1)), None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    fixture.assert_not_published().await;
}

