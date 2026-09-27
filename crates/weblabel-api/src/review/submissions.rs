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
pub(super) struct SubmitRequest {
    annotation_revision_ids: Vec<String>,
}
pub(super) async fn submit(
    State(state): State<ReviewState>,
    Path(task_id): Path<String>,
    Extension(actor): Extension<Principal>,
    Json(body): Json<SubmitRequest>,
) -> Result<Json<Value>, axum::response::Response> {
    if body.annotation_revision_ids.len() != 1 {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_SUBMISSION",
            "A task submission must identify exactly its immutable annotation revision",
        ));
    }
    let mut tx = state.repository.begin_write().await.map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not begin submission",
        )
    })?;
    let task=sqlx::query("SELECT project_id,asset_revision_id,ontology_version_id,assignee_id,state FROM review_tasks WHERE task_id=?").bind(&task_id).fetch_optional(tx.connection()).await.map_err(|_|error(StatusCode::SERVICE_UNAVAILABLE,"REVIEW_UNAVAILABLE","Could not read task"))?.ok_or_else(||error(StatusCode::NOT_FOUND,"TASK_NOT_FOUND","Task does not exist"))?;
    let project: String = task.get("project_id");
    let asset: String = task.get("asset_revision_id");
    let ontology: String = task.get("ontology_version_id");
    let assignee: String = task.get("assignee_id");
    let task_state: String = task.get("state");
    require_project_role(
        &state.auth,
        &actor.user_id,
        &project,
        &[Role::Annotator, Role::Admin],
    )
    .await?;
    if assignee != actor.user_id && !actor.platform_admin {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::FORBIDDEN,
            "TASK_NOT_ASSIGNED",
            "Only the assigned annotator may submit",
        ));
    }
    if task_state != "open" {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::CONFLICT,
            "TASK_NOT_OPEN",
            "Only open tasks can receive a submission",
        ));
    }
    let lease =
        sqlx::query("SELECT holder_id,fencing_token,expires_at FROM task_leases WHERE task_id=?")
            .bind(&task_id)
            .fetch_optional(tx.connection())
            .await
            .map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "REVIEW_UNAVAILABLE",
                    "Could not verify task lease",
                )
            })?
            .ok_or_else(|| {
                error(
                    StatusCode::CONFLICT,
                    "LEASE_REQUIRED",
                    "An active task lease is required",
                )
            })?;
    if lease.get::<Option<String>, _>("holder_id").as_deref() != Some(actor.user_id.as_str())
        || lease.get::<i64, _>("expires_at") <= chrono::Utc::now().timestamp()
    {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::CONFLICT,
            "LEASE_EXPIRED",
            "A current task lease is required",
        ));
    }
    let rev=sqlx::query("SELECT body_json FROM annotation_revisions WHERE annotation_revision_id=? AND project_id=? AND asset_revision_id=? AND ontology_version_id=?").bind(&body.annotation_revision_ids[0]).bind(&project).bind(&asset).bind(&ontology).fetch_optional(tx.connection()).await.map_err(|_|error(StatusCode::SERVICE_UNAVAILABLE,"REVIEW_UNAVAILABLE","Could not read revision"))?.ok_or_else(||error(StatusCode::UNPROCESSABLE_ENTITY,"REVISION_MISMATCH","Revision must belong to task media and ontology"))?;
    let document: Value = serde_json::from_str(rev.get::<String, _>("body_json").as_str())
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "REVISION_INVALID",
                "Stored annotation revision is invalid",
            )
        })?;
    let completion = document.get("completion").and_then(Value::as_str);
    let empty = document
        .get("objects")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty);
    if completion == Some("confirmed_negative") && !empty {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_NEGATIVE",
            "Confirmed negative requires an empty object list",
        ));
    }
    if empty && completion != Some("confirmed_negative") {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "EMPTY_NOT_NEGATIVE",
            "An empty annotation must be explicitly confirmed negative",
        ));
    }
    if completion != Some("complete") && completion != Some("confirmed_negative") {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "ANNOTATION_INCOMPLETE",
            "Unprocessed or in-progress annotations cannot be submitted",
        ));
    }
    let current=sqlx::query_scalar::<_,String>("SELECT annotation_revision_id FROM annotation_heads WHERE project_id=? AND asset_revision_id=? AND ontology_version_id=?").bind(&project).bind(&asset).bind(&ontology).fetch_optional(tx.connection()).await.map_err(|_|error(StatusCode::SERVICE_UNAVAILABLE,"REVIEW_UNAVAILABLE","Could not verify current annotation head"))?;
    if current.as_deref() != Some(body.annotation_revision_ids[0].as_str()) {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::CONFLICT,
            "REVISION_NOT_HEAD",
            "Submission must identify the current saved revision",
        ));
    }
    let review_id = uuid::Uuid::new_v4().to_string();
    let now = crate::projects::now_rfc3339();
    sqlx::query("INSERT INTO review_submissions(review_id,task_id,project_id,submitted_by,revision_ids_json,state,created_at) VALUES(?,?,?,?,?,'pending',?)").bind(&review_id).bind(&task_id).bind(&project).bind(&actor.user_id).bind(serde_json::to_string(&body.annotation_revision_ids).unwrap_or_default()).bind(&now).execute(tx.connection()).await.map_err(|_|error(StatusCode::CONFLICT,"SUBMISSION_CONFLICT","Task already has a pending submission"))?;
    let changed =
        sqlx::query("UPDATE review_tasks SET state='submitted' WHERE task_id=? AND state='open'")
            .bind(&task_id)
            .execute(tx.connection())
            .await
            .map_err(|_| {
                error(
                    StatusCode::CONFLICT,
                    "TASK_STATE_CONFLICT",
                    "Task is not open",
                )
            })?;
    if changed.rows_affected() != 1 {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::CONFLICT,
            "TASK_STATE_CONFLICT",
            "Task is not open",
        ));
    }
    tx.commit().await.map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not commit submission",
        )
    })?;
    Ok(Json(
        json!({"review_id":review_id,"task_id":task_id,"revision_ids":body.annotation_revision_ids,"state":"pending","created_at":now}),
    ))
}
