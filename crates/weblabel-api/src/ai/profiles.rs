//! Read-only public projection of persisted model profiles; never provisions defaults.
use annotation_domain::ModelProfile;
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use sqlx::{sqlite::SqliteRow, Row};

use super::{failure_response, AiState};

fn decode(row: SqliteRow) -> Result<ModelProfile, Box<dyn std::error::Error>> {
    let capabilities: String = row.try_get("capabilities_json")?;
    // The domain DTO validates capability fields, enums and optional timestamps.
    // Only these selected public columns are ever passed to serialization.
    Ok(serde_json::from_value(json!({
        "profile_id": row.try_get::<String, _>("profile_id")?,
        "provider_id": row.try_get::<String, _>("provider_id")?,
        "model_id": row.try_get::<String, _>("model_id")?,
        "auth_kind": row.try_get::<String, _>("auth_kind")?,
        "capabilities": serde_json::from_str::<annotation_domain::ModelCapabilities>(&capabilities)?,
        "availability": row.try_get::<String, _>("availability")?,
        "verification": row.try_get::<String, _>("verification")?,
        "runtime_version": row.try_get::<Option<String>, _>("runtime_version")?,
        "verified_at": row.try_get::<Option<String>, _>("verified_at")?,
    }))?)
}

pub(super) async fn list(State(state): State<AiState>) -> Response {
    let mut tx = match state.repository.begin_write().await {
        Ok(tx) => tx,
        Err(_) => return failed(),
    };
    let rows = match sqlx::query(
        "SELECT profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at \
         FROM model_profiles ORDER BY profile_id",
    ).fetch_all(tx.connection()).await {
        Ok(rows) => rows,
        Err(_) => return failed(),
    };
    if tx.commit().await.is_err() {
        return failed();
    }
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        match decode(row) {
            Ok(profile) => items.push(profile),
            Err(_) => return failed(),
        }
    }
    (
        StatusCode::OK,
        Json(json!({"items": items, "next_cursor": null})),
    )
        .into_response()
}

fn failed() -> Response {
    failure_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "PROFILE_LIST_FAILED",
        "Could not read model profiles",
    )
}
