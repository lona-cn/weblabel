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
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
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
#[cfg(debug_assertions)]
#[tokio::test]
async fn drain_waits_for_live_owner_without_blocking_writes_or_changing_ownership() {
    let directory = tempdir().unwrap();
    let config = ServerConfig {
        bind: HOST.parse().unwrap(),
        database_url: format!("sqlite:{}", directory.path().join("drain.sqlite").display()),
        object_root: directory.path().join("objects"),
        write_timeout: Duration::from_secs(2),
        production: true,
    };
    let state = AppState::open_with_auth(
        &config,
        AuthConfig {
            bind: config.bind,
            cookie_secure: false,
            allowed_origins: vec![ORIGIN.to_owned()],
            allowed_hosts: vec![HOST.to_owned()],
            launch_code: hash_launch_code("drain-launch"),
            launch_code_expires_at: chrono::Utc::now().timestamp() + 3600,
        },
    )
    .await
    .unwrap();
    let repository = state.repository.clone();
    let queue = weblabel_api::jobs::queue::JobQueue::new(repository.clone());
    let app = router(state);
    let (status, bootstrap, cookie) = send(
        &app,
        "POST",
        "/api/session/bootstrap",
        Some(json!({"launch_code":"drain-launch","password":"drain-bootstrap-password"})),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cookie = cookie.unwrap();
    let csrf = bootstrap["csrf_token"].as_str().unwrap();
    for succeeded in [true, false] {
        let enqueued = queue
            .enqueue(
                None,
                "owner-controlled",
                &uuid::Uuid::new_v4().to_string(),
                &json!({}),
            )
            .await
            .unwrap();
        let lease = queue
            .lease_next("background-owner", Duration::from_secs(30))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(lease.job_id, enqueued.job_id);
        let drain = send(
            &app,
            "POST",
            "/internal/test/jobs/drain",
            Some(json!({})),
            Some(&cookie),
            Some(csrf),
        );
        tokio::pin!(drain);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut drain)
                .await
                .is_err(),
            "drain completed before live owner"
        );
        let (status, _, _) = tokio::time::timeout(Duration::from_millis(500), send(&app, "POST", "/api/projects",
            Some(json!({"name":"Concurrent write","description":"drain must release writer","allow_self_review":true})), Some(&cookie), Some(csrf))).await.unwrap();
        assert_eq!(status, StatusCode::CREATED);
        let later = queue
            .enqueue(
                None,
                "later-owner-controlled",
                &uuid::Uuid::new_v4().to_string(),
                &json!({}),
            )
            .await
            .unwrap();
        let later_lease = queue
            .lease_next("later-owner", Duration::from_secs(30))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(later_lease.job_id, later.job_id);
        let result = json!({"owner_result": if succeeded { "success" } else { "failure" }});
        queue.finish(&lease, succeeded, &result).await.unwrap();
        let (status, body, _) = tokio::time::timeout(Duration::from_millis(500), &mut drain)
            .await
            .unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"processed":0,"jobs":[]}));
        let mut tx = repository.begin_write().await.unwrap();
        let row: (String, String, i64, i64, String) = sqlx::query_as(
            "SELECT state, worker_id, fencing_token, attempt, result_json FROM jobs WHERE job_id=?",
        )
        .bind(&lease.job_id)
        .fetch_one(tx.connection())
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            row,
            (
                if succeeded { "succeeded" } else { "failed" }.to_owned(),
                "background-owner".to_owned(),
                1,
                1,
                result.to_string()
            )
        );
        queue.finish(&later_lease, true, &json!({})).await.unwrap();
    }
    let held = queue
        .enqueue(
            None,
            "timeout-owner",
            &uuid::Uuid::new_v4().to_string(),
            &json!({}),
        )
        .await
        .unwrap();
    let held_lease = queue
        .lease_next("timeout-owner", Duration::from_secs(30))
        .await
        .unwrap()
        .unwrap();
    let (status, body, _) = tokio::time::timeout(
        Duration::from_secs(3),
        send(
            &app,
            "POST",
            "/internal/test/jobs/drain",
            Some(json!({})),
            Some(&cookie),
            Some(csrf),
        ),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["code"], "JOB_DRAIN_TIMEOUT");
    assert_eq!(held.job_id, held_lease.job_id);
    queue.finish(&held_lease, true, &json!({})).await.unwrap();
    let missing = queue
        .enqueue(
            None,
            "missing-owner",
            &uuid::Uuid::new_v4().to_string(),
            &json!({}),
        )
        .await
        .unwrap();
    let missing_lease = queue
        .lease_next("missing-owner", Duration::from_secs(30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(missing.job_id, missing_lease.job_id);
    let drain = send(
        &app,
        "POST",
        "/internal/test/jobs/drain",
        Some(json!({})),
        Some(&cookie),
        Some(csrf),
    );
    tokio::pin!(drain);
    assert!(tokio::time::timeout(Duration::from_millis(100), &mut drain)
        .await
        .is_err());
    let mut tx = repository.begin_write().await.unwrap();
    sqlx::query("DELETE FROM job_idempotency WHERE job_id=?")
        .bind(&missing.job_id)
        .execute(tx.connection())
        .await
        .unwrap();
    sqlx::query("DELETE FROM jobs WHERE job_id=?")
        .bind(&missing.job_id)
        .execute(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (status, body, _) = tokio::time::timeout(Duration::from_millis(500), &mut drain)
        .await
        .unwrap();
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body["code"], "JOB_DRAIN_FAILED");
    let queued = queue
        .enqueue(
            None,
            "unsupported",
            &uuid::Uuid::new_v4().to_string(),
            &json!({}),
        )
        .await
        .unwrap();
    let (status, body, _) = send(
        &app,
        "POST",
        "/internal/test/jobs/drain",
        Some(json!({})),
        Some(&cookie),
        Some(csrf),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({"processed":1,"jobs":[{"job_id":queued.job_id,"kind":"unsupported","state":"failed"}]})
    );
}
