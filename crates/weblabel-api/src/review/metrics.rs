//! Voluntary actor-owned project metrics. Never changes annotations or review decisions.
use super::{require_project_role, ReviewState};
use crate::auth::{error, Principal, Role};
use annotation_domain::{
    ActivityCheckpoint, ActivityInterval, ActivitySession, ActivitySessionPage,
};
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;
use sqlx::Row;

type Failure = axum::response::Response;
fn unavailable() -> Failure {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "ACTIVITY_UNAVAILABLE",
        "Could not access local activity metrics",
    )
}
fn invalid() -> Failure {
    error(
        StatusCode::UNPROCESSABLE_ENTITY,
        "INVALID_ACTIVITY",
        "Intervals must be an ordered bounded positive-duration session",
    )
}
fn conflict() -> Failure {
    error(
        StatusCode::CONFLICT,
        "ACTIVITY_CONFLICT",
        "Session version or committed interval prefix differs",
    )
}
fn validate(intervals: &[ActivityInterval]) -> Result<(), Failure> {
    if intervals.is_empty() || intervals.len() > 10_000 {
        return Err(invalid());
    }
    let mut total = 0u64;
    for (index, interval) in intervals.iter().enumerate() {
        if interval.seq != index as u64
            || interval.duration_ms == 0
            || interval.duration_ms > 86_400_000
        {
            return Err(invalid());
        }
        total = total
            .checked_add(interval.duration_ms)
            .ok_or_else(invalid)?;
        if total > 86_400_000 {
            return Err(invalid());
        }
    }
    Ok(())
}

pub(super) async fn checkpoint(
    State(state): State<ReviewState>,
    Path((project_id, session_id)): Path<(String, String)>,
    Extension(actor): Extension<Principal>,
    body: Result<Json<ActivityCheckpoint>, JsonRejection>,
) -> Result<Json<ActivitySession>, Failure> {
    let Json(body) = body.map_err(|rejection| {
        error(
            rejection.status(),
            "INVALID_ACTIVITY",
            "Request JSON does not match activity schema",
        )
    })?;
    require_project_role(
        &state.auth,
        &actor.user_id,
        &project_id,
        &[Role::Admin, Role::Annotator, Role::Reviewer, Role::Viewer],
    )
    .await?;
    annotation_domain::document::validate_id(&session_id).map_err(|_| invalid())?;
    validate(&body.intervals)?;
    let mut tx = state
        .repository
        .begin_write()
        .await
        .map_err(|_| unavailable())?;
    let stored = sqlx::query("SELECT version,intervals_json FROM activity_sessions WHERE project_id=? AND actor_id=? AND session_id=?")
        .bind(&project_id).bind(&actor.user_id).bind(&session_id).fetch_optional(tx.connection()).await.map_err(|_| unavailable())?;
    let (version, previous) = match stored {
        Some(row) => (
            row.get::<i64, _>("version") as u64,
            serde_json::from_str::<Vec<ActivityInterval>>(&row.get::<String, _>("intervals_json"))
                .map_err(|_| unavailable())?,
        ),
        None => (0, Vec::new()),
    };
    if previous == body.intervals {
        tx.rollback().await.map_err(|_| unavailable())?;
        return Ok(Json(ActivitySession {
            session_id: session_id.into(),
            version,
            intervals: previous,
        }));
    }
    if version != body.expected_version || !body.intervals.starts_with(&previous) {
        tx.rollback().await.map_err(|_| unavailable())?;
        return Err(conflict());
    }
    let version = version
        .checked_add(1)
        .filter(|v| *v <= 9_007_199_254_740_991)
        .ok_or_else(conflict)?;
    let payload = serde_json::to_string(&body.intervals).map_err(|_| invalid())?;
    sqlx::query("INSERT INTO activity_sessions(project_id,actor_id,session_id,version,intervals_json) VALUES(?,?,?,?,?) ON CONFLICT(project_id,actor_id,session_id) DO UPDATE SET version=excluded.version,intervals_json=excluded.intervals_json")
        .bind(&project_id).bind(&actor.user_id).bind(&session_id).bind(version as i64).bind(payload).execute(tx.connection()).await.map_err(|_| unavailable())?;
    tx.commit().await.map_err(|_| unavailable())?;
    Ok(Json(ActivitySession {
        session_id: session_id.into(),
        version,
        intervals: body.intervals,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PageQuery {
    cursor: Option<String>,
    limit: Option<u32>,
}

pub(super) async fn list(
    State(state): State<ReviewState>,
    Path(project_id): Path<String>,
    Extension(actor): Extension<Principal>,
    query: Result<Query<PageQuery>, QueryRejection>,
) -> Result<Json<ActivitySessionPage>, Failure> {
    let Query(query) = query.map_err(|rejection| {
        error(
            rejection.status(),
            "INVALID_ACTIVITY",
            "Activity pagination query is invalid",
        )
    })?;
    require_project_role(
        &state.auth,
        &actor.user_id,
        &project_id,
        &[Role::Admin, Role::Annotator, Role::Reviewer, Role::Viewer],
    )
    .await?;
    let limit = query.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(invalid());
    }
    if let Some(cursor) = &query.cursor {
        annotation_domain::document::validate_id(cursor).map_err(|_| invalid())?;
    }
    let rows = sqlx::query("SELECT session_id,version,intervals_json FROM activity_sessions WHERE project_id=? AND actor_id=? AND (? IS NULL OR session_id>?) ORDER BY session_id LIMIT ?")
        .bind(project_id).bind(actor.user_id).bind(&query.cursor).bind(&query.cursor).bind(i64::from(limit)+1).fetch_all(&state.auth.pool).await.map_err(|_| unavailable())?;
    let more = rows.len() > limit as usize;
    let mut items = Vec::with_capacity(rows.len().min(limit as usize));
    for row in rows.into_iter().take(limit as usize) {
        items.push(ActivitySession {
            session_id: row.get::<String, _>("session_id").into(),
            version: row.get::<i64, _>("version") as u64,
            intervals: serde_json::from_str(&row.get::<String, _>("intervals_json"))
                .map_err(|_| unavailable())?,
        });
    }
    let next_cursor = if more {
        items.last().map(|s| s.session_id.clone())
    } else {
        None
    };
    Ok(Json(ActivitySessionPage { items, next_cursor }))
}
