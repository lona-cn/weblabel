use super::project_role;
use crate::auth::{error, AuthState, Principal, Role};
use annotation_domain::{Id, ProjectMember, ProjectMemberPage, ProjectMemberRole};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use sqlx::Row;

#[derive(Deserialize)]
pub(super) struct MemberQuery {
    limit: Option<usize>,
    cursor: Option<String>,
}

pub(super) async fn list(
    State(state): State<AuthState>,
    Path(project_id): Path<String>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<MemberQuery>,
) -> Response {
    match project_role(&state, &principal.user_id, &project_id).await {
        Ok(Some(Role::Admin)) => {}
        Ok(Some(_)) => {
            return error(
                StatusCode::FORBIDDEN,
                "PROJECT_ADMIN_REQUIRED",
                "Project administrator required",
            )
        }
        Ok(None) => {
            return error(
                StatusCode::NOT_FOUND,
                "PROJECT_NOT_FOUND",
                "Project not found",
            )
        }
        Err(_) => return failed(),
    }
    let limit = query.limit.unwrap_or(100);
    if !(1..=100).contains(&limit) {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_LIMIT",
            "limit must be 1–100",
        );
    }
    let rows = match sqlx::query("SELECT m.user_id,u.username,m.role FROM memberships m JOIN users u ON u.user_id=m.user_id WHERE m.project_id=? AND (? IS NULL OR m.user_id>?) ORDER BY m.user_id LIMIT ?")
        .bind(&project_id).bind(&query.cursor).bind(&query.cursor).bind((limit+1) as i64).fetch_all(&state.pool).await {
        Ok(rows) => rows, Err(_) => return failed(),
    };
    let next_cursor = if rows.len() > limit {
        rows[limit - 1].try_get::<String, _>("user_id").ok()
    } else {
        None
    };
    let items: Result<Vec<_>, sqlx::Error> = rows
        .iter()
        .take(limit)
        .map(|row| {
            let role = match row.try_get::<String, _>("role")?.as_str() {
                "admin" => ProjectMemberRole::Admin,
                "annotator" => ProjectMemberRole::Annotator,
                "reviewer" => ProjectMemberRole::Reviewer,
                "viewer" => ProjectMemberRole::Viewer,
                _ => return Err(sqlx::Error::Protocol("Invalid project member role".into())),
            };
            Ok(ProjectMember {
                user_id: Id::from(row.try_get::<String, _>("user_id")?),
                username: row.try_get("username")?,
                role,
            })
        })
        .collect();
    match items {
        Ok(items) => Json(ProjectMemberPage { items, next_cursor }).into_response(),
        Err(_) => failed(),
    }
}

fn failed() -> Response {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "PROJECT_MEMBER_READ_FAILED",
        "Could not read project members",
    )
}
