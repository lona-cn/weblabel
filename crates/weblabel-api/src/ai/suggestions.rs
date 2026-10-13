//! Suggestion sets: immutable content with a separate, explicitly mutable
//! state row. Prediction content is never rewritten by state changes.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::ai::{failure_response, predictions, runs, AiState};
use crate::auth::Principal;

pub const SUGGESTIONS_PAGE_DEFAULT: usize = 100;
pub const SUGGESTIONS_PAGE_MAX: usize = 500;

#[derive(Deserialize)]
pub(super) struct ListQuery {
    after: Option<String>,
    limit: Option<usize>,
}

pub(super) async fn list(
    State(state): State<AiState>,
    Path(run_id): Path<String>,
    Query(query): Query<ListQuery>,
    Extension(principal): Extension<Principal>,
) -> Response {
    let limit = query.limit.unwrap_or(SUGGESTIONS_PAGE_DEFAULT);
    if limit == 0 || limit > SUGGESTIONS_PAGE_MAX {
        return error_response(
            StatusCode::BAD_REQUEST,
            "INVALID_SUGGESTIONS_QUERY",
            "limit must be between 1 and 500",
        );
    }
    if query
        .after
        .as_deref()
        .is_some_and(|after| after.is_empty() || after.chars().count() > 128)
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            "INVALID_SUGGESTIONS_QUERY",
            "after cursor is invalid",
        );
    }
    let summary =
        match runs::load_visible_summary(&state.repository, &run_id, &principal.user_id, false)
            .await
        {
            Ok(summary) => summary,
            Err(failure) => return failure.into_response(),
        };
    let mut tx = match state.repository.begin_write().await {
        Ok(tx) => tx,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "SUGGESTIONS_READ_FAILED",
                "Could not read suggestion sets",
            )
        }
    };
    let after_rowid: Option<i64> = match query.after.as_deref() {
        Some(after) => {
            let rowid: Option<i64> = sqlx::query_scalar(
                "SELECT rowid FROM suggestion_sets WHERE suggestion_set_id=? AND run_id=?",
            )
            .bind(after)
            .bind(&run_id)
            .fetch_optional(tx.connection())
            .await
            .ok()
            .flatten();
            match rowid {
                Some(rowid) => Some(rowid),
                None => {
                    return error_response(
                        StatusCode::BAD_REQUEST,
                        "INVALID_SUGGESTIONS_QUERY",
                        "after cursor is invalid",
                    )
                }
            }
        }
        None => None,
    };
    let rows = match sqlx::query(
        "SELECT s.suggestion_set_id, s.run_id, s.prediction_id, s.changes_json, s.issues_json, \
                s.score, st.state \
         FROM suggestion_sets s \
         LEFT JOIN suggestion_set_states st ON st.suggestion_set_id=s.suggestion_set_id \
         WHERE s.run_id=? AND (? IS NULL OR s.rowid > ?) \
         ORDER BY s.rowid LIMIT ?",
    )
    .bind(&run_id)
    .bind(after_rowid)
    .bind(after_rowid)
    .bind(limit as i64)
    .fetch_all(tx.connection())
    .await
    {
        Ok(rows) => rows,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "SUGGESTIONS_READ_FAILED",
                "Could not read suggestion sets",
            )
        }
    };
    tx.commit().await.ok();

    let context_json = match state.repository.begin_write().await {
        Ok(mut tx) => {
            let value: Option<String> =
                sqlx::query_scalar("SELECT context_json FROM model_runs WHERE run_id=?")
                    .bind(&run_id)
                    .fetch_optional(tx.connection())
                    .await
                    .ok()
                    .flatten();
            tx.commit().await.ok();
            value
        }
        Err(_) => None,
    };
    let context: Value = context_json
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or(Value::Null);

    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let changes_json: String = row.try_get("changes_json").unwrap_or_default();
        let issues_json: String = row.try_get("issues_json").unwrap_or_default();
        let state_name: Option<String> = row.try_get("state").unwrap_or(None);
        items.push(json!({
            "suggestion_set_id": row.try_get::<String, _>("suggestion_set_id").unwrap_or_default(),
            "model_run_id": row.try_get::<String, _>("run_id").unwrap_or_default(),
            "prediction_id": row.try_get::<String, _>("prediction_id").unwrap_or_default(),
            "context": context,
            "changes": predictions::parse_changes(&changes_json),
            "issues": predictions::parse_issues(&issues_json),
            "score": row.try_get::<Option<f64>, _>("score").unwrap_or(None),
            "state": state_name.unwrap_or_else(|| "pending".to_owned()),
        }));
    }
    let next_cursor = if items.len() == limit {
        rows.last()
            .and_then(|row| row.try_get::<String, _>("suggestion_set_id").ok())
    } else {
        None
    };
    (
        StatusCode::OK,
        Json(json!({"run": summary, "items": items, "next_cursor": next_cursor})),
    )
        .into_response()
}

fn error_response(status: StatusCode, code: &'static str, message: &str) -> Response {
    failure_response(status, code, message)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RejectionRequest {
    operation_id: String,
    change_ids: Vec<String>,
}

#[derive(Deserialize)]
pub(super) struct RejectionQuery {
    operation_id: Option<String>,
    after: Option<i64>,
    limit: Option<usize>,
}

fn rejection_error() -> Response {
    failure_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "REJECTION_FAILED",
        "Could not read or persist rejection",
    )
}

pub(super) async fn rejection_scope(
    c: &mut sqlx::SqliteConnection,
    set_id: &str,
    actor: &str,
    write: bool,
) -> Result<Vec<annotation_domain::Change>, Response> {
    let row = sqlx::query("SELECT s.changes_json,u.role FROM suggestion_sets s JOIN model_runs r ON r.run_id=s.run_id AND r.project_id=s.project_id AND r.asset_revision_id=s.asset_revision_id JOIN memberships u ON u.project_id=s.project_id AND u.user_id=? JOIN media_revisions m ON m.project_id=r.project_id AND m.asset_revision_id=r.asset_revision_id AND m.canonical_sha256=json_extract(r.context_json,'$.canonical_sha256') JOIN annotation_revisions a ON a.project_id=r.project_id AND a.annotation_revision_id=r.annotation_revision_id AND a.asset_revision_id=r.asset_revision_id AND a.ontology_version_id=r.ontology_version_id WHERE s.suggestion_set_id=?")
        .bind(actor).bind(set_id).fetch_optional(&mut *c).await.map_err(|_| rejection_error())?
        .ok_or_else(|| failure_response(StatusCode::NOT_FOUND,"SUGGESTION_NOT_FOUND","Suggestion set was not found"))?;
    let role: String = row.try_get("role").map_err(|_| rejection_error())?;
    if write && !matches!(role.as_str(), "admin" | "annotator") {
        return Err(failure_response(
            StatusCode::FORBIDDEN,
            "PROJECT_WRITE_REQUIRED",
            "Project write role required",
        ));
    }
    serde_json::from_str(
        &row.try_get::<String, _>("changes_json")
            .map_err(|_| rejection_error())?,
    )
    .map_err(|_| rejection_error())
}

pub(super) async fn rejection_list(
    State(state): State<AiState>,
    Path(set_id): Path<String>,
    Query(query): Query<RejectionQuery>,
    Extension(actor): Extension<Principal>,
) -> Response {
    let result = async {
        let limit = query.limit.unwrap_or(100);
        if limit == 0 || limit > 500 || query.after.is_some_and(|n| n < 0) || query.operation_id.as_ref().is_some_and(|id| annotation_domain::document::validate_id(id).is_err()) { return Err(failure_response(StatusCode::BAD_REQUEST,"INVALID_REJECTION_QUERY","Invalid rejection page")); }
        let mut tx = state.repository.begin_write().await.map_err(|_| rejection_error())?;
        rejection_scope(tx.connection(), &set_id, &actor.user_id, false).await?;
        let rejected: Vec<String> = sqlx::query_scalar("SELECT change_id FROM suggestion_change_rejections WHERE suggestion_set_id=? ORDER BY change_id").bind(&set_id).fetch_all(tx.connection()).await.map_err(|_| rejection_error())?;
        let rows = sqlx::query("SELECT rowid,operation_id,change_ids_json,created_at FROM suggestion_rejection_operations WHERE suggestion_set_id=? AND (? IS NULL OR operation_id=?) AND rowid>? ORDER BY rowid LIMIT ?")
            .bind(&set_id).bind(&query.operation_id).bind(&query.operation_id).bind(query.after.unwrap_or(0)).bind(limit as i64).fetch_all(tx.connection()).await.map_err(|_| rejection_error())?;
        let mut receipts = Vec::with_capacity(rows.len());
        for row in &rows { receipts.push(json!({"operation_id": row.get::<String,_>("operation_id"), "change_ids": serde_json::from_str::<Value>(&row.get::<String,_>("change_ids_json")).map_err(|_| rejection_error())?, "created_at": row.get::<String,_>("created_at")})); }
        let next = if rows.len() == limit { rows.last().map(|r| r.get::<i64,_>("rowid")) } else { None };
        tx.commit().await.map_err(|_| rejection_error())?;
        Ok(Json(json!({"suggestion_set_id":set_id,"rejected_change_ids":rejected,"operations":receipts,"next_cursor":next})).into_response())
    }.await;
    result.unwrap_or_else(|e| e)
}

pub(super) async fn reject_changes(
    State(state): State<AiState>,
    Path(set_id): Path<String>,
    Extension(actor): Extension<Principal>,
    Json(input): Json<RejectionRequest>,
) -> Response {
    let result = async {
        let unique: std::collections::HashSet<&str> = input.change_ids.iter().map(String::as_str).collect();
        if annotation_domain::document::validate_id(&input.operation_id).is_err() || input.change_ids.is_empty() || input.change_ids.len() > annotation_domain::suggestion_validation::MAX_CHANGE_IDS || unique.len() != input.change_ids.len() { return Err(failure_response(StatusCode::UNPROCESSABLE_ENTITY,"INVALID_REJECTION","Provide an operation ID and distinct change IDs")); }
        #[cfg(not(test))]
        let transaction = state.repository.begin_write().await;
        #[cfg(test)]
        let transaction = super::acceptance::contention::begin_write(&state.repository).await;
        let mut tx = transaction.map_err(|_| rejection_error())?;
        let changes = rejection_scope(tx.connection(), &set_id, &actor.user_id, true).await?;
        let payload = serde_json::to_string(&input.change_ids).map_err(|_| rejection_error())?;
        let previous = sqlx::query("SELECT suggestion_set_id,actor_id,change_ids_json,created_at FROM suggestion_rejection_operations WHERE operation_id=?").bind(&input.operation_id).fetch_optional(tx.connection()).await.map_err(|_| rejection_error())?;
        if let Some(row) = previous {
            if row.get::<String,_>("suggestion_set_id") != set_id || row.get::<String,_>("actor_id") != actor.user_id || row.get::<String,_>("change_ids_json") != payload { return Err(failure_response(StatusCode::CONFLICT,"OPERATION_CONFLICT","Operation ID already has another rejection payload")); }
            let created_at: String = row.get("created_at");
            tx.commit().await.map_err(|_| rejection_error())?;
            return Ok(Json(json!({"suggestion_set_id":set_id,"operation_id":input.operation_id,"change_ids":input.change_ids,"created_at":created_at,"idempotent_replay":true})).into_response());
        }
        let known: std::collections::HashSet<&str> = changes.iter().map(|c| &**annotation_domain::suggestion_validation::change_id(c)).collect();
        for id in &input.change_ids {
            if !known.contains(id.as_str()) { return Err(failure_response(StatusCode::UNPROCESSABLE_ENTITY,"CHANGE_NOT_FOUND","Change does not belong to this suggestion set")); }
            let decision: Option<String> = sqlx::query_scalar("SELECT decision FROM suggestion_decisions WHERE suggestion_set_id=? AND change_id=? ORDER BY rowid DESC LIMIT 1").bind(&set_id).bind(id).fetch_optional(tx.connection()).await.map_err(|_| rejection_error())?;
            if decision.as_deref() == Some("accept") { return Err(failure_response(StatusCode::CONFLICT,"ACCEPTED_CHANGE_REQUIRES_REVERT","Revert accepted changes in an annotation save before rejecting")); }
        }
        let created_at = crate::projects::now_rfc3339();
        sqlx::query("INSERT INTO suggestion_rejection_operations(operation_id,suggestion_set_id,actor_id,change_ids_json,created_at) VALUES(?,?,?,?,?)").bind(&input.operation_id).bind(&set_id).bind(&actor.user_id).bind(&payload).bind(&created_at).execute(tx.connection()).await.map_err(|_| rejection_error())?;
        for id in &input.change_ids { sqlx::query("INSERT INTO suggestion_change_rejections(suggestion_set_id,change_id,operation_id) VALUES(?,?,?) ON CONFLICT(suggestion_set_id,change_id) DO NOTHING").bind(&set_id).bind(id).bind(&input.operation_id).execute(tx.connection()).await.map_err(|_| rejection_error())?; }
        tx.commit().await.map_err(|_| rejection_error())?;
        Ok(Json(json!({"suggestion_set_id":set_id,"operation_id":input.operation_id,"change_ids":input.change_ids,"created_at":created_at,"idempotent_replay":false})).into_response())
    }.await;
    result.unwrap_or_else(|e| e)
}
