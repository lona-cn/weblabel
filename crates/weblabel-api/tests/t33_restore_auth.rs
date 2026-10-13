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
const HOST: &str = "127.0.0.1:48333";
const CODE: &str = "t33-synthetic-one-time-launch-code";
async fn fixture() -> (tempfile::TempDir, AppState) {
    let directory = tempfile::tempdir().unwrap();
    let config = ServerConfig {
        bind: HOST.parse::<SocketAddr>().unwrap(),
        database_url: format!("sqlite:{}", directory.path().join("api.sqlite").display()),
        object_root: directory.path().join("objects"),
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
            launch_code: hash_launch_code(CODE),
            launch_code_expires_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64
                + 600,
        },
    )
    .await
    .unwrap();
    sqlx::query("INSERT INTO users(user_id,username,password_hash,created_at,platform_admin) VALUES('old-user','local-admin','','synthetic',1)").execute(&state.auth.pool).await.unwrap();
    sqlx::query("INSERT INTO projects(project_id,name,description,created_at) VALUES('restored-project','Synthetic restored project','','synthetic')").execute(&state.auth.pool).await.unwrap();
    sqlx::query("INSERT INTO memberships(project_id,user_id,role) VALUES('restored-project','old-user','admin')").execute(&state.auth.pool).await.unwrap();
    (directory, state)
}
async fn bootstrap(state: &AppState) -> (StatusCode, Value) {
    let response = router(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session/bootstrap")
                .header(header::HOST, HOST)
                .header(header::ORIGIN, format!("http://{HOST}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"launch_code":CODE,"password":"t33-new-synthetic-password"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}
async fn session(state: &AppState) {
    sqlx::query("INSERT INTO sessions(session_id,user_id,expires_at,created_at,csrf_hash) VALUES('retained-session','old-user','9999999999','synthetic','synthetic')").execute(&state.auth.pool).await.unwrap();
}
async fn assert_status(state: &AppState, mode: &str, available: bool) {
    let response = router(state.clone())
        .oneshot(
            Request::builder()
                .uri("/api/session/bootstrap")
                .header(header::HOST, HOST)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"mode":mode,"bootstrap_available":available})
    );
}

#[tokio::test]
async fn restored_bootstrap_is_explicit_one_shot_and_preserves_old_audit_identity() {
    let (_directory, state) = fixture().await;
    assert_status(&state, "login", false).await;
    assert_eq!(bootstrap(&state).await.0, StatusCode::CONFLICT);
    assert!(state.auth.enable_restore_bootstrap().await.unwrap());
    assert_status(&state, "restore", true).await;
    let (status, body) = bootstrap(&state).await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(body["user_id"], "old-user");
    assert!(body["username"]
        .as_str()
        .unwrap()
        .starts_with("restore-admin-"));
    assert_status(&state, "login", false).await;
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT user_id,username,password_hash FROM users ORDER BY user_id")
            .fetch_all(&state.auth.pool)
            .await
            .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().any(|row| row
        == &(
            "old-user".to_owned(),
            "local-admin".to_owned(),
            String::new()
        )));
    let role: String = sqlx::query_scalar(
        "SELECT role FROM memberships WHERE project_id='restored-project' AND user_id=?",
    )
    .bind(body["user_id"].as_str().unwrap())
    .fetch_one(&state.auth.pool)
    .await
    .unwrap();
    assert_eq!(role, "admin");
    assert_eq!(bootstrap(&state).await.0, StatusCode::CONFLICT);
}
#[tokio::test]
async fn restore_mode_cannot_reset_surviving_credentials_or_sessions() {
    for retained_session in [false, true] {
        let (_directory, state) = fixture().await;
        if retained_session {
            session(&state).await;
        } else {
            sqlx::query("UPDATE users SET password_hash='surviving-credential'")
                .execute(&state.auth.pool)
                .await
                .unwrap();
        }
        assert!(!state.auth.enable_restore_bootstrap().await.unwrap());
        assert_status(&state, "login", false).await;
        assert_eq!(bootstrap(&state).await.0, StatusCode::CONFLICT);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&state.auth.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }
}
#[tokio::test]
async fn startup_eligibility_is_rechecked_transactionally_before_creating_recovery_admin() {
    for retained_session in [false, true] {
        let (_directory, state) = fixture().await;
        assert!(state.auth.enable_restore_bootstrap().await.unwrap());
        assert_status(&state, "restore", true).await;
        if retained_session {
            session(&state).await;
        } else {
            sqlx::query("UPDATE users SET password_hash='racing-credential'")
                .execute(&state.auth.pool)
                .await
                .unwrap();
        }
        assert_status(&state, "login", false).await;
        assert_eq!(bootstrap(&state).await.0, StatusCode::CONFLICT);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&state.auth.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let old_role: String =
            sqlx::query_scalar("SELECT role FROM memberships WHERE user_id='old-user'")
                .fetch_one(&state.auth.pool)
                .await
                .unwrap();
        assert_eq!(old_role, "admin");
    }
}
