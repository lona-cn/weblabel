mod csrf;
pub(crate) mod password;
mod policy;
mod session;
pub use password::{hash as hash_password, verify as verify_password};
pub use policy::{hash_launch_code, verify_launch_code, AuthConfig, AuthState, Principal, Role};
pub use session::router;

use axum::{
    body::Body,
    extract::State,
    http::{header, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

pub(crate) fn error(status: StatusCode, code: &'static str, message: &'static str) -> Response {
    let request_id = uuid::Uuid::new_v4().to_string();
    (
        status,
        Json(json!({"code": code, "message": message, "request_id": request_id, "details": null})),
    )
        .into_response()
}

pub(crate) async fn authenticate(
    State(state): State<AuthState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let Some(token) = cookie_value(request.headers(), "weblabel_session") else {
        return error(
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
            "Authentication required",
        );
    };
    match session::principal(&state, &token).await {
        Ok(Some(principal)) => {
            let mut request = request;
            request.extensions_mut().insert(principal);
            next.run(request).await
        }
        Ok(None) => error(
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
            "Authentication required",
        ),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "AUTHENTICATION_FAILED",
            "Authentication failed",
        ),
    }
}

/// Host/Origin gate for bearer-only agent tools. No session cookie can grant
/// tool permissions; the tool handler still performs the run-token checks.
pub(crate) async fn host_and_origin(
    State(state): State<AuthState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if let Some(response) = policy::check_host_and_origin(&state, &request) {
        return response;
    }
    next.run(request).await
}

pub(crate) async fn csrf_and_origin(
    State(state): State<AuthState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if let Some(response) = policy::check_request(&state, &request) {
        return response;
    }
    let method = request.method().as_str();
    if !matches!(method, "GET" | "HEAD" | "OPTIONS") {
        if let Some(token) = cookie_value(request.headers(), "weblabel_session") {
            // Replacing an expired credential is not an authenticated mutation.
            // Active sessions still require CSRF; Host/Origin were checked above.
            if request.uri().path() == "/api/session/login" {
                match session::principal(&state, &token).await {
                    Ok(None) => return next.run(request).await,
                    Ok(Some(_)) => {}
                    Err(_) => {
                        return error(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "AUTHENTICATION_FAILED",
                            "Authentication failed",
                        )
                    }
                }
            }
            let Some(csrf) = request
                .headers()
                .get("x-csrf-token")
                .and_then(|v| v.to_str().ok())
            else {
                return error(
                    StatusCode::FORBIDDEN,
                    "CSRF_REQUIRED",
                    "CSRF token required",
                );
            };
            match session::validate_csrf(&state, &token, csrf).await {
                Ok(true) => {}
                Ok(false) => {
                    return error(
                        StatusCode::FORBIDDEN,
                        "CSRF_INVALID",
                        "CSRF token is invalid",
                    )
                }
                Err(_) => {
                    return error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "AUTHENTICATION_FAILED",
                        "Authentication failed",
                    )
                }
            }
        }
    }
    next.run(request).await
}

pub(crate) fn cookie_value(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (key == name && !value.is_empty()).then(|| value.to_owned())
        })
}
