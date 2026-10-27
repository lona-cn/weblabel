//! Synthetic loopback protocol evidence, never a live provider/account claim.
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{watch, Mutex},
    time::Instant,
};
use weblabel_api::runtime::providers::http::{HttpClient, Kind, Limits, Turn};

async fn server(
    status: u16,
    body: Vec<u8>,
    fragment: usize,
    delay: Duration,
) -> (
    Value,
    Arc<AtomicUsize>,
    Arc<Mutex<Vec<u8>>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let c = calls.clone();
    let s = seen.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            c.fetch_add(1, Ordering::SeqCst);
            let body = body.clone();
            let s = s.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let length = headers
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|s| s.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                *s.lock().await = bytes;
                tokio::time::sleep(delay).await;
                let header=format!("HTTP/1.1 {status} Synthetic\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nLocation: /steal\r\nConnection: close\r\n\r\n",body.len());
                if socket.write_all(header.as_bytes()).await.is_err() {
                    return;
                }
                for part in body.chunks(fragment.max(1)) {
                    if socket.write_all(part).await.is_err() {
                        return;
                    }
                    tokio::task::yield_now().await;
                }
            });
        }
    });
    (
        json!({"profile_id":"synthetic","model_id":"synthetic-model","api_base":base,"local_admins":["synthetic-admin"],"base_approval":{"approved":true,"approved_by":"synthetic-admin","approved_at":"2026-10-25T00:00:00Z","allow_private_network":true,"allow_insecure_http":true}}),
        calls,
        seen,
        task,
    )
}
async fn post(
    kind: Kind,
    config: &Value,
    limits: Limits,
    deadline: Instant,
    cancel: &watch::Receiver<bool>,
    turn: &mut Turn,
) -> Result<(), weblabel_api::runtime::providers::http::HttpError> {
    HttpClient::new()
        .unwrap()
        .post(
            kind,
            config,
            "synthetic-secret",
            &json!({"model":"synthetic-model","stream":true}),
            limits,
            deadline,
            cancel,
            turn,
        )
        .await
}
fn wire(kind: Kind) -> String {
    match kind {
        Kind::OpenAi => encode_responses(response_text_events("中文")),
        Kind::Anthropic => concat!("event: message_start\r\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"r1\",\"model\":\"synthetic-model\",\"usage\":{\"input_tokens\":5}}}\r\n\r\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\r\n\r\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"中文\"}}\r\n\r\n",
        "data: {\"type\":\"content_block_stop\",\"index\":0}\r\n\r\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\r\n\r\n",
        "data: {\"type\":\"message_stop\"}\r\n\r\n").into(),
        Kind::Mimo => concat!("data: {\"id\":\"r1\",\"model\":\"synthetic-model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"中文\"},\"finish_reason\":null}],\"usage\":null}\r\n\r\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\r\n\r\ndata: [DONE]\r\n\r\n").into()
    }
}
#[tokio::test]
async fn all_three_protocols_decode_one_byte_utf8_crlf_and_cumulative_usage_once() {
    for kind in [Kind::OpenAi, Kind::Anthropic, Kind::Mimo] {
        let (config, calls, seen, task) =
            server(200, wire(kind).into_bytes(), 1, Duration::ZERO).await;
        let (_tx, rx) = watch::channel(false);
        let mut turn = Turn::new(kind);
        post(
            kind,
            &config,
            Limits::default(),
            Instant::now() + Duration::from_secs(5),
            &rx,
            &mut turn,
        )
        .await
        .unwrap();
        assert_eq!(turn.text, "中文");
        assert_eq!(turn.usage.input_tokens, Some(5));
        assert_eq!(turn.usage.output_tokens, Some(2));
        assert_eq!(turn.response_id.as_deref(), Some("r1"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let request = String::from_utf8(seen.lock().await.clone())
            .unwrap()
            .to_ascii_lowercase();
        assert!(request.starts_with(&format!("post {} ", kind.path())));
        assert!(request.contains(if kind == Kind::Anthropic {
            "x-api-key: synthetic-secret"
        } else {
            "authorization: bearer synthetic-secret"
        }));
        task.abort();
    }
}
#[tokio::test]
async fn status_failures_are_distinct_secret_free_and_never_retried() {
    for (status, code) in [
        (401, "unauthorized_401"),
        (403, "forbidden_403"),
        (429, "rate_limited_429"),
        (500, "upstream_5xx"),
        (307, "redirect_rejected"),
    ] {
        let (config, calls, _, task) =
            server(status, b"synthetic-secret".to_vec(), 1, Duration::ZERO).await;
        let (_tx, rx) = watch::channel(false);
        let mut turn = Turn::new(Kind::OpenAi);
        let error = post(
            Kind::OpenAi,
            &config,
            Limits::default(),
            Instant::now() + Duration::from_secs(2),
            &rx,
            &mut turn,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, code);
        assert!(!format!("{error:?}").contains("synthetic-secret"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        task.abort();
    }
}
#[tokio::test]
async fn timeout_cancellation_and_late_terminal_never_resend() {
    for cancelled in [false, true] {
        let (config, calls, _, task) = server(
            200,
            wire(Kind::OpenAi).into_bytes(),
            1,
            Duration::from_secs(1),
        )
        .await;
        let (tx, rx) = watch::channel(false);
        let mut turn = Turn::new(Kind::OpenAi);
        let cancel = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            if cancelled {
                tx.send(true).unwrap();
            } else {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
        let error = post(
            Kind::OpenAi,
            &config,
            Limits::default(),
            Instant::now() + Duration::from_millis(80),
            &rx,
            &mut turn,
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.code,
            if cancelled {
                "RUN_CANCELLED"
            } else {
                "timeout"
            }
        );
        assert!(turn.calls.is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        task.abort();
        cancel.abort();
    }
}
#[tokio::test]
async fn missing_terminal_and_truncated_frame_have_independent_codes() {
    for (body, code) in [
        ("data: {}\n\n", "missing_terminal"),
        ("data: {}\n", "interrupted_stream"),
    ] {
        let (config, _, _, task) = server(200, body.as_bytes().to_vec(), 1, Duration::ZERO).await;
        let (_tx, rx) = watch::channel(false);
        let mut turn = Turn::new(Kind::OpenAi);
        assert_eq!(
            post(
                Kind::OpenAi,
                &config,
                Limits::default(),
                Instant::now() + Duration::from_secs(2),
                &rx,
                &mut turn
            )
            .await
            .unwrap_err()
            .code,
            code
        );
        task.abort();
    }
}
#[tokio::test]
async fn frame_and_stream_limits_stop_while_reading() {
    for (limits, code) in [
        (
            Limits {
                max_frame_bytes: 16,
                ..Limits::default()
            },
            "oversized_frame",
        ),
        (
            Limits {
                max_stream_bytes: 16,
                ..Limits::default()
            },
            "oversized_response",
        ),
    ] {
        let (config, calls, _, task) = server(
            200,
            b"data: "
                .iter()
                .copied()
                .chain(std::iter::repeat(b'x').take(100))
                .collect(),
            1,
            Duration::ZERO,
        )
        .await;
        let (_tx, rx) = watch::channel(false);
        let mut turn = Turn::new(Kind::OpenAi);
        assert_eq!(
            post(
                Kind::OpenAi,
                &config,
                limits,
                Instant::now() + Duration::from_secs(2),
                &rx,
                &mut turn
            )
            .await
            .unwrap_err()
            .code,
            code
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        task.abort();
    }
}
#[tokio::test]
async fn multiple_data_lines_form_one_json_event() {
    let created = json!({"type":"response.created","response":{"id":"multi","model":"synthetic-model","status":"in_progress","output":[]}});
    let terminal=json!({"type":"response.completed","sequence_number":1,"response":{"id":"multi","model":"synthetic-model","status":"completed","output":[]}}).to_string();
    let split = terminal.find(",\"type\"").unwrap() + 1;
    let body = format!(
        "{}data: {}\ndata: {}\n\n",
        encode_responses(vec![created]),
        &terminal[..split],
        &terminal[split..]
    );
    let (config, _, _, task) = server(200, body.as_bytes().to_vec(), 1, Duration::ZERO).await;
    let (_tx, rx) = watch::channel(false);
    let mut turn = Turn::new(Kind::OpenAi);
    post(
        Kind::OpenAi,
        &config,
        Limits::default(),
        Instant::now() + Duration::from_secs(2),
        &rx,
        &mut turn,
    )
    .await
    .unwrap();
    assert_eq!(turn.usage.input_tokens, None);
    task.abort();
}
#[test]
fn duplicate_and_out_of_order_tool_calls_are_rejected_before_execution() {
    let mut turn = Turn::new(Kind::OpenAi);
    assert_eq!(
        turn.frame(
            None,
            r#"{"type":"response.function_call_arguments.delta","item_id":"unknown","delta":"{}"}"#
        )
        .unwrap_err()
        .code,
        "stream_order_invalid"
    );
    let mut turn = Turn::new(Kind::OpenAi);
    turn.frame(None,&json!({"type":"response.created","sequence_number":0,"response":{"id":"duplicate","model":"synthetic-model","status":"in_progress","output":[]}}).to_string()).unwrap();
    let mut item = json!({"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"type":"function_call","id":"i","call_id":"c","name":"propose_changes","arguments":"","status":"in_progress"}});
    turn.frame(None, &item.to_string()).unwrap();
    item["sequence_number"] = json!(2);
    assert_eq!(
        turn.frame(None, &item.to_string()).unwrap_err().code,
        "duplicate_tool_call"
    );
}
#[test]
fn distinct_request_bodies_share_only_authoritative_tool_schema() {
    use weblabel_api::runtime::providers::{anthropic, mimo, openai};
    let config = json!({"model_id":"synthetic-model"});
    let history = vec![json!({"role":"user","content":[]})];
    let a = openai::request(&config, &history, 2048);
    let b = anthropic::request(&config, &history, 2048);
    let c = mimo::request(&config, &history, 2048);
    assert!(a.get("instructions").is_some());
    assert!(a.get("input").is_some());
    assert!(a.get("messages").is_none());
    assert_eq!(a["store"], false);
    assert!(b.get("system").is_some());
    assert!(b["tools"][0].get("input_schema").is_some());
    assert_eq!(b["max_tokens"], 2048);
    assert!(c["tools"][0].get("function").is_some());
    assert_eq!(c["max_completion_tokens"], 2048);
    assert_eq!(c["thinking"]["type"], "disabled");
    assert_eq!(a["tools"].as_array().unwrap().len(), 5);
    assert_eq!(b["tools"].as_array().unwrap().len(), 5);
    assert_eq!(c["tools"].as_array().unwrap().len(), 5);
    fn closed(schema: &Value) {
        if schema["type"] == "object" {
            assert_eq!(schema["additionalProperties"], false);
            let properties = schema["properties"].as_object().unwrap();
            let required = schema["required"].as_array().unwrap();
            assert_eq!(properties.len(), required.len());
            for key in properties.keys() {
                assert!(required.iter().any(|v| v.as_str() == Some(key)));
            }
        }
        assert!(schema.get("$ref").is_none());
        assert!(schema.get("oneOf").is_none());
        match schema {
            Value::Object(map) => {
                for child in map.values() {
                    closed(child)
                }
            }
            Value::Array(items) => {
                for child in items {
                    closed(child)
                }
            }
            _ => {}
        }
    }
    for tool in a["tools"].as_array().unwrap() {
        assert_eq!(tool["strict"], true);
        closed(&tool["parameters"]);
    }
}
#[test]
fn unapproved_and_credential_bearing_destinations_fail_closed() {
    use weblabel_api::runtime::providers::http::resolve_base;
    for base in [
        "https://proxy.example/v1",
        "http://127.0.0.1:9",
        "https://user:password@api.openai.com/v1",
        "https://api.openai.com/v1?q=x",
    ] {
        assert!(resolve_base(Kind::OpenAi, &json!({"api_base":base})).is_err());
    }
}

// Use a subprocess solely to set a synthetic environment credential without
// mutating this parallel test process's environment. This is the Cargo consumer
// executable, not a substitute for Main's separate real-product smoke.
#[test]
fn native_http_consumer_matrix() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "native_http_subprocess", "--nocapture"])
        .env("R03_SYNTHETIC_CONSUMER", "1")
        .env(
            "R03_SYNTHETIC_API_KEY",
            "synthetic-r03-credential-never-real",
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_http_subprocess() {
    if std::env::var("R03_SYNTHETIC_CONSUMER").as_deref() != Ok("1") {
        return;
    }
    for kind in [Kind::OpenAi, Kind::Anthropic, Kind::Mimo] {
        for scenario in [
            "success",
            "cancel",
            "timeout",
            "config_changed",
            "expired",
            "secret_denied",
            "policy_revoke",
            "token_revoke",
            "duplicate",
            "turn_budget",
            "byte_budget",
            "time_budget",
            "image_budget",
            "invalid_tool",
            "text_candidate",
            "unknown_usage",
            "crop_only",
        ] {
            native_scenario(kind, scenario).await;
        }
    }
}
fn candidate(id: &str) -> Value {
    json!({"changes":[],"issues":[{"issue_id":id,"object_id":null,"code":"synthetic_review","message":"Synthetic engineering fixture","region":null}],"score":null})
}
fn tool_wire(kind: Kind, number: usize, calls: &[(&str, &str, Value)]) -> String {
    let mut frames = Vec::new();
    let usage = json!({"input_tokens":5,"output_tokens":2});
    match kind {
        Kind::OpenAi => {
            let mut output = Vec::new();
            frames.push(json!({"type":"response.created","response":{"id":format!("r{number}"),"model":"synthetic-model","status":"in_progress","output":[],"usage":usage}}));
            for (index, (id, name, args)) in calls.iter().enumerate() {
                let item = format!("i{index}");
                frames.push(json!({"type":"response.output_item.added","output_index":index,"item":{"type":"function_call","id":item,"call_id":id,"name":name,"arguments":"","status":"in_progress"}}));
                let arguments = args.to_string();
                let split = arguments
                    .char_indices()
                    .nth(arguments.chars().count() / 2)
                    .map(|(index, _)| index)
                    .unwrap_or(0);
                for partial in [&arguments[..split], &arguments[split..]] {
                    frames.push(json!({"type":"response.function_call_arguments.delta","output_index":index,"item_id":item,"delta":partial}));
                }
                frames.push(json!({"type":"response.function_call_arguments.done","output_index":index,"item_id":item,"arguments":args.to_string()}));
                let completed = json!({"type":"function_call","id":item,"call_id":id,"name":name,"arguments":args.to_string(),"status":"completed"});
                frames.push(json!({"type":"response.output_item.done","output_index":index,"item":completed}));
                output.push(completed);
            }
            frames.push(json!({"type":"response.completed","response":{"id":format!("r{number}"),"model":"synthetic-model","status":"completed","output":output,"usage":usage}}));
            return encode_responses(frames);
        }
        Kind::Anthropic => {
            frames.push(json!({"type":"message_start","message":{"id":format!("r{number}"),"model":"synthetic-model","usage":{"input_tokens":5,"output_tokens":0}}}));
            for (index, (id, name, args)) in calls.iter().enumerate() {
                frames.push(json!({"type":"content_block_start","index":index,"content_block":{"type":"tool_use","id":id,"name":name,"input":{}}}));
                if *name != "get_context" {
                    let arguments = args.to_string();
                    let split = arguments
                        .char_indices()
                        .nth(arguments.chars().count() / 2)
                        .map(|(index, _)| index)
                        .unwrap_or(0);
                    for partial in [&arguments[..split], &arguments[split..]] {
                        frames.push(json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":partial}}));
                    }
                }
                frames.push(json!({"type":"content_block_stop","index":index}));
            }
            frames.push(json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}));
            frames.push(json!({"type":"message_delta","delta":{},"usage":{"output_tokens":2}}));
            frames.push(json!({"type":"message_stop"}));
        }
        Kind::Mimo => {
            let mut initial = Vec::new();
            let mut deltas = Vec::new();
            for (index, (id, name, args)) in calls.iter().enumerate() {
                let arguments = args.to_string();
                let split = arguments
                    .char_indices()
                    .nth(arguments.chars().count() / 2)
                    .map(|(index, _)| index)
                    .unwrap_or(0);
                initial.push(json!({"index":index,"id":id,"type":"function","function":{"name":name,"arguments":&arguments[..split]}}));
                deltas.push(json!({"index":index,"function":{"arguments":&arguments[split..]}}));
            }
            frames.push(json!({"id":format!("r{number}"),"model":"synthetic-model","choices":[{"index":0,"delta":{"tool_calls":initial},"finish_reason":null}],"usage":{"prompt_tokens":5,"completion_tokens":0}}));
            frames.push(json!({"choices":[{"index":0,"delta":{"tool_calls":deltas},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}));
        }
    }
    let mut result = frames
        .into_iter()
        .map(|v| format!("data: {v}\n\n"))
        .collect::<String>();
    if kind == Kind::Mimo {
        result.push_str("data: [DONE]\n\n");
    }
    result
}
async fn api(
    app: &axum::Router,
    path: &str,
    body: Value,
    cookie: Option<&str>,
    csrf: Option<&str>,
) -> (axum::http::StatusCode, Value, Option<String>) {
    api_method(
        app,
        if path.ends_with("external-processing-policy") {
            "PUT"
        } else {
            "POST"
        },
        path,
        body,
        cookie,
        csrf,
    )
    .await
}
async fn api_method(
    app: &axum::Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: Option<&str>,
    csrf: Option<&str>,
) -> (axum::http::StatusCode, Value, Option<String>) {
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use tower::ServiceExt;
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "127.0.0.1:48303")
        .header("origin", "http://127.0.0.1:48303")
        .header("content-type", "application/json");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    if let Some(csrf) = csrf {
        request = request.header("x-csrf-token", csrf);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_owned());
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap(), cookie)
}
async fn native_scenario(kind: Kind, scenario: &str) {
    use axum::{http::StatusCode, routing::post, Router};
    use weblabel_api::{
        auth::{hash_launch_code, AuthConfig},
        config::ServerConfig,
        jobs::{model_jobs::process_model_next, queue::JobQueue},
        router,
        runtime::{
            agent_tools::AgentToolService, config::RuntimeConfig, providers::http::HttpRunner,
        },
        AppState,
    };
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/test-artifacts/R03");
    std::fs::create_dir_all(&root).unwrap();
    let temp = tempfile::tempdir_in(root).unwrap();
    let config = ServerConfig {
        bind: "127.0.0.1:48303".parse().unwrap(),
        database_url: format!("sqlite:{}", temp.path().join("r03.sqlite").display()),
        object_root: temp.path().join("objects"),
        write_timeout: Duration::from_secs(2),
        production: true,
    };
    let state = AppState::open_with_auth(
        &config,
        AuthConfig {
            bind: config.bind,
            cookie_secure: false,
            allowed_hosts: vec!["127.0.0.1:48303".into()],
            allowed_origins: vec!["http://127.0.0.1:48303".into()],
            launch_code: hash_launch_code("synthetic-launch"),
            launch_code_expires_at: chrono::Utc::now().timestamp() + 3600,
        },
    )
    .await
    .unwrap();
    let app = router(state.clone());
    let (status, login, cookie) = api(
        &app,
        "/api/session/bootstrap",
        json!({"launch_code":"synthetic-launch","password":"synthetic-r03-password"}),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{login}");
    let cookie = cookie.unwrap();
    let csrf = login["csrf_token"].as_str().unwrap();
    let actor = login["user_id"].as_str().unwrap();
    let (status, project, _) = api(
        &app,
        "/api/projects",
        json!({"name":"Synthetic R03","description":"No business data","allow_self_review":false}),
        Some(&cookie),
        Some(csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{project}");
    let project = project["project_id"].as_str().unwrap();
    let domain_case = matches!(
        scenario,
        "audit_attributes" | "audit_stale" | "detect_create" | "detect_scope_violation"
    );
    let attributes = if domain_case {
        json!([
            {"key":"state","kind":"enum","required":true,"default_value":"old","enum_values":["old","new"],"min":null,"max":null},
            {"key":"note","kind":"text","required":false,"default_value":"","enum_values":[],"min":null,"max":null},
            {"key":"count","kind":"number","required":false,"default_value":0,"enum_values":[],"min":0,"max":10}
        ])
    } else {
        json!([])
    };
    let (status,ontology,_)=api(&app,&format!("/api/projects/{project}/ontologies"),json!({"labels":[{"label_id":"fixture-label","name":"Fixture","color":"#33AA66","shortcut":null,"allowed_geometry_types":["bbox_xyxy"],"attributes":attributes}],"guidelines_markdown":"Synthetic only"}),Some(&cookie),Some(csrf)).await;
    assert_eq!(status, StatusCode::CREATED, "{ontology}");
    let ontology = ontology["ontology_version_id"].as_str().unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image::RgbImage::new(32, 24))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let asset = weblabel_api::media::ingest::import_one(
        &state.repository,
        &weblabel_api::jobs::worker::MediaWorker::new(),
        weblabel_api::media::ingest::ImportInput {
            project_id: project.into(),
            ontology_version_id: ontology.into(),
            actor_id: actor.into(),
            source_group_id: "synthetic-source".into(),
            original_name: "synthetic.png".into(),
            declared_mime: Some("image/png".into()),
            bytes: png.into_inner(),
        },
    )
    .await
    .unwrap();
    let mut object_hashes = serde_json::Map::new();
    let mut selected = Vec::new();
    if domain_case {
        let mut tx = state.repository.begin_write().await.unwrap();
        let body: String = sqlx::query_scalar(
            "SELECT body_json FROM annotation_revisions WHERE annotation_revision_id=?",
        )
        .bind(&asset.annotation_revision_id)
        .fetch_one(tx.connection())
        .await
        .unwrap();
        let mut document: annotation_domain::AnnotationDocument =
            serde_json::from_str(&body).unwrap();
        for index in 0..101 {
            let id = format!("object-{index:03}");
            let object:annotation_domain::AnnotationObject=serde_json::from_value(json!({"object_id":id,"label_id":"fixture-label","geometry":{"type":"bbox_xyxy","x_min":4,"y_min":4,"x_max":20,"y_max":20},"attributes":{"state":"old","note":"keep","count":2},"origin":{"type":"manual","prediction_id":null,"model_run_id":null,"import_batch_id":null}})).unwrap();
            object_hashes.insert(id.clone(), json!(annotation_domain::object_hash(&object)));
            selected.push(id);
            document.objects.push(object);
        }
        let serialized = annotation_domain::hash::serialize_document(&document).unwrap();
        sqlx::query("UPDATE annotation_revisions SET body_json=?,content_hash=? WHERE annotation_revision_id=?").bind(serialized.json).bind(serialized.content_hash).bind(&asset.annotation_revision_id).execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
    }
    let proposal = if matches!(scenario, "audit_attributes" | "audit_stale") {
        let before = if scenario == "audit_stale" {
            json!("f".repeat(64))
        } else {
            object_hashes["object-100"].clone()
        };
        let values = if kind == Kind::OpenAi {
            json!({"state":"new","note":null,"count":null})
        } else {
            json!({"state":"new"})
        };
        json!({"changes":[{"kind":"set_attributes","change_id":"audit-change","object_id":"object-100","values":values,"before_hash":before,"reason":"Synthetic attribute audit"}],"issues":[],"score":null})
    } else if matches!(scenario, "detect_create" | "detect_scope_violation") {
        let geometry = if scenario == "detect_scope_violation" {
            json!({"type":"bbox_xyxy","x_min":21,"y_min":5,"x_max":25,"y_max":15})
        } else {
            json!({"type":"bbox_xyxy","x_min":5,"y_min":6,"x_max":15,"y_max":16})
        };
        let attributes = if kind == Kind::OpenAi {
            json!({"state":"new","note":null,"count":null})
        } else {
            json!({"state":"new"})
        };
        json!({"changes":[{"kind":"create","change_id":"detect-change","object":{"object_id":"candidate-new","label_id":"fixture-label","geometry":geometry,"attributes":attributes,"origin":{"type":"manual","prediction_id":null,"model_run_id":null,"import_batch_id":null}},"before_hash":null,"reason":"Synthetic detection"}],"issues":[],"score":null})
    } else {
        candidate("synthetic-issue")
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let release = Arc::new(tokio::sync::Notify::new());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let counter = calls.clone();
    let recorded = bodies.clone();
    let late = release.clone();
    let delayed = matches!(
        scenario,
        "cancel"
            | "cancel_first_receipt"
            | "policy_revoke"
            | "token_revoke"
            | "timeout"
            | "time_budget"
            | "numeric_timeout_float"
    );
    let mode = scenario.to_owned();
    let model_proposal = proposal.clone();
    let model = Router::new().route(
        kind.path(),
        post(move |axum::Json(body): axum::Json<Value>| {
            let counter = counter.clone();
            let recorded = recorded.clone();
            let late = late.clone();
            let mode = mode.clone();
            let proposal = model_proposal.clone();
            async move {
                let n = counter.fetch_add(1, Ordering::SeqCst);
                recorded.lock().await.push(body);
                if delayed || (n == 1 && mode == "second_headers_timeout") {
                    late.notified().await;
                }
                let mut status = StatusCode::OK;
                let mut body =
                    if n == 1 && matches!(mode.as_str(), "second_429" | "numeric_response_float") {
                        status = StatusCode::TOO_MANY_REQUESTS;
                        "x".repeat(64)
                    } else if mode == "observed_failure" {
                        observed_failure_wire(kind)
                    } else if mode == "duplicate" {
                        tool_wire(
                            kind,
                            n,
                            &[
                                ("dup-a", "propose_changes", candidate("same")),
                                ("dup-b", "propose_changes", candidate("same")),
                            ],
                        )
                    } else if mode == "text_candidate" {
                        wire(kind).replace(
                            "\"中文\"",
                            &serde_json::to_string(&candidate("text-issue").to_string()).unwrap(),
                        )
                    } else if mode == "invalid_tool" {
                        tool_wire(
                            kind,
                            n,
                            &[("forbidden", "shell", json!({"command":"not-executed"}))],
                        )
                    } else if n == 0 {
                        tool_wire(kind, n, &inspection_calls())
                    } else {
                        tool_wire(kind, n, &[("proposal", "propose_changes", proposal)])
                    };
                let unknown_usage =
                    mode == "unknown_usage" || (mode == "second_success_missing_usage" && n == 1);
                if unknown_usage {
                    body = body
                        .lines()
                        .map(|line| {
                            let Some(data) = line.strip_prefix("data: ").filter(|s| *s != "[DONE]")
                            else {
                                return format!("{line}\n");
                            };
                            let mut value: Value = serde_json::from_str(data).unwrap();
                            if let Some(map) = value.as_object_mut() {
                                map.remove("usage");
                            }
                            for field in ["message", "response"] {
                                if let Some(map) =
                                    value.get_mut(field).and_then(Value::as_object_mut)
                                {
                                    map.remove("usage");
                                }
                            }
                            format!("data: {value}\n")
                        })
                        .collect();
                }
                if mode == "framing_budget" {
                    body = format!(":{}\r\n\r\n{body}", "padding".repeat(600));
                }
                if mode == "model_mismatch" {
                    body = body.replace("synthetic-model", "different-model");
                }
                if kind == Kind::OpenAi && mode.starts_with("response_") && n == 0 {
                    body = mutate_response_wire(&body, &mode);
                }
                (status, [("content-type", "text/event-stream")], body)
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, model).await.unwrap();
    });
    let capabilities = json!({"image_input":true,"tools":true,"structured_output":true,"bbox_output":true,"attributes":true});
    let mut execution = json!({"profile_id":"synthetic","model_id":"synthetic-model","credential":{"secret_ref":"env:R03_SYNTHETIC_API_KEY"},"account_model_verified":true,"capabilities":capabilities,"api_base":base,"base_approval":{"approved":true,"approved_by":"fixture-admin","approved_at":"2026-10-25T00:00:00Z","allow_private_network":true,"allow_insecure_http":true},"local_admins":["fixture-admin"],"pricing":{"input_per_million_usd":2,"output_per_million_usd":8}});
    match scenario {
        "turn_budget" => execution["budgets"] = json!({"max_tool_turns":1}),
        "byte_budget" => execution["budgets"] = json!({"max_total_bytes":64}),
        "time_budget" => execution["budgets"] = json!({"max_run_ms":150}),
        "image_budget" => execution["budgets"] = json!({"max_pixels":1}),
        "numeric_turn_zero" => execution["budgets"] = json!({"max_tool_turns":0.0}),
        "numeric_image_one" => execution["budgets"] = json!({"max_pixels":1.0}),
        "numeric_output_one" => {
            execution["budgets"] =
                json!({"max_output_tokens":serde_json::from_str::<Value>("1e0").unwrap()})
        }
        "numeric_total_float" => {
            execution["budgets"] =
                json!({"max_total_bytes":serde_json::from_str::<Value>("1e1").unwrap()})
        }
        "numeric_timeout_float" => execution["timeout_ms"] = json!(100.0),
        "numeric_stream_float" => execution["max_stream_bytes"] = json!(16.0),
        "numeric_response_float" => execution["max_response_bytes"] = json!(16.0),
        "second_headers_timeout" => execution["timeout_ms"] = json!(150),
        "framing_budget" => {
            let data = sse_data_bytes(&tool_wire(kind, 0, &inspection_calls()))
                + sse_data_bytes(&tool_wire(
                    kind,
                    1,
                    &[("proposal", "propose_changes", proposal.clone())],
                ));
            execution["budgets"] = json!({"max_total_bytes":data});
        }
        _ => {}
    }
    let (status, policy, _) = api(
        &app,
        &format!("/api/projects/{project}/external-processing-policy"),
        json!({"allow_external_processing":true}),
        Some(&cookie),
        Some(csrf),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{policy}");
    let mut tx = state.repository.begin_write().await.unwrap();
    sqlx::query("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES('synthetic',?,'synthetic-model','api_key',?,'ready','not_run',NULL,NULL,?,'env:R03_SYNTHETIC_API_KEY','2026-10-25T00:00:00Z')").bind(kind.id()).bind(capabilities.to_string()).bind(execution.to_string()).execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    let intent = if scenario.starts_with("audit_") {
        "audit_attributes"
    } else if scenario.starts_with("detect_") {
        "detect"
    } else {
        "find_issues"
    };
    let request = json!({"operation_id":"synthetic-operation","profile_id":"synthetic","context":{"project_id":project,"asset_revision_id":asset.asset_revision_id,"annotation_revision_id":asset.annotation_revision_id,"ontology_version_id":ontology,"draft_generation":0,"canonical_sha256":asset.canonical_sha256,"selected_object_ids":selected,"object_hashes":object_hashes,"input_fingerprint":"untrusted"},"intent":intent,"prompt":"Synthetic review only","consent_id":null});
    let crop = if scenario == "crop_only" || scenario.starts_with("detect_") {
        json!({"type":"bbox_xyxy","x_min":4,"y_min":4,"x_max":20,"y_max":20})
    } else {
        Value::Null
    };
    let (status,preview,_)=api(&app,"/api/ai/previews",json!({"request":request,"grants":{"allow_image":true,"allow_object_context":domain_case,"preview_crop":crop}}),Some(&cookie),Some(csrf)).await;
    assert_eq!(status, StatusCode::CREATED, "{preview}");
    let (status, consent, _) = api(
        &app,
        "/api/ai/consents",
        json!({"preview_id":preview["preview_id"]}),
        Some(&cookie),
        Some(csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{consent}");
    let mut request = preview["request"].clone();
    request["consent_id"] = consent["consent_id"].clone();
    let (status, created, _) = api(&app, "/api/ai/runs", request, Some(&cookie), Some(csrf)).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let run = created["run_id"].as_str().unwrap();
    let checkpoint_failure = scenario.starts_with("checkpoint_");
    if checkpoint_failure {
        let mut tx = state.repository.begin_write().await.unwrap();
        sqlx::query("CREATE TABLE r03_observation_failure(run_id TEXT PRIMARY KEY, receipt_count INTEGER NOT NULL)").execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO r03_observation_failure VALUES(?,?)")
            .bind(run)
            .bind(if scenario == "checkpoint_next_failure" {
                2_i64
            } else {
                1_i64
            })
            .execute(tx.connection())
            .await
            .unwrap();
        sqlx::query("CREATE TRIGGER r03_abort_observation BEFORE INSERT ON run_events WHEN NEW.event_type='progress' AND NEW.message='provider observation checkpoint' AND EXISTS(SELECT 1 FROM r03_observation_failure f WHERE f.run_id=NEW.run_id AND f.receipt_count=json_array_length(NEW.data_json,'$.receipts')) BEGIN SELECT RAISE(ABORT,'synthetic observation INSERT failure'); END").execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
    }
    if scenario == "expired" {
        let mut tx = state.repository.begin_write().await.unwrap();
        sqlx::query("INSERT OR REPLACE INTO model_run_authorizations(run_id,preview_id,grants_json,profile_configuration_hash,capability_expires_at) SELECT run_id,preview_id,grants_json,profile_configuration_hash,'2020-01-01T00:00:00Z' FROM model_run_authorizations WHERE run_id=?").bind(run).execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
    }
    let mut actual = execution.clone();
    if scenario == "config_changed" {
        actual["budgets"] = json!({"max_tool_turns":1});
    }
    let envelope = json!({"schema_version":1,"timeout_ms":5000,"providers":[{"provider":kind.id(),"config":actual}]});
    let allowed = if scenario == "secret_denied" {
        vec![]
    } else {
        vec!["R03_SYNTHETIC_API_KEY".into()]
    };
    let runtime = RuntimeConfig::parse(&envelope.to_string(), &allowed).unwrap();
    if scenario == "native_profile_eligibility" {
        assert_eq!(kind, Kind::OpenAi);
        native_profile_metadata(&state, runtime, &execution, &cookie, csrf).await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "metadata/provisioning must not probe or execute a provider"
        );
        server.abort();
        state.repository.close().await;
        return;
    }
    let runner = HttpRunner::new(
        state.repository.clone(),
        Arc::new(runtime),
        state.run_tokens.clone(),
        Duration::from_millis(if scenario == "timeout" { 150 } else { 5000 }),
    )
    .unwrap();
    #[cfg(debug_assertions)]
    let dispatch_barrier = match scenario {
        "dispatch_revoke" => Some(Arc::new(
            weblabel_api::runtime::providers::http::HttpDispatchBarrier::default(),
        )),
        "checkpoint_cancel_race" => Some(Arc::new(
            weblabel_api::runtime::providers::http::HttpDispatchBarrier::after_admission(),
        )),
        _ => None,
    };
    #[cfg(debug_assertions)]
    let runner = if let Some(barrier) = &dispatch_barrier {
        runner.with_dispatch_barrier(barrier.clone())
    } else {
        runner
    };
    let queue = JobQueue::new(state.repository.clone());
    let cancel = async {
        #[cfg(debug_assertions)]
        if let Some(barrier) = &dispatch_barrier {
            tokio::time::timeout(Duration::from_secs(3), barrier.entered())
                .await
                .unwrap();
            if scenario == "checkpoint_cancel_race" {
                let cancellation = weblabel_api::ai::runs::cancel(
                    &state.repository,
                    &state.run_tokens,
                    run,
                    actor,
                    "synthetic checkpoint cancellation",
                );
                tokio::pin!(cancellation);
                std::future::poll_fn(|cx| {
                    assert!(
                        std::future::Future::poll(cancellation.as_mut(), cx).is_pending(),
                        "cancel must queue behind the held dispatch writer"
                    );
                    std::task::Poll::Ready(())
                })
                .await;
                barrier.release();
                cancellation.await.unwrap();
                let mut tx = state.repository.begin_write().await.unwrap();
                let terminal:String=sqlx::query_scalar("SELECT data_json FROM run_events WHERE run_id=? AND event_type='cancelled' ORDER BY seq LIMIT 1").bind(run).fetch_one(tx.connection()).await.unwrap();
                tx.commit().await.unwrap();
                let terminal: Value = serde_json::from_str(&terminal).unwrap();
                assert_unconfirmed_observation(&terminal);
                assert_eq!(terminal["error_code"], "RUN_CANCELLED");
                return;
            }
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert_eq!(state.run_tokens.revoke_run(run), 1);
            barrier.release();
            return;
        }
        if !matches!(
            scenario,
            "cancel" | "cancel_first_receipt" | "policy_revoke" | "token_revoke"
        ) {
            return;
        }
        let until = Instant::now() + Duration::from_secs(3);
        while calls.load(Ordering::SeqCst) == 0 {
            assert!(Instant::now() < until);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        if scenario == "cancel" || scenario == "cancel_first_receipt" {
            weblabel_api::ai::runs::cancel(
                &state.repository,
                &state.run_tokens,
                run,
                actor,
                "synthetic cancellation",
            )
            .await
            .unwrap();
            if scenario == "cancel_first_receipt" {
                let mut tx = state.repository.begin_write().await.unwrap();
                let terminal:String=sqlx::query_scalar("SELECT data_json FROM run_events WHERE run_id=? AND event_type='cancelled' ORDER BY seq LIMIT 1").bind(run).fetch_one(tx.connection()).await.unwrap();
                tx.commit().await.unwrap();
                let terminal: Value = serde_json::from_str(&terminal).unwrap();
                assert_eq!(terminal["receipts"].as_array().unwrap().len(), 1);
                assert_eq!(terminal["receipt"]["dispatch_phase"],"attempted","a received POST must already have a durable attempted receipt at first cancellation");
                assert!(terminal["receipt"]["actual_model_id"].is_null());
                assert!(terminal["receipt"]["response_id"].is_null());
                assert_eq!(terminal["error_code"], "RUN_CANCELLED");
                assert_eq!(terminal["cost_display"], "unknown");
                assert_eq!(
                    terminal["usage"],
                    json!({"input_tokens":null,"output_tokens":null,"cost_usd":null})
                );
            }
        } else if scenario == "token_revoke" {
            assert_eq!(state.run_tokens.revoke_run(run), 1);
        } else {
            let (status, body, _) = api(
                &app,
                &format!("/api/projects/{project}/external-processing-policy"),
                json!({"allow_external_processing":false}),
                Some(&cookie),
                Some(csrf),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
        }
    };
    let worker_started = Instant::now();
    let (result, _) = tokio::join!(
        process_model_next(
            &state.repository,
            &queue,
            "r03-worker",
            Duration::from_secs(30),
            &runner
        ),
        cancel
    );
    assert!(result.unwrap().is_some());
    if scenario == "numeric_timeout_float" {
        assert!(
            worker_started.elapsed() < Duration::from_secs(2),
            "100.0ms request budget must not fall back to the 5s run deadline"
        );
    }
    let review_case = matches!(
        scenario,
        "second_429"
            | "second_headers_timeout"
            | "observed_failure"
            | "model_mismatch"
            | "second_success_missing_usage"
            | "framing_budget"
            | "audit_attributes"
            | "audit_stale"
            | "detect_create"
            | "detect_scope_violation"
            | "cancel_first_receipt"
            | "dispatch_revoke"
    ) || scenario.starts_with("numeric_")
        || scenario.starts_with("response_")
        || matches!(
            scenario,
            "config_changed" | "expired" | "secret_denied" | "image_budget"
        );
    if review_case {
        let mut tx = state.repository.begin_write().await.unwrap();
        let terminal:Option<String>=sqlx::query_scalar("SELECT data_json FROM run_events WHERE run_id=? AND event_type IN ('succeeded','failed','cancelled') ORDER BY seq LIMIT 1").bind(run).fetch_one(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
        if calls.load(Ordering::SeqCst) > 0 {
            let terminal: Value =
                serde_json::from_str(terminal.as_deref().expect("controlled terminal envelope"))
                    .unwrap();
            assert!(
                terminal["receipts"]
                    .as_array()
                    .is_some_and(|receipts| !receipts.is_empty()),
                "{kind:?} {scenario} {terminal}"
            );
            assert!(terminal.get("usage").is_some());
            assert!(terminal.get("cost_display").is_some());
            if scenario == "second_429" {
                assert_eq!(terminal["error_code"], "rate_limited_429");
            }
        }
        if matches!(
            scenario,
            "config_changed"
                | "expired"
                | "secret_denied"
                | "image_budget"
                | "numeric_turn_zero"
                | "numeric_image_one"
                | "dispatch_revoke"
        ) {
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            let terminal: Value = serde_json::from_str(
                terminal
                    .as_deref()
                    .expect("controlled pre-admission terminal"),
            )
            .unwrap();
            assert_eq!(
                terminal["receipts"],
                json!([]),
                "zero POST must not manufacture attempt receipts: {terminal}"
            );
            assert!(
                terminal.get("receipt").is_some_and(Value::is_null),
                "zero POST must have an explicit null latest attempt: {terminal}"
            );
            assert_eq!(
                terminal["usage"],
                json!({"input_tokens":null,"output_tokens":null,"cost_usd":null})
            );
            assert_eq!(terminal["cost_display"], "unknown");
            assert!(terminal["error_code"]
                .as_str()
                .is_some_and(|code| !code.is_empty()));
        }
    }
    // A delayed server may still finish and bill upstream; release its output
    // only after cancellation/timeout settlement and prove it cannot apply.
    release.notify_waiters();
    tokio::time::sleep(Duration::from_millis(20)).await;
    let mut tx = state.repository.begin_write().await.unwrap();
    let status: String = sqlx::query_scalar("SELECT state FROM model_runs WHERE run_id=?")
        .bind(run)
        .fetch_one(tx.connection())
        .await
        .unwrap();
    let predictions: i64 = sqlx::query_scalar("SELECT count(*) FROM predictions WHERE run_id=?")
        .bind(run)
        .fetch_one(tx.connection())
        .await
        .unwrap();
    let events: Vec<Option<String>> =
        sqlx::query_scalar("SELECT data_json FROM run_events WHERE run_id=? ORDER BY seq")
            .bind(run)
            .fetch_all(tx.connection())
            .await
            .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(state.run_tokens.active_tokens_for_run(run), 0);
    let events = events.into_iter().flatten().collect::<Vec<_>>();
    assert!(!events
        .join("")
        .contains("synthetic-r03-credential-never-real"));
    if checkpoint_failure {
        assert_eq!(predictions, 0);
        assert_eq!(
            status,
            if scenario == "checkpoint_cancel_race" {
                "cancelled"
            } else {
                "failed"
            }
        );
        let mut tx = state.repository.begin_write().await.unwrap();
        let terminal_count:i64=sqlx::query_scalar("SELECT count(*) FROM run_events WHERE run_id=? AND event_type IN ('failed','cancelled','succeeded')").bind(run).fetch_one(tx.connection()).await.unwrap();
        let terminal:String=sqlx::query_scalar("SELECT data_json FROM run_events WHERE run_id=? AND event_type IN ('failed','cancelled','succeeded') ORDER BY seq LIMIT 1").bind(run).fetch_one(tx.connection()).await.unwrap();
        let observations:Vec<String>=sqlx::query_scalar("SELECT data_json FROM run_events WHERE run_id=? AND event_type='progress' AND message='provider observation checkpoint' ORDER BY seq").bind(run).fetch_all(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(terminal_count, 1);
        let terminal: Value = serde_json::from_str(&terminal).unwrap();
        assert_unconfirmed_observation(&terminal);
        assert_eq!(
            terminal["error_code"],
            if scenario == "checkpoint_cancel_race" {
                "RUN_CANCELLED"
            } else {
                "event_checkpoint_failed"
            }
        );
        let admitted_turns = if scenario == "checkpoint_next_failure" {
            2
        } else {
            1
        };
        assert!(
            calls.load(Ordering::SeqCst) <= admitted_turns,
            "metadata failure must never retry POST"
        );
        if scenario == "checkpoint_next_failure" {
            assert!(calls.load(Ordering::SeqCst) >= 1);
            assert!(
                observations
                    .iter()
                    .map(|raw| serde_json::from_str::<Value>(raw).unwrap())
                    .any(|observation| observation["receipts"]
                        .as_array()
                        .is_some_and(|receipts| receipts.len() == 1)
                        && observation["receipt"]["response_id"].as_str().is_some()
                        && observation["receipt"]["actual_model_id"] == "synthetic-model"
                        && observation["usage"]["input_tokens"] == 5
                        && observation["usage"]["output_tokens"] == 2),
                "prior observed identity and usage must remain in history"
            );
        } else {
            assert!(
                observations.is_empty(),
                "aborted first observation must not be fabricated later"
            );
        }
    } else if matches!(
        scenario,
        "success"
            | "text_candidate"
            | "unknown_usage"
            | "crop_only"
            | "second_success_missing_usage"
            | "numeric_output_one"
            | "framing_budget"
            | "audit_attributes"
            | "detect_create"
            | "response_unknown_extension"
            | "response_reasoning_valid"
    ) {
        let turns = if scenario == "text_candidate" { 1 } else { 2 };
        assert_eq!(status, "succeeded", "{kind:?} {scenario}");
        assert_eq!(predictions, 1);
        assert_eq!(calls.load(Ordering::SeqCst), turns);
        let checkpoint: Value = serde_json::from_str(
            events
                .iter()
                .rev()
                .find(|s| s.contains("receipts"))
                .unwrap(),
        )
        .unwrap();
        if scenario == "unknown_usage" || scenario == "second_success_missing_usage" {
            assert!(checkpoint["usage"]["input_tokens"].is_null());
            assert!(checkpoint["usage"]["output_tokens"].is_null());
            assert!(checkpoint["usage"]["cost_usd"].is_null());
            assert_eq!(checkpoint["cost_display"], "unknown");
        } else {
            assert_eq!(checkpoint["usage"]["input_tokens"], 5 * turns);
            assert_eq!(checkpoint["usage"]["output_tokens"], 2 * turns);
            assert!(
                (checkpoint["usage"]["cost_usd"].as_f64().unwrap() - 0.000026 * turns as f64).abs()
                    < 1e-12
            );
        }
        let bodies = bodies.lock().await;
        if scenario == "crop_only" {
            use base64::Engine;
            let content = match kind {
                Kind::OpenAi => &bodies[0]["input"][0]["content"],
                Kind::Anthropic => &bodies[0]["messages"][0]["content"],
                Kind::Mimo => &bodies[0]["messages"][1]["content"],
            };
            let images = content
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|part| {
                    part["source"]["data"].as_str().or_else(|| {
                        part["image_url"]
                            .as_str()
                            .or_else(|| part["image_url"]["url"].as_str())
                            .and_then(|s| s.strip_prefix("data:image/png;base64,"))
                    })
                })
                .collect::<Vec<_>>();
            assert_eq!(images.len(), 1);
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(images[0])
                .unwrap();
            let image = image::load_from_memory(&bytes).unwrap();
            assert_eq!((image.width(), image.height()), (16, 16));
        }
        if scenario != "text_candidate" {
            let serialized = bodies[1].to_string();
            assert!(serialized.contains("transform_to_canonical"));
            assert!(serialized.contains("16"));
            assert!(serialized.contains("inspect"));
            assert!(
                serialized.contains("data:image/png;base64,")
                    || serialized.contains("\"media_type\":\"image/png\"")
            );
            assert_roundtrip(&bodies[1], kind, project, domain_case);
            if scenario == "response_unknown_extension" {
                assert!(!serialized.contains("injected-extension"));
            }
            if scenario == "response_reasoning_valid" {
                assert!(serialized.contains("complete-final"));
                assert!(!serialized.contains("incomplete-first"));
            }
        }
        if scenario == "numeric_output_one" {
            for body in bodies.iter() {
                assert_eq!(
                    body[if kind == Kind::OpenAi {
                        "max_output_tokens"
                    } else if kind == Kind::Mimo {
                        "max_completion_tokens"
                    } else {
                        "max_tokens"
                    }],
                    1
                );
            }
        }
        if domain_case {
            let mut tx = state.repository.begin_write().await.unwrap();
            let changes: String =
                sqlx::query_scalar("SELECT changes_json FROM suggestion_sets WHERE run_id=?")
                    .bind(run)
                    .fetch_one(tx.connection())
                    .await
                    .unwrap();
            let raw: String =
                sqlx::query_scalar("SELECT raw_output_json FROM predictions WHERE run_id=?")
                    .bind(run)
                    .fetch_one(tx.connection())
                    .await
                    .unwrap();
            tx.commit().await.unwrap();
            let changes: Value = serde_json::from_str(&changes).unwrap();
            let raw: Value = serde_json::from_str(&raw).unwrap();
            if scenario == "audit_attributes" {
                assert_eq!(changes[0]["before_hash"], object_hashes["object-100"]);
                assert_eq!(changes[0]["values"], json!({"state":"new"}));
                assert_eq!(raw["changes"][0]["values"], json!({"state":"new"}));
            } else {
                assert_eq!(
                    changes[0]["object"]["geometry"],
                    json!({"type":"bbox_xyxy","x_min":5.0,"y_min":6.0,"x_max":15.0,"y_max":16.0})
                );
                assert_eq!(
                    raw["changes"][0]["object"]["attributes"],
                    json!({"state":"new"})
                );
            }
            if kind == Kind::OpenAi {
                assert_nonempty_strict_attributes(&bodies[0]);
            }
        }
        // A fresh table models lost transport ownership, not token renewal.
        let late_tokens = weblabel_api::runtime::run_tokens::RunTokenStore::new();
        let token = late_tokens.issue(run, project, Duration::from_secs(1));
        let error = AgentToolService::new(state.repository.clone(), late_tokens.clone())
            .invoke(&token, "propose_changes", &candidate("late-issue"))
            .await
            .unwrap_err();
        assert_eq!(error.code, "RUN_TERMINAL_QUARANTINED");
        late_tokens.revoke(&token);
        let mut tx = state.repository.begin_write().await.unwrap();
        let audit:i64=sqlx::query_scalar("SELECT count(*) FROM prediction_audit WHERE run_id=? AND raw_output_json LIKE '%late-issue%'").bind(run).fetch_one(tx.connection()).await.unwrap();
        assert_eq!(audit, 1);
        tx.commit().await.unwrap();
    } else {
        assert_eq!(predictions, 0, "{kind:?} {scenario}");
        assert_eq!(
            status,
            if matches!(
                scenario,
                "cancel" | "cancel_first_receipt" | "policy_revoke"
            ) {
                "cancelled"
            } else {
                "failed"
            },
            "{kind:?} {scenario}"
        );
        let expected_posts = if matches!(
            scenario,
            "config_changed"
                | "expired"
                | "secret_denied"
                | "image_budget"
                | "numeric_turn_zero"
                | "numeric_image_one"
                | "dispatch_revoke"
        ) {
            0
        } else if matches!(
            scenario,
            "second_429"
                | "second_headers_timeout"
                | "numeric_response_float"
                | "audit_stale"
                | "detect_scope_violation"
        ) {
            2
        } else {
            1
        };
        assert_eq!(
            calls.load(Ordering::SeqCst),
            expected_posts,
            "{kind:?} {scenario}"
        );
        if scenario == "duplicate" {
            assert!(events.iter().any(|s| s.contains("duplicate_candidate")));
        }
        if scenario == "timeout" {
            assert!(events.iter().any(|s| s.contains("timeout")));
        }
        for (case, code) in [
            ("turn_budget", "tool_turn_budget_exceeded"),
            ("byte_budget", "tool_byte_budget_exceeded"),
            ("time_budget", "tool_time_budget_exceeded"),
            ("image_budget", "image_budget_exceeded"),
            ("invalid_tool", "invalid_tool_call"),
            ("token_revoke", "RUN_TOKEN_REVOKED"),
        ] {
            if scenario == case {
                assert!(
                    events.iter().any(|s| s.contains(code)),
                    "{kind:?} {scenario} {events:?}"
                );
            }
        }
        for (case, code) in [
            ("numeric_turn_zero", "tool_turn_budget_exceeded"),
            ("numeric_image_one", "image_budget_exceeded"),
            ("numeric_total_float", "tool_byte_budget_exceeded"),
            ("numeric_timeout_float", "timeout"),
            ("numeric_stream_float", "oversized_response"),
            ("numeric_response_float", "oversized_response"),
            ("second_429", "rate_limited_429"),
            ("second_headers_timeout", "timeout"),
            ("observed_failure", "provider_reported_failure"),
            ("model_mismatch", "MODEL_MISMATCH"),
            ("audit_stale", "BEFORE_HASH_MISMATCH"),
            ("detect_scope_violation", "CANDIDATE_REGION_NOT_APPROVED"),
            ("dispatch_revoke", "RUN_TOKEN_REVOKED"),
        ] {
            if scenario == case {
                assert!(
                    events.iter().any(|s| s.contains(code)),
                    "{kind:?} {scenario} {events:?}"
                );
            }
        }
        if matches!(
            scenario,
            "second_429" | "second_headers_timeout" | "numeric_response_float" | "observed_failure"
        ) {
            let checkpoint: Value = serde_json::from_str(
                events
                    .iter()
                    .rev()
                    .find(|s| s.contains("receipts"))
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(checkpoint["usage"]["input_tokens"], 5);
            assert_eq!(checkpoint["usage"]["output_tokens"], 2);
            assert_eq!(
                checkpoint["receipts"].as_array().unwrap().len(),
                if scenario == "observed_failure" { 1 } else { 2 }
            );
            if scenario != "observed_failure" {
                assert!(checkpoint["receipt"]["response_id"].is_null());
                assert!(checkpoint["receipt"]["actual_model_id"].is_null());
            }
        }
        if scenario.starts_with("response_") {
            assert!(
                events.iter().any(|s| s.contains("stream_order_invalid")),
                "{scenario} {events:?}"
            );
        }
    }
    server.abort();
    state.repository.close().await;
}

#[tokio::test]
async fn malformed_utf8_and_provider_declared_failure_are_controlled() {
    for (kind, body, code) in [
        (Kind::OpenAi, b"data: \xff\n\n".to_vec(), "invalid_utf8"),
        (
            Kind::OpenAi,
            observed_failure_wire(Kind::OpenAi).into_bytes(),
            "provider_reported_failure",
        ),
        (
            Kind::Anthropic,
            b"data: {\"type\":\"error\",\"error\":{\"message\":\"synthetic-secret\"}}\n\n".to_vec(),
            "provider_reported_failure",
        ),
        (
            Kind::Mimo,
            b"data: {\"error\":{\"message\":\"synthetic-secret\"}}\n\n".to_vec(),
            "provider_reported_failure",
        ),
    ] {
        let (config, calls, _, task) = server(200, body, 1, Duration::ZERO).await;
        let (_tx, rx) = watch::channel(false);
        let mut turn = Turn::new(kind);
        let error = post(
            kind,
            &config,
            Limits::default(),
            Instant::now() + Duration::from_secs(2),
            &rx,
            &mut turn,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, code);
        assert!(!format!("{error:?}").contains("synthetic-secret"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        task.abort();
    }
}

#[tokio::test]
async fn named_loopback_requires_private_grant_even_with_shared_dns_cache() {
    let (mut config, calls, _, task) =
        server(200, wire(Kind::OpenAi).into_bytes(), 1, Duration::ZERO).await;
    config["api_base"] = json!(config["api_base"]
        .as_str()
        .unwrap()
        .replace("127.0.0.1", "localhost"));
    let client = HttpClient::new().unwrap();
    let (_tx, rx) = watch::channel(false);
    let mut turn = Turn::new(Kind::OpenAi);
    client
        .post(
            Kind::OpenAi,
            &config,
            "synthetic-secret",
            &json!({}),
            Limits::default(),
            Instant::now() + Duration::from_secs(3),
            &rx,
            &mut turn,
        )
        .await
        .unwrap();
    config["base_approval"]["allow_private_network"] = json!(false);
    let mut turn = Turn::new(Kind::OpenAi);
    let error = client
        .post(
            Kind::OpenAi,
            &config,
            "synthetic-secret",
            &json!({}),
            Limits::default(),
            Instant::now() + Duration::from_secs(3),
            &rx,
            &mut turn,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "ssrf_blocked");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    task.abort();
}
#[tokio::test]
async fn token_plan_never_guesses_an_official_base_or_dispatches() {
    let client = HttpClient::new().unwrap();
    let (_tx, rx) = watch::channel(false);
    let mut turn = Turn::new(Kind::Mimo);
    let error = client
        .post(
            Kind::Mimo,
            &json!({}),
            "tp-synthetic-not-real",
            &json!({}),
            Limits::default(),
            Instant::now() + Duration::from_secs(1),
            &rx,
            &mut turn,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "base_not_approved");
    assert!(turn.response_id.is_none());
}

fn encode_responses(frames: Vec<Value>) -> String {
    frames
        .into_iter()
        .enumerate()
        .map(|(sequence, mut frame)| {
            frame["sequence_number"] = json!(sequence);
            format!("data: {frame}\r\n\r\n")
        })
        .collect()
}
fn response_text_events(text: &str) -> Vec<Value> {
    let item = json!({"type":"message","id":"message-1","role":"assistant","content":[],"status":"in_progress"});
    let part = json!({"type":"output_text","text":"","annotations":[],"logprobs":[]});
    let final_part = json!({"type":"output_text","text":text,"annotations":[],"logprobs":[]});
    let completed = json!({"type":"message","id":"message-1","role":"assistant","content":[final_part],"status":"completed"});
    vec![
        json!({"type":"response.created","response":{"id":"r1","model":"synthetic-model","status":"in_progress","output":[],"usage":{"input_tokens":5,"output_tokens":2}}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
        json!({"type":"response.content_part.added","output_index":0,"item_id":"message-1","content_index":0,"part":part}),
        json!({"type":"response.output_text.delta","output_index":0,"item_id":"message-1","content_index":0,"delta":text}),
        json!({"type":"response.output_text.done","output_index":0,"item_id":"message-1","content_index":0,"text":text}),
        json!({"type":"response.content_part.done","output_index":0,"item_id":"message-1","content_index":0,"part":final_part}),
        json!({"type":"response.output_item.done","output_index":0,"item":completed}),
        json!({"type":"response.completed","response":{"id":"r1","model":"synthetic-model","status":"completed","output":[completed],"usage":{"input_tokens":5,"output_tokens":2}}}),
    ]
}
fn feed(
    kind: Kind,
    frames: Vec<Value>,
) -> Result<Turn, weblabel_api::runtime::providers::http::HttpError> {
    let mut turn = Turn::new(kind);
    for (sequence, mut frame) in frames.into_iter().enumerate() {
        frame["sequence_number"] = json!(sequence);
        turn.frame(None, &frame.to_string())?;
    }
    Ok(turn)
}
#[test]
fn responses_rejects_missing_repeated_start_and_orphan_or_contradictory_items() {
    let good = response_text_events("{}");
    assert_eq!(
        feed(Kind::OpenAi, vec![good[7].clone()]).unwrap_err().code,
        "stream_order_invalid"
    );
    assert_eq!(
        feed(Kind::OpenAi, vec![good[0].clone(), good[0].clone()])
            .unwrap_err()
            .code,
        "stream_order_invalid"
    );
    assert_eq!(
        feed(Kind::OpenAi, vec![good[0].clone(), good[6].clone()])
            .unwrap_err()
            .code,
        "stream_order_invalid"
    );
    let mut duplicate = good.clone();
    duplicate.insert(7, good[6].clone());
    assert_eq!(
        feed(Kind::OpenAi, duplicate).unwrap_err().code,
        "stream_order_invalid"
    );
    let mut wrong_index = good.clone();
    wrong_index[3]["output_index"] = json!(1);
    assert_eq!(
        feed(Kind::OpenAi, wrong_index).unwrap_err().code,
        "stream_order_invalid"
    );
    let mut wrong_item = good.clone();
    wrong_item[6]["item"]["id"] = json!("other");
    assert_eq!(
        feed(Kind::OpenAi, wrong_item).unwrap_err().code,
        "stream_order_invalid"
    );
    let mut incomplete = good.clone();
    incomplete.remove(6);
    assert_eq!(
        feed(Kind::OpenAi, incomplete).unwrap_err().code,
        "stream_order_invalid"
    );
    let mut contradictory = good;
    contradictory[7]["response"]["output"][0]["content"][0]["text"] = json!("injected");
    assert_eq!(
        feed(Kind::OpenAi, contradictory).unwrap_err().code,
        "stream_order_invalid"
    );
}
#[test]
fn unknown_responses_events_cannot_supply_receipts_or_continuation() {
    let mut frames = response_text_events("{}");
    frames.insert(1,json!({"type":"response.future_extension","response":{"id":"injected","model":"other","usage":{"input_tokens":999}},"item":{"type":"reasoning","id":"orphan","summary":[],"encrypted_content":"injected"}}));
    frames.push(json!({"type":"response.future_extension","response":{"id":"trailing-injection","usage":{"output_tokens":999}}}));
    let turn = feed(Kind::OpenAi, frames).unwrap();
    assert_eq!(turn.response_id.as_deref(), Some("r1"));
    assert_eq!(turn.actual_model_id.as_deref(), Some("synthetic-model"));
    assert_eq!(turn.usage.input_tokens, Some(5));
    assert_eq!(turn.text, "{}");
}
fn anthropic_call_frames(initial: Value, deltas: &[&str], reason: &str) -> Vec<Value> {
    let mut frames = vec![
        json!({"type":"message_start","message":{"id":"a1","model":"synthetic-model","usage":{"input_tokens":5}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"context","name":"get_context","input":initial}}),
    ];
    for delta in deltas {
        frames.push(json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":delta}}));
    }
    frames.extend([
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":reason},"usage":{"output_tokens":2}}),
        json!({"type":"message_stop"}),
    ]);
    frames
}
#[test]
fn anthropic_empty_initial_object_is_valid_without_any_json_delta() {
    let turn = feed(
        Kind::Anthropic,
        anthropic_call_frames(json!({}), &[], "tool_use"),
    )
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&turn.calls[0].arguments).unwrap(),
        json!({})
    );
    let turn = feed(
        Kind::Anthropic,
        anthropic_call_frames(json!({"old":1}), &["{", "}"], "tool_use"),
    )
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&turn.calls[0].arguments).unwrap(),
        json!({})
    );
}
#[test]
fn anthropic_stop_reason_must_match_actual_completed_tool_blocks() {
    for reason in ["end_turn", "stop_sequence"] {
        assert_eq!(
            feed(
                Kind::Anthropic,
                anthropic_call_frames(json!({}), &[], reason)
            )
            .unwrap_err()
            .code,
            "stream_order_invalid"
        );
    }
    let frames = vec![
        json!({"type":"message_start","message":{"id":"a1","model":"synthetic-model","usage":{}}}),
        json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{}}),
        json!({"type":"message_stop"}),
    ];
    assert_eq!(
        feed(Kind::Anthropic, frames).unwrap_err().code,
        "stream_order_invalid"
    );
}

fn inspection_calls() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "inspect",
            "read_region",
            json!({"region":{"type":"bbox_xyxy","x_min":4,"y_min":4,"x_max":20,"y_max":20}}),
        ),
        ("context", "get_context", json!({})),
    ]
}
fn sse_data_bytes(wire: &str) -> usize {
    wire.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(str::len)
        .sum()
}
fn observed_failure_wire(kind: Kind) -> String {
    match kind {
        Kind::OpenAi => encode_responses(vec![
            json!({"type":"response.created","response":{"id":"failure","model":"synthetic-model","status":"in_progress","output":[],"usage":{"input_tokens":5,"output_tokens":2}}}),
            json!({"type":"response.failed","response":{"id":"failure","model":"synthetic-model","status":"failed","output":[],"error":{"message":"synthetic-secret"}}}),
        ]),
        Kind::Anthropic => format!(
            "data: {}\n\ndata: {}\n\n",
            json!({"type":"message_start","message":{"id":"failure","model":"synthetic-model","usage":{"input_tokens":5,"output_tokens":2}}}),
            json!({"type":"error","error":{"message":"synthetic-secret"}})
        ),
        Kind::Mimo => format!(
            "data: {}\n\ndata: {}\n\n",
            json!({"id":"failure","model":"synthetic-model","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}),
            json!({"error":{"message":"synthetic-secret"}})
        ),
    }
}
fn mutate_response_wire(wire: &str, mode: &str) -> String {
    let mut frames = wire
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|data| serde_json::from_str::<Value>(data).unwrap())
        .collect::<Vec<_>>();
    match mode {
        "response_missing_start"=>{frames.remove(0);},
        "response_duplicate_start"=>frames.insert(1,frames[0].clone()),
        "response_orphan_done"=>{
            let done=frames.iter().find(|frame|frame["type"]=="response.output_item.done").unwrap().clone();frames.insert(1,done);
        },
        "response_contradictory_item"=>{
            frames.iter_mut().find(|frame|frame["type"]=="response.output_item.done").unwrap()["item"]["name"]=json!("get_context");
        },
        "response_unknown_extension"=>frames.insert(1,json!({"type":"response.future_extension","response":{"id":"injected-extension","model":"injected-extension","usage":{"input_tokens":999}},"item":{"type":"reasoning","id":"injected-extension","summary":[],"encrypted_content":"injected-extension"}})),
        "response_reasoning_valid"=>{
            for frame in &mut frames{if let Some(index)=frame["output_index"].as_u64(){frame["output_index"]=json!(index+1);}}
            let complete=json!({"type":"reasoning","id":"reasoning","status":"completed","summary":[],"encrypted_content":"complete-final"});
            frames.last_mut().unwrap()["response"]["output"].as_array_mut().unwrap().insert(0,complete.clone());
            frames.insert(1,json!({"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"reasoning","status":"in_progress","summary":[],"encrypted_content":"incomplete-first"}}));
            frames.insert(2,json!({"type":"response.output_item.done","output_index":0,"item":complete}));
        },
        _=>panic!("unknown fixture mode")
    }
    encode_responses(frames)
}
fn assert_nonempty_strict_attributes(body: &Value) {
    fn visit<'a>(value: &'a Value, found: &mut Vec<&'a Value>) {
        if value["properties"].as_object().is_some_and(|properties| {
            properties.contains_key("state") && properties.contains_key("note")
        }) {
            found.push(value);
        }
        match value {
            Value::Object(map) => {
                for child in map.values() {
                    visit(child, found)
                }
            }
            Value::Array(items) => {
                for child in items {
                    visit(child, found)
                }
            }
            _ => {}
        }
    }
    let mut found = Vec::new();
    visit(&body["tools"], &mut found);
    assert!(found.len() >= 2);
    assert!(found
        .iter()
        .any(|schema| schema["properties"]["state"]["type"] == "string"));
    assert!(found
        .iter()
        .any(|schema| schema["properties"]["state"]["anyOf"]
            .as_array()
            .is_some_and(|variants| variants.iter().any(|v| v["type"] == "null"))));
    for schema in found {
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"].as_array().unwrap().len(), 3);
        assert!(schema["properties"]["note"]["anyOf"]
            .as_array()
            .unwrap()
            .iter()
            .any(|variant| variant["type"] == "null"));
    }
}
#[test]
fn native_review_consumer_matrix() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "native_review_subprocess", "--nocapture"])
        .env("R03_REVIEW_CONSUMER", "1")
        .env(
            "R03_SYNTHETIC_API_KEY",
            "synthetic-r03-credential-never-real",
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_review_subprocess() {
    if std::env::var("R03_REVIEW_CONSUMER").as_deref() != Ok("1") {
        return;
    }
    native_scenario(Kind::OpenAi, "native_profile_eligibility").await;
    for kind in [Kind::OpenAi, Kind::Anthropic, Kind::Mimo] {
        for scenario in [
            "second_429",
            "second_headers_timeout",
            "observed_failure",
            "model_mismatch",
            "second_success_missing_usage",
            "numeric_turn_zero",
            "numeric_image_one",
            "numeric_output_one",
            "numeric_total_float",
            "numeric_timeout_float",
            "numeric_stream_float",
            "numeric_response_float",
            "framing_budget",
            "audit_attributes",
            "audit_stale",
            "detect_create",
            "detect_scope_violation",
            "cancel_first_receipt",
        ] {
            native_scenario(kind, scenario).await;
        }
        #[cfg(debug_assertions)]
        native_scenario(kind, "dispatch_revoke").await;
    }
    for scenario in [
        "response_missing_start",
        "response_duplicate_start",
        "response_orphan_done",
        "response_contradictory_item",
        "response_unknown_extension",
        "response_reasoning_valid",
    ] {
        native_scenario(Kind::OpenAi, scenario).await;
    }
    for scenario in ["checkpoint_first_failure", "checkpoint_next_failure"] {
        native_scenario(Kind::OpenAi, scenario).await;
    }
    #[cfg(debug_assertions)]
    native_scenario(Kind::OpenAi, "checkpoint_cancel_race").await;
}

async fn native_profile_metadata(
    state: &weblabel_api::AppState,
    runtime: weblabel_api::runtime::config::RuntimeConfig,
    execution: &Value,
    cookie: &str,
    csrf: &str,
) {
    use axum::http::StatusCode;
    use weblabel_api::runtime::config::{RuntimeConfig, RuntimeConfigurationError};
    let make_app = |configuration| {
        let mut next = state.clone();
        next.profile_configuration = configuration;
        weblabel_api::router(next)
    };
    let runtime = Arc::new(runtime);
    let native = make_app(Ok(Some(runtime.clone())));
    assert_profile_views(&native, "synthetic", "ready", execution, cookie).await;
    let original_hash = runtime
        .configuration_hash("openai_api", "synthetic")
        .unwrap();
    let (status, presets, _) = api_method(
        &native,
        "GET",
        "/api/model-profile-presets",
        Value::Null,
        Some(cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{presets}");
    assert_public_metadata(&presets, execution);
    let preset = presets["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|preset| preset["profile_id"] == "synthetic")
        .unwrap();
    assert_eq!(preset["configuration_hash"], original_hash);
    assert_eq!(preset["configured"], true);
    assert_eq!(preset["availability"], "ready");

    // A newly provisioned profile derives current eligibility; no verification
    // timestamp/runtime identity or historical readiness is manufactured.
    let mut fresh = execution.clone();
    fresh["profile_id"] = json!("synthetic-new");
    let envelope = json!({"schema_version":1,"timeout_ms":5000,"providers":[{"provider":"openai_api","config":execution},{"provider":"openai_api","config":fresh}]});
    let allowed = vec!["R03_SYNTHETIC_API_KEY".to_owned()];
    let fresh_runtime = Arc::new(RuntimeConfig::parse(&envelope.to_string(), &allowed).unwrap());
    let fresh_hash = fresh_runtime
        .configuration_hash("openai_api", "synthetic-new")
        .unwrap();
    let fresh_app = make_app(Ok(Some(fresh_runtime)));
    let (status, presets, _) = api_method(
        &fresh_app,
        "GET",
        "/api/model-profile-presets",
        Value::Null,
        Some(cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{presets}");
    assert_public_metadata(&presets, execution);
    assert_eq!(presets["items"].as_array().unwrap().len(), 2);
    let preset = presets["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|preset| preset["profile_id"] == "synthetic-new")
        .unwrap();
    assert_eq!(preset["configuration_hash"], fresh_hash);
    assert_eq!(preset["configured"], false);
    assert_eq!(preset["availability"], "ready");
    let (status, provisioned, _) = api_method(
        &fresh_app,
        "PUT",
        "/api/model-profiles/synthetic-new",
        json!({"configuration_hash":fresh_hash}),
        Some(cookie),
        Some(csrf),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{provisioned}");
    assert_public_profile(&provisioned, "synthetic-new", "ready", &fresh);
    assert_public_metadata(&provisioned, execution);
    assert_profile_views(&fresh_app, "synthetic-new", "ready", &fresh, cookie).await;
    let mut tx = state.repository.begin_write().await.unwrap();
    let stored_availability: String = sqlx::query_scalar(
        "SELECT availability FROM model_profiles WHERE profile_id='synthetic-new'",
    )
    .fetch_one(tx.connection())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        stored_availability, "ready",
        "provision must persist fresh configuration eligibility"
    );
    let (status, presets, _) = api_method(
        &fresh_app,
        "GET",
        "/api/model-profile-presets",
        Value::Null,
        Some(cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_public_metadata(&presets, execution);
    assert_eq!(
        presets["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|preset| preset["profile_id"] == "synthetic-new")
            .unwrap()["configured"],
        true
    );

    // Native HTTP can only publish domain candidates through tool calls.
    let mut no_tools = execution.clone();
    no_tools["profile_id"] = json!("synthetic-no-tools");
    no_tools["capabilities"]["tools"] = json!(false);
    let no_tools_envelope = json!({"schema_version":1,"timeout_ms":5000,"providers":[{"provider":"openai_api","config":no_tools}]});
    let no_tools_runtime =
        Arc::new(RuntimeConfig::parse(&no_tools_envelope.to_string(), &allowed).unwrap());
    let no_tools_hash = no_tools_runtime
        .configuration_hash("openai_api", "synthetic-no-tools")
        .unwrap();
    let no_tools_app = make_app(Ok(Some(no_tools_runtime)));
    let (status, presets, _) = api_method(
        &no_tools_app,
        "GET",
        "/api/model-profile-presets",
        Value::Null,
        Some(cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_public_metadata(&presets, execution);
    assert_eq!(
        presets["items"][0]["availability"], "blocked",
        "a profile the installed executor rejects cannot be Ready"
    );
    let (status, provisioned, _) = api_method(
        &no_tools_app,
        "PUT",
        "/api/model-profiles/synthetic-no-tools",
        json!({"configuration_hash":no_tools_hash}),
        Some(cookie),
        Some(csrf),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_public_profile(&provisioned, "synthetic-no-tools", "blocked", &no_tools);
    assert_profile_views(
        &no_tools_app,
        "synthetic-no-tools",
        "blocked",
        &no_tools,
        cookie,
    )
    .await;

    let mut changed = envelope.clone();
    changed["providers"][0]["config"]["timeout_ms"] = json!(1000);
    let changed_runtime = Arc::new(RuntimeConfig::parse(&changed.to_string(), &allowed).unwrap());
    let changed_hash = changed_runtime
        .configuration_hash("openai_api", "synthetic")
        .unwrap();
    assert_ne!(changed_hash, original_hash);
    let transitions = [
        ("absent", Ok(None)),
        ("invalid", Err(RuntimeConfigurationError)),
        (
            "secret_not_allowed",
            Ok(Some(Arc::new(
                RuntimeConfig::parse(&envelope.to_string(), &[]).unwrap(),
            ))),
        ),
        ("changed_hash", Ok(Some(changed_runtime))),
    ];
    for (mode, configuration) in transitions {
        let app = make_app(configuration);
        assert_profile_views(&app, "synthetic", "needs_configuration", execution, cookie).await;
        let (status, presets, _) = api_method(
            &app,
            "GET",
            "/api/model-profile-presets",
            Value::Null,
            Some(cookie),
            None,
        )
        .await;
        assert_public_metadata(&presets, execution);
        match mode {
            "absent" => {
                assert_eq!(status, StatusCode::OK);
                assert_eq!(presets["items"], json!([]));
            }
            "invalid" => {
                assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
                assert_eq!(presets["code"], "RUNTIME_CONFIGURATION_UNAVAILABLE");
            }
            "secret_not_allowed" => {
                assert_eq!(status, StatusCode::OK);
                assert!(presets["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|preset| preset["availability"] == "needs_configuration"));
                assert_eq!(
                    presets["items"].as_array().unwrap().len(),
                    2,
                    "missing secrets must not hide service-owned presets"
                );
            }
            "changed_hash" => {
                assert_eq!(status, StatusCode::OK);
                assert_eq!(presets["items"].as_array().unwrap().len(), 2);
                let preset = presets["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|preset| preset["profile_id"] == "synthetic")
                    .unwrap();
                assert_eq!(preset["configured"], false);
                assert_eq!(preset["configuration_hash"], changed_hash);
                let (status, conflict, _) = api_method(
                    &app,
                    "PUT",
                    "/api/model-profiles/synthetic",
                    json!({"configuration_hash":changed_hash}),
                    Some(cookie),
                    Some(csrf),
                )
                .await;
                assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
                assert_eq!(conflict["code"], "PROFILE_CONFIGURATION_CONFLICT");
                assert_public_metadata(&conflict, execution);
            }
            _ => unreachable!(),
        }
    }
    // Returning to the exact private configuration restores eligibility,
    // proving negative views did not mutate the historical profile identity.
    assert_profile_views(&fresh_app, "synthetic", "ready", execution, cookie).await;
    let mut tx = state.repository.begin_write().await.unwrap();
    for (id, provider, auth) in [
        ("synthetic-claude", "claude_local", "official_user_login"),
        ("synthetic-detector", "detector_local", "local_weights"),
    ] {
        sqlx::query("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES(?,?,'synthetic-local-model',?,?,'ready','not_run',NULL,NULL,'{}',NULL,'2026-10-25T00:00:00Z')")
            .bind(id).bind(provider).bind(auth).bind(execution["capabilities"].to_string()).execute(tx.connection()).await.unwrap();
    }
    tx.commit().await.unwrap();
    let (status, list, _) = api_method(
        &fresh_app,
        "GET",
        "/api/model-profiles",
        Value::Null,
        Some(cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_public_metadata(&list, execution);
    for id in ["synthetic-claude", "synthetic-detector"] {
        assert_eq!(
            list["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|profile| profile["profile_id"] == id)
                .unwrap()["availability"],
            "needs_configuration",
            "HTTP installation must not enable {id}"
        );
    }
    let mut tx = state.repository.begin_write().await.unwrap();
    let runs: i64 = sqlx::query_scalar("SELECT count(*) FROM model_runs")
        .fetch_one(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(runs, 1, "metadata/provisioning must not start runs");
}
async fn assert_profile_views(
    app: &axum::Router,
    id: &str,
    availability: &str,
    stored: &Value,
    cookie: &str,
) {
    use axum::http::StatusCode;
    let (status, list, _) = api_method(
        app,
        "GET",
        "/api/model-profiles",
        Value::Null,
        Some(cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_public_metadata(&list, stored);
    let profile = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|profile| profile["profile_id"] == id)
        .unwrap();
    assert_public_profile(profile, id, availability, stored);
    let (status, admin, _) = api_method(
        app,
        "GET",
        &format!("/api/model-profiles/{id}"),
        Value::Null,
        Some(cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{admin}");
    assert_public_metadata(&admin, stored);
    assert_public_profile(&admin["profile"], id, availability, stored);
    assert_eq!(
        admin["configuration_hash"],
        annotation_domain::hash::execution_configuration_hash(stored).unwrap()
    );
}
fn assert_public_profile(profile: &Value, id: &str, availability: &str, config: &Value) {
    assert_eq!(profile["profile_id"], id);
    assert_eq!(profile["provider_id"], "openai_api");
    assert_eq!(profile["model_id"], "synthetic-model");
    assert_eq!(profile["availability"], availability, "{profile}");
    assert_eq!(profile["capabilities"], config["capabilities"]);
    assert_eq!(profile["verification"], "not_run");
    assert_eq!(profile.get("runtime_version"), Some(&Value::Null));
    assert_eq!(profile.get("verified_at"), Some(&Value::Null));
}
fn assert_public_metadata(body: &Value, config: &Value) {
    let text = body.to_string();
    for private in [
        "synthetic-r03-credential-never-real",
        "R03_SYNTHETIC_API_KEY",
        config["api_base"].as_str().unwrap(),
    ] {
        assert!(
            !text.contains(private),
            "metadata must not expose private values: {body}"
        );
    }
    for key in [
        "config_json",
        "credential",
        "secret_ref",
        "api_base",
        "base_approval",
        "local_admins",
    ] {
        assert!(
            !text.contains(&format!("\"{key}\"")),
            "metadata must not return private configuration: {body}"
        );
    }
}

fn assert_unconfirmed_observation(terminal: &Value) {
    assert_eq!(
        terminal["dropped"], "observation_checkpoint_unconfirmed",
        "{terminal}"
    );
    for field in ["receipts", "receipt", "usage", "cost_display"] {
        assert!(
            terminal.get(field).is_none(),
            "unconfirmed metadata must not fabricate or copy {field}: {terminal}"
        );
    }
}

#[test]
fn responses_accepts_empty_arguments_done_without_argument_deltas() {
    let frames = tool_wire(Kind::OpenAi, 0, &[("context", "get_context", json!({}))])
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|data| serde_json::from_str::<Value>(data).unwrap())
        .filter(|event| event["type"] != "response.function_call_arguments.delta")
        .collect::<Vec<_>>();
    let turn = feed(Kind::OpenAi, frames).unwrap();
    assert_eq!(turn.calls[0].arguments, "{}");
}
fn assert_roundtrip(body: &Value, kind: Kind, project: &str, object_context: bool) {
    let mut calls = Vec::new();
    let mut outputs = std::collections::BTreeMap::new();
    match kind {
        Kind::OpenAi => {
            for item in body["input"].as_array().unwrap() {
                if item["type"] == "function_call" {
                    calls.push((
                        item["call_id"].as_str().unwrap(),
                        item["name"].as_str().unwrap(),
                        serde_json::from_str::<Value>(item["arguments"].as_str().unwrap()).unwrap(),
                    ));
                }
                if item["type"] == "function_call_output" {
                    assert!(outputs
                        .insert(
                            item["call_id"].as_str().unwrap(),
                            serde_json::from_str::<Value>(item["output"].as_str().unwrap())
                                .unwrap()
                        )
                        .is_none());
                }
            }
        }
        Kind::Anthropic => {
            for message in body["messages"].as_array().unwrap() {
                for item in message["content"].as_array().into_iter().flatten() {
                    if item["type"] == "tool_use" {
                        calls.push((
                            item["id"].as_str().unwrap(),
                            item["name"].as_str().unwrap(),
                            item["input"].clone(),
                        ));
                    }
                    if item["type"] == "tool_result" {
                        assert!(outputs
                            .insert(
                                item["tool_use_id"].as_str().unwrap(),
                                serde_json::from_str::<Value>(
                                    item["content"][0]["text"].as_str().unwrap()
                                )
                                .unwrap()
                            )
                            .is_none());
                    }
                }
            }
        }
        Kind::Mimo => {
            for message in body["messages"].as_array().unwrap() {
                for call in message["tool_calls"].as_array().into_iter().flatten() {
                    calls.push((
                        call["id"].as_str().unwrap(),
                        call["function"]["name"].as_str().unwrap(),
                        serde_json::from_str::<Value>(
                            call["function"]["arguments"].as_str().unwrap(),
                        )
                        .unwrap(),
                    ));
                }
                if message["role"] == "tool" {
                    assert!(outputs
                        .insert(
                            message["tool_call_id"].as_str().unwrap(),
                            serde_json::from_str::<Value>(message["content"].as_str().unwrap())
                                .unwrap()
                        )
                        .is_none());
                }
            }
        }
    }
    assert_eq!(calls.len(), 2);
    assert_eq!(outputs.len(), 2);
    assert_eq!((calls[0].0, calls[0].1), ("inspect", "read_region"));
    assert_eq!((calls[1].0, calls[1].1), ("context", "get_context"));
    assert_eq!(
        calls[0].2,
        json!({"region":{"type":"bbox_xyxy","x_min":4,"y_min":4,"x_max":20,"y_max":20}})
    );
    assert_eq!(calls[1].2, json!({}));
    let image = &outputs["inspect"];
    assert_eq!(image["width"], 16);
    assert_eq!(image["height"], 16);
    assert_eq!(image["region"], json!([4, 4, 20, 20]));
    assert_eq!(
        image["transform_to_canonical"],
        json!([1.0, 0.0, 4.0, 0.0, 1.0, 4.0, 0.0, 0.0, 1.0])
    );
    let context = &outputs["context"];
    assert_eq!(context["project_id"], project);
    assert_eq!(context["allow_object_context"], object_context);
    assert_eq!(
        context["context"]["object_hashes"]
            .as_object()
            .unwrap()
            .len(),
        if object_context { 101 } else { 0 }
    );
}
