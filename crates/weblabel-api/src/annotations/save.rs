use annotation_domain::{
    hash::serialize_document, validate_document, AnnotationRevision, Id, OriginType, SaveRequest,
    SaveResponse,
};
use axum::{
    body::{to_bytes, Body},
    extract::{Path, State},
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::Value;
use sqlx::{Row, SqliteConnection};
use uuid::Uuid;

use crate::{
    auth::{error, Principal, Role},
    projects::now_rfc3339,
};

use super::{
    idempotency::{self, ExistingOperation},
    AnnotationState, Failure, MAX_ANNOTATION_BODY_BYTES,
};

struct WritableAsset {
    project_id: String,
    width: u32,
    height: u32,
}

pub(super) async fn put(
    State(state): State<AnnotationState>,
    Path(asset_revision_id): Path<String>,
    Extension(principal): Extension<Principal>,
    request: Request<Body>,
) -> Response {
    let bytes = match to_bytes(request.into_body(), MAX_ANNOTATION_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "ANNOTATION_TOO_LARGE",
                "Annotation request exceeds the 32 MiB limit",
            )
        }
    };
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(body) => body,
        Err(_) => {
            return error(
                StatusCode::BAD_REQUEST,
                "INVALID_SAVE_REQUEST",
                "Request body must be valid JSON",
            )
        }
    };
    let save_request: SaveRequest = match serde_json::from_value(body) {
        Ok(request) => request,
        Err(_) => {
            return error(
                StatusCode::BAD_REQUEST,
                "INVALID_SAVE_REQUEST",
                "Request body does not match SaveRequest",
            )
        }
    };
    if let Err(domain_error) = save_request.validate() {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            domain_error.code,
            domain_error.message,
        );
    }
    let request_hash = match idempotency::request_hash(&asset_revision_id, &save_request) {
        Ok(hash) => hash,
        Err(_) => {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_SAVE_REQUEST",
                "SaveRequest cannot be serialized",
            )
        }
    };
    let mut transaction = match state.repository.begin_write().await {
        Ok(transaction) => transaction,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "SAVE_UNAVAILABLE",
                "Could not start annotation transaction",
            )
        }
    };
    match save_in_transaction(
        &mut transaction,
        &asset_revision_id,
        &principal,
        &save_request,
        &request_hash,
    )
    .await
    {
        Ok(response) => match transaction.commit().await {
            Ok(()) => (StatusCode::OK, Json(response)).into_response(),
            Err(_) => error(
                StatusCode::SERVICE_UNAVAILABLE,
                "SAVE_UNAVAILABLE",
                "Could not commit annotation transaction",
            ),
        },
        Err(failure) => match transaction.rollback().await {
            Ok(()) => failure.into_response(),
            Err(_) => error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "SAVE_ROLLBACK_FAILED",
                "Could not roll back annotation transaction",
            ),
        },
    }
}

async fn save_in_transaction(
    transaction: &mut crate::storage::WriteTransaction,
    asset_revision_id: &str,
    principal: &Principal,
    request: &SaveRequest,
    request_hash: &str,
) -> Result<SaveResponse, Failure> {
    if let Some(existing) = idempotency::find(
        transaction.connection(),
        &principal.user_id,
        &request.operation_id,
    )
    .await
    .map_err(|_| storage_failure())?
    {
        return replay_or_conflict(
            transaction.connection(),
            asset_revision_id,
            principal,
            request,
            request_hash,
            existing,
        )
        .await;
    }

    let asset = writable_asset(
        transaction.connection(),
        asset_revision_id,
        &principal.user_id,
    )
    .await?;
    if request.lease.is_some() {
        return Err(Failure::new(
            StatusCode::CONFLICT,
            "LEASE_UNSUPPORTED",
            "Task leases are not supported by this save endpoint yet",
        ));
    }
    if !request.suggestion_decisions.is_empty() {
        return Err(Failure::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "SUGGESTION_DECISIONS_UNSUPPORTED",
            "Suggestion decisions must be empty until transactional decision support is available",
        ));
    }
    if &*request.document.asset_revision_id != asset_revision_id {
        return Err(Failure::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "ASSET_REVISION_MISMATCH",
            "Document asset_revision_id must match the request path",
        ));
    }
    if request.document.coordinate_space.width != asset.width
        || request.document.coordinate_space.height != asset.height
    {
        return Err(Failure::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "COORDINATE_SPACE_MISMATCH",
            "Document dimensions must match the canonical media revision",
        ));
    }
    if request
        .document
        .objects
        .iter()
        .any(|object| object.origin.kind != OriginType::Manual)
    {
        return Err(Failure::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "UNVERIFIED_PROVENANCE",
            "Only manual object provenance is currently verifiable for annotation saves",
        ));
    }

    let ontology_json: Option<String> = sqlx::query_scalar(
        "SELECT body_json FROM ontology_versions \
         WHERE project_id=? AND ontology_version_id=?",
    )
    .bind(&asset.project_id)
    .bind(&*request.document.ontology_version_id)
    .fetch_optional(transaction.connection())
    .await
    .map_err(|_| storage_failure())?;
    let Some(ontology_json) = ontology_json else {
        return Err(Failure::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "ONTOLOGY_NOT_FOUND",
            "Document ontology version is not published in this project",
        ));
    };
    let ontology: annotation_domain::OntologyVersion = serde_json::from_str(&ontology_json)
        .map_err(|_| {
            Failure::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "ONTOLOGY_CORRUPT",
                "Stored ontology version is invalid",
            )
        })?;
    if ontology.project_id.as_ref() != asset.project_id
        || ontology.ontology_version_id != request.document.ontology_version_id
    {
        return Err(Failure::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "ONTOLOGY_CORRUPT",
            "Stored ontology identity is invalid",
        ));
    }
    validate_document(&request.document, &ontology).map_err(|domain_error| {
        Failure::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            domain_error.code,
            domain_error.message,
        )
    })?;

    let head = sqlx::query(
        "SELECT h.annotation_revision_id, r.revision_no \
         FROM annotation_heads h \
         JOIN annotation_revisions r ON r.project_id=h.project_id \
             AND r.annotation_revision_id=h.annotation_revision_id \
         WHERE h.project_id=? AND h.asset_revision_id=? AND h.ontology_version_id=?",
    )
    .bind(&asset.project_id)
    .bind(asset_revision_id)
    .bind(&*request.document.ontology_version_id)
    .fetch_optional(transaction.connection())
    .await
    .map_err(|_| storage_failure())?;
    let Some(head) = head else {
        return Err(Failure::new(
            StatusCode::NOT_FOUND,
            "ANNOTATION_NOT_FOUND",
            "Annotation head not found",
        ));
    };
    let current_revision_id: String = head
        .try_get("annotation_revision_id")
        .map_err(|_| storage_failure())?;
    if current_revision_id != request.base_revision_id.as_ref() {
        return Err(Failure::new(
            StatusCode::CONFLICT,
            "REVISION_CONFLICT",
            "base_revision_id is not the current annotation head",
        ));
    }
    let current_revision_no: i64 = head.try_get("revision_no").map_err(|_| storage_failure())?;
    if current_revision_no >= 9_007_199_254_740_991 {
        return Err(Failure::new(
            StatusCode::CONFLICT,
            "REVISION_LIMIT_REACHED",
            "Annotation revision number reached the supported integer limit",
        ));
    }
    let revision_no = current_revision_no + 1;
    let serialized = serialize_document(&request.document).map_err(|_| {
        Failure::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_DOCUMENT",
            "Annotation document cannot be serialized",
        )
    })?;
    let revision = AnnotationRevision {
        annotation_revision_id: Id::from(Uuid::new_v4().to_string()),
        parent_revision_id: Some(request.base_revision_id.clone()),
        revision_no: u64::try_from(revision_no).map_err(|_| storage_failure())?,
        document: request.document.clone(),
        created_at: now_rfc3339(),
        created_by: Id::from(principal.user_id.clone()),
        content_hash: serialized.content_hash,
    };
    sqlx::query(
        "INSERT INTO annotation_revisions( \
            annotation_revision_id, project_id, asset_revision_id, ontology_version_id, \
            parent_revision_id, revision_no, body_json, content_hash, created_by, created_at \
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&*revision.annotation_revision_id)
    .bind(&asset.project_id)
    .bind(asset_revision_id)
    .bind(&*request.document.ontology_version_id)
    .bind(&*request.base_revision_id)
    .bind(revision_no)
    .bind(&serialized.json)
    .bind(&revision.content_hash)
    .bind(&principal.user_id)
    .bind(&revision.created_at)
    .execute(transaction.connection())
    .await
    .map_err(|_| storage_failure())?;

    let updated = sqlx::query(
        "UPDATE annotation_heads SET annotation_revision_id=? \
         WHERE project_id=? AND asset_revision_id=? AND ontology_version_id=? \
           AND annotation_revision_id=?",
    )
    .bind(&*revision.annotation_revision_id)
    .bind(&asset.project_id)
    .bind(asset_revision_id)
    .bind(&*request.document.ontology_version_id)
    .bind(&*request.base_revision_id)
    .execute(transaction.connection())
    .await
    .map_err(|_| storage_failure())?;
    if updated.rows_affected() != 1 {
        return Err(Failure::new(
            StatusCode::CONFLICT,
            "REVISION_CONFLICT",
            "Annotation head changed before the save completed",
        ));
    }

    let response = SaveResponse {
        operation_id: request.operation_id.clone(),
        revision,
        idempotent_replay: false,
    };
    let response_json = serde_json::to_string(&response).map_err(|_| storage_failure())?;
    idempotency::store(
        transaction.connection(),
        &principal.user_id,
        &request.operation_id,
        request_hash,
        &response_json,
        &response.revision.created_at,
    )
    .await
    .map_err(|_| storage_failure())?;
    Ok(response)
}

async fn replay_or_conflict(
    connection: &mut SqliteConnection,
    asset_revision_id: &str,
    principal: &Principal,
    request: &SaveRequest,
    request_hash: &str,
    existing: ExistingOperation,
) -> Result<SaveResponse, Failure> {
    if existing.request_hash != request_hash {
        return Err(Failure::new(
            StatusCode::CONFLICT,
            "IDEMPOTENCY_KEY_REUSE",
            "operation_id was reused with a different SaveRequest",
        ));
    }
    writable_asset(connection, asset_revision_id, &principal.user_id).await?;
    let mut response: SaveResponse =
        serde_json::from_str(&existing.response_json).map_err(|_| {
            Failure::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "IDEMPOTENCY_RECORD_CORRUPT",
                "Stored idempotency response is invalid",
            )
        })?;
    if response.operation_id != request.operation_id {
        return Err(Failure::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "IDEMPOTENCY_RECORD_CORRUPT",
            "Stored idempotency operation identity is invalid",
        ));
    }
    response.idempotent_replay = true;
    Ok(response)
}

async fn writable_asset(
    connection: &mut SqliteConnection,
    asset_revision_id: &str,
    user_id: &str,
) -> Result<WritableAsset, Failure> {
    let row = sqlx::query(
        "SELECT r.project_id, m.canonical_width, m.canonical_height, u.role \
         FROM media_revisions r \
         JOIN media_metadata m ON m.asset_revision_id=r.asset_revision_id \
         JOIN memberships u ON u.project_id=r.project_id \
         WHERE r.asset_revision_id=? AND u.user_id=?",
    )
    .bind(asset_revision_id)
    .bind(user_id)
    .fetch_optional(connection)
    .await
    .map_err(|_| storage_failure())?;
    let Some(row) = row else {
        return Err(Failure::new(
            StatusCode::NOT_FOUND,
            "ANNOTATION_NOT_FOUND",
            "Annotation resource not found",
        ));
    };
    let role: String = row.try_get("role").map_err(|_| storage_failure())?;
    if !Role::parse(&role).is_some_and(Role::can_write) {
        return Err(Failure::new(
            StatusCode::FORBIDDEN,
            "PROJECT_WRITE_REQUIRED",
            "Project write role required",
        ));
    }
    let width: i64 = row
        .try_get("canonical_width")
        .map_err(|_| storage_failure())?;
    let height: i64 = row
        .try_get("canonical_height")
        .map_err(|_| storage_failure())?;
    Ok(WritableAsset {
        project_id: row.try_get("project_id").map_err(|_| storage_failure())?,
        width: u32::try_from(width).map_err(|_| storage_failure())?,
        height: u32::try_from(height).map_err(|_| storage_failure())?,
    })
}

fn storage_failure() -> Failure {
    Failure::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "ANNOTATION_SAVE_FAILED",
        "Could not save annotation revision",
    )
}
