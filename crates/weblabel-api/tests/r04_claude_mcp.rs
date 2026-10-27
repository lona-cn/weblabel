//! R04 engineering fixtures only. Never runs Claude or claims subscription evidence.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use rmcp::{
    model::{CallToolRequestParams, CallToolResult},
    ServiceExt,
};
use serde_json::{json, Value};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    time::Duration,
};
use tower::ServiceExt as _;
use weblabel_api::jobs::model_jobs::{RunDriver, RunOutcome, RunRunner, RunnerError};
use weblabel_api::runtime::{agent_tools::tool_definitions, mcp::validate_api_base};
use weblabel_api::{
    auth::{hash_launch_code, AuthConfig},
    config::ServerConfig,
    router, AppState,
};

fn scratch() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/test-artifacts/R04");
    std::fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}

#[test]
fn api_base_accepts_only_explicit_literal_loopback_authorities() {
    for good in [
        "http://127.0.0.1:1",
        "http://127.0.0.1:65535",
        "http://[::1]:48100",
    ] {
        assert!(validate_api_base(good).is_ok(), "{good}");
    }
    for bad in [
        "http://localhost:48100",
        "http://127.1:48100",
        "http://2130706433:48100",
        "http://127.0.0.2:48100",
        "https://127.0.0.1:48100",
        "http://127.0.0.1",
        "http://127.0.0.1:0",
        "http://127.0.0.1:65536",
        "http://a@127.0.0.1:48100",
        "http://127.0.0.1:48100/",
        "http://127.0.0.1:48100/x",
        "http://127.0.0.1:48100?x",
        "http://127.0.0.1:48100#x",
        "http://[::ffff:127.0.0.1]:48100",
        " http://127.0.0.1:48100",
        "http://127.0.0.1:+1",
    ] {
        assert!(validate_api_base(bad).is_err(), "{bad}");
    }
}

async fn post(app: &Router, path: &str, body: Value, cookie: &str, csrf: &str) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("host", "127.0.0.1:48100")
                .header("origin", "http://127.0.0.1:48100")
                .header("content-type", "application/json")
                .header("cookie", cookie)
                .header("x-csrf-token", csrf)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let value: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(status.is_success(), "{path}: {status}: {value}");
    value
}

async fn fixture(
    directory: &Path,
    tool_addr: std::net::SocketAddr,
) -> (AppState, Router, String, String) {
    fixture_for_provider(directory, tool_addr, false).await
}
async fn fixture_for_provider(
    directory: &Path,
    tool_addr: std::net::SocketAddr,
    claude: bool,
) -> (AppState, Router, String, String) {
    let bind = "127.0.0.1:48100".parse().unwrap();
    let config = ServerConfig {
        bind,
        database_url: format!("sqlite:{}", directory.join("api.sqlite").display()),
        object_root: directory.join("objects"),
        write_timeout: Duration::from_secs(2),
        production: false,
    };
    let auth = AuthConfig {
        bind,
        cookie_secure: false,
        allowed_origins: vec!["http://127.0.0.1:48100".into()],
        allowed_hosts: vec!["127.0.0.1:48100".into(), tool_addr.to_string()],
        launch_code: hash_launch_code("r04-synthetic-launch-code"),
        launch_code_expires_at: chrono::Utc::now().timestamp() + 3600,
    };
    let state = AppState::open_with_auth(&config, auth).await.unwrap();
    let app = router(state.clone());
    let response = app.clone().oneshot(Request::builder().method("POST").uri("/api/session/bootstrap")
        .header("host", "127.0.0.1:48100").header("origin", "http://127.0.0.1:48100").header("content-type", "application/json")
        .body(Body::from(json!({"launch_code":"r04-synthetic-launch-code","password":"r04-synthetic-password"}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let account: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    let csrf = account["csrf_token"].as_str().unwrap().to_owned();
    let mut profile = weblabel_api::ai::runs::mock_profile();
    if claude {
        profile.profile_id = "r04-claude-engineering".into();
        profile.provider_id = annotation_domain::ProviderId::ClaudeLocal;
        profile.model_id = "claude-fixture".into();
        profile.auth_kind = annotation_domain::AuthKind::OfficialUserLogin;
        profile.verification = annotation_domain::Verification::NotRun;
        profile.runtime_version = Some("synthetic-engineering-only".into());
        profile.capabilities.bbox_output = false;
    }
    let mut tx = state.repository.begin_write().await.unwrap();
    sqlx::query("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,config_json,created_at) VALUES(?,?,?,?,?,'ready',?,?,'{}','2026-10-25T00:00:00Z')")
        .bind(&*profile.profile_id).bind(if claude{"claude_local"}else{"mock"}).bind(&profile.model_id)
        .bind(if claude{"official_user_login"}else{"none"})
        .bind(serde_json::to_string(&profile.capabilities).unwrap()).bind(if claude{"not_run"}else{"mock_only"})
        .bind(&profile.runtime_version).execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    let project = post(
        &app,
        "/api/projects",
        json!({"name":"R04 synthetic","description":"engineering only","allow_self_review":false}),
        &cookie,
        &csrf,
    )
    .await;
    let project_id = project["project_id"].as_str().unwrap();
    if claude {
        let mut tx = state.repository.begin_write().await.unwrap();
        sqlx::query("UPDATE projects SET allow_external_processing=1 WHERE project_id=?")
            .bind(project_id)
            .execute(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    let ontology = post(&app,&format!("/api/projects/{project_id}/ontologies"),json!({"labels":[{"label_id":"person","name":"Person","color":"#0099ff","shortcut":null,"allowed_geometry_types":["bbox_xyxy"],"attributes":[]}],"guidelines_markdown":"Synthetic fixture"}),&cookie,&csrf).await;
    let ontology_id = ontology["ontology_version_id"].as_str().unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(16, 8)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let asset = weblabel_api::media::ingest::import_one(
        &state.repository,
        &weblabel_api::jobs::worker::MediaWorker::new(),
        weblabel_api::media::ingest::ImportInput {
            project_id: project_id.into(),
            ontology_version_id: ontology_id.into(),
            actor_id: account["user_id"].as_str().unwrap().into(),
            source_group_id: "r04-source".into(),
            original_name: "synthetic.png".into(),
            declared_mime: Some("image/png".into()),
            bytes: png.into_inner(),
        },
    )
    .await
    .unwrap();
    let request = json!({"operation_id":"r04-op","profile_id":profile.profile_id,"context":{"project_id":project_id,"asset_revision_id":asset.asset_revision_id,"annotation_revision_id":asset.annotation_revision_id,"ontology_version_id":ontology_id,"draft_generation":0,"canonical_sha256":asset.canonical_sha256,"selected_object_ids":[],"object_hashes":{},"input_fingerprint":"r04-fingerprint"},"intent":if claude{"find_issues"}else{"detect"},"prompt":"Synthetic detection","consent_id":null});
    let preview = post(&app,"/api/ai/previews",json!({"request":request,"grants":{"allow_image":true,"allow_object_context":true,"preview_crop":null}}),&cookie,&csrf).await;
    let consent = post(
        &app,
        "/api/ai/consents",
        json!({"preview_id":preview["preview_id"]}),
        &cookie,
        &csrf,
    )
    .await;
    let mut request = preview["request"].clone();
    request["consent_id"] = consent["consent_id"].clone();
    let run = post(&app, "/api/ai/runs", request, &cookie, &csrf).await;
    (
        state,
        app,
        run["run_id"].as_str().unwrap().into(),
        project_id.into(),
    )
}

async fn call(
    peer: &rmcp::service::RunningService<rmcp::RoleClient, ()>,
    name: &str,
    args: Value,
) -> CallToolResult {
    tokio::time::timeout(
        Duration::from_secs(10),
        peer.call_tool(
            serde_json::from_value::<CallToolRequestParams>(json!({"name":name,"arguments":args}))
                .unwrap(),
        ),
    )
    .await
    .unwrap()
    .unwrap()
}

#[tokio::test]
async fn real_product_stdio_lists_shared_schemas_preserves_region_and_reauthorizes_every_call() {
    let directory = scratch();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (state, app, run, project) = fixture(directory.path(), addr).await;
    let tools = weblabel_api::runtime::agent_tools::router(
        state.repository.clone(),
        state.run_tokens.clone(),
        state.auth.clone(),
    );
    let server = tokio::spawn(async move { axum::serve(listener, tools).await.unwrap() });
    let token = state
        .run_tokens
        .issue(&run, &project, Duration::from_secs(60));
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_weblabel"))
        .arg("mcp-stdio")
        .env("WEBLABEL_API_BASE", format!("http://{addr}"))
        .env("WEBLABEL_RUN_TOKEN", &token)
        .env("DATABASE_URL", "invalid-before-dispatch")
        .env("RUST_LOG", "trace")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let client = tokio::time::timeout(
        Duration::from_secs(10),
        ().serve((child.stdout.take().unwrap(), child.stdin.take().unwrap())),
    )
    .await
    .unwrap()
    .unwrap();
    let listed = client.list_tools(None).await.unwrap();
    let expected: Vec<Value> = tool_definitions()
        .as_array()
        .unwrap()
        .iter()
        .cloned()
        .collect();
    assert_eq!(listed.tools.len(), 5);
    for (tool, definition) in listed.tools.iter().zip(expected) {
        assert_eq!(tool.name.as_ref(), definition["name"].as_str().unwrap());
        assert_eq!(
            serde_json::to_value(&tool.input_schema).unwrap(),
            definition["inputSchema"]
        );
    }
    let context = call(&client, "get_context", json!({})).await;
    assert_ne!(context.is_error, Some(true));
    let region = call(&client, "read_region", json!({"region":null})).await;
    assert_ne!(region.is_error, Some(true));
    let wire = serde_json::to_value(region).unwrap();
    assert!(wire["content"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["type"] == "image" && c["mimeType"] == "image/png"));
    let metadata: Value =
        serde_json::from_str(wire["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(metadata["width"], 16);
    assert_eq!(metadata["height"], 8);
    assert_eq!(metadata["region"], Value::Null);
    assert_eq!(
        metadata["transform_to_canonical"],
        json!([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0])
    );
    let cross = call(
        &client,
        "get_context",
        json!({"project_id":"other-project"}),
    )
    .await;
    assert_eq!(cross.is_error, Some(true));
    assert!(serde_json::to_string(&cross)
        .unwrap()
        .contains("IDENTITY_OVERRIDE"));
    assert!(client.list_prompts(None).await.is_err());
    assert!(client.list_resources(None).await.is_err());
    assert!(client.list_resource_templates(None).await.is_err());
    let excluded = serde_json::from_value(
        json!({"ref":{"type":"ref/prompt","name":"excluded"},"argument":{"name":"x","value":""}}),
    )
    .unwrap();
    assert!(client.complete(excluded).await.is_err());
    // An actual run bound to a different project must fail in the API, not only
    // via transport-side argument filtering.
    let wrong = state
        .run_tokens
        .issue(&run, "other-project", Duration::from_secs(60));
    let mut child2 = tokio::process::Command::new(env!("CARGO_BIN_EXE_weblabel"))
        .arg("mcp-stdio")
        .env("WEBLABEL_API_BASE", format!("http://{addr}"))
        .env("WEBLABEL_RUN_TOKEN", &wrong)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let client2 = tokio::time::timeout(
        Duration::from_secs(10),
        ().serve((child2.stdout.take().unwrap(), child2.stdin.take().unwrap())),
    )
    .await
    .unwrap()
    .unwrap();
    let cross = call(&client2, "get_context", json!({})).await;
    assert_eq!(cross.is_error, Some(true));
    assert!(serde_json::to_string(&cross)
        .unwrap()
        .contains("RUN_TOKEN_PROJECT_MISMATCH"));
    client2.cancel().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), child2.wait())
        .await
        .unwrap()
        .unwrap();
    state.run_tokens.revoke_run(&run);
    let revoked = call(&client, "get_context", json!({})).await;
    assert_eq!(revoked.is_error, Some(true));
    assert!(serde_json::to_string(&revoked)
        .unwrap()
        .contains("RUN_TOKEN_REVOKED"));
    assert!(!serde_json::to_string(&revoked).unwrap().contains(&token));
    client.cancel().await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .unwrap()
        .unwrap();
    server.abort();
    drop(app);
}

#[tokio::test]
async fn invalid_mcp_environment_exits_without_startup_output_or_network() {
    for base in [
        "http://localhost:1",
        "https://127.0.0.1:1",
        "http://127.0.0.1:1/secret",
    ] {
        let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_weblabel"))
            .arg("mcp-stdio")
            .env("WEBLABEL_API_BASE", base)
            .env("WEBLABEL_RUN_TOKEN", "synthetic-private-token")
            .env("DATABASE_URL", "invalid-before-dispatch")
            .output()
            .await
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("synthetic-private-token"));
    }
}

#[test]
fn synthetic_session_rejects_unknown_auth_foreign_session_model_and_unpaired_tools() {
    use weblabel_api::runtime::providers::claude::protocol::Session;
    let id = "550e8400-e29b-41d4-a716-446655440000";
    let init = |auth: &str, model: &str| json!({"type":"system","subtype":"init","session_id":id,"auth_mode":auth,"model":model,"tools":weblabel_api::runtime::providers::claude::permitted_tools(),"mcp_servers":[{"name":"weblabel-agent-tools","status":"connected"}]});
    for (auth, model, code) in [
        ("unknown", "claude-fixture", "needs_login"),
        ("api_key", "claude-fixture", "api_auth_not_subscription"),
        ("subscription", "wrong", "model_mismatch"),
    ] {
        let mut session = Session::new(id.into(), "claude-fixture".into(), 4, 1024);
        assert_eq!(session.fold(&init(auth, model)).unwrap_err().code, code);
    }
    let mut session = Session::new(id.into(), "claude-fixture".into(), 4, 1024);
    session
        .fold(&init("subscription", "claude-fixture"))
        .unwrap();
    let result = json!({"type":"user","session_id":id,"message":{"content":[{"type":"tool_result","tool_use_id":"missing","content":"x"}]}});
    assert_eq!(
        session.fold(&result).unwrap_err().code,
        "tool_boundary_violation"
    );
    let mut session = Session::new(id.into(), "claude-fixture".into(), 4, 1024);
    session
        .fold(&init("subscription", "claude-fixture"))
        .unwrap();
    assert_eq!(
        session
            .fold(&json!({"type":"result","session_id":"foreign","subtype":"success"}))
            .unwrap_err()
            .code,
        "session_mismatch"
    );
}

// Compiled under the project-local fixture directory by the integration test.
// This is an intentionally synthetic Rust CLI, never the official Claude binary.
const FAKE_CLI: &str = r##"
use std::{env,io::{Read,Write},process::{Command,Stdio},thread,time::Duration};
fn main(){
    let args:Vec<String>=env::args().collect();
    if args.get(1).map(String::as_str)==Some("--child"){
        loop{thread::sleep(Duration::from_millis(50));}
    }
    if args.get(1).map(String::as_str)==Some("--spawner"){
        let path=&args[2];let start=format!("{path}.start");
        while !std::path::Path::new(&start).exists(){thread::sleep(Duration::from_millis(5));}
        for _ in 0..12{
            let child=Command::new(env::current_exe().unwrap()).arg("--child").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
            let mut file=std::fs::OpenOptions::new().append(true).open(path).unwrap();write!(file," {}",child.id()).unwrap();
            thread::sleep(Duration::from_millis(20));
        }
        loop{thread::sleep(Duration::from_millis(50));}
    }
    let mut prompt=String::new();std::io::stdin().read_to_string(&mut prompt).unwrap();
    assert_eq!(prompt,"r04-private-prompt-only-stdin");
    assert!(!args.iter().any(|a|a.contains(&prompt)));
    let mode=env::var("R04_MODE").unwrap();
    if mode=="hang" || mode=="orphan" || mode=="late"{
        let mut command=Command::new(env::current_exe().unwrap());
        if mode=="late"{command.arg("--spawner").arg(env::var("R04_PIDS").unwrap());}else{command.arg("--child");}
        let child=command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        std::fs::write(env::var("R04_PIDS").unwrap(),format!("{} {}",std::process::id(),child.id())).unwrap();
        if mode=="orphan"||mode=="late"{return;}
        loop{thread::sleep(Duration::from_millis(50));}
    }
    let session=args.windows(2).find(|p|p[0]=="--session-id").unwrap()[1].clone();
    println!("{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"{session}\",\"auth_mode\":\"subscription\",\"model\":\"claude-fixture\",\"tools\":[\"mcp__weblabel-agent-tools__get_context\",\"mcp__weblabel-agent-tools__list_objects\",\"mcp__weblabel-agent-tools__read_region\",\"mcp__weblabel-agent-tools__propose_changes\",\"mcp__weblabel-agent-tools__report_issues\"],\"mcp_servers\":[{{\"name\":\"weblabel-agent-tools\",\"status\":\"connected\"}}]}}");
    if mode=="truncated"{print!("{{");std::io::stdout().flush().unwrap();return;}
    if mode=="flood"{for _ in 0..(4*1024+1){print!("{}", "x".repeat(1024));}return;}
    if mode=="usage-failed"{
        println!("{{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"session_id\":\"{session}\",\"usage\":{{\"input_tokens\":11,\"output_tokens\":3}}}}");return;
    }
    print!("{{\"type\":\"result\",\"subtype\":\"success\",\"session_id\":\"{session}\",\"structured_output\":{{\"changes\":[],\"issues\":[]}}");
    if mode.starts_with("usage-"){print!(",\"usage\":{{\"input_tokens\":11,\"output_tokens\":3}}");}
    println!("}}");
    if mode=="usage-nonzero"{std::process::exit(7);}
    if mode=="usage-truncated"{print!("{{");std::io::stdout().flush().unwrap();return;}
    if mode=="usage-cancel"{loop{thread::sleep(Duration::from_millis(50));}}
    if mode=="duplicate"{println!("{{\"type\":\"result\",\"subtype\":\"success\",\"session_id\":\"{session}\"}}");}
}
"##;

fn compile_fake(directory: &Path) -> PathBuf {
    let source = directory.join("fake.rs");
    std::fs::write(&source, FAKE_CLI).unwrap();
    let binary = directory.join(if cfg!(windows) {
        "fake-claude.exe"
    } else {
        "fake-claude"
    });
    let status = std::process::Command::new("rustc")
        .arg("--edition=2024")
        .arg("--crate-name")
        .arg("r04_fake_claude")
        .arg(&source)
        .arg("-o")
        .arg(&binary)
        .env("TEMP", directory)
        .env("TMP", directory)
        .env("TMPDIR", directory)
        .status()
        .unwrap();
    assert!(status.success(), "controlled Rust CLI fixture must compile");
    binary
}

fn fixture_host(
    directory: &Path,
    binary: &Path,
    mode: &str,
    token: &str,
) -> weblabel_api::runtime::host::HostConfig {
    use std::collections::BTreeMap;
    use weblabel_api::runtime::providers::claude::{launch_config, ClaudeConfig};
    let config=ClaudeConfig::parse(&json!({"profile_id":"r04-profile","model_id":"claude-fixture","executable":binary,"timeout_ms":5000,"max_tool_turns":4,"max_tool_result_bytes":1024})).unwrap();
    let mut host = launch_config(
        &config,
        Path::new(env!("CARGO_BIN_EXE_weblabel")),
        directory,
        "http://127.0.0.1:48100",
        token,
        "550e8400-e29b-41d4-a716-446655440000",
        BTreeMap::new(),
    )
    .unwrap();
    host.allowed_env
        .extend(["R04_MODE".into(), "R04_PIDS".into()]);
    host.extra_env.insert("R04_MODE".into(), mode.into());
    host.extra_env.insert(
        "R04_PIDS".into(),
        directory.join("pids").to_str().unwrap().into(),
    );
    host
}

#[tokio::test]
async fn synthetic_native_cli_uses_stdin_strict_flags_terminal_usage_once_and_bounded_frames() {
    use weblabel_api::runtime::{
        providers::claude::{protocol::Session, run_native},
        run_tokens::RunTokenStore,
    };
    let directory = scratch();
    let binary = compile_fake(directory.path());
    let tokens = RunTokenStore::new();
    for (mode, error) in [
        ("success", None),
        ("truncated", Some("truncated_stream")),
        ("flood", Some("stream_budget_exceeded")),
        ("duplicate", Some("duplicate_result")),
    ] {
        let token = tokens.issue(
            &format!("r04-run-{mode}"),
            "r04-project",
            Duration::from_secs(60),
        );
        let host = fixture_host(directory.path(), &binary, mode, &token);
        assert!(!host.argv.iter().any(|arg| arg.contains(&token)
            || arg == "--bare"
            || arg.contains("skip-permissions")));
        for flag in [
            "-p",
            "--strict-mcp-config",
            "--no-session-persistence",
            "--allowedTools",
            "--disallowedTools",
        ] {
            assert!(host.argv.iter().any(|a| a == flag));
        }
        assert_eq!(
            host.argv.windows(2).find(|a| a[0] == "--tools").unwrap()[1],
            ""
        );
        let result = run_native(
            &host,
            "r04-private-prompt-only-stdin",
            Session::new(
                "550e8400-e29b-41d4-a716-446655440000".into(),
                "claude-fixture".into(),
                4,
                1024,
            ),
            &tokens,
            &token,
            tokio::time::Instant::now() + Duration::from_secs(10),
            None,
        )
        .await;
        if let Some(code) = error {
            assert_eq!(result.unwrap_err().code, code);
        } else {
            let result = result.unwrap();
            assert!(result.usage.is_none());
            assert_eq!(result.candidates, vec![json!({"changes":[],"issues":[]})]);
        }
        tokens.revoke(&token);
    }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        },
    };
    // SAFETY: a query/synchronize handle only; no process memory or termination.
    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        );
        if handle.is_null() {
            return false;
        }
        let running = WaitForSingleObject(handle, 0) == 258;
        CloseHandle(handle);
        running
    }
}
#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[tokio::test]
async fn native_timeout_and_revocation_reclaim_owned_root_and_grandchild() {
    use weblabel_api::runtime::{
        providers::claude::{protocol::Session, run_native},
        run_tokens::RunTokenStore,
    };
    let directory = scratch();
    let binary = compile_fake(directory.path());
    for cancel in [false, true] {
        let run_dir = directory
            .path()
            .join(if cancel { "cancel" } else { "timeout" });
        std::fs::create_dir(&run_dir).unwrap();
        let tokens = RunTokenStore::new();
        let token = tokens.issue("r04-run", "r04-project", Duration::from_secs(60));
        let host = fixture_host(&run_dir, &binary, "hang", &token);
        let cancellation = tokens.clone();
        let revoke = token.clone();
        let pids = run_dir.join("pids");
        let wait_path = pids.clone();
        let trigger = tokio::spawn(async move {
            let limit = tokio::time::Instant::now() + Duration::from_secs(10);
            while !wait_path.exists() {
                assert!(tokio::time::Instant::now() < limit);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            if cancel {
                cancellation.revoke(&revoke);
            }
        });
        let began = tokio::time::Instant::now();
        let error = run_native(
            &host,
            "r04-private-prompt-only-stdin",
            Session::new(
                "550e8400-e29b-41d4-a716-446655440000".into(),
                "claude-fixture".into(),
                4,
                1024,
            ),
            &tokens,
            &token,
            began + Duration::from_secs(if cancel { 15 } else { 3 }),
            None,
        )
        .await
        .unwrap_err();
        trigger.await.unwrap();
        assert_eq!(
            error.code,
            if cancel {
                "run_cancelled"
            } else {
                "tool_time_budget_exceeded"
            }
        );
        assert!(
            began.elapsed() < Duration::from_secs(25),
            "owned tree cleanup and drain must be bounded"
        );
        let ids = std::fs::read_to_string(pids).unwrap();
        for pid in ids.split_whitespace().map(|p| p.parse::<u32>().unwrap()) {
            assert!(!process_alive(pid), "owned process {pid} survived");
        }
    }
}

#[test]
fn native_launch_refuses_script_wrapper_and_api_credential_environment() {
    use std::collections::BTreeMap;
    use weblabel_api::runtime::providers::claude::{launch_config, ClaudeConfig};
    let directory = scratch();
    let script = directory.path().join("claude.cmd");
    std::fs::write(&script, "@echo off\\r\\nnode cli.js\\r\\n").unwrap();
    assert!(ClaudeConfig::parse(&json!({"profile_id":"r04-profile","model_id":"claude-fixture","executable":script,"timeout_ms":5000,"max_tool_turns":4,"max_tool_result_bytes":1024})).is_err());
    let config = ClaudeConfig {
        profile_id: "r04-profile".into(),
        model_id: "claude-fixture".into(),
        executable: PathBuf::from(env!("CARGO_BIN_EXE_weblabel")),
        timeout_ms: 5000,
        max_tool_turns: 4,
        max_tool_result_bytes: 1024,
    };
    for name in [
        "ANTHROPIC_API_KEY",
        "anthropic_auth_token",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "NODE_OPTIONS",
        "HTTPS_PROXY",
        "CLAUDE_CODE_USE_BEDROCK",
    ] {
        let env = BTreeMap::from([(name.into(), "synthetic-secret-must-not-launch".into())]);
        let error = launch_config(
            &config,
            Path::new(env!("CARGO_BIN_EXE_weblabel")),
            directory.path(),
            "http://127.0.0.1:48100",
            &"a".repeat(64),
            "550e8400-e29b-41d4-a716-446655440000",
            env,
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "env_denied");
    }
}

#[test]
fn synthetic_session_pairs_once_enforces_budgets_and_never_adds_checkpoint_usage() {
    use weblabel_api::runtime::providers::claude::{permitted_tools, protocol::Session};
    let id = "550e8400-e29b-41d4-a716-446655440000";
    let init = json!({"type":"system","subtype":"init","session_id":id,"auth_mode":"subscription","model":"claude-fixture","tools":permitted_tools(),"mcp_servers":[{"name":"weblabel-agent-tools","status":"connected"}]});
    let call = json!({"type":"assistant","session_id":id,"message":{"content":[{"type":"tool_use","id":"call-1","name":permitted_tools()[0],"input":{}}]},"usage":{"input_tokens":999}});
    let result = json!({"type":"user","session_id":id,"message":{"content":[{"type":"tool_result","tool_use_id":"call-1","content":"ok"}]}});
    let terminal = json!({"type":"result","session_id":id,"subtype":"success","usage":{"input_tokens":10,"output_tokens":3},"structured_output":{"changes":[],"issues":[]}});
    let mut session = Session::new(id.into(), "claude-fixture".into(), 1, 1024);
    session.fold(&init).unwrap();
    session.fold(&call).unwrap();
    session.fold(&result).unwrap();
    let done = session.fold(&terminal).unwrap().unwrap();
    assert_eq!(
        done.usage,
        Some(json!({"input_tokens":10,"output_tokens":3}))
    );
    assert_eq!(done.tool_calls, 1);
    assert_eq!(done.candidates.len(), 1);
    assert_eq!(
        session.fold(&terminal).unwrap_err().code,
        "duplicate_result"
    );
    let mut session = Session::new(id.into(), "claude-fixture".into(), 1, 1024);
    session.fold(&init).unwrap();
    session.fold(&call).unwrap();
    assert_eq!(
        session.fold(&terminal).unwrap_err().code,
        "tool_boundary_violation"
    );
    let mut session = Session::new(id.into(), "claude-fixture".into(), 1, 1);
    session.fold(&init).unwrap();
    session.fold(&call).unwrap();
    assert_eq!(
        session.fold(&result).unwrap_err().code,
        "tool_byte_budget_exceeded"
    );
    let mut session = Session::new(id.into(), "claude-fixture".into(), 0, 1024);
    session.fold(&init).unwrap();
    assert_eq!(
        session.fold(&call).unwrap_err().code,
        "tool_turn_budget_exceeded"
    );
}

#[tokio::test]
async fn real_stdio_rejects_api_redirect_without_forwarding_private_bearer() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let hits = Arc::new(AtomicUsize::new(0));
    let hit_count = hits.clone();
    let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_addr = target.local_addr().unwrap();
    let target_router = Router::new().route(
        "/capture",
        axum::routing::post(move || {
            let hits = hit_count.clone();
            async move {
                hits.fetch_add(1, Ordering::SeqCst);
                axum::Json(json!({}))
            }
        }),
    );
    let target_task =
        tokio::spawn(async move { axum::serve(target, target_router).await.unwrap() });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let redirect = Router::new().route(
        "/internal/agent-tools/get_context",
        axum::routing::post(move || async move {
            (
                StatusCode::TEMPORARY_REDIRECT,
                [(
                    axum::http::header::LOCATION,
                    format!("http://{target_addr}/capture"),
                )],
            )
        }),
    );
    let redirect_task = tokio::spawn(async move { axum::serve(listener, redirect).await.unwrap() });
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_weblabel"))
        .arg("mcp-stdio")
        .env("WEBLABEL_API_BASE", format!("http://{addr}"))
        .env("WEBLABEL_RUN_TOKEN", "a".repeat(64))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let client = tokio::time::timeout(
        Duration::from_secs(10),
        ().serve((child.stdout.take().unwrap(), child.stdin.take().unwrap())),
    )
    .await
    .unwrap()
    .unwrap();
    let result = call(&client, "get_context", json!({})).await;
    assert_eq!(result.is_error, Some(true));
    assert!(serde_json::to_string(&result)
        .unwrap()
        .contains("MCP_REDIRECT_FORBIDDEN"));
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    client.cancel().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .unwrap()
        .unwrap();
    redirect_task.abort();
    target_task.abort();
}

#[test]
fn rejects_unknown_candidate_families_and_malformed_consumed_terminal_fields() {
    use weblabel_api::runtime::providers::claude::{permitted_tools, protocol::Session};
    let id = "550e8400-e29b-41d4-a716-446655440000";
    let init = json!({"type":"system","subtype":"init","session_id":id,"auth_mode":"subscription","model":"claude-fixture","tools":permitted_tools(),"mcp_servers":[{"name":"weblabel-agent-tools","status":"connected"}]});
    let mut session = Session::new(id.into(), "claude-fixture".into(), 1, 1024);
    session.fold(&init).unwrap();
    assert!(session
        .fold(
            &json!({"type":"unrecognized","session_id":id,"proposals":[{"changes":[],"issues":[]}]})
        )
        .is_err());
    for invalid in [json!("true"), json!(1), json!({})] {
        let mut session = Session::new(id.into(), "claude-fixture".into(), 1, 1024);
        session.fold(&init).unwrap();
        assert!(session
            .fold(&json!({"type":"result","subtype":"success","session_id":id,"is_error":invalid}))
            .is_err());
    }
}

#[test]
fn failed_terminal_usage_is_observed_once_and_not_replaced_by_later_messages() {
    use weblabel_api::runtime::providers::claude::{permitted_tools, protocol::Session};
    let id = "550e8400-e29b-41d4-a716-446655440000";
    let mut session = Session::new(id.into(), "claude-fixture".into(), 1, 1024);
    session.fold(&json!({"type":"system","subtype":"init","session_id":id,"auth_mode":"subscription","model":"claude-fixture","tools":permitted_tools(),"mcp_servers":[{"name":"weblabel-agent-tools","status":"connected"}]})).unwrap();
    let terminal = json!({"type":"result","subtype":"error_during_execution","is_error":true,"session_id":id,"usage":{"input_tokens":7,"output_tokens":2}});
    assert!(session.fold(&terminal).is_err());
    assert_eq!(
        session.take_terminal_usage(),
        Some(json!({"input_tokens":7,"output_tokens":2}))
    );
    assert!(session.take_terminal_usage().is_none());
    assert!(session.fold(&terminal).is_err());
    assert!(session.take_terminal_usage().is_none());
}

#[test]
fn json_budgets_accept_exact_size_and_refuse_one_over_without_growing_output() {
    use weblabel_api::runtime::mcp::{json_size_bounded, serialize_bounded};
    let value = json!({"x":"escaped\\ntext"});
    let expected = serde_json::to_vec(&value).unwrap();
    assert_eq!(serialize_bounded(&value, expected.len()).unwrap(), expected);
    assert!(serialize_bounded(&value, expected.len() - 1).is_err());
    assert_eq!(
        json_size_bounded(&value, expected.len()).unwrap(),
        expected.len()
    );
    assert!(json_size_bounded(&json!({"x":"x".repeat(1024*1024)}), 1024).is_err());
}

#[cfg(windows)]
#[tokio::test]
async fn job_ownership_survives_fast_root_exit_and_future_abandonment() {
    use tokio::io::AsyncWriteExt;
    use weblabel_api::runtime::{
        host::spawn_native,
        providers::claude::{protocol::Session, run_native},
        run_tokens::RunTokenStore,
    };
    let directory = scratch();
    let binary = compile_fake(directory.path());
    for mode in ["orphan", "late", "abort"] {
        let run_dir = directory.path().join(mode);
        std::fs::create_dir(&run_dir).unwrap();
        let tokens = RunTokenStore::new();
        let token = tokens.issue(&format!("r04-{mode}"), "project", Duration::from_secs(60));
        let host = fixture_host(
            &run_dir,
            &binary,
            if mode == "abort" { "hang" } else { mode },
            &token,
        );
        let mut direct = None;
        let mut task = None;
        if mode != "abort" {
            let mut child = spawn_native(&host).unwrap();
            let forged = weblabel_api::runtime::supervisor::ReclaimRoot {
                root_pid: child.root.root_pid,
                spawned_at_ms: 0,
                exited_at_ms: None,
            };
            assert!(weblabel_api::runtime::supervisor::reclaim_process_tree(forged).is_err());
            let mut stdin = child.child.stdin.take().unwrap();
            stdin
                .write_all(b"r04-private-prompt-only-stdin")
                .await
                .unwrap();
            drop(stdin);
            child.child.wait().await.unwrap();
            direct = Some(child);
        } else {
            task = Some(tokio::spawn(async move {
                run_native(
                    &host,
                    "r04-private-prompt-only-stdin",
                    Session::new(
                        "550e8400-e29b-41d4-a716-446655440000".into(),
                        "claude-fixture".into(),
                        4,
                        1024,
                    ),
                    &tokens,
                    &token,
                    tokio::time::Instant::now() + Duration::from_secs(60),
                    None,
                )
                .await
            }));
        }
        let pids = run_dir.join("pids");
        let limit = tokio::time::Instant::now() + Duration::from_secs(10);
        while !pids.exists() {
            assert!(tokio::time::Instant::now() < limit);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        if mode == "late" {
            std::fs::write(run_dir.join("pids.start"), "start").unwrap();
            while std::fs::read_to_string(&pids)
                .unwrap()
                .split_whitespace()
                .count()
                < 3
            {
                assert!(tokio::time::Instant::now() < limit);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
        if let Some(mut owned) = direct {
            owned.reclaim().await.unwrap();
        }
        if let Some(task) = task {
            let began = tokio::time::Instant::now();
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            assert!(
                began.elapsed() < Duration::from_millis(250),
                "Drop must not run blocking process utilities"
            );
        }
        let ids: Vec<u32> = std::fs::read_to_string(pids)
            .unwrap()
            .split_whitespace()
            .map(|s| s.parse().unwrap())
            .collect();
        let limit = tokio::time::Instant::now() + Duration::from_secs(5);
        while ids.iter().any(|pid| process_alive(*pid)) {
            assert!(tokio::time::Instant::now() < limit, "owned orphan survived");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

#[cfg(windows)]
#[test]
fn unregistered_or_recycled_pid_never_authorizes_process_table_kills() {
    use weblabel_api::runtime::supervisor::{reclaim_process_tree, ReclaimRoot};
    // An impossible unregistered identity must fail; never target the test
    // process or another real process during the red run.
    let error = reclaim_process_tree(ReclaimRoot {
        root_pid: u32::MAX,
        spawned_at_ms: 0,
        exited_at_ms: None,
    })
    .unwrap_err();
    assert!(error.to_string().contains("ownership"), "{error}");
}

struct UsageRunner {
    host: weblabel_api::runtime::host::HostConfig,
    tokens: weblabel_api::runtime::run_tokens::RunTokenStore,
    token: String,
}
impl RunRunner for UsageRunner {
    fn execute<'a>(
        &'a self,
        driver: &'a RunDriver,
    ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, RunnerError>> + Send + 'a>> {
        Box::pin(async move {
            use weblabel_api::runtime::providers::claude::{protocol::Session, run_native};
            run_native(
                &self.host,
                "r04-private-prompt-only-stdin",
                Session::new(
                    "550e8400-e29b-41d4-a716-446655440000".into(),
                    "claude-fixture".into(),
                    4,
                    1024,
                ),
                &self.tokens,
                &self.token,
                tokio::time::Instant::now() + Duration::from_secs(10),
                Some(driver),
            )
            .await?;
            Ok(RunOutcome::Completed)
        })
    }
}

#[tokio::test]
async fn real_run_event_channel_retains_usage_on_failed_nonzero_truncated_and_cancelled_runs() {
    use weblabel_api::jobs::{model_jobs::process_model_next, queue::JobQueue};
    let directory = scratch();
    let binary = compile_fake(directory.path());
    for mode in [
        "usage-failed",
        "usage-nonzero",
        "usage-truncated",
        "usage-cancel",
    ] {
        let run_dir = directory.path().join(mode);
        std::fs::create_dir(&run_dir).unwrap();
        let (state, _app, run, project) = fixture(&run_dir, "127.0.0.1:1".parse().unwrap()).await;
        let token = state
            .run_tokens
            .issue(&run, &project, Duration::from_secs(60));
        let runner = UsageRunner {
            host: fixture_host(&run_dir, &binary, mode, &token),
            tokens: state.run_tokens.clone(),
            token,
        };
        let queue = JobQueue::new(state.repository.clone());
        let cancel = async {
            if mode != "usage-cancel" {
                return;
            }
            let limit = tokio::time::Instant::now() + Duration::from_secs(8);
            loop {
                let mut tx = state.repository.begin_write().await.unwrap();
                let observed:i64=sqlx::query_scalar("SELECT COUNT(*) FROM run_events WHERE run_id=? AND provider_event_id='claude-terminal-usage'").bind(&run).fetch_one(tx.connection()).await.unwrap();
                let actor: String =
                    sqlx::query_scalar("SELECT actor_id FROM model_runs WHERE run_id=?")
                        .bind(&run)
                        .fetch_one(tx.connection())
                        .await
                        .unwrap();
                tx.commit().await.unwrap();
                if observed > 0 {
                    weblabel_api::ai::runs::cancel(
                        &state.repository,
                        &state.run_tokens,
                        &run,
                        &actor,
                        "synthetic cancellation after usage",
                    )
                    .await
                    .unwrap();
                    break;
                }
                assert!(tokio::time::Instant::now() < limit);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        let (processed, ()) = tokio::join!(
            process_model_next(
                &state.repository,
                &queue,
                "r04-usage-worker",
                Duration::from_secs(30),
                &runner
            ),
            cancel
        );
        assert!(processed.unwrap().is_some());
        let mut tx = state.repository.begin_write().await.unwrap();
        let rows:Vec<String>=sqlx::query_scalar("SELECT data_json FROM run_events WHERE run_id=? AND provider_event_id='claude-terminal-usage'").bind(&run).fetch_all(tx.connection()).await.unwrap();
        let status: String = sqlx::query_scalar("SELECT state FROM model_runs WHERE run_id=?")
            .bind(&run)
            .fetch_one(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_ne!(
            status, "succeeded",
            "{mode} must not turn billing observation into successful execution"
        );
        assert_eq!(rows.len(), 1);
        let observation: Value = serde_json::from_str(&rows[0]).unwrap();
        assert_eq!(
            observation["usage"],
            json!({"input_tokens":11,"output_tokens":3})
        );
        assert_eq!(observation["cost_display"], "unknown");
    }
}

#[test]
fn tool_result_remaining_budget_is_checked_before_resolving_the_call() {
    use weblabel_api::runtime::providers::claude::{permitted_tools, protocol::Session};
    let id = "550e8400-e29b-41d4-a716-446655440000";
    let init = json!({"type":"system","subtype":"init","session_id":id,"auth_mode":"subscription","model":"claude-fixture","tools":permitted_tools(),"mcp_servers":[{"name":"weblabel-agent-tools","status":"connected"}]});
    let call = json!({"type":"assistant","session_id":id,"message":{"content":[{"type":"tool_use","id":"call","name":permitted_tools()[0],"input":{}}]}});
    let block = json!({"type":"tool_result","tool_use_id":"call","content":"boundary"});
    let bytes = serde_json::to_vec(&block).unwrap().len();
    let result = json!({"type":"user","session_id":id,"message":{"content":[block]}});
    let terminal = json!({"type":"result","session_id":id,"subtype":"success"});
    let mut exact = Session::new(id.into(), "claude-fixture".into(), 1, bytes);
    exact.fold(&init).unwrap();
    exact.fold(&call).unwrap();
    exact.fold(&result).unwrap();
    assert!(exact.fold(&terminal).unwrap().is_some());
    let mut over = Session::new(id.into(), "claude-fixture".into(), 1, bytes - 1);
    over.fold(&init).unwrap();
    over.fold(&call).unwrap();
    assert_eq!(
        over.fold(&result).unwrap_err().code,
        "tool_byte_budget_exceeded"
    );
    assert_eq!(
        over.fold(&terminal).unwrap_err().code,
        "tool_boundary_violation"
    );
    let mut candidate = Session::new(id.into(), "claude-fixture".into(), 1, bytes);
    candidate.fold(&init).unwrap();
    let oversized = json!({"type":"assistant","session_id":id,"message":{"content":[]},"proposals":[{"changes":[],"issues":[],"blob":"x".repeat(256*1024)}]});
    assert_eq!(
        candidate.fold(&oversized).unwrap_err().code,
        "candidate_too_large"
    );
}

async fn assert_candidate_counts(
    repository: &weblabel_api::storage::Repository,
    run: &str,
    expected: i64,
) {
    let mut tx = repository.begin_write().await.unwrap();
    let predictions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM predictions WHERE run_id=?")
        .bind(run)
        .fetch_one(tx.connection())
        .await
        .unwrap();
    let suggestions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM suggestion_sets WHERE run_id=?")
            .bind(run)
            .fetch_one(tx.connection())
            .await
            .unwrap();
    let events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM run_events WHERE run_id=? AND event_type='candidate'",
    )
    .bind(run)
    .fetch_one(tx.connection())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(predictions, expected, "stored prediction count");
    assert_eq!(suggestions, expected, "stored suggestion count");
    assert_eq!(events, expected, "stored candidate event count");
}

struct EchoRunner {
    repository: weblabel_api::storage::Repository,
    tokens: weblabel_api::runtime::run_tokens::RunTokenStore,
    addr: std::net::SocketAddr,
}
impl RunRunner for EchoRunner {
    fn execute<'a>(
        &'a self,
        driver: &'a RunDriver,
    ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, RunnerError>> + Send + 'a>> {
        Box::pin(async move {
            use weblabel_api::{
                ai::predictions::SubmitCandidates, runtime::agent_tools::claude_candidate_event_id,
            };
            let token = self.tokens.issue(
                driver.run_id(),
                &driver.context().project_id,
                Duration::from_secs(60),
            );
            let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_weblabel"))
                .arg("mcp-stdio")
                .env("WEBLABEL_API_BASE", format!("http://{}", self.addr))
                .env("WEBLABEL_RUN_TOKEN", &token)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let client = tokio::time::timeout(
                Duration::from_secs(10),
                ().serve((child.stdout.take().unwrap(), child.stdin.take().unwrap())),
            )
            .await
            .unwrap()
            .unwrap();
            let issue = json!({"issue_id":"issue_echo","object_id":null,"code":"suspected_missing_box","message":"Synthetic engineering issue, not a review decision",
                "region":{"type":"bbox_xyxy","x_min":1,"y_min":1,"x_max":4,"y_max":4}});
            let submitted = call(&client, "report_issues", json!({"issues":[issue.clone()]})).await;
            assert_ne!(submitted.is_error, Some(true), "{submitted:?}");
            // The tool DTO serializes BBox as f64 and inserts score:null.
            // Terminal echo deliberately uses integer pixels and omitted score.
            let terminal = json!({"changes":[],"issues":[issue.clone()]});
            let provider_event_id = claude_candidate_event_id(&terminal).unwrap();
            driver
                .submit_candidates(
                    SubmitCandidates {
                        provider_event_id,
                        provider_seq: None,
                        raw: terminal.clone(),
                    },
                    Some((&self.tokens, &token)),
                )
                .await?;
            assert_candidate_counts(&self.repository, driver.run_id(), 1).await;
            let repeated = call(&client, "report_issues", json!({"issues":[issue]})).await;
            assert_eq!(repeated.is_error, Some(true));
            assert!(serde_json::to_string(&repeated)
                .unwrap()
                .contains("DUPLICATE_CANDIDATE"));
            assert_candidate_counts(&self.repository, driver.run_id(), 1).await;
            let mut invalid = terminal.clone();
            invalid["unexpected"] = json!(true);
            assert!(
                claude_candidate_event_id(&invalid).is_err(),
                "unknown fields cannot disappear during identity normalization"
            );
            let invalid_tool = call(
                &client,
                "report_issues",
                json!({"issues":terminal["issues"],"unexpected":true}),
            )
            .await;
            assert_eq!(invalid_tool.is_error, Some(true));
            assert_candidate_counts(&self.repository, driver.run_id(), 1).await;
            let mut distinct = terminal.clone();
            distinct["issues"][0]["issue_id"] = json!("issue_distinct");
            let submitted = call(
                &client,
                "report_issues",
                json!({"issues":distinct["issues"]}),
            )
            .await;
            assert_ne!(submitted.is_error, Some(true), "{submitted:?}");
            driver
                .submit_candidates(
                    SubmitCandidates {
                        provider_event_id: claude_candidate_event_id(&distinct).unwrap(),
                        provider_seq: None,
                        raw: distinct,
                    },
                    Some((&self.tokens, &token)),
                )
                .await?;
            assert_candidate_counts(&self.repository, driver.run_id(), 2).await;
            let mut structured_only = terminal;
            structured_only["issues"][0]["issue_id"] = json!("issue_structured_only");
            driver
                .submit_candidates(
                    SubmitCandidates {
                        provider_event_id: claude_candidate_event_id(&structured_only).unwrap(),
                        provider_seq: None,
                        raw: structured_only,
                    },
                    Some((&self.tokens, &token)),
                )
                .await?;
            assert_candidate_counts(&self.repository, driver.run_id(), 3).await;
            client.cancel().await.unwrap();
            tokio::time::timeout(Duration::from_secs(5), child.wait())
                .await
                .unwrap()
                .unwrap();
            self.tokens.revoke_run(driver.run_id());
            Ok(RunOutcome::Completed)
        })
    }
}

#[tokio::test]
async fn real_native_mcp_submission_and_driver_terminal_echo_persist_one_identity_not_two() {
    use weblabel_api::jobs::{model_jobs::process_model_next, queue::JobQueue};
    let directory = scratch();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (state, _app, run, _project) = fixture_for_provider(directory.path(), addr, true).await;
    let tools = weblabel_api::runtime::agent_tools::router(
        state.repository.clone(),
        state.run_tokens.clone(),
        state.auth.clone(),
    );
    let server = tokio::spawn(async move { axum::serve(listener, tools).await.unwrap() });
    let runner = EchoRunner {
        repository: state.repository.clone(),
        tokens: state.run_tokens.clone(),
        addr,
    };
    let queue = JobQueue::new(state.repository.clone());
    assert!(process_model_next(
        &state.repository,
        &queue,
        "r04-echo-worker",
        Duration::from_secs(30),
        &runner
    )
    .await
    .unwrap()
    .is_some());
    assert_candidate_counts(&state.repository, &run, 3).await;
    let mut tx = state.repository.begin_write().await.unwrap();
    let status: String = sqlx::query_scalar("SELECT state FROM model_runs WHERE run_id=?")
        .bind(&run)
        .fetch_one(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(status, "succeeded");
    server.abort();
}

struct RevokedPublicationRunner {
    repository: weblabel_api::storage::Repository,
    tokens: weblabel_api::runtime::run_tokens::RunTokenStore,
    mode: &'static str,
}
impl RunRunner for RevokedPublicationRunner {
    fn execute<'a>(
        &'a self,
        driver: &'a RunDriver,
    ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, RunnerError>> + Send + 'a>> {
        Box::pin(async move {
            use weblabel_api::{
                ai::predictions::SubmitCandidates, runtime::agent_tools::claude_candidate_event_id,
            };
            assert_eq!(
                driver.profile().provider_id,
                annotation_domain::ProviderId::ClaudeLocal
            );
            let token = self.tokens.issue(
                driver.run_id(),
                &driver.context().project_id,
                Duration::from_secs(60),
            );
            let candidate = |id: &str| {
                json!({"changes":[],"issues":[{"issue_id":id,"object_id":null,"code":"suspected_missing_box",
                "message":"Synthetic queued terminal candidate","region":{"type":"bbox_xyxy","x_min":1,"y_min":1,"x_max":4,"y_max":4}}]})
            };
            let before = if self.mode == "between-batches" {
                let raw = candidate("issue_before_revoke");
                driver
                    .submit_candidates(
                        SubmitCandidates {
                            provider_event_id: claude_candidate_event_id(&raw).unwrap(),
                            provider_seq: None,
                            raw,
                        },
                        Some((&self.tokens, &token)),
                    )
                    .await?;
                1
            } else {
                0
            };
            let mut barrier = self.repository.begin_write().await.unwrap();
            let running: String = sqlx::query_scalar("SELECT state FROM model_runs WHERE run_id=?")
                .bind(driver.run_id())
                .fetch_one(barrier.connection())
                .await
                .unwrap();
            assert_eq!(running,"running","This regression must leave DB authorization live, not hide memory revocation behind DB cancellation");
            let raw = candidate("issue_after_revoke");
            let mut submission = Box::pin(driver.submit_candidates(
                SubmitCandidates {
                    provider_event_id: claude_candidate_event_id(&raw).unwrap(),
                    provider_seq: None,
                    raw,
                },
                Some((&self.tokens, &token)),
            ));
            // Repository clones share the existing FIFO writer semaphore.
            // Poll exactly once while its only permit is held; no production
            // hook, fake completion, sleep, or DB-backed cancellation is used.
            std::future::poll_fn(|cx| {
                assert!(
                    submission.as_mut().poll(cx).is_pending(),
                    "candidate must queue behind the held writer"
                );
                std::task::Poll::Ready(())
            })
            .await;
            if self.mode == "shutdown" {
                self.tokens.revoke_all();
            } else {
                self.tokens.revoke_run(driver.run_id());
            }
            assert!(self.tokens.verify(&token).is_err());
            if self.mode == "terminal" {
                // Separate preservation control: once DB settlement is terminal,
                // trusted claimed output must still enter the quarantine funnel
                // even though the original public bearer is no longer valid.
                sqlx::query("UPDATE model_runs SET state='cancelled',cancel_requested=1,finished_at=? WHERE run_id=?")
                    .bind(chrono::Utc::now().to_rfc3339()).bind(driver.run_id()).execute(barrier.connection()).await.unwrap();
                barrier.commit().await.unwrap();
                submission
                    .await
                    .expect("terminal trusted output must remain quarantinable");
                let mut tx = self.repository.begin_write().await.unwrap();
                let predictions: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM predictions WHERE run_id=?")
                        .bind(driver.run_id())
                        .fetch_one(tx.connection())
                        .await
                        .unwrap();
                let suggestions: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM suggestion_sets WHERE run_id=?")
                        .bind(driver.run_id())
                        .fetch_one(tx.connection())
                        .await
                        .unwrap();
                let audit: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM prediction_audit WHERE run_id=?")
                        .bind(driver.run_id())
                        .fetch_one(tx.connection())
                        .await
                        .unwrap();
                let receipts: Vec<String> = sqlx::query_scalar(
                    "SELECT data_json FROM run_events WHERE run_id=? AND event_type='candidate'",
                )
                .bind(driver.run_id())
                .fetch_all(tx.connection())
                .await
                .unwrap();
                tx.commit().await.unwrap();
                assert_eq!(predictions, 0);
                assert_eq!(suggestions, 0);
                assert_eq!(audit, 1);
                assert_eq!(receipts.len(), 1);
                let receipt: Value = serde_json::from_str(&receipts[0]).unwrap();
                assert_eq!(receipt["quarantined"], true);
                return Ok(RunOutcome::Completed);
            }
            barrier.rollback().await.unwrap();
            let error=submission.await.expect_err("queued native candidate must not commit after original in-memory capability revocation");
            assert!(
                error.to_string().contains("RUN_TOKEN_"),
                "expected a controlled original-capability error, got {error}"
            );
            let mut tx = self.repository.begin_write().await.unwrap();
            let still_running: String =
                sqlx::query_scalar("SELECT state FROM model_runs WHERE run_id=?")
                    .bind(driver.run_id())
                    .fetch_one(tx.connection())
                    .await
                    .unwrap();
            let audit: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM prediction_audit WHERE run_id=?")
                    .bind(driver.run_id())
                    .fetch_one(tx.connection())
                    .await
                    .unwrap();
            tx.commit().await.unwrap();
            assert_eq!(
                still_running, "running",
                "Only the memory capability was revoked before publication"
            );
            assert_eq!(audit,0,"a still-running revoked-capability submission must fail, not become terminal quarantine");
            assert_candidate_counts(&self.repository, driver.run_id(), before).await;
            Err(error.into())
        })
    }
}

#[tokio::test]
async fn original_capability_revocation_fences_queued_native_terminal_publication() {
    use weblabel_api::jobs::{model_jobs::process_model_next, queue::JobQueue};
    for mode in ["revoke", "shutdown", "between-batches"] {
        let directory = scratch();
        let (state, _app, run, _project) =
            fixture_for_provider(directory.path(), "127.0.0.1:1".parse().unwrap(), true).await;
        let queue = JobQueue::new(state.repository.clone());
        let runner = RevokedPublicationRunner {
            repository: state.repository.clone(),
            tokens: state.run_tokens.clone(),
            mode,
        };
        assert!(process_model_next(
            &state.repository,
            &queue,
            "r04-revoked-publication-worker",
            Duration::from_secs(30),
            &runner
        )
        .await
        .unwrap()
        .is_some());
        assert_candidate_counts(
            &state.repository,
            &run,
            if mode == "between-batches" { 1 } else { 0 },
        )
        .await;
        let mut tx = state.repository.begin_write().await.unwrap();
        let status: String = sqlx::query_scalar("SELECT state FROM model_runs WHERE run_id=?")
            .bind(&run)
            .fetch_one(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            status, "failed",
            "revoked terminal publication cannot report successful native completion"
        );
    }
}

#[tokio::test]
async fn revoked_original_capability_preserves_trusted_terminal_quarantine_without_pending_output()
{
    use weblabel_api::jobs::{model_jobs::process_model_next, queue::JobQueue};
    let directory = scratch();
    let (state, _app, run, _project) =
        fixture_for_provider(directory.path(), "127.0.0.1:1".parse().unwrap(), true).await;
    let queue = JobQueue::new(state.repository.clone());
    let runner = RevokedPublicationRunner {
        repository: state.repository.clone(),
        tokens: state.run_tokens.clone(),
        mode: "terminal",
    };
    assert!(process_model_next(
        &state.repository,
        &queue,
        "r04-terminal-quarantine-worker",
        Duration::from_secs(30),
        &runner
    )
    .await
    .unwrap()
    .is_some());
    let mut tx = state.repository.begin_write().await.unwrap();
    let status: String = sqlx::query_scalar("SELECT state FROM model_runs WHERE run_id=?")
        .bind(&run)
        .fetch_one(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(status, "cancelled");
}
