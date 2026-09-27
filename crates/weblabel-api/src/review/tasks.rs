use super::{require_project_role, ReviewState};
use crate::{
    auth::{error, Principal, Role},
    projects::now_rfc3339,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub(super) struct CreateTask {
    project_id: Option<String>,
    asset_revision_id: String,
    ontology_version_id: String,
    assignee_id: String,
}

pub(super) async fn create(
    State(state): State<ReviewState>,
    Path(project_id): Path<String>,
    Extension(actor): Extension<Principal>,
    Json(body): Json<CreateTask>,
) -> Result<Json<Value>, axum::response::Response> {
    let role =
        require_project_role(&state.auth, &actor.user_id, &project_id, &[Role::Admin]).await?;
    let _ = role;
    if body
        .project_id
        .as_deref()
        .is_some_and(|id| id != project_id)
    {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "PROJECT_MISMATCH",
            "Task project does not match route",
        ));
    }
    if require_project_role(
        &state.auth,
        &body.assignee_id,
        &project_id,
        &[Role::Annotator, Role::Admin],
    )
    .await
    .is_err()
    {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_ASSIGNEE",
            "Assignee must be a project annotator or admin",
        ));
    }
    let mut tx = state.repository.begin_write().await.map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not begin task transaction",
        )
    })?;
    let asset_project: Option<String> =
        sqlx::query_scalar("SELECT project_id FROM media_revisions WHERE asset_revision_id=?")
            .bind(&body.asset_revision_id)
            .fetch_optional(tx.connection())
            .await
            .map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "REVIEW_UNAVAILABLE",
                    "Could not verify media revision",
                )
            })?;
    if asset_project.as_deref() != Some(project_id.as_str()) {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::NOT_FOUND,
            "ASSET_NOT_FOUND",
            "Media revision is unavailable",
        ));
    }
    let ontology: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ontology_versions WHERE project_id=? AND ontology_version_id=?)").bind(&project_id).bind(&body.ontology_version_id).fetch_one(tx.connection()).await.map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE,"REVIEW_UNAVAILABLE","Could not verify ontology"))?;
    if ontology == 0 {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "ONTOLOGY_MISMATCH",
            "Ontology version must belong to the project",
        ));
    }
    let task_id = uuid::Uuid::new_v4().to_string();
    let created_at = now_rfc3339();
    sqlx::query("INSERT INTO review_tasks(task_id,project_id,asset_revision_id,ontology_version_id,assignee_id,created_by,state,created_at) VALUES(?,?,?,?,?,?, 'open', ?)")
        .bind(&task_id).bind(&project_id).bind(&body.asset_revision_id).bind(&body.ontology_version_id).bind(&body.assignee_id).bind(&actor.user_id).bind(&created_at).execute(tx.connection()).await.map_err(|_| error(StatusCode::CONFLICT,"TASK_EXISTS","Task could not be created"))?;
    tx.commit().await.map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not commit task",
        )
    })?;
    Ok(Json(
        json!({"task_id":task_id,"project_id":project_id,"asset_revision_id":body.asset_revision_id,"ontology_version_id":body.ontology_version_id,"assignee_id":body.assignee_id,"state":"open","created_at":created_at}),
    ))
}

pub(super) async fn list(
    State(state): State<ReviewState>,
    Path(project_id): Path<String>,
    Extension(actor): Extension<Principal>,
) -> Result<Json<Value>, axum::response::Response> {
    require_project_role(
        &state.auth,
        &actor.user_id,
        &project_id,
        &[Role::Admin, Role::Annotator, Role::Reviewer, Role::Viewer],
    )
    .await?;
    let rows=sqlx::query("SELECT t.task_id,t.project_id,t.asset_revision_id,t.ontology_version_id,t.assignee_id,t.state,t.created_at,s.review_id,s.revision_ids_json,d.decision AS review_decision,d.reason AS review_reason FROM review_tasks t LEFT JOIN review_submissions s ON s.review_id=(SELECT s2.review_id FROM review_submissions s2 WHERE s2.task_id=t.task_id ORDER BY CASE WHEN s2.state='pending' THEN 0 ELSE 1 END,s2.created_at DESC,s2.review_id DESC LIMIT 1) LEFT JOIN review_decisions d ON d.review_id=s.review_id WHERE t.project_id=? ORDER BY t.created_at,t.task_id").bind(&project_id).fetch_all(&state.auth.pool).await.map_err(|_|error(StatusCode::SERVICE_UNAVAILABLE,"REVIEW_UNAVAILABLE","Could not list tasks"))?;
    use sqlx::Row;
    let items:Vec<Value>=rows.into_iter().map(|r|json!({"task_id":r.get::<String,_>("task_id"),"project_id":r.get::<String,_>("project_id"),"asset_revision_id":r.get::<String,_>("asset_revision_id"),"ontology_version_id":r.get::<String,_>("ontology_version_id"),"assignee_id":r.get::<String,_>("assignee_id"),"state":r.get::<String,_>("state"),"created_at":r.get::<String,_>("created_at"),"review_id":r.get::<Option<String>,_>("review_id"),"revision_ids":r.get::<Option<String>,_>("revision_ids_json").and_then(|v|serde_json::from_str::<Value>(&v).ok()),"review_decision":r.get::<Option<String>,_>("review_decision"),"review_reason":r.get::<Option<String>,_>("review_reason")})).collect();
    Ok(Json(json!({"items":items,"next_cursor":null})))
}
