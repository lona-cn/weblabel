//! AI subsystem: persistent model runs, immutable predictions, suggestion sets
//! and the monotonic run event stream.

pub mod acceptance;
pub mod events;
pub mod predictions;
pub mod runs;
pub mod suggestions;

use axum::{
    extract::DefaultBodyLimit,
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

use crate::jobs::model_jobs;
use crate::{
    auth::{self, AuthState},
    storage::Repository,
};

pub use runs::MOCK_PROFILE_ID;

#[derive(Clone)]
pub(crate) struct AiState {
    pub(crate) repository: Repository,
    /// The built-in labeled mock source is only resolvable outside production.
    pub(crate) allow_mock_runs: bool,
    /// Run-scoped bearer tokens for `/internal/agent-tools/{tool}` (C5).
    pub(crate) run_tokens: crate::runtime::run_tokens::RunTokenStore,
}

pub fn router(
    repository: Repository,
    auth: AuthState,
    allow_mock_runs: bool,
    run_tokens: crate::runtime::run_tokens::RunTokenStore,
) -> Router {
    let state = AiState {
        repository,
        allow_mock_runs,
        run_tokens,
    };
    let mut app = Router::new()
        .route("/api/ai/runs", post(runs::create))
        .route("/api/ai/runs/{run_id}/cancel", post(runs::cancel_route))
        .route("/api/ai/runs/{run_id}/events", get(events::list))
        .route("/api/ai/runs/{run_id}/suggestions", get(suggestions::list))
        .route("/api/jobs/{job_id}", get(model_jobs::job_status));
    // Test builds only: drains the shared job queue through the real worker
    // path. Release builds do not compile this entry point.
    #[cfg(debug_assertions)]
    {
        app = app.route("/internal/test/jobs/drain", post(model_jobs::drain));
    }
    app.route_layer(middleware::from_fn_with_state(
        auth.clone(),
        auth::authenticate,
    ))
    .route_layer(middleware::from_fn_with_state(auth, auth::csrf_and_origin))
    .layer(DefaultBodyLimit::max(runs::MAX_RUN_REQUEST_BYTES))
    .with_state(state)
}

/// Builds an ApiError response with a dynamic message.
pub(crate) fn failure_response(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({
            "code": code,
            "message": message,
            "request_id": uuid::Uuid::new_v4().to_string(),
            "details": null
        })),
    )
        .into_response()
}

const SECRET_KEY_FRAGMENTS: [&str; 11] = [
    "secret",
    "token",
    "password",
    "passwd",
    "authorization",
    "cookie",
    "credential",
    "api_key",
    "apikey",
    "api-key",
    "private_key",
];

fn token_core(token: &str) -> &str {
    token.trim_matches(|character: char| {
        character.is_ascii_punctuation() && character != '_' && character != '-'
    })
}

/// Redacts secret-looking tokens from untrusted text output.
pub(crate) fn redact_text(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut redact_next = false;
    for token in input.split_inclusive(char::is_whitespace) {
        let trimmed = token.trim_end_matches(char::is_whitespace);
        let trailing = &token[trimmed.len()..];
        let core = token_core(trimmed);
        let lower = core.to_ascii_lowercase();
        let mut redacted = false;
        if redact_next && !core.is_empty() {
            redacted = true;
            redact_next = false;
        }
        if !core.is_empty() {
            if lower.starts_with("sk-")
                || lower.starts_with("ghp_")
                || lower.starts_with("gho_")
                || lower.starts_with("xoxb-")
                || lower.starts_with("xoxp-")
                || lower.starts_with("akia")
                || lower.starts_with("ya29.")
                || (lower.starts_with("eyj") && core.matches('.').count() >= 2)
            {
                redacted = true;
            }
            let keyword = lower.trim_end_matches(':');
            if keyword == "bearer" || keyword == "authorization" {
                redact_next = true;
            }
        }
        if redacted {
            output.push_str("[REDACTED]");
        } else {
            output.push_str(trimmed);
        }
        output.push_str(trailing);
    }
    output
}

/// Recursively redacts secret-looking keys and values from untrusted JSON.
pub(crate) fn redact_json(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, entry) in map.iter_mut() {
                let lower = key.to_ascii_lowercase();
                if SECRET_KEY_FRAGMENTS
                    .iter()
                    .any(|fragment| lower.contains(fragment))
                {
                    *entry = Value::String("[REDACTED]".to_owned());
                } else {
                    redact_json(entry);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_json(item);
            }
        }
        Value::String(text) => {
            *text = redact_text(text);
        }
        _ => {}
    }
}
