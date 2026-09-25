mod idempotency;
mod revision;
mod save;

use axum::{extract::DefaultBodyLimit, middleware, routing::get, Router};

use crate::{auth::AuthState, storage::Repository};

pub(crate) const MAX_ANNOTATION_BODY_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct AnnotationState {
    pub(crate) repository: Repository,
    pub(crate) auth: AuthState,
}

pub fn router(repository: Repository, auth: AuthState) -> Router {
    let state = AnnotationState {
        repository,
        auth: auth.clone(),
    };
    Router::new()
        .route(
            "/api/assets/{asset_revision_id}/annotation",
            get(revision::head).put(save::put),
        )
        .route(
            "/api/annotation-revisions/{annotation_revision_id}",
            get(revision::historical),
        )
        .route_layer(middleware::from_fn_with_state(
            auth.clone(),
            crate::auth::authenticate,
        ))
        .route_layer(middleware::from_fn_with_state(
            auth,
            crate::auth::csrf_and_origin,
        ))
        .layer(DefaultBodyLimit::max(MAX_ANNOTATION_BODY_BYTES))
        .with_state(state)
}

#[derive(Clone, Copy)]
pub(crate) struct Failure {
    pub(crate) status: axum::http::StatusCode,
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
}

impl Failure {
    pub(crate) const fn new(
        status: axum::http::StatusCode,
        code: &'static str,
        message: &'static str,
    ) -> Self {
        Self {
            status,
            code,
            message,
        }
    }

    pub(crate) fn into_response(self) -> axum::response::Response {
        crate::auth::error(self.status, self.code, self.message)
    }
}
