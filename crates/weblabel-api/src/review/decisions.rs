use super::{require_project_role, ReviewState};
use crate::auth::{error, Principal, Role};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
#[derive(Deserialize)]
pub(super) struct DecisionRequest {
    decision: String,
    reason: String,
    revision_ids: Vec<String>,
}
pub(super) async fn decide(
    State(state): State<ReviewState>,
    Path(review_id): Path<String>,
    Extension(actor): Extension<Principal>,
    Json(body): Json<DecisionRequest>,
) -> Result<Json<Value>, axum::response::Response> {
    if !["approve", "reject"].contains(&body.decision.as_str())
        || body.reason.trim().is_empty()
        || body.reason.len() > 4096
    {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_REVIEW_DECISION",
            "Decision must be approve/reject with a nonempty reason",
        ));
    }
    let mut tx = state.repository.begin_write().await.map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not begin review decision",
        )
    })?;
    let record=sqlx::query("SELECT s.task_id,s.project_id,s.submitted_by,s.revision_ids_json,s.state,t.asset_revision_id,t.ontology_version_id FROM review_submissions s JOIN review_tasks t ON t.task_id=s.task_id WHERE s.review_id=?").bind(&review_id).fetch_optional(tx.connection()).await.map_err(|_|error(StatusCode::SERVICE_UNAVAILABLE,"REVIEW_UNAVAILABLE","Could not read submission"))?.ok_or_else(||error(StatusCode::NOT_FOUND,"REVIEW_NOT_FOUND","Review does not exist"))?;
    let project: String = record.get("project_id");
    let submitted_by: String = record.get("submitted_by");
    let expected: Vec<String> = serde_json::from_str(
        record.get::<String, _>("revision_ids_json").as_str(),
    )
    .map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "REVIEW_INVALID",
            "Stored review revisions are invalid",
        )
    })?;
    require_project_role(
        &state.auth,
        &actor.user_id,
        &project,
        &[Role::Reviewer, Role::Admin],
    )
    .await?;
    if record.get::<String, _>("state") != "pending" {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::CONFLICT,
            "REVIEW_ALREADY_DECIDED",
            "Review is no longer pending",
        ));
    }
    if body.revision_ids != expected {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::CONFLICT,
            "REVIEW_REVISION_MISMATCH",
            "Decision must bind exactly the submitted revision IDs",
        ));
    }
    let allow_self: i64 =
        sqlx::query_scalar("SELECT allow_self_review FROM projects WHERE project_id=?")
            .bind(&project)
            .fetch_one(tx.connection())
            .await
            .map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "REVIEW_UNAVAILABLE",
                    "Could not read project policy",
                )
            })?;
    if allow_self == 0 && submitted_by == actor.user_id {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::FORBIDDEN,
            "SELF_REVIEW_FORBIDDEN",
            "Project policy forbids reviewing your own annotation",
        ));
    }
    let now = crate::projects::now_rfc3339();
    sqlx::query("INSERT INTO review_decisions(review_id,decided_by,decision,reason,revision_ids_json,created_at) VALUES(?,?,?,?,?,?)").bind(&review_id).bind(&actor.user_id).bind(&body.decision).bind(body.reason.trim()).bind(serde_json::to_string(&expected).unwrap_or_default()).bind(&now).execute(tx.connection()).await.map_err(|_|error(StatusCode::CONFLICT,"REVIEW_ALREADY_DECIDED","Review already has a decision"))?;
    sqlx::query("UPDATE review_submissions SET state=? WHERE review_id=? AND state='pending'")
        .bind(if body.decision == "approve" {
            "approved"
        } else {
            "rejected"
        })
        .bind(&review_id)
        .execute(tx.connection())
        .await
        .map_err(|_| {
            error(
                StatusCode::CONFLICT,
                "REVIEW_ALREADY_DECIDED",
                "Review already has a decision",
            )
        })?;
    let next_task_state = if body.decision == "approve" {
        "closed"
    } else {
        "open"
    };
    sqlx::query("UPDATE review_tasks SET state=? WHERE task_id=? AND state='submitted'")
        .bind(next_task_state)
        .bind(record.get::<String, _>("task_id"))
        .execute(tx.connection())
        .await
        .map_err(|_| {
            error(
                StatusCode::CONFLICT,
                "TASK_STATE_CONFLICT",
                "Task state changed before review decision",
            )
        })?;
    tx.commit().await.map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not commit review decision",
        )
    })?;
    Ok(Json(
        json!({"review_id":review_id,"decision":body.decision,"reason":body.reason.trim(),"revision_ids":expected,"decided_by":actor.user_id,"created_at":now}),
    ))
}
