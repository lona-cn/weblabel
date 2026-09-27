use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use super::{require_project_role, ReviewState, LEASE_SECONDS};
use crate::auth::{error, Principal, Role};

pub fn validate_fencing(current: i64, supplied: i64) -> Result<(), &'static str> {
    if current == supplied {
        Ok(())
    } else {
        Err("STALE_FENCING_TOKEN")
    }
}

#[derive(Deserialize)]
pub(super) struct LeaseRequest {
    action: String,
    holder_id: Option<String>,
}

pub(super) async fn lease(
    State(state): State<ReviewState>,
    Path(task_id): Path<String>,
    Extension(actor): Extension<Principal>,
    Json(body): Json<LeaseRequest>,
) -> Result<Json<Value>, axum::response::Response> {
    if !["acquire", "renew", "release", "transfer"].contains(&body.action.as_str()) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "INVALID_LEASE_ACTION",
            "Action must be acquire, renew, release, or transfer",
        ));
    }
    if body.action == "transfer" && body.holder_id.is_none() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "TRANSFER_TARGET_REQUIRED",
            "Transfer requires a target holder_id",
        ));
    }
    let mut tx = state.repository.begin_write().await.map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not begin lease transaction",
        )
    })?;
    let row = sqlx::query("SELECT project_id,assignee_id,state FROM review_tasks WHERE task_id=?")
        .bind(&task_id)
        .fetch_optional(tx.connection())
        .await
        .map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "REVIEW_UNAVAILABLE",
                "Could not read task",
            )
        })?
        .ok_or_else(|| {
            error(
                StatusCode::NOT_FOUND,
                "TASK_NOT_FOUND",
                "Task does not exist",
            )
        })?;
    let project: String = row.get("project_id");
    let assigned: String = row.get("assignee_id");
    let is_transfer = body.action == "transfer";
    let minimum = if is_transfer {
        &[Role::Admin][..]
    } else {
        &[Role::Annotator, Role::Admin][..]
    };
    require_project_role(&state.auth, &actor.user_id, &project, minimum).await?;
    if !is_transfer && assigned != actor.user_id && !actor.platform_admin {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::FORBIDDEN,
            "TASK_NOT_ASSIGNED",
            "Task is assigned to another annotator",
        ));
    }
    if row.get::<String, _>("state") != "open" {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::CONFLICT,
            "TASK_NOT_OPEN",
            "Only open tasks can be leased",
        ));
    }
    let now = chrono::Utc::now().timestamp();
    let existing =
        sqlx::query("SELECT holder_id,fencing_token,expires_at FROM task_leases WHERE task_id=?")
            .bind(&task_id)
            .fetch_optional(tx.connection())
            .await
            .map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "REVIEW_UNAVAILABLE",
                    "Could not read lease",
                )
            })?;
    let (holder, token, expires) = existing
        .map(|r| {
            (
                r.get::<Option<String>, _>("holder_id"),
                r.get::<i64, _>("fencing_token"),
                r.get::<i64, _>("expires_at"),
            )
        })
        .unwrap_or((None, 0, 0));
    let (new_holder, new_token, until) = match body.action.as_str() {
        "acquire" => {
            if expires > now {
                if holder.as_deref() == Some(actor.user_id.as_str()) {
                    (actor.user_id.clone(), token, expires)
                } else {
                    let _ = tx.rollback().await;
                    return Err(error(
                        StatusCode::CONFLICT,
                        "TASK_LEASED",
                        "Task is leased by another annotator",
                    ));
                }
            } else {
                let next = token.checked_add(1).ok_or_else(|| {
                    error(
                        StatusCode::CONFLICT,
                        "FENCING_EXHAUSTED",
                        "Lease fencing counter exhausted",
                    )
                })?;
                (actor.user_id.clone(), next, now + LEASE_SECONDS)
            }
        }
        "transfer" => {
            let target = body.holder_id.clone().expect("checked transfer target");
            if require_project_role(
                &state.auth,
                &target,
                &project,
                &[Role::Annotator, Role::Admin],
            )
            .await
            .is_err()
            {
                let _ = tx.rollback().await;
                return Err(error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "INVALID_ASSIGNEE",
                    "Transfer target must be a project annotator or admin",
                ));
            }
            let next = token.checked_add(1).ok_or_else(|| {
                error(
                    StatusCode::CONFLICT,
                    "FENCING_EXHAUSTED",
                    "Lease fencing counter exhausted",
                )
            })?;
            sqlx::query("UPDATE review_tasks SET assignee_id=? WHERE task_id=? AND state='open'")
                .bind(&target)
                .bind(&task_id)
                .execute(tx.connection())
                .await
                .map_err(|_| {
                    error(
                        StatusCode::CONFLICT,
                        "TASK_STATE_CONFLICT",
                        "Task cannot be transferred",
                    )
                })?;
            (target, next, now + LEASE_SECONDS)
        }
        "renew" => {
            if expires <= now || holder.as_deref() != Some(actor.user_id.as_str()) {
                let _ = tx.rollback().await;
                return Err(error(
                    StatusCode::CONFLICT,
                    "LEASE_EXPIRED",
                    "Only the current unexpired holder can renew",
                ));
            }
            (actor.user_id.clone(), token, now + LEASE_SECONDS)
        }
        _ => {
            if expires <= now || holder.as_deref() != Some(actor.user_id.as_str()) {
                let _ = tx.rollback().await;
                return Err(error(
                    StatusCode::CONFLICT,
                    "LEASE_EXPIRED",
                    "Only the current holder can release an unexpired lease",
                ));
            }
            sqlx::query("UPDATE task_leases SET holder_id=NULL,expires_at=?,updated_at=? WHERE task_id=? AND holder_id=? AND fencing_token=?").bind(now).bind(now).bind(&task_id).bind(&actor.user_id).bind(token).execute(tx.connection()).await.map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "REVIEW_UNAVAILABLE", "Could not release lease"))?;
            tx.commit().await.map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "REVIEW_UNAVAILABLE",
                    "Could not commit lease release",
                )
            })?;
            return Ok(Json(
                json!({"task_id":task_id,"holder_id":null,"fencing_token":token,"expires_at_unix":now,"lease_seconds":LEASE_SECONDS,"heartbeat_seconds":20}),
            ));
        }
    };
    sqlx::query("INSERT INTO task_leases(task_id,holder_id,fencing_token,expires_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET holder_id=excluded.holder_id,fencing_token=excluded.fencing_token,expires_at=excluded.expires_at,updated_at=excluded.updated_at")
        .bind(&task_id).bind(&new_holder).bind(new_token).bind(until).bind(now).execute(tx.connection()).await.map_err(|_| error(StatusCode::CONFLICT, "TASK_LEASED", "Could not update task lease"))?;
    tx.commit().await.map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not commit lease",
        )
    })?;
    Ok(Json(
        json!({"task_id":task_id,"holder_id":new_holder,"fencing_token":new_token,"expires_at_unix":until,"lease_seconds":LEASE_SECONDS,"heartbeat_seconds":20}),
    ))
}
