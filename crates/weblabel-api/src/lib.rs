//! Local Axum service and its SQLite/object-store state.

pub mod config;
pub mod storage;

use std::sync::atomic::{AtomicU64, Ordering};

use crate::{config::ServerConfig, storage::Repository};
use annotation_domain::{ApiError, Id};
use axum::{
    extract::{Extension, State},
    http::{header::HeaderValue, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};

#[derive(Clone)]
pub struct AppState {
    pub repository: Repository,
}

impl AppState {
    pub async fn open(config: &ServerConfig) -> Result<Self, sqlx::Error> {
        let repository = Repository::open(
            &config.database_url,
            &config.object_root,
            config.write_timeout,
        )
        .await?;
        Ok(Self { repository })
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .fallback(not_found)
        .with_state(state)
        .layer(middleware::from_fn(request_id))
}

async fn health(State(_state): State<AppState>) -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn not_found(Extension(request_id): Extension<RequestId>) -> ApiErrorResponse {
    ApiErrorResponse::new(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        "Route not found",
        request_id.0,
    )
}

async fn request_id(mut request: Request<axum::body::Body>, next: Next) -> Response {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let id = request
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        })
        .map(str::to_owned)
        .unwrap_or_else(|| format!("req-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed)));
    tracing::debug!(
        request_id = %id,
        method = %request.method(),
        path = %request.uri().path(),
        "handling local API request"
    );
    request.extensions_mut().insert(RequestId(id.clone()));
    let mut response = next.run(request).await;
    if let Ok(value) = HeaderValue::from_str(&id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response
}

#[derive(Clone, Debug)]
pub struct RequestId(pub String);

pub struct ApiErrorResponse {
    status: StatusCode,
    error: ApiError,
}

impl ApiErrorResponse {
    fn new(status: StatusCode, code: &str, message: &str, request_id: String) -> Self {
        Self {
            status,
            error: ApiError {
                code: code.to_owned(),
                message: message.to_owned(),
                request_id: Id::from(request_id),
                details: None,
            },
        }
    }
}

impl IntoResponse for ApiErrorResponse {
    fn into_response(self) -> Response {
        (self.status, Json(self.error)).into_response()
    }
}
