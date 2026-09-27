use std::{net::SocketAddr, time::Duration};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use image::{DynamicImage, ImageFormat, RgbImage};
use serde_json::{json, Value};
use tempfile::tempdir;
use tower::ServiceExt;
use weblabel_api::{
    auth::{hash_launch_code, AuthConfig},
    config::ServerConfig,
    jobs::worker::MediaWorker,
    media::ingest::{import_one, ImportInput},
    review::leases::validate_fencing,
    router, AppState,
};

const HOST: &str = "127.0.0.1:48100";
const ORIGIN: &str = "http://127.0.0.1:48100";

#[test]
fn fencing_requires_the_exact_generation() {
    assert!(validate_fencing(42, 42).is_ok());
    assert_eq!(validate_fencing(42, 41), Err("STALE_FENCING_TOKEN"));
    assert_eq!(validate_fencing(42, 43), Err("STALE_FENCING_TOKEN"));
    assert_eq!(validate_fencing(1, 0), Err("STALE_FENCING_TOKEN"));
}

async fn send(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    cookie: Option<&str>,
    csrf: Option<&str>,
) -> (StatusCode, Value, Option<String>) {
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
    let response = app
        .clone()
        .oneshot(
            builder
                .body(Body::from(body.map(|v| v.to_string()).unwrap_or_default()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or_default().to_owned());
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, json, cookie)
}

#[tokio::test]
async fn expired_lease_blocks_annotation_put_even_when_cas_head_matches() {
    let directory = tempdir().unwrap();
    let config = ServerConfig {
        bind: HOST.parse::<SocketAddr>().unwrap(),
        database_url: format!("sqlite:{}", directory.path().join("t26.sqlite").display()),
        object_root: directory.path().join("objects"),
        write_timeout: Duration::from_secs(2),
        production: true,
    };
    let launch_code = "t26-expiry-launch";
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
    let app = router(state.clone());
    let (status, bootstrap, admin_cookie) = send(
        &app,
        "POST",
        "/api/session/bootstrap",
        Some(json!({"launch_code":launch_code,"password":"t26-bootstrap-password"})),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let admin_cookie = admin_cookie.unwrap();
    let admin_csrf = bootstrap["csrf_token"].as_str().unwrap().to_owned();
    let admin_id = bootstrap["user_id"].as_str().unwrap().to_owned();
    let (status,project,_)=send(&app,"POST","/api/projects",Some(json!({"name":"T26 expiry","description":"isolated lease expiry","allow_self_review":false})),Some(&admin_cookie),Some(&admin_csrf)).await;
    assert_eq!(status, StatusCode::CREATED);
    let project_id = project["project_id"].as_str().unwrap().to_owned();
    let ontology_body = json!({"labels":[{"label_id":"label_person","name":"Person","color":"#0099ff","shortcut":null,"allowed_geometry_types":["bbox_xyxy"],"attributes":[]}],"guidelines_markdown":"Expiry test ontology"});
    let (status, ontology, _) = send(
        &app,
        "POST",
        &format!("/api/projects/{project_id}/ontologies"),
        Some(ontology_body),
        Some(&admin_cookie),
        Some(&admin_csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let ontology_id = ontology["ontology_version_id"].as_str().unwrap().to_owned();
    let username = "t26-expiry-annotator";
    let password = "t26-annotator-password";
    let (status, user, _) = send(
        &app,
        "POST",
        "/api/users",
        Some(json!({"username":username,"password":password})),
        Some(&admin_cookie),
        Some(&admin_csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let annotator_id = user["user_id"].as_str().unwrap().to_owned();
    let (status, _, _) = send(
        &app,
        "POST",
        &format!("/api/projects/{project_id}/members"),
        Some(json!({"user_id":annotator_id,"role":"annotator"})),
        Some(&admin_cookie),
        Some(&admin_csrf),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, login, annotator_cookie) = send(
        &app,
        "POST",
        "/api/session/login",
        Some(json!({"username":username,"password":password})),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let annotator_cookie = annotator_cookie.unwrap();
    let annotator_csrf = login["csrf_token"].as_str().unwrap().to_owned();
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
            actor_id: admin_id,
            source_group_id: "t26-expiry".to_owned(),
            original_name: "fixture.png".to_owned(),
            declared_mime: Some("image/png".to_owned()),
            bytes: png.into_inner(),
        },
    )
    .await
    .unwrap();
    let (status,task,_)=send(&app,"POST",&format!("/api/projects/{project_id}/tasks"),Some(json!({"asset_revision_id":imported.asset_revision_id,"ontology_version_id":ontology_id,"assignee_id":annotator_id})),Some(&admin_cookie),Some(&admin_csrf)).await;
    assert_eq!(status, StatusCode::OK);
    let task_id = task["task_id"].as_str().unwrap().to_owned();
    let (status, lease, _) = send(
        &app,
        "POST",
        &format!("/api/tasks/{task_id}/lease"),
        Some(json!({"action":"acquire"})),
        Some(&annotator_cookie),
        Some(&annotator_csrf),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    sqlx::query("UPDATE task_leases SET expires_at=0 WHERE task_id=?")
        .bind(&task_id)
        .execute(&state.auth.pool)
        .await
        .unwrap();
    let path = format!("/api/assets/{}/annotation", imported.asset_revision_id);
    let (status, head, _) = send(
        &app,
        "GET",
        &format!("{path}?ontology_version_id={ontology_id}"),
        None,
        Some(&admin_cookie),
        Some(&admin_csrf),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status,denied,_)=send(&app,"PUT",&path,Some(json!({"operation_id":"t26-expired-save","base_revision_id":imported.annotation_revision_id,"document":head["document"],"lease":{"task_id":task_id,"fencing_token":lease["fencing_token"]},"suggestion_decisions":[]})),Some(&annotator_cookie),Some(&annotator_csrf)).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "expired lease must fail even while base revision still matches: {denied}"
    );
    assert_eq!(denied["code"], "LEASE_EXPIRED");
    let (_, unchanged, _) = send(
        &app,
        "GET",
        &format!("{path}?ontology_version_id={ontology_id}"),
        None,
        Some(&admin_cookie),
        Some(&admin_csrf),
    )
    .await;
    assert_eq!(
        unchanged["annotation_revision_id"],
        imported.annotation_revision_id
    );
}
