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
pub(super) struct IssueInput {
    annotation_revision_id: String,
    object_id: Option<String>,
    code: String,
    message: String,
    region: Option<annotation_domain::BBox>,
}
pub(super) async fn create(
    State(state): State<ReviewState>,
    Path(review_id): Path<String>,
    Extension(actor): Extension<Principal>,
    Json(body): Json<IssueInput>,
) -> Result<Json<Value>, axum::response::Response> {
    if body.code.trim().is_empty() || body.message.trim().is_empty() || body.message.len() > 4096 {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_ISSUE",
            "Issue code and message are required",
        ));
    }
    let mut tx = state.repository.begin_write().await.map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not begin issue transaction",
        )
    })?;
    let review = sqlx::query(
        "SELECT project_id,revision_ids_json FROM review_submissions WHERE review_id=?",
    )
    .bind(&review_id)
    .fetch_optional(tx.connection())
    .await
    .map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not read review",
        )
    })?
    .ok_or_else(|| {
        error(
            StatusCode::NOT_FOUND,
            "REVIEW_NOT_FOUND",
            "Review does not exist",
        )
    })?;
    let project: String = review.get("project_id");
    require_project_role(
        &state.auth,
        &actor.user_id,
        &project,
        &[Role::Reviewer, Role::Admin],
    )
    .await?;
    let revisions: Vec<String> =
        serde_json::from_str(review.get::<String, _>("revision_ids_json").as_str())
            .unwrap_or_default();
    if !revisions.contains(&body.annotation_revision_id) {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "ISSUE_REVISION_MISMATCH",
            "Issue provenance must be a revision submitted for this review",
        ));
    }
    let revision=sqlx::query("SELECT body_json,ontology_version_id FROM annotation_revisions WHERE project_id=? AND annotation_revision_id=?").bind(&project).bind(&body.annotation_revision_id).fetch_optional(tx.connection()).await.map_err(|_|error(StatusCode::SERVICE_UNAVAILABLE,"REVIEW_UNAVAILABLE","Could not read annotation revision"))?.ok_or_else(||error(StatusCode::NOT_FOUND,"REVISION_NOT_FOUND","Issue source revision does not exist"))?;
    let document: Value = serde_json::from_str(revision.get::<String, _>("body_json").as_str())
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "REVISION_INVALID",
                "Stored annotation revision is invalid",
            )
        })?;
    if let Some(region) = body.region.as_ref() {
        let width = document
            .get("coordinate_space")
            .and_then(|v| v.get("width"))
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
            .unwrap_or(0);
        let height = document
            .get("coordinate_space")
            .and_then(|v| v.get("height"))
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
            .unwrap_or(0);
        if annotation_domain::validate_bbox(region, width, height).is_err() {
            let _ = tx.rollback().await;
            return Err(error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_ISSUE_REGION",
                "Issue region must be a valid canonical image box",
            ));
        }
    }
    if let Some(object_id) = body.object_id.as_deref() {
        let exists = document
            .get("objects")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items
                    .iter()
                    .any(|o| o.get("object_id").and_then(Value::as_str) == Some(object_id))
            });
        if !exists {
            let _ = tx.rollback().await;
            return Err(error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "ISSUE_OBJECT_NOT_IN_REVISION",
                "Issue object must exist in its provenance revision",
            ));
        }
    }
    let issue_id = uuid::Uuid::new_v4().to_string();
    let now = crate::projects::now_rfc3339();
    let region_json = body
        .region
        .as_ref()
        .and_then(|region| serde_json::to_string(region).ok());
    sqlx::query("INSERT INTO review_issues(issue_id,review_id,project_id,annotation_revision_id,ontology_version_id,object_id,code,message,region_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(&issue_id).bind(&review_id).bind(&project).bind(&body.annotation_revision_id).bind(revision.get::<String,_>("ontology_version_id")).bind(&body.object_id).bind(body.code.trim()).bind(body.message.trim()).bind(region_json).bind(&actor.user_id).bind(&now).execute(tx.connection()).await.map_err(|_|error(StatusCode::SERVICE_UNAVAILABLE,"REVIEW_UNAVAILABLE","Could not save issue"))?;
    tx.commit().await.map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not commit issue",
        )
    })?;
    Ok(Json(
        json!({"issue_id":issue_id,"review_id":review_id,"annotation_revision_id":body.annotation_revision_id,"ontology_version_id":revision.get::<String,_>("ontology_version_id"),"object_id":body.object_id,"code":body.code,"message":body.message,"region":body.region,"created_by":actor.user_id,"created_at":now}),
    ))
}
pub(super) async fn list(
    State(state): State<ReviewState>,
    Path(review_id): Path<String>,
    Extension(actor): Extension<Principal>,
) -> Result<Json<Value>, axum::response::Response> {
    let review = sqlx::query("SELECT project_id FROM review_submissions WHERE review_id=?")
        .bind(&review_id)
        .fetch_optional(&state.auth.pool)
        .await
        .map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "REVIEW_UNAVAILABLE",
                "Could not read review",
            )
        })?
        .ok_or_else(|| {
            error(
                StatusCode::NOT_FOUND,
                "REVIEW_NOT_FOUND",
                "Review does not exist",
            )
        })?;
    let project: String = review.get("project_id");
    require_project_role(
        &state.auth,
        &actor.user_id,
        &project,
        &[Role::Admin, Role::Annotator, Role::Reviewer, Role::Viewer],
    )
    .await?;
    let rows=sqlx::query("SELECT issue_id,review_id,annotation_revision_id,ontology_version_id,object_id,code,message,region_json,created_by,created_at FROM review_issues WHERE review_id=? ORDER BY created_at,issue_id").bind(&review_id).fetch_all(&state.auth.pool).await.map_err(|_|error(StatusCode::SERVICE_UNAVAILABLE,"REVIEW_UNAVAILABLE","Could not list issues"))?;
    let items:Vec<Value>=rows.into_iter().map(|r|json!({"issue_id":r.get::<String,_>("issue_id"),"review_id":r.get::<String,_>("review_id"),"annotation_revision_id":r.get::<String,_>("annotation_revision_id"),"ontology_version_id":r.get::<String,_>("ontology_version_id"),"object_id":r.get::<Option<String>,_>("object_id"),"code":r.get::<String,_>("code"),"message":r.get::<String,_>("message"),"region":r.get::<Option<String>,_>("region_json").and_then(|v|serde_json::from_str::<Value>(&v).ok()),"created_by":r.get::<String,_>("created_by"),"created_at":r.get::<String,_>("created_at")})).collect();
    Ok(Json(json!({"items":items,"next_cursor":null})))
}
