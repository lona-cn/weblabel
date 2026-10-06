use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::{net::SocketAddr, time::Duration};
use tempfile::{tempdir, TempDir};
use tower::ServiceExt;
use weblabel_api::{
    auth::{hash_launch_code, AuthConfig},
    config::ServerConfig,
    router, AppState,
};

const HOST: &str = "127.0.0.1:48124";
const ORIGIN: &str = "http://127.0.0.1:48124";

struct Fixture {
    _directory: TempDir,
    state: AppState,
    app: Router,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempdir().unwrap();
        let config = ServerConfig {
            bind: HOST.parse::<SocketAddr>().unwrap(),
            database_url: format!("sqlite:{}", directory.path().join("t24.sqlite").display()),
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
                launch_code: hash_launch_code("t24-launch"),
                launch_code_expires_at: chrono::Utc::now().timestamp() + 3600,
            },
        )
        .await
        .unwrap();
        let app = router(state.clone());
        Self {
            _directory: directory,
            state,
            app,
        }
    }
    async fn login(&self) -> (String, String, String) {
        let (status, body, cookie) = send(
            &self.app,
            "POST",
            "/api/session/bootstrap",
            Some(json!({"launch_code":"t24-launch", "password":"t24-bootstrap-password"})),
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        (
            cookie.unwrap(),
            body["csrf_token"].as_str().unwrap().to_owned(),
            body["user_id"].as_str().unwrap().to_owned(),
        )
    }
    async fn profile(&self, id: &str, provider: &str, availability: &str, capabilities: Value) {
        let mut tx = self.state.repository.begin_write().await.unwrap();
        sqlx::query("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES(?,?,?,'official_user_login',?,?,'not_run','test-runtime',NULL,?,?,'2026-10-06T00:00:00Z')")
            .bind(id).bind(provider).bind("test-model").bind(capabilities.to_string()).bind(availability)
            .bind(json!({"api_key":"private-config-sentinel"}).to_string()).bind("private-secret-sentinel")
            .execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
    }
    async fn count_consents(&self) -> i64 {
        let mut tx = self.state.repository.begin_write().await.unwrap();
        let count = sqlx::query_scalar("SELECT count(*) FROM consents")
            .fetch_one(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        count
    }
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
                .body(Body::from(body.map(|v| v.to_string()).unwrap_or_default()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_owned());
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, body, cookie)
}
fn capabilities() -> Value {
    json!({"image_input":true,"tools":false,"structured_output":true,"bbox_output":false,"attributes":true})
}
fn intent(profile: &str) -> Value {
    json!({"profile_id":profile,"input_fingerprint":"a".repeat(64),"approved_grants":{"image":true,"selected_objects":true,"crop":{"x_min":1.0,"y_min":2.0,"x_max":30.0,"y_max":40.0}}})
}

#[tokio::test]
async fn profiles_return_only_valid_public_persisted_data_without_provisioning_defaults() {
    let f = Fixture::new().await;
    let (status, _, _) = send(&f.app, "GET", "/api/model-profiles", None, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (cookie, _, _) = f.login().await;
    let (status, body, _) = send(
        &f.app,
        "GET",
        "/api/model-profiles",
        None,
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"items":[],"next_cursor":null}));
    f.profile("profile-public", "claude_local", "ready", capabilities())
        .await;
    let (status, body, _) = send(
        &f.app,
        "GET",
        "/api/model-profiles",
        None,
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({"items":[{"profile_id":"profile-public","provider_id":"claude_local","model_id":"test-model","auth_kind":"official_user_login","capabilities":capabilities(),"availability":"ready","verification":"not_run","runtime_version":"test-runtime","verified_at":null}],"next_cursor":null})
    );
    let _: annotation_domain::ModelProfile =
        serde_json::from_value(body["items"][0].clone()).unwrap();
    assert!(!body.to_string().contains("private-"));
    let mut tx = f.state.repository.begin_write().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM model_profiles")
        .fetch_one(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn malformed_public_capabilities_fail_closed_without_exposing_private_columns() {
    let f = Fixture::new().await;
    let (cookie, _, _) = f.login().await;
    f.profile(
        "profile-invalid",
        "codex_local",
        "ready",
        json!({"image_input":true,"secret_ref":"private-capability-sentinel"}),
    )
    .await;
    let (status, body, _) = send(
        &f.app,
        "GET",
        "/api/model-profiles",
        None,
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!body.to_string().contains("private-"));
    assert!(body.get("items").is_none());
}

#[tokio::test]
async fn legacy_consent_shape_is_rejected_without_persisting_an_executable_intent() {
    let f = Fixture::new().await;
    let (cookie, csrf, _) = f.login().await;
    f.profile("profile-ready", "codex_local", "ready", capabilities())
        .await;
    let (status, _, _) = send(
        &f.app,
        "POST",
        "/api/ai/consents",
        Some(intent("profile-ready")),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(f.count_consents().await, 0);
}
