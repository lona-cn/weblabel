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
