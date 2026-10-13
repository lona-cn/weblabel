//! Read-only public readiness; no account, object or filesystem details leave this route.
use axum::{extract::State, http::{header, StatusCode}, response::{IntoResponse, Response}, Json};
use serde::Serialize;
use crate::AppState;

#[derive(Serialize)]
struct Readiness {
    ready: bool,
    mode: &'static str,
}

pub async fn ready(State(state): State<AppState>) -> Response {
    let maintenance = state.auth.password_recovery_enabled();
    let ready = !maintenance
        && matches!(tokio::time::timeout(std::time::Duration::from_secs(2), state.repository.readiness()).await, Ok(Ok(())));
    (
        if ready { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE },
        [(header::CACHE_CONTROL, "no-store")],
        Json(Readiness { ready, mode: if maintenance { "password_recovery" } else { "normal" } }),
    ).into_response()
}
