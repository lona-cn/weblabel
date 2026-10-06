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

const HOST: &str = "127.0.0.1:48125";
const ORIGIN: &str = "http://127.0.0.1:48125";

struct Fixture {
    _directory: TempDir,
    state: AppState,
    app: Router,
    cookie: String,
    csrf: String,
    actor: String,
    project: String,
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
        .header("origin", ORIGIN);
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    if let Some(csrf) = csrf {
        request = request.header("x-csrf-token", csrf);
    }
    let request = if let Some(body) = body {
        request
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    } else {
        request.body(Body::empty()).unwrap()
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let cookie = response.headers().get("set-cookie").map(|value| {
        value
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    });
    let bytes = to_bytes(response.into_body(), 65536).await.unwrap();
    let body = serde_json::from_slice(&bytes).unwrap();
    (status, body, cookie)
}

impl Fixture {
    async fn new() -> Self {
        let directory = tempdir().unwrap();
        let config = ServerConfig {
            bind: HOST.parse::<SocketAddr>().unwrap(),
            database_url: format!(
                "sqlite:{}",
                directory.path().join("policy.sqlite").display()
            ),
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
                launch_code: hash_launch_code("policy-test-launch"),
                launch_code_expires_at: chrono::Utc::now().timestamp() + 3600,
            },
        )
        .await
        .unwrap();
        let app = router(state.clone());
        let (status, session, cookie) = send(
            &app,
            "POST",
            "/api/session/bootstrap",
            Some(
                json!({"launch_code":"policy-test-launch","password":"synthetic-policy-password"}),
            ),
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{session}");
        let cookie = cookie.unwrap();
        let csrf = session["csrf_token"].as_str().unwrap().to_owned();
        let actor = session["user_id"].as_str().unwrap().to_owned();
        let (status, project, _) = send(&app, "POST", "/api/projects", Some(json!({"name":"Synthetic policy project","description":"","allow_self_review":false})), Some(&cookie), Some(&csrf)).await;
        assert_eq!(status, StatusCode::CREATED, "{project}");
        Self {
            _directory: directory,
            state,
            app,
            cookie,
            csrf,
            actor,
            project: project["project_id"].as_str().unwrap().to_owned(),
        }
    }
    async fn request(&self, method: &str, body: Option<Value>) -> (StatusCode, Value) {
        let (status, body, _) = send(
            &self.app,
            method,
            &format!("/api/projects/{}/external-processing-policy", self.project),
            body,
            Some(&self.cookie),
            Some(&self.csrf),
        )
        .await;
        (status, body)
    }
}

#[tokio::test]
async fn project_policy_is_default_deny_and_only_actual_project_admin_can_change_it() {
    let fixture = Fixture::new().await;
    let (status, policy) = fixture.request("GET", None).await;
    assert_eq!(status, StatusCode::OK, "{policy}");
    assert_eq!(policy, json!({"allow_external_processing":false}));
    let (status, policy) = fixture
        .request("PUT", Some(json!({"allow_external_processing":true})))
        .await;
    assert_eq!(status, StatusCode::OK, "{policy}");
    assert_eq!(policy, json!({"allow_external_processing":true}));
    assert_eq!(
        fixture.request("GET", None).await.1["allow_external_processing"],
        true
    );

    // Bootstrap actor is still platform admin, but is no longer project admin.
    let mut tx = fixture.state.repository.begin_write().await.unwrap();
    sqlx::query("UPDATE memberships SET role='viewer' WHERE project_id=? AND user_id=?")
        .bind(&fixture.project)
        .bind(&fixture.actor)
        .execute(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (status, error) = fixture
        .request("PUT", Some(json!({"allow_external_processing":false})))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
    assert_eq!(error["code"], "PROJECT_ADMIN_REQUIRED");
    assert_eq!(
        fixture.request("GET", None).await.1["allow_external_processing"],
        true
    );
}

#[tokio::test]
async fn policy_rejects_unauthenticated_cross_project_csrf_and_non_boolean_or_extra_fields() {
    let fixture = Fixture::new().await;
    let path = format!(
        "/api/projects/{}/external-processing-policy",
        fixture.project
    );
    assert_eq!(
        send(&fixture.app, "GET", &path, None, None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send(
            &fixture.app,
            "PUT",
            &path,
            Some(json!({"allow_external_processing":true})),
            Some(&fixture.cookie),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let other = format!(
        "/api/projects/{}/external-processing-policy",
        uuid::Uuid::new_v4()
    );
    for method in ["GET", "PUT"] {
        let body = (method == "PUT").then(|| json!({"allow_external_processing":true}));
        assert_eq!(
            send(
                &fixture.app,
                method,
                &other,
                body,
                Some(&fixture.cookie),
                Some(&fixture.csrf)
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
    for body in [
        json!({"allow_external_processing":"true"}),
        json!({"allow_external_processing":true,"actor_id":fixture.actor}),
    ] {
        let (status, error) = fixture.request("PUT", Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
        assert_eq!(error["code"], "INVALID_EXTERNAL_PROCESSING_POLICY");
    }
    assert_eq!(
        fixture.request("GET", None).await.1["allow_external_processing"],
        false
    );
}
