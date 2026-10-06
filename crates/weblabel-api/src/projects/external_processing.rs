use annotation_domain::ExternalProcessingPolicy;
use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use sqlx::Row;

use crate::{
    auth::{error, AuthState, Principal},
    storage::Repository,
};

#[derive(Clone)]
struct PolicyState {
    auth: AuthState,
    repository: Repository,
}

pub(super) fn router(auth: AuthState, repository: Repository) -> Router {
    Router::new()
        .route(
            "/api/projects/{project_id}/external-processing-policy",
            get(read).put(update),
        )
        .route_layer(middleware::from_fn_with_state(
            auth.clone(),
            crate::auth::authenticate,
        ))
        .route_layer(middleware::from_fn_with_state(
            auth.clone(),
            crate::auth::csrf_and_origin,
        ))
        .with_state(PolicyState { auth, repository })
}

async fn read(
    State(state): State<PolicyState>,
    Extension(principal): Extension<Principal>,
    Path(project_id): Path<String>,
) -> Response {
    // Membership and policy are one database snapshot; platform admin is not a membership.
    match sqlx::query("SELECT p.allow_external_processing FROM projects p JOIN memberships m ON m.project_id=p.project_id WHERE p.project_id=? AND m.user_id=?")
        .bind(&project_id).bind(&principal.user_id).fetch_optional(&state.auth.pool).await {
        Ok(Some(row)) => Json(ExternalProcessingPolicy { allow_external_processing: row.get::<i64, _>("allow_external_processing") == 1 }).into_response(),
        Ok(None) => not_found(),
        Err(_) => failed(),
    }
}

async fn update(
    State(state): State<PolicyState>,
    Extension(principal): Extension<Principal>,
    Path(project_id): Path<String>,
    body: Result<Json<ExternalProcessingPolicy>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_EXTERNAL_PROCESSING_POLICY",
            "allow_external_processing must be a boolean; no other fields are accepted",
        );
    };
    let mut tx = match state.repository.begin_write().await {
        Ok(tx) => tx,
        Err(_) => return failed(),
    };
    let membership = sqlx::query_scalar::<_, String>(
        "SELECT role FROM memberships WHERE project_id=? AND user_id=?",
    )
    .bind(&project_id)
    .bind(&principal.user_id)
    .fetch_optional(tx.connection())
    .await;
    match membership {
        Ok(Some(role)) if role == "admin" => {}
        Ok(Some(_)) => {
            return error(
                StatusCode::FORBIDDEN,
                "PROJECT_ADMIN_REQUIRED",
                "Project admin role required",
            )
        }
        Ok(None) => return not_found(),
        Err(_) => return failed(),
    }
    let result = async {
        sqlx::query("UPDATE projects SET allow_external_processing=? WHERE project_id=?")
            .bind(i64::from(body.allow_external_processing)).bind(&project_id).execute(tx.connection()).await?;
        if !body.allow_external_processing {
            // Deny future reads immediately after commit; the worker asynchronously stops
            // in-flight provider processes. Already transmitted data cannot be recalled.
            sqlx::query("UPDATE model_runs SET cancel_requested=1 WHERE project_id=? AND state IN ('queued','running') AND provider_id IN ('openai_api','anthropic_api','mimo_api','codex_local','claude_local')")
                .bind(&project_id).execute(tx.connection()).await?;
        }
        Ok::<_, sqlx::Error>(())
    }.await;
    if result.is_err() || tx.commit().await.is_err() {
        return failed();
    }
    Json(body).into_response()
}

fn not_found() -> Response {
    error(
        StatusCode::NOT_FOUND,
        "PROJECT_NOT_FOUND",
        "Project not found",
    )
}
fn failed() -> Response {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "EXTERNAL_PROCESSING_POLICY_FAILED",
        "Could not read or update project external-processing policy",
    )
}
