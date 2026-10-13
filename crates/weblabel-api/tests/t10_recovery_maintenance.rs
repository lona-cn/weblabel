use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;
use weblabel_api::{
    auth::{hash_launch_code, AuthConfig},
    config::ServerConfig,
    router, AppState,
};

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    payload: Option<Value>,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("host", "127.0.0.1:48100")
                .header("origin", "http://127.0.0.1:48100")
                .header("content-type", "application/json")
                .body(payload.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 65536).await.unwrap();
    (
        status,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        },
    )
}

#[tokio::test]
async fn maintenance_rejects_normal_authentication_business_and_agent_routes_even_after_completion()
{
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/admin-recovery-tests");
    std::fs::create_dir_all(&root).unwrap();
    let scratch = tempfile::tempdir_in(root).unwrap();
    let config = ServerConfig {
        database_url: format!("sqlite:{}", scratch.path().join("api.sqlite").display()),
        object_root: scratch.path().join("objects"),
        ..ServerConfig::default()
    };
    let expiry = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
        + 600;
    let auth = AuthConfig {
        bind: config.bind,
        cookie_secure: false,
        allowed_hosts: vec!["127.0.0.1:48100".into()],
        allowed_origins: vec!["http://127.0.0.1:48100".into()],
        launch_code: hash_launch_code("synthetic-bootstrap-code"),
        launch_code_expires_at: expiry,
    };
    let mut state = AppState::open_for_password_recovery(&config, auth)
        .await
        .unwrap();
    let normal = router(state.clone());
    let (status, _) = request(
        &normal,
        "POST",
        "/api/session/bootstrap",
        Some(
            json!({"launch_code":"synthetic-bootstrap-code", "password":"old-synthetic-password"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    state
        .auth
        .enable_password_recovery(
            &uuid::Uuid::new_v4().to_string(),
            "local-admin",
            hash_launch_code("synthetic-recovery-code"),
            expiry,
        )
        .await
        .unwrap();
    let maintenance = router(state);
    for app in [&normal, &maintenance] {
        for (host, origin) in [
            ("evil.example", "http://127.0.0.1:48100"),
            ("127.0.0.1:48100", "https://evil.example"),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/api/session/password-recovery")
                        .header("host", host)
                        .header("origin", origin)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            assert_eq!(
                response
                    .headers()
                    .get("cache-control")
                    .and_then(|header| header.to_str().ok()),
                Some("no-store")
            );
        }
    }
    for (method, path) in [
        ("GET", "/api/session"),
        ("POST", "/api/session/login"),
        ("POST", "/api/session/bootstrap"),
        ("GET", "/api/projects"),
        ("POST", "/api/projects"),
        ("POST", "/internal/agent-tools/list_objects"),
    ] {
        let (status, body) = request(&maintenance, method, path, Some(json!({}))).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{path}");
        assert_eq!(body["code"], "RECOVERY_MAINTENANCE");
    }
    let (status, body) = request(
        &maintenance,
        "POST",
        "/api/session/password-recovery",
        Some(
            json!({"recovery_code":"synthetic-recovery-code", "password":"new-synthetic-password"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["state"], "completed");
    let (status, body) = request(
        &maintenance,
        "POST",
        "/api/session/login",
        Some(json!({"username":"local-admin", "password":"new-synthetic-password"})),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["code"], "RECOVERY_MAINTENANCE");
}
