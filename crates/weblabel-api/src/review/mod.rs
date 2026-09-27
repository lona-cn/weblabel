pub mod decisions;
pub mod issues;
pub mod leases;
pub mod submissions;
pub mod tasks;

use crate::{auth::AuthState, storage::Repository};
use axum::{
    middleware,
    routing::{get, post},
    Router,
};

#[derive(Clone)]
pub(super) struct ReviewState {
    pub repository: Repository,
    pub auth: AuthState,
}

pub fn router(repository: Repository, auth: AuthState) -> Router {
    let state = ReviewState {
        repository,
        auth: auth.clone(),
    };
    Router::new()
        .route(
            "/api/projects/{project_id}/tasks",
            get(tasks::list).post(tasks::create),
        )
        .route("/api/tasks/{task_id}/lease", post(leases::lease))
        .route("/api/tasks/{task_id}/submit", post(submissions::submit))
        .route("/api/reviews/{review_id}/decision", post(decisions::decide))
        .route(
            "/api/reviews/{review_id}/issues",
            get(issues::list).post(issues::create),
        )
        .route_layer(middleware::from_fn_with_state(
            auth.clone(),
            crate::auth::authenticate,
        ))
        .route_layer(middleware::from_fn_with_state(
            auth,
            crate::auth::csrf_and_origin,
        ))
        .with_state(state)
}

pub async fn require_project_role(
    auth: &AuthState,
    user: &str,
    project: &str,
    minimum: &[crate::auth::Role],
) -> Result<crate::auth::Role, axum::response::Response> {
    match crate::projects::project_role(auth, user, project).await {
        Ok(Some(role)) if minimum.contains(&role) => Ok(role),
        Ok(_) => Err(crate::auth::error(
            axum::http::StatusCode::FORBIDDEN,
            "PROJECT_ROLE_REQUIRED",
            "Project role does not permit this action",
        )),
        Err(_) => Err(crate::auth::error(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not check project membership",
        )),
    }
}

pub(super) const LEASE_SECONDS: i64 = 60;
