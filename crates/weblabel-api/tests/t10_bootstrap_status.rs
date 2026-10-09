use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tower::ServiceExt;
use weblabel_api::{
    auth::{hash_launch_code, AuthConfig},
    config::ServerConfig,
    router, AppState,
};

const HOST: &str = "127.0.0.1:48310";
const CODE: &str = "t10-synthetic-one-time-code";
async fn fixture(expired: bool) -> (tempfile::TempDir, AppState) {
    let directory = tempfile::tempdir().unwrap();
    let config = ServerConfig {
        bind: HOST.parse::<SocketAddr>().unwrap(),
        database_url: format!("sqlite:{}", directory.path().join("api.sqlite").display()),
        object_root: directory.path().join("objects"),
        write_timeout: Duration::from_secs(2),
        production: true,
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let state = AppState::open_with_auth(
        &config,
        AuthConfig {
            bind: config.bind,
            cookie_secure: false,
            allowed_origins: vec![format!("http://{HOST}")],
            allowed_hosts: vec![HOST.to_owned()],
            launch_code: hash_launch_code(CODE),
            launch_code_expires_at: now + if expired { -1 } else { 600 },
        },
    )
    .await
    .unwrap();
    (directory, state)
}
async fn request(
    state: &AppState,
    method: &str,
    host: &str,
    origin: Option<&str>,
    body: Value,
) -> (StatusCode, String, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri("/api/session/bootstrap")
        .header(header::HOST, host)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(origin) = origin {
        request = request.header(header::ORIGIN, origin);
    }
    let response = router(state.clone())
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cache = response
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        cache,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn status(state: &AppState) -> Value {
    let (status, cache, body) = request(state, "GET", HOST, None, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cache, "no-store");
    body
}
async fn redeem(state: &AppState, code: &str) -> (StatusCode, String, Value) {
    request(
        state,
        "POST",
        HOST,
        Some(&format!("http://{HOST}")),
        json!({"launch_code":code,"password":"t10-synthetic-password"}),
    )
    .await
}
#[tokio::test]
async fn empty_database_status_does_not_consume_code_and_tracks_redemption() {
    let (_directory, state) = fixture(false).await;
    assert_eq!(
        status(&state).await,
        json!({"mode":"initial","bootstrap_available":true})
    );
    assert_eq!(
        redeem(&state, "incorrect").await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        status(&state).await,
        json!({"mode":"initial","bootstrap_available":true})
    );
    assert_eq!(redeem(&state, CODE).await.0, StatusCode::OK);
    assert_eq!(
        status(&state).await,
        json!({"mode":"login","bootstrap_available":false})
    );
}
#[tokio::test]
async fn expired_code_is_unavailable() {
    let (_directory, state) = fixture(true).await;
    assert_eq!(
        status(&state).await,
        json!({"mode":"initial","bootstrap_available":false})
    );
}
#[tokio::test]
async fn host_origin_and_database_failures_are_not_cached_or_disguised() {
    let (_directory, state) = fixture(false).await;
    for (host, origin, code) in [
        ("attacker.invalid", None, "HOST_NOT_ALLOWED"),
        (HOST, Some("https://attacker.invalid"), "ORIGIN_NOT_ALLOWED"),
    ] {
        let (status, cache, body) = request(&state, "GET", host, origin, Value::Null).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(cache, "no-store");
        assert_eq!(body["code"], code);
    }
    state.auth.pool.close().await;
    let (status, cache, body) = request(&state, "GET", HOST, None, Value::Null).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(cache, "no-store");
    assert_eq!(body["code"], "BOOTSTRAP_STATUS_FAILED");
    assert_eq!(body["message"], "Bootstrap status could not be read");
}
#[tokio::test]
async fn concurrent_redemptions_create_only_one_initial_admin() {
    let (_directory, state) = fixture(false).await;
    let (a, b) = tokio::join!(redeem(&state, CODE), redeem(&state, CODE));
    assert!(matches!(
        (a.0, b.0),
        (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)
    ));
    let users: Vec<(String, i64)> = sqlx::query_as("SELECT username, platform_admin FROM users")
        .fetch_all(&state.auth.pool)
        .await
        .unwrap();
    assert_eq!(users, vec![("local-admin".to_owned(), 1)]);
    assert_eq!(
        status(&state).await,
        json!({"mode":"login","bootstrap_available":false})
    );
}
