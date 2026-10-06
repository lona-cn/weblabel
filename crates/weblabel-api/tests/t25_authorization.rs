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

struct Scope {
    project: String,
    request: Value,
}
impl Fixture {
    async fn scope(
        &self,
        actor: &str,
        cookie: &str,
        csrf: &str,
        provider: &str,
        policy: bool,
        objects: bool,
    ) -> Scope {
        self.profile("profile-ready", provider, "ready", capabilities())
            .await;
        let (status,project,_)=send(&self.app,"POST","/api/projects",Some(json!({"name":"Synthetic authorization fixture","description":"No business images","allow_self_review":false})),Some(cookie),Some(csrf)).await;
        assert_eq!(status, StatusCode::CREATED, "{project}");
        let project = project["project_id"].as_str().unwrap().to_owned();
        let (status,ontology,_)=send(&self.app,"POST",&format!("/api/projects/{project}/ontologies"),Some(json!({"labels":[{"label_id":"label-person","name":"Person","color":"#0099ff","shortcut":null,"allowed_geometry_types":["bbox_xyxy"],"attributes":[]}],"guidelines_markdown":"Synthetic fixture"})),Some(cookie),Some(csrf)).await;
        assert_eq!(status, StatusCode::CREATED, "{ontology}");
        let ontology = ontology["ontology_version_id"].as_str().unwrap().to_owned();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::new(32, 24))
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let imported = weblabel_api::media::ingest::import_one(
            &self.state.repository,
            &weblabel_api::jobs::worker::MediaWorker::new(),
            weblabel_api::media::ingest::ImportInput {
                project_id: project.clone(),
                ontology_version_id: ontology.clone(),
                actor_id: actor.to_owned(),
                source_group_id: "synthetic-source".into(),
                original_name: "synthetic.png".into(),
                declared_mime: Some("image/png".into()),
                bytes: png.into_inner(),
            },
        )
        .await
        .unwrap();
        let mut tx = self.state.repository.begin_write().await.unwrap();
        sqlx::query("UPDATE projects SET allow_external_processing=? WHERE project_id=?")
            .bind(policy)
            .bind(&project)
            .execute(tx.connection())
            .await
            .unwrap();
        let mut hashes = serde_json::Map::new();
        if objects {
            let mut document: annotation_domain::AnnotationDocument = serde_json::from_str(
                &sqlx::query_scalar::<_, String>(
                    "SELECT body_json FROM annotation_revisions WHERE annotation_revision_id=?",
                )
                .bind(&imported.annotation_revision_id)
                .fetch_one(tx.connection())
                .await
                .unwrap(),
            )
            .unwrap();
            for id in ["object-1", "object-2"] {
                let object:annotation_domain::AnnotationObject=serde_json::from_value(json!({"object_id":id,"label_id":"label-person","geometry":{"type":"bbox_xyxy","x_min":2,"y_min":3,"x_max":10,"y_max":11},"attributes":{},"origin":{"type":"manual","prediction_id":null,"model_run_id":null,"import_batch_id":null}})).unwrap();
                hashes.insert(
                    id.to_owned(),
                    json!(annotation_domain::object_hash(&object)),
                );
                document.objects.push(object);
            }
            let serialized = annotation_domain::hash::serialize_document(&document).unwrap();
            sqlx::query("UPDATE annotation_revisions SET body_json=?,content_hash=? WHERE annotation_revision_id=?").bind(serialized.json).bind(serialized.content_hash).bind(&imported.annotation_revision_id).execute(tx.connection()).await.unwrap();
        }
        tx.commit().await.unwrap();
        Scope {
            project: project.clone(),
            request: json!({"operation_id":"operation-synthetic","profile_id":"profile-ready","context":{"project_id":project,"asset_revision_id":imported.asset_revision_id,"annotation_revision_id":imported.annotation_revision_id,"ontology_version_id":ontology,"draft_generation":0,"canonical_sha256":imported.canonical_sha256,"selected_object_ids":if objects {json!(["object-1"])}else{json!([])},"object_hashes":hashes,"input_fingerprint":"client-not-authoritative"},"intent":"find_issues","prompt":"Review synthetic context","consent_id":null}),
        }
    }
    async fn preview(
        &self,
        cookie: &str,
        csrf: &str,
        request: &Value,
        grants: Value,
    ) -> (StatusCode, Value) {
        let (status, body, _) = send(
            &self.app,
            "POST",
            "/api/ai/previews",
            Some(json!({"request":request,"grants":grants})),
            Some(cookie),
            Some(csrf),
        )
        .await;
        (status, body)
    }
    async fn consent(&self, cookie: &str, csrf: &str, preview: &Value) -> (StatusCode, Value) {
        let (status, body, _) = send(
            &self.app,
            "POST",
            "/api/ai/consents",
            Some(json!({"preview_id":preview["preview_id"]})),
            Some(cookie),
            Some(csrf),
        )
        .await;
        (status, body)
    }
    async fn start(&self, cookie: &str, csrf: &str, request: &Value) -> (StatusCode, Value) {
        let (status, body, _) = send(
            &self.app,
            "POST",
            "/api/ai/runs",
            Some(request.clone()),
            Some(cookie),
            Some(csrf),
        )
        .await;
        (status, body)
    }
    async fn counts(&self) -> (i64, i64, i64) {
        let mut tx = self.state.repository.begin_write().await.unwrap();
        let jobs = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE kind='model_run'")
            .fetch_one(tx.connection())
            .await
            .unwrap();
        let runs = sqlx::query_scalar("SELECT count(*) FROM model_runs")
            .fetch_one(tx.connection())
            .await
            .unwrap();
        let auth = sqlx::query_scalar("SELECT count(*) FROM model_run_authorizations")
            .fetch_one(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        (jobs, runs, auth)
    }
    async fn sql(&self, sql: &str) {
        let mut tx = self.state.repository.begin_write().await.unwrap();
        sqlx::query(sql).execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
    }
    async fn tool(&self, token: &str, name: &str, args: Value) -> (StatusCode, Value) {
        let request = Request::builder()
            .method("POST")
            .uri(format!("/internal/agent-tools/{name}"))
            .header("host", HOST)
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::from(args.to_string()))
            .unwrap();
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let body = serde_json::from_slice(
            &to_bytes(response.into_body(), 2 * 1024 * 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        (status, body)
    }
    async fn authorized(
        &self,
        cookie: &str,
        csrf: &str,
        scope: &Scope,
        grants: Value,
    ) -> (Value, Value) {
        let (status, preview) = self.preview(cookie, csrf, &scope.request, grants).await;
        assert_eq!(status, StatusCode::CREATED, "{preview}");
        let (status, consent) = self.consent(cookie, csrf, &preview).await;
        assert_eq!(status, StatusCode::CREATED, "{consent}");
        let mut request = preview["request"].clone();
        request["consent_id"] = consent["consent_id"].clone();
        (request, preview)
    }
}
fn no_grants() -> Value {
    json!({"allow_image":false,"allow_object_context":false,"preview_crop":null})
}
fn all_grants() -> Value {
    json!({"allow_image":true,"allow_object_context":true,"preview_crop":null})
}
fn crop_grants() -> Value {
    json!({"allow_image":true,"allow_object_context":true,"preview_crop":{"type":"bbox_xyxy","x_min":2.0,"y_min":3.0,"x_max":12.0,"y_max":15.0}})
}

#[tokio::test]
async fn legacy_intent_is_not_executable_authorization() {
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
#[tokio::test]
async fn every_external_channel_requires_project_policy_even_without_data_grants() {
    for provider in [
        "codex_local",
        "claude_local",
        "openai_api",
        "anthropic_api",
        "mimo_api",
        "detector_local",
    ] {
        let f = Fixture::new().await;
        let (cookie, csrf, actor) = f.login().await;
        let scope = f
            .scope(&actor, &cookie, &csrf, provider, false, false)
            .await;
        let (status, body) = f.preview(&cookie, &csrf, &scope.request, no_grants()).await;
        assert_eq!(
            status,
            if provider == "detector_local" {
                StatusCode::CREATED
            } else {
                StatusCode::FORBIDDEN
            },
            "{provider}: {body}"
        );
        assert_eq!(f.counts().await, (0, 0, 0));
    }
}
#[tokio::test]
async fn server_fingerprint_ignores_operation_but_pins_prompt_grants_and_private_configuration() {
    let f = Fixture::new().await;
    let (cookie, csrf, actor) = f.login().await;
    let scope = f
        .scope(&actor, &cookie, &csrf, "codex_local", true, true)
        .await;
    let (status, first) = f
        .preview(&cookie, &csrf, &scope.request, all_grants())
        .await;
    assert_eq!(status, StatusCode::CREATED, "{first}");
    assert_ne!(
        first["input_fingerprint"],
        scope.request["context"]["input_fingerprint"]
    );
    assert!(!first.to_string().contains("private-"));
    let mut request = scope.request.clone();
    request["operation_id"] = json!("different-operation");
    request["consent_id"] = json!("ignored-consent");
    request["context"]["input_fingerprint"] = json!("ignored");
    let (_, same) = f.preview(&cookie, &csrf, &request, all_grants()).await;
    assert_eq!(same["input_fingerprint"], first["input_fingerprint"]);
    request["prompt"] = json!("Changed instruction");
    let (_, changed) = f.preview(&cookie, &csrf, &request, all_grants()).await;
    assert_ne!(changed["input_fingerprint"], first["input_fingerprint"]);
    let (_, crop) = f
        .preview(&cookie, &csrf, &scope.request, crop_grants())
        .await;
    assert_ne!(crop["input_fingerprint"], first["input_fingerprint"]);
    f.sql(r#"UPDATE model_profiles SET config_json='{"temperature":0.7}' WHERE profile_id='profile-ready'"#).await;
    let (status, body) = f.consent(&cookie, &csrf, &first).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(f.count_consents().await, 0);
}
#[tokio::test]
async fn changed_request_and_legacy_row_cannot_enqueue_and_valid_replay_is_atomic() {
    let f = Fixture::new().await;
    let (cookie, csrf, actor) = f.login().await;
    let scope = f
        .scope(&actor, &cookie, &csrf, "claude_local", true, false)
        .await;
    let (request, _) = f.authorized(&cookie, &csrf, &scope, no_grants()).await;
    for field in ["prompt", "intent", "profile_id"] {
        let mut bad = request.clone();
        bad[field] = json!(if field == "intent" {
            "audit_attributes"
        } else {
            "tampered"
        });
        assert!(!f.start(&cookie, &csrf, &bad).await.0.is_success());
        assert_eq!(f.counts().await, (0, 0, 0));
    }
    f.sql("CREATE TRIGGER reject_authorization BEFORE INSERT ON model_run_authorizations BEGIN SELECT RAISE(ABORT,'synthetic atomic failure'); END").await;
    assert_eq!(
        f.start(&cookie, &csrf, &request).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(f.counts().await, (0, 0, 0));
    f.sql("DROP TRIGGER reject_authorization").await;
    let (left, right) = tokio::join!(
        f.start(&cookie, &csrf, &request),
        f.start(&cookie, &csrf, &request)
    );
    assert_eq!(left.0, StatusCode::ACCEPTED, "{}", left.1);
    assert_eq!(right.0, StatusCode::ACCEPTED, "{}", right.1);
    assert_eq!(left.1["run_id"], right.1["run_id"]);
    assert_eq!(f.counts().await, (1, 1, 1));
    let mut other = request.clone();
    other["context"]["draft_generation"] = json!(1);
    assert_eq!(
        f.start(&cookie, &csrf, &other).await.0,
        StatusCode::CONFLICT
    );
    // Existing T24 intent data remains stored but is not a capability.
    let mut tx = f.state.repository.begin_write().await.unwrap();
    sqlx::query("INSERT INTO consents(consent_id,actor_id,profile_id,input_fingerprint,approved_grants_json,created_at) VALUES('legacy',?,'profile-ready',?,'{}','2026-10-06T00:00:00Z')").bind(&actor).bind(request["context"]["input_fingerprint"].as_str().unwrap()).execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    other = request.clone();
    other["consent_id"] = json!("legacy");
    assert_eq!(
        f.start(&cookie, &csrf, &other).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(f.counts().await, (1, 1, 1));
}
#[tokio::test]
async fn runtime_scope_blocks_full_image_pixel_expansion_and_unselected_objects() {
    let f = Fixture::new().await;
    let (cookie, csrf, actor) = f.login().await;
    let scope = f
        .scope(&actor, &cookie, &csrf, "codex_local", true, true)
        .await;
    let (request, _) = f.authorized(&cookie, &csrf, &scope, crop_grants()).await;
    let (status, run) = f.start(&cookie, &csrf, &request).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{run}");
    let token = f.state.run_tokens.issue(
        run["run_id"].as_str().unwrap(),
        &scope.project,
        Duration::from_secs(60),
    );
    let (status, context) = f.tool(&token, "get_context", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{context}");
    assert!(
        !context.to_string().contains("private-config-sentinel"),
        "Raw model-callable tools must not disclose adapter secrets"
    );
    assert_eq!(
        context["approved_image_region"],
        crop_grants()["preview_crop"]
    );
    assert_eq!(
        context["context"]["object_hashes"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        vec!["object-1"]
    );
    let (status, list) = f.tool(&token, "list_objects", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        list["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["object_id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["object-1"]
    );
    for region in [
        Value::Null,
        json!({"type":"bbox_xyxy","x_min":1.9,"y_min":3,"x_max":12,"y_max":15}),
        json!({"type":"bbox_xyxy","x_min":2,"y_min":3,"x_max":12.1,"y_max":15}),
    ] {
        let (status, body) = f
            .tool(&token, "read_region", json!({"region":region}))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(body.get("data_base64").is_none());
    }
    let (status, image) = f
        .tool(
            &token,
            "read_region",
            json!({"region":crop_grants()["preview_crop"]}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{image}");
    assert_eq!(image["width"], 10);
    assert_eq!(image["height"], 12);
    assert_eq!(image["region"], json!([2, 3, 12, 15]));
    f.sql("UPDATE projects SET allow_external_processing=0")
        .await;
    for name in [
        "get_context",
        "list_objects",
        "read_region",
        "report_issues",
    ] {
        assert_eq!(
            f.tool(&token, name, json!({})).await.0,
            StatusCode::FORBIDDEN
        );
    }
}
#[tokio::test]
async fn no_grants_and_revoked_membership_or_configuration_fail_closed_at_runtime() {
    for mutation in [
        "UPDATE memberships SET role='viewer'",
        r#"UPDATE model_profiles SET config_json='{"changed":true}'"#,
    ] {
        let f = Fixture::new().await;
        let (cookie, csrf, actor) = f.login().await;
        let scope = f
            .scope(&actor, &cookie, &csrf, "openai_api", true, true)
            .await;
        let (request, _) = f.authorized(&cookie, &csrf, &scope, no_grants()).await;
        let (status, run) = f.start(&cookie, &csrf, &request).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{run}");
        let token = f.state.run_tokens.issue(
            run["run_id"].as_str().unwrap(),
            &scope.project,
            Duration::from_secs(60),
        );
        let (_, context) = f.tool(&token, "get_context", json!({})).await;
        assert_eq!(context["context"]["object_hashes"], json!({}));
        assert_eq!(context["approved_grant_ids"], json!([]));
        assert_eq!(
            f.tool(&token, "read_region", json!({"region":null}))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            f.tool(&token, "list_objects", json!({})).await.0,
            StatusCode::FORBIDDEN
        );
        f.sql(mutation).await;
        assert_eq!(
            f.tool(&token, "get_context", json!({})).await.0,
            StatusCode::FORBIDDEN
        );
    }
}

#[tokio::test]
async fn expired_preview_blocks_start_but_execution_uses_its_own_finite_deadline() {
    let f = Fixture::new().await;
    let (cookie, csrf, actor) = f.login().await;
    let scope = f
        .scope(&actor, &cookie, &csrf, "mimo_api", true, false)
        .await;
    let (request, preview) = f.authorized(&cookie, &csrf, &scope, no_grants()).await;
    let (status, run) = f.start(&cookie, &csrf, &request).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{run}");
    let original = preview["preview_id"].as_str().unwrap();
    let run_id = run["run_id"].as_str().unwrap();
    let mut tx = f.state.repository.begin_write().await.unwrap();
    let deadline: String = sqlx::query_scalar(
        "SELECT capability_expires_at FROM model_run_authorizations WHERE run_id=?",
    )
    .bind(run_id)
    .fetch_one(tx.connection())
    .await
    .unwrap();
    let remaining = chrono::DateTime::parse_from_rfc3339(&deadline)
        .unwrap()
        .with_timezone(&chrono::Utc)
        - chrono::Utc::now();
    assert!(remaining > chrono::Duration::minutes(9) && remaining <= chrono::Duration::minutes(10));
    sqlx::query("INSERT INTO ai_run_previews SELECT 'expired-preview',actor_id,project_id,profile_id,input_fingerprint,request_json,profile_configuration_hash,grants_json,created_at,'2000-01-01T00:00:00Z' FROM ai_run_previews WHERE preview_id=?").bind(original).execute(tx.connection()).await.unwrap();
    sqlx::query("INSERT INTO consents(consent_id,actor_id,profile_id,input_fingerprint,approved_grants_json,created_at,preview_id) SELECT 'expired-consent',actor_id,profile_id,input_fingerprint,grants_json,created_at,preview_id FROM ai_run_previews WHERE preview_id='expired-preview'").execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    let mut expired = request.clone();
    expired["consent_id"] = json!("expired-consent");
    expired["operation_id"] = json!("expired-operation");
    assert_eq!(
        f.start(&cookie, &csrf, &expired).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(f.counts().await, (1, 1, 1));
    // Seed immutable rows representing passage of time, without sleeping or
    // weakening the production immutable triggers.
    let token = f
        .state
        .run_tokens
        .issue(run_id, &scope.project, Duration::from_secs(60));
    for (deadline, expected) in [
        (Some(deadline.as_str()), StatusCode::OK),
        (None, StatusCode::FORBIDDEN),
        (Some("2000-01-01T00:00:00Z"), StatusCode::FORBIDDEN),
    ] {
        let mut tx = f.state.repository.begin_write().await.unwrap();
        sqlx::query("DELETE FROM model_run_authorizations WHERE run_id=?")
            .bind(run_id)
            .execute(tx.connection())
            .await
            .unwrap();
        sqlx::query("INSERT INTO model_run_authorizations(run_id,preview_id,grants_json,profile_configuration_hash,capability_expires_at) SELECT ?,'expired-preview',grants_json,profile_configuration_hash,? FROM ai_run_previews WHERE preview_id='expired-preview'").bind(run_id).bind(deadline).execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
        let (status, body) = f.tool(&token, "get_context", json!({})).await;
        assert_eq!(status, expected, "{body}");
        if status == StatusCode::FORBIDDEN {
            assert_eq!(body["code"], "RUN_CAPABILITY_EXPIRED");
        }
    }
}

#[tokio::test]
async fn another_authorized_project_member_cannot_confirm_or_use_the_original_actors_preview() {
    let f = Fixture::new().await;
    let (cookie, csrf, actor) = f.login().await;
    let scope = f
        .scope(&actor, &cookie, &csrf, "openai_api", true, false)
        .await;
    let (request, preview) = f.authorized(&cookie, &csrf, &scope, no_grants()).await;
    let (status, original_run) = f.start(&cookie, &csrf, &request).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{original_run}");
    let (status, user, _) = send(
        &f.app,
        "POST",
        "/api/users",
        Some(
            json!({"username":"synthetic-other-actor","password":"synthetic-other-actor-password"}),
        ),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{user}");
    let (status, body, _) = send(
        &f.app,
        "POST",
        &format!("/api/projects/{}/members", scope.project),
        Some(json!({"user_id":user["user_id"],"role":"annotator"})),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, login, other_cookie) = send(
        &f.app,
        "POST",
        "/api/session/login",
        Some(
            json!({"username":"synthetic-other-actor","password":"synthetic-other-actor-password"}),
        ),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{login}");
    let other_cookie = other_cookie.unwrap();
    let other_csrf = login["csrf_token"].as_str().unwrap();
    // The actor really has write access and can prepare their own identical
    // saved input; failures below are not an incidental membership denial.
    assert_eq!(
        f.preview(&other_cookie, other_csrf, &scope.request, no_grants())
            .await
            .0,
        StatusCode::CREATED
    );
    assert_eq!(
        f.consent(&other_cookie, other_csrf, &preview).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.start(&other_cookie, other_csrf, &request).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(f.count_consents().await, 1);
    assert_eq!(f.counts().await, (1, 1, 1));
}

#[tokio::test]
async fn public_contract_rejects_implicit_full_image_and_malformed_authorization() {
    let f = Fixture::new().await;
    let (cookie, csrf, actor) = f.login().await;
    let scope = f
        .scope(&actor, &cookie, &csrf, "openai_api", true, false)
        .await;
    for grants in [
        json!({"allow_image":true,"allow_object_context":false}),
        json!({"allow_image":"true","allow_object_context":false,"preview_crop":null}),
        json!({"allow_image":true,"allow_object_context":false,"preview_crop":false}),
        json!({"allow_image":true,"allow_object_context":false,"preview_crop":null,"allow_all":true}),
    ] {
        let (status, body) = f.preview(&cookie, &csrf, &scope.request, grants).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["code"], "INVALID_PREVIEW");
    }
    let mut tx = f.state.repository.begin_write().await.unwrap();
    let previews: i64 = sqlx::query_scalar("SELECT count(*) FROM ai_run_previews")
        .fetch_one(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        previews, 0,
        "invalid scopes must not create authorization material"
    );
    assert_eq!(f.count_consents().await, 0);
    let grants = json!({"allow_image":true,"allow_object_context":false,"preview_crop":null});
    let (status, preview) = f.preview(&cookie, &csrf, &scope.request, grants).await;
    assert_eq!(status, StatusCode::CREATED, "{preview}");
    let typed: annotation_domain::AiPreviewResponse =
        serde_json::from_value(preview.clone()).unwrap();
    assert!(typed.grants.allow_image);
    assert_eq!(typed.grants.preview_crop, None);
    assert_eq!(
        typed.request.context.input_fingerprint,
        typed.input_fingerprint
    );
    for body in [
        json!({"preview_id":false}),
        json!({"preview_id":""}),
        json!({"preview_id":preview["preview_id"],"allow_image":true}),
    ] {
        let (status, response, _) = send(
            &f.app,
            "POST",
            "/api/ai/consents",
            Some(body),
            Some(&cookie),
            Some(&csrf),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
        assert_eq!(response["code"], "INVALID_CONSENT");
    }
    assert_eq!(f.count_consents().await, 0);
    let (status, consent) = f.consent(&cookie, &csrf, &preview).await;
    assert_eq!(status, StatusCode::CREATED);
    let consent: annotation_domain::AiConsentResponse = serde_json::from_value(consent).unwrap();
    assert_eq!(consent.preview_id, typed.preview_id);
    assert_eq!(consent.input_fingerprint, typed.input_fingerprint);
    assert_eq!(consent.expires_at, typed.expires_at);
    let path = format!("/api/projects/{}/external-processing-policy", scope.project);
    for body in [
        json!({}),
        json!({"allow_external_processing":"true"}),
        json!({"allow_external_processing":true,"allow_all":true}),
    ] {
        let (status, response, _) =
            send(&f.app, "PUT", &path, Some(body), Some(&cookie), Some(&csrf)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
    }
    let (status, policy, _) = send(&f.app, "GET", &path, None, Some(&cookie), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        serde_json::from_value::<annotation_domain::ExternalProcessingPolicy>(policy)
            .unwrap()
            .allow_external_processing
    );
}

#[tokio::test]
async fn successful_start_replay_survives_expired_preview_and_changed_pins_without_execution_authority(
) {
    let f = Fixture::new().await;
    let (cookie, csrf, actor) = f.login().await;
    let scope = f
        .scope(&actor, &cookie, &csrf, "openai_api", true, false)
        .await;
    let (request, _) = f.authorized(&cookie, &csrf, &scope, no_grants()).await;
    let (status, created) = f.start(&cookie, &csrf, &request).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let mut tx = f.state.repository.begin_write().await.unwrap();
    sqlx::query("INSERT OR REPLACE INTO ai_run_previews SELECT preview_id,actor_id,project_id,profile_id,input_fingerprint,request_json,profile_configuration_hash,grants_json,created_at,'2000-01-01T00:00:00Z' FROM ai_run_previews").execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    let (status, replay) = f.start(&cookie, &csrf, &request).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{replay}");
    assert_eq!(replay["run_id"], created["run_id"]);
    f.sql(r#"UPDATE model_profiles SET config_json='{"changed":true}'"#)
        .await;
    let (status, replay) = f.start(&cookie, &csrf, &request).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{replay}");
    assert_eq!(replay["run_id"], created["run_id"]);
    let mut mismatch = request.clone();
    mismatch["prompt"] = json!("different payload");
    assert_eq!(
        f.start(&cookie, &csrf, &mismatch).await.0,
        StatusCode::CONFLICT
    );
    let mut fresh = request.clone();
    fresh["operation_id"] = json!("fresh-operation");
    assert!(!f.start(&cookie, &csrf, &fresh).await.0.is_success());
    let token = f.state.run_tokens.issue(
        created["run_id"].as_str().unwrap(),
        &scope.project,
        Duration::from_secs(60),
    );
    assert_eq!(
        f.tool(&token, "get_context", json!({})).await.0,
        StatusCode::FORBIDDEN
    );
    f.sql("DELETE FROM memberships").await;
    assert_eq!(
        f.start(&cookie, &csrf, &request).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(f.counts().await, (1, 1, 1));
}

#[tokio::test]
async fn native_issue_regions_are_validated_before_any_prediction_is_persisted() {
    let f = Fixture::new().await;
    let (cookie, csrf, actor) = f.login().await;
    let scope = f
        .scope(&actor, &cookie, &csrf, "claude_local", true, false)
        .await;
    let (request, _) = f.authorized(&cookie, &csrf, &scope, no_grants()).await;
    let (status, created) = f.start(&cookie, &csrf, &request).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let token = f.state.run_tokens.issue(
        created["run_id"].as_str().unwrap(),
        &scope.project,
        Duration::from_secs(60),
    );
    for region in [
        json!({"type":"bbox_xyxy","x_min":8,"y_min":1,"x_max":2,"y_max":4}),
        json!({"type":"bbox_xyxy","x_min":2,"y_min":1,"x_max":2,"y_max":4}),
        json!({"type":"bbox_xyxy","x_min":0,"y_min":0,"x_max":100000,"y_max":4}),
        json!({"type":"bbox_xyxy","x_min":-1,"y_min":0,"x_max":2,"y_max":4}),
        json!({"type":"bbox_xyxy","x_min":0,"y_min":5,"x_max":2,"y_max":3}),
        json!({"type":"bbox_xyxy","x_min":0,"y_min":2,"x_max":2,"y_max":2}),
        json!({"type":"bbox_xyxy","x_min":0,"y_min":0,"x_max":2,"y_max":24.1}),
        json!({"type":"bbox_xyxy","x_min":0,"y_min":0,"x_max":"32","y_max":24}),
    ] {
        let (status, body) = f.tool(&token, "report_issues", json!({"issues":[{"issue_id":"boundary-issue","object_id":null,"code":"review","message":"synthetic","region":region}]})).await;
        assert!(!status.is_success(), "invalid region persisted: {body}");
    }
    let mut tx = f.state.repository.begin_write().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM predictions")
        .fetch_one(tx.connection())
        .await
        .unwrap();
    assert_eq!(count, 0);
    tx.commit().await.unwrap();
    let (status, body) = f.tool(&token, "report_issues", json!({"issues":[{"issue_id":"media-boundary","object_id":null,"code":"review","message":"synthetic","region":{"type":"bbox_xyxy","x_min":0,"y_min":0,"x_max":32,"y_max":24}}]})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn issue_region_crop_containment_does_not_replace_geometry_validation() {
    let f = Fixture::new().await;
    let (cookie, csrf, actor) = f.login().await;
    let scope = f
        .scope(&actor, &cookie, &csrf, "claude_local", true, false)
        .await;
    let (request, _) = f.authorized(&cookie, &csrf, &scope, crop_grants()).await;
    let (status, created) = f.start(&cookie, &csrf, &request).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let token = f.state.run_tokens.issue(
        created["run_id"].as_str().unwrap(),
        &scope.project,
        Duration::from_secs(60),
    );
    for region in [
        json!({"type":"bbox_xyxy","x_min":8,"y_min":4,"x_max":3,"y_max":10}),
        json!({"type":"bbox_xyxy","x_min":3,"y_min":4,"x_max":3,"y_max":10}),
        json!({"type":"bbox_xyxy","x_min":1,"y_min":3,"x_max":12,"y_max":15}),
    ] {
        let (status, body) = f.tool(&token, "report_issues", json!({"issues":[{"issue_id":"crop-invalid","object_id":null,"code":"review","message":"synthetic","region":region}]})).await;
        assert!(!status.is_success(), "{body}");
    }
    let (status, body) = f.tool(&token, "report_issues", json!({"issues":[{"issue_id":"crop-boundary","object_id":null,"code":"review","message":"synthetic","region":crop_grants()["preview_crop"]}]})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
