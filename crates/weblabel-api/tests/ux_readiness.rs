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

async fn get(app: &Router, path: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(path)
                .header("host", "127.0.0.1:48100")
                .body(Body::empty())
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

async fn state(root: &std::path::Path, maintenance: bool) -> AppState {
    let config = ServerConfig {
        database_url: format!("sqlite:{}", root.join("api.sqlite").display()),
        object_root: root.join("objects"),
        ..ServerConfig::default()
    };
    let auth = AuthConfig {
        bind: config.bind,
        cookie_secure: false,
        allowed_hosts: vec!["127.0.0.1:48100".into()],
        allowed_origins: vec!["http://127.0.0.1:48100".into()],
        launch_code: hash_launch_code("synthetic-ux-code"),
        launch_code_expires_at: i64::MAX,
    };
    if maintenance {
        AppState::open_for_password_recovery(&config, auth)
            .await
            .unwrap()
    } else {
        AppState::open_with_auth(&config, auth).await.unwrap()
    }
}

#[tokio::test]
async fn readiness_distinguishes_a_reachable_service_from_an_unavailable_object_store() {
    let parent = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/ux-readiness");
    std::fs::create_dir_all(&parent).unwrap();
    let scratch = tempfile::tempdir_in(parent).unwrap();
    let state = state(scratch.path(), false).await;
    let objects = state.repository.object_store().root().to_owned();
    let app = router(state);
    assert_eq!(
        get(&app, "/ready").await,
        (StatusCode::OK, json!({"ready":true,"mode":"normal"}))
    );
    std::fs::remove_dir(&objects).unwrap();
    assert_eq!(get(&app, "/health").await.0, StatusCode::NO_CONTENT);
    let (status, body) = get(&app, "/ready").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["ready"], false);
    assert!(body.get("path").is_none());
    assert!(
        !objects.exists(),
        "readiness must not recreate storage or write a probe"
    );
}

#[tokio::test]
async fn maintenance_is_live_but_not_business_ready_and_host_origin_are_enforced() {
    let parent = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/ux-readiness");
    std::fs::create_dir_all(&parent).unwrap();
    let scratch = tempfile::tempdir_in(parent).unwrap();
    let mut state = state(scratch.path(), true).await;
    let normal = router(state.clone());
    let bootstrap = normal.oneshot(Request::builder().method("POST").uri("/api/session/bootstrap")
        .header("host", "127.0.0.1:48100").header("origin", "http://127.0.0.1:48100").header("content-type", "application/json")
        .body(Body::from(json!({"launch_code":"synthetic-ux-code","password":"SyntheticReadinessOnly-20261013"}).to_string())).unwrap()).await.unwrap();
    assert_eq!(bootstrap.status(), StatusCode::OK);
    state
        .auth
        .enable_password_recovery(
            &uuid::Uuid::new_v4().to_string(),
            "local-admin",
            hash_launch_code("synthetic-recovery"),
            i64::MAX,
        )
        .await
        .unwrap();

    let app = router(state);
    assert_eq!(get(&app, "/health").await.0, StatusCode::NO_CONTENT);
    assert_eq!(
        get(&app, "/ready").await,
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"ready":false,"mode":"password_recovery"})
        )
    );
    for (host, origin) in [
        ("remote.example", "http://127.0.0.1:48100"),
        ("127.0.0.1:48100", "https://remote.example"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/ready")
                    .header("host", host)
                    .header("origin", origin)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    drop(app);
}
