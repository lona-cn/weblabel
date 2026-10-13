use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tower::ServiceExt;
use weblabel_api::{
    auth::{self, hash_launch_code, AuthConfig, AuthState},
    config::ServerConfig,
    AppState,
};
const HOST: &str = "127.0.0.1:48310";
const ID: &str = "afc7511a-456b-478c-b123-456789abcdef";
const CODE: &str = "synthetic-recovery-code";
const OLD: &str = "synthetic-old-password";
const NEW: &str = "  synthetic-new-password  ";
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
async fn fixture() -> (tempfile::TempDir, AuthState) {
    let temporary_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/admin-recovery-tests/backend");
    std::fs::create_dir_all(&temporary_root).unwrap();
    let directory = tempfile::tempdir_in(temporary_root).unwrap();
    let config = ServerConfig {
        bind: HOST.parse().unwrap(),
        database_url: format!("sqlite:{}", directory.path().join("test.sqlite").display()),
        object_root: directory.path().join("objects"),
        write_timeout: Duration::from_secs(2),
        production: true,
    };
    let state = AppState::open_with_auth(
        &config,
        AuthConfig {
            bind: config.bind,
            cookie_secure: false,
            allowed_hosts: vec![HOST.into()],
            allowed_origins: vec![format!("http://{HOST}")],
            launch_code: hash_launch_code("synthetic-launch-code"),
            launch_code_expires_at: now() + 600,
        },
    )
    .await
    .unwrap();
    for (id, name, admin) in [
        ("admin-id", "local-admin", 1),
        ("other-id", "other-user", 0),
    ] {
        sqlx::query("INSERT INTO users(user_id,username,password_hash,created_at,platform_admin) VALUES(?,?,?,'synthetic',?)").bind(id).bind(name).bind(auth::hash_password(OLD).unwrap()).bind(admin).execute(&state.auth.pool).await.unwrap();
        sqlx::query("INSERT INTO sessions(session_id,user_id,expires_at,created_at,csrf_hash) VALUES(?,?,'9999999999','synthetic','synthetic')").bind(hash_launch_code(id)).bind(id).execute(&state.auth.pool).await.unwrap();
    }
    sqlx::query("INSERT INTO projects(project_id,name,description,created_at) VALUES('project','Synthetic','','synthetic')").execute(&state.auth.pool).await.unwrap();
    sqlx::query("INSERT INTO memberships(project_id,user_id,role) VALUES('project','admin-id','admin'),('project','other-id','reviewer')").execute(&state.auth.pool).await.unwrap();
    (directory, state.auth)
}
fn app(state: &AuthState) -> Router {
    auth::password_recovery_router(state.clone()).merge(auth::router(state.clone()))
}
async fn request(
    state: &AuthState,
    path: &str,
    method: &str,
    body: Value,
    host: &str,
    origin: Option<&str>,
    cookie: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let mut req = Request::builder()
        .uri(path)
        .method(method)
        .header(header::HOST, host)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(origin) = origin {
        req = req.header(header::ORIGIN, origin);
    }
    if let Some(cookie) = cookie {
        req = req.header(header::COOKIE, cookie);
    }
    let res = app(state)
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = to_bytes(res.into_body(), 16384).await.unwrap();
    (
        status,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn recovery(
    state: &AuthState,
    method: &str,
    code: &str,
    password: &str,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let result = request(
        state,
        "/api/session/password-recovery",
        method,
        json!({"recovery_code":code,"password":password}),
        HOST,
        Some(&format!("http://{HOST}")),
        Some("weblabel_session=stale"),
    )
    .await;
    assert_eq!(result.1[header::CACHE_CONTROL], "no-store");
    assert!(!result.1.contains_key(header::SET_COOKIE));
    result
}
async fn enable(state: &mut AuthState, expires: i64) {
    state
        .enable_password_recovery(ID, "local-admin", hash_launch_code(CODE), expires)
        .await
        .unwrap();
}
#[tokio::test]
async fn recovery_preserves_identity_and_revokes_only_target_sessions() {
    let (_dir, mut state) = fixture().await;
    enable(&mut state, now() + 600).await;
    assert!(state.password_recovery_enabled());
    assert_eq!(
        recovery(&state, "GET", CODE, NEW).await.2,
        json!({"state":"available","request_id":ID,"username":"local-admin"})
    );
    assert_eq!(recovery(&state, "POST", CODE, NEW).await.0, StatusCode::OK);
    assert_eq!(
        recovery(&state, "GET", CODE, NEW).await.2["state"],
        "completed"
    );
    assert_eq!(
        recovery(&state, "POST", CODE, NEW).await.0,
        StatusCode::CONFLICT
    );
    for (password, expected) in [(OLD, StatusCode::UNAUTHORIZED), (NEW, StatusCode::OK)] {
        assert_eq!(
            request(
                &state,
                "/api/session/login",
                "POST",
                json!({"username":"local-admin","password":password}),
                HOST,
                Some(&format!("http://{HOST}")),
                None
            )
            .await
            .0,
            expected
        );
    }
    assert_eq!(
        request(
            &state,
            "/api/session",
            "GET",
            Value::Null,
            HOST,
            None,
            Some("weblabel_session=admin-id")
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &state,
            "/api/session",
            "GET",
            Value::Null,
            HOST,
            None,
            Some("weblabel_session=other-id")
        )
        .await
        .0,
        StatusCode::OK
    );
    let identities: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT user_id,username,platform_admin FROM users ORDER BY user_id")
            .fetch_all(&state.pool)
            .await
            .unwrap();
    assert_eq!(
        identities,
        vec![
            ("admin-id".into(), "local-admin".into(), 1),
            ("other-id".into(), "other-user".into(), 0)
        ]
    );
    let roles: Vec<(String, String)> =
        sqlx::query_as("SELECT user_id,role FROM memberships ORDER BY user_id")
            .fetch_all(&state.pool)
            .await
            .unwrap();
    assert_eq!(
        roles,
        vec![
            ("admin-id".into(), "admin".into()),
            ("other-id".into(), "reviewer".into())
        ]
    );
    let hash: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE user_id='other-id'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert!(auth::verify_password(OLD, &hash));
    let mut restarted = AuthState::new(state.pool.clone(), state.config.clone()).unwrap();
    assert!(restarted
        .enable_password_recovery(ID, "local-admin", hash_launch_code(CODE), now() + 600)
        .await
        .is_err());
}
#[tokio::test]
async fn disabled_validation_expiry_and_rate_limit() {
    let (_dir, mut state) = fixture().await;
    assert_eq!(
        recovery(&state, "GET", CODE, NEW).await.2,
        json!({"state":"disabled","request_id":null,"username":null})
    );
    assert_eq!(
        recovery(&state, "POST", CODE, NEW).await.0,
        StatusCode::NOT_FOUND
    );
    for (id, user) in [
        ("not-uuid", "local-admin"),
        ("00000000-0000-0000-0000-000000000000", "local-admin"),
        (ID, "other-user"),
        (ID, " local-admin"),
        (ID, "missing-user"),
    ] {
        assert!(state
            .enable_password_recovery(id, user, hash_launch_code(CODE), now() + 600)
            .await
            .is_err());
    }
    enable(&mut state, now() - 1).await;
    assert_eq!(
        recovery(&state, "GET", CODE, NEW).await.2["state"],
        "expired"
    );
    assert_eq!(
        recovery(&state, "POST", CODE, NEW).await.0,
        StatusCode::UNAUTHORIZED
    );
    let mut state = AuthState::new(state.pool.clone(), state.config.clone()).unwrap();
    enable(&mut state, now() + 600).await;
    assert_eq!(
        recovery(&state, "POST", CODE, "short").await.0,
        StatusCode::BAD_REQUEST
    );
    for _ in 0..8 {
        assert_eq!(
            recovery(&state, "POST", "wrong", NEW).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    let result = recovery(&state, "POST", CODE, NEW).await;
    assert_eq!(result.0, StatusCode::TOO_MANY_REQUESTS);
    assert!(result.1.contains_key(header::RETRY_AFTER));
}
#[tokio::test]
async fn origin_host_and_regular_csrf_are_independent() {
    let (_dir, mut state) = fixture().await;
    enable(&mut state, now() + 600).await;
    for (host, origin) in [
        ("evil.invalid", Some("http://127.0.0.1:48310")),
        (HOST, None),
        (HOST, Some("https://evil.invalid")),
    ] {
        let r = request(
            &state,
            "/api/session/password-recovery",
            "POST",
            json!({"recovery_code":CODE,"password":NEW}),
            host,
            origin,
            None,
        )
        .await;
        assert_eq!(r.0, StatusCode::FORBIDDEN);
        assert_eq!(r.1[header::CACHE_CONTROL], "no-store");
    }
    assert_eq!(
        request(
            &state,
            "/api/session/logout",
            "POST",
            Value::Null,
            HOST,
            Some("http://127.0.0.1:48310"),
            Some("weblabel_session=admin-id")
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(recovery(&state, "POST", CODE, NEW).await.0, StatusCode::OK);
}
#[tokio::test]
async fn concurrency_and_database_faults_are_atomic_and_retryable() {
    let (_dir, mut state) = fixture().await;
    enable(&mut state, now() + 600).await;
    sqlx::query("CREATE TRIGGER fail_recovery BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'synthetic fault'); END").execute(&state.pool).await.unwrap();
    assert_eq!(
        recovery(&state, "POST", CODE, NEW).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    let hash: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE user_id='admin-id'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert!(auth::verify_password(OLD, &hash));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM admin_password_recoveries")
            .fetch_one(&state.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sessions")
            .fetch_one(&state.pool)
            .await
            .unwrap(),
        2
    );
    sqlx::query("DROP TRIGGER fail_recovery")
        .execute(&state.pool)
        .await
        .unwrap();
    let (a, b, observed) = tokio::join!(biased; recovery(&state,"POST",CODE,NEW),recovery(&state,"POST",CODE,NEW), recovery(&state,"GET",CODE,NEW));
    assert!(matches!(
        (a.0, b.0),
        (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)
    ));
    assert_eq!(
        observed.2["state"], "completed",
        "Status must wait for the pending mutation, even if its response is lost"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM admin_password_recoveries")
            .fetch_one(&state.pool)
            .await
            .unwrap(),
        1
    );
}
#[tokio::test]
async fn target_role_is_rechecked_and_credentialless_restore_is_rejected() {
    let (_dir, mut state) = fixture().await;
    enable(&mut state, now() + 600).await;
    sqlx::query("UPDATE users SET platform_admin=0 WHERE user_id='admin-id'")
        .execute(&state.pool)
        .await
        .unwrap();
    assert_eq!(
        recovery(&state, "POST", CODE, NEW).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    sqlx::query("UPDATE users SET platform_admin=1 WHERE user_id='admin-id'")
        .execute(&state.pool)
        .await
        .unwrap();
    assert_eq!(recovery(&state, "POST", CODE, NEW).await.0, StatusCode::OK);
    let mut clean = AuthState::new(state.pool.clone(), state.config.clone()).unwrap();
    sqlx::query("UPDATE users SET password_hash=''")
        .execute(&state.pool)
        .await
        .unwrap();
    assert!(clean
        .enable_password_recovery(
            "afc7511a-456b-478c-b123-456789abcdee",
            "local-admin",
            hash_launch_code(CODE),
            now() + 600
        )
        .await
        .is_err());
}

#[tokio::test]
async fn utf8_byte_boundaries_and_empty_database() {
    let (_dir, mut state) = fixture().await;
    enable(&mut state, now() + 600).await;
    for password in ["界界界".to_owned(), "界".repeat(342)] {
        assert_eq!(
            recovery(&state, "POST", CODE, &password).await.2["code"],
            "INVALID_PASSWORD"
        );
    }
    assert_eq!(
        recovery(&state, "POST", CODE, "界界界界").await.0,
        StatusCode::OK
    );
    let (_dir, mut empty) = fixture().await;
    for statement in [
        "DELETE FROM sessions",
        "DELETE FROM memberships",
        "DELETE FROM users",
    ] {
        sqlx::query(statement).execute(&empty.pool).await.unwrap();
    }
    assert!(empty
        .enable_password_recovery(ID, "local-admin", hash_launch_code(CODE), now() + 600)
        .await
        .is_err());
}

#[tokio::test]
async fn real_tcp_recovery_then_explicit_login() {
    use std::io::{Read, Write};
    let (_dir, mut state) = fixture().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    state.config.allowed_hosts = vec![address.to_string()];
    state.config.allowed_origins = vec![format!("http://{address}")];
    enable(&mut state, now() + 600).await;
    let routes = app(&state);
    let server = tokio::spawn(async move {
        axum::serve(listener, routes).await.unwrap();
    });
    let responses = tokio::task::spawn_blocking(move || {
        let mut responses = Vec::new();
        for (path, body) in [
            ("/api/session/password-recovery",json!({"recovery_code":CODE,"password":NEW})),
            ("/api/session/login",json!({"username":"local-admin","password":OLD})),
            ("/api/session/login",json!({"username":"local-admin","password":NEW})),
        ] {
            let mut stream = std::net::TcpStream::connect(address).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let body = body.to_string();
            write!(stream,"POST {path} HTTP/1.1\r\nHost: {address}\r\nOrigin: http://{address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            let mut response = String::new(); stream.read_to_string(&mut response).unwrap(); responses.push(response);
        }
        responses
    }).await.unwrap();
    server.abort();
    assert!(responses[0].starts_with("HTTP/1.1 200"));
    assert!(responses[0].contains("cache-control: no-store"));
    assert!(!responses[0].contains("set-cookie:"));
    assert!(responses[0].contains("\"state\":\"completed\""));
    assert!(responses[1].starts_with("HTTP/1.1 401"));
    assert!(responses[2].starts_with("HTTP/1.1 200"));
    assert!(responses[2].contains("set-cookie: weblabel_session="));
}

#[tokio::test]
async fn recovery_submission_waits_for_read_query_without_false_completion() {
    let (_dir, mut state) = fixture().await;
    enable(&mut state, now() + 600).await;
    // Hold the pool so a read owns the gate while awaiting its SELECT.
    let mut held = Vec::new();
    for _ in 0..state.pool.options().get_max_connections() {
        held.push(state.pool.acquire().await.unwrap());
    }
    let read = recovery(&state, "GET", CODE, NEW);
    let write = recovery(&state, "POST", CODE, NEW);
    tokio::pin!(read, write);
    tokio::select! {
        biased;
        _ = &mut read => panic!("Read must wait for the held database pool"),
        result = &mut write => panic!("Read-only lookup must not reject recovery: {}", result.0),
        _ = tokio::task::yield_now() => {}
    }
    drop(held);
    let (read, write) = tokio::join!(read, write);
    assert_eq!(read.0, StatusCode::OK);
    assert_eq!(read.2["state"], "available");
    assert_eq!(write.0, StatusCode::OK);
    assert_eq!(write.2["state"], "completed");
    assert_eq!(
        recovery(&state, "GET", CODE, NEW).await.2["state"],
        "completed"
    );
}
