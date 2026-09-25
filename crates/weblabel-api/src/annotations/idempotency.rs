use annotation_domain::SaveRequest;
use serde::Serialize;
use sqlx::{Row, SqliteConnection};

use crate::media::canonical::sha256_hex;

pub(crate) const SAVE_OPERATION_KIND: &str = "annotation_save";

pub(crate) struct ExistingOperation {
    pub(crate) request_hash: String,
    pub(crate) response_json: String,
}

#[derive(Serialize)]
struct RequestHashInput<'a> {
    asset_revision_id: &'a str,
    request: &'a SaveRequest,
}

pub(crate) fn request_hash(
    asset_revision_id: &str,
    request: &SaveRequest,
) -> Result<String, serde_json::Error> {
    let bytes = serde_json::to_vec(&RequestHashInput {
        asset_revision_id,
        request,
    })?;
    Ok(sha256_hex(&bytes))
}

pub(crate) async fn find(
    connection: &mut SqliteConnection,
    actor_id: &str,
    operation_id: &str,
) -> Result<Option<ExistingOperation>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT request_hash, response_json FROM idempotency_keys \
         WHERE actor_id=? AND operation_id=? AND operation_kind=?",
    )
    .bind(actor_id)
    .bind(operation_id)
    .bind(SAVE_OPERATION_KIND)
    .fetch_optional(connection)
    .await?;
    row.map(|row| {
        Ok(ExistingOperation {
            request_hash: row.try_get("request_hash")?,
            response_json: row.try_get("response_json")?,
        })
    })
    .transpose()
}

pub(crate) async fn store(
    connection: &mut SqliteConnection,
    actor_id: &str,
    operation_id: &str,
    request_hash: &str,
    response_json: &str,
    created_at: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO idempotency_keys(actor_id, operation_id, operation_kind, request_hash, response_json, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(actor_id)
    .bind(operation_id)
    .bind(SAVE_OPERATION_KIND)
    .bind(request_hash)
    .bind(response_json)
    .bind(created_at)
    .execute(connection)
    .await?;
    Ok(())
}
