use annotation_domain::{
    hash::serialize_document, AnnotationDocument, AnnotationRevision, Id, OntologyVersion, Origin,
    OriginType,
};

use axum::{
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use dataset_formats::{
    archive::ArchiveLimits, coco::import_coco, native::import_native, yolo::import_yolo,
    ImportContext, LossItem, LossReport,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    auth::{error, Principal, Role},
    projects::now_rfc3339,
};

use super::AnnotationState;

use std::collections::HashSet;

const MAX_IMPORT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Deserialize)]
pub(super) struct CommitRequest {
    loss_ack: bool,
    operation_id: String,
}

#[derive(Serialize)]
struct PreviewResponse {
    import_batch_id: String,
    document: AnnotationDocument,
    loss_report: LossReport,
    base_revision_id: Option<String>,
    base_revision_no: i64,
}

#[derive(Serialize, Deserialize)]
struct CommitResponse {
    import_batch_id: String,
    revision: AnnotationRevision,
    idempotent_replay: bool,
}

pub(super) async fn preview(
    State(state): State<AnnotationState>,
    Path(asset_revision_id): Path<String>,
    Extension(principal): Extension<Principal>,
    mut multipart: Multipart,
) -> Response {
    let mut format = None;
    let mut ontology_version_id = None;
    let mut source_image_id = None;
    let mut label_ids: Option<Vec<Id>> = None;
    let mut data = None;
    let mut seen_fields = HashSet::new();
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "IMPORT_MULTIPART_INVALID",
                    "Multipart import body is invalid",
                )
            }
        };
        let name = field.name().unwrap_or_default().to_owned();
        if !seen_fields.insert(name.clone()) {
            return error(
                StatusCode::BAD_REQUEST,
                "IMPORT_FIELD_DUPLICATE",
                "Multipart fields must not be duplicated",
            );
        }
        match name.as_str() {
            "format" => format = field.text().await.ok(),
            "ontology_version_id" => ontology_version_id = field.text().await.ok(),
            "source_image_id" => {
                let value = match field.text().await {
                    Ok(value) => value,
                    Err(_) => {
                        return error(
                            StatusCode::BAD_REQUEST,
                            "SOURCE_IMAGE_ID_INVALID",
                            "source_image_id must be an integer",
                        )
                    }
                };
                source_image_id = match value.parse() {
                    Ok(value) => Some(value),
                    Err(_) => {
                        return error(
                            StatusCode::BAD_REQUEST,
                            "SOURCE_IMAGE_ID_INVALID",
                            "source_image_id must be an integer",
                        )
                    }
                };
            }
            "label_ids" => {
                label_ids = field
                    .text()
                    .await
                    .ok()
                    .and_then(|value| serde_json::from_str(&value).ok())
            }
            "data" => {
                data = field
                    .bytes()
                    .await
                    .ok()
                    .filter(|bytes| bytes.len() <= MAX_IMPORT_BYTES)
                    .map(|bytes| bytes.to_vec())
            }
            _ => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "IMPORT_FIELD_INVALID",
                    "Unknown import field",
                )
            }
        }
    }
    let Some(format) = format else {
        return error(
            StatusCode::BAD_REQUEST,
            "IMPORT_FORMAT_REQUIRED",
            "format is required",
        );
    };
    if format != "coco" && source_image_id.is_some() {
        return error(
            StatusCode::BAD_REQUEST,
            "SOURCE_IMAGE_ID_UNEXPECTED",
            "source_image_id is only valid for COCO imports",
        );
    }
    if format != "yolo" && label_ids.is_some() {
        return error(
            StatusCode::BAD_REQUEST,
            "LABEL_IDS_UNEXPECTED",
            "label_ids is only valid for YOLO imports",
        );
    }
    let Some(ontology_version_id) = ontology_version_id else {
        return error(
            StatusCode::BAD_REQUEST,
            "ONTOLOGY_VERSION_REQUIRED",
            "ontology_version_id is required",
        );
    };
    let Some(data) = data else {
        return error(
            StatusCode::BAD_REQUEST,
            "IMPORT_DATA_REQUIRED",
            "A nonempty data field within the size limit is required",
        );
    };
    let import_batch_id = Uuid::new_v4().to_string();
    let mut transaction = match state.repository.begin_write().await {
        Ok(transaction) => transaction,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "IMPORT_UNAVAILABLE",
                "Could not start import transaction",
            )
        }
    };
    let access = sqlx::query(
        "SELECT r.project_id, mm.canonical_width, mm.canonical_height, r.canonical_sha256, \
                o.body_json, m.role, h.annotation_revision_id, ar.revision_no \
         FROM media_revisions r \
         JOIN media_metadata mm ON mm.asset_revision_id=r.asset_revision_id \
         JOIN ontology_versions o ON o.project_id=r.project_id AND o.ontology_version_id=? \
         JOIN memberships m ON m.project_id=r.project_id AND m.user_id=? \
         LEFT JOIN annotation_heads h ON h.project_id=r.project_id AND h.asset_revision_id=r.asset_revision_id AND h.ontology_version_id=o.ontology_version_id \
         LEFT JOIN annotation_revisions ar ON ar.project_id=h.project_id AND ar.annotation_revision_id=h.annotation_revision_id \
         WHERE r.asset_revision_id=?"
    ).bind(&ontology_version_id).bind(&principal.user_id).bind(&asset_revision_id).fetch_optional(transaction.connection()).await;
    let row = match access {
        Ok(Some(row)) => row,
        Ok(None) => {
            return rollback_error(
                transaction,
                StatusCode::NOT_FOUND,
                "IMPORT_TARGET_NOT_FOUND",
                "Target asset or ontology is unavailable",
            )
            .await
        }
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_READ_FAILED",
                "Could not read import target",
            )
            .await
        }
    };
    let role: String = match row.try_get("role") {
        Ok(value) => value,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_READ_FAILED",
                "Could not read project access",
            )
            .await
        }
    };
    if !Role::parse(&role).is_some_and(Role::can_write) {
        return rollback_error(
            transaction,
            StatusCode::FORBIDDEN,
            "PROJECT_WRITE_REQUIRED",
            "Project write access is required",
        )
        .await;
    }
    let project_id: String = match row.try_get("project_id") {
        Ok(value) => value,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_READ_FAILED",
                "Could not read target project",
            )
            .await
        }
    };
    let width: i64 = match row.try_get("canonical_width") {
        Ok(value) => value,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_READ_FAILED",
                "Could not read target dimensions",
            )
            .await
        }
    };
    let height: i64 = match row.try_get("canonical_height") {
        Ok(value) => value,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_READ_FAILED",
                "Could not read target dimensions",
            )
            .await
        }
    };
    let target_hash: String = match row.try_get("canonical_sha256") {
        Ok(value) => value,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_READ_FAILED",
                "Could not read target hash",
            )
            .await
        }
    };
    let ontology_json: String = match row.try_get("body_json") {
        Ok(value) => value,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_READ_FAILED",
                "Could not read target ontology",
            )
            .await
        }
    };
    let ontology: OntologyVersion = match serde_json::from_str(&ontology_json) {
        Ok(value) => value,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "ONTOLOGY_CORRUPT",
                "Stored ontology is invalid",
            )
            .await
        }
    };
    let class_mapping_json = match serde_json::to_string(label_ids.as_deref().unwrap_or(&[])) {
        Ok(value) => value,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_SERIALIZE_FAILED",
                "Could not serialize the import class mapping",
            )
            .await
        }
    };
    let context = ImportContext {
        asset_revision_id: Id::from(asset_revision_id.clone()),
        import_batch_id: Id::from(import_batch_id.clone()),
        width: width as u32,
        height: height as u32,
        source_image_id,
    };
    let mut report = match format.as_str() {
        "yolo" => {
            let labels = match label_ids {
                Some(labels) => labels,
                None => {
                    return rollback_error(
                        transaction,
                        StatusCode::BAD_REQUEST,
                        "YOLO_LABELS_REQUIRED",
                        "YOLO imports require explicit label_ids mapping",
                    )
                    .await
                }
            };
            let text = match std::str::from_utf8(&data) {
                Ok(text) => text,
                Err(_) => {
                    return rollback_error(
                        transaction,
                        StatusCode::BAD_REQUEST,
                        "IMPORT_INVALID",
                        "YOLO data must be UTF-8",
                    )
                    .await
                }
            };
            match import_yolo(text, &labels, &context, &ontology) {
                Ok(report) => report,
                Err(_) => {
                    return rollback_error(
                        transaction,
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "IMPORT_INVALID",
                        "YOLO data is invalid",
                    )
                    .await
                }
            }
        }
        "coco" => match import_coco(&data, &context, &ontology) {
            Ok(report) => report,
            Err(_) => {
                return rollback_error(
                    transaction,
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "IMPORT_INVALID",
                    "COCO data is invalid",
                )
                .await
            }
        },
        "native" => {
            let bundle = match import_native(&data, &ArchiveLimits::default()) {
                Ok(bundle) => bundle,
                Err(_) => {
                    return rollback_error(
                        transaction,
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "IMPORT_INVALID",
                        "Native bundle is invalid",
                    )
                    .await
                }
            };
            if bundle.media_revision.canonical_sha256 != target_hash
                || bundle.ontology != ontology
                || bundle.revision.document.coordinate_space.width != context.width
                || bundle.revision.document.coordinate_space.height != context.height
            {
                return rollback_error(
                    transaction,
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "NATIVE_TARGET_MISMATCH",
                    "Native image hash, dimensions, or ontology do not match the explicit target",
                )
                .await;
            }
            let mut document = bundle.revision.document;
            document.asset_revision_id = context.asset_revision_id.clone();
            let mut loss_report = LossReport {
                losses: vec![LossItem {
                    field: "revision_history".to_owned(),
                    reason: "native source revision identity and history are replaced by the new committed revision".to_owned(),
                }],
            };
            if !document.objects.is_empty() {
                loss_report.losses.push(LossItem {
                    field: "provenance".to_owned(),
                    reason: "native object provenance is rebound to the new import batch"
                        .to_owned(),
                });
            }
            for object in &mut document.objects {
                object.origin = Origin {
                    kind: OriginType::Import,
                    prediction_id: None,
                    model_run_id: None,
                    import_batch_id: Some(context.import_batch_id.clone()),
                };
            }
            if annotation_domain::validate_document(&document, &ontology).is_err() {
                return rollback_error(
                    transaction,
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "IMPORT_INVALID",
                    "Native annotation document is invalid",
                )
                .await;
            }
            dataset_formats::ImportReport {
                document,
                loss_report,
            }
        }
        _ => {
            return rollback_error(
                transaction,
                StatusCode::BAD_REQUEST,
                "IMPORT_FORMAT_INVALID",
                "format must be native, yolo, or coco",
            )
            .await
        }
    };
    // Bind every imported object to this durable preview, regardless of source provenance.
    for object in &mut report.document.objects {
        object.origin = Origin {
            kind: OriginType::Import,
            prediction_id: None,
            model_run_id: None,
            import_batch_id: Some(context.import_batch_id.clone()),
        };
    }
    let base_revision_id: Option<String> = row.try_get("annotation_revision_id").unwrap_or(None);
    let base_revision_no: i64 = row.try_get("revision_no").unwrap_or(Some(0)).unwrap_or(0);
    let serialized_document = match serde_json::to_string(&report.document) {
        Ok(value) => value,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_SERIALIZE_FAILED",
                "Could not serialize import preview",
            )
            .await
        }
    };
    let loss_report = match serde_json::to_string(&report.loss_report) {
        Ok(value) => value,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_SERIALIZE_FAILED",
                "Could not serialize loss report",
            )
            .await
        }
    };
    let created_at = now_rfc3339();
    let source_sha256 = format!("{:x}", Sha256::digest(&data));
    if sqlx::query("INSERT INTO annotation_import_batches(import_batch_id, project_id, asset_revision_id, format, ontology_version_id, source_image_id, class_mapping_json, base_revision_id, base_revision_no, actor_id, source_sha256, document_json, loss_report_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&import_batch_id).bind(&project_id).bind(&asset_revision_id).bind(&format).bind(&ontology_version_id).bind(source_image_id).bind(&class_mapping_json).bind(&base_revision_id).bind(base_revision_no).bind(&principal.user_id).bind(source_sha256).bind(&serialized_document).bind(&loss_report).bind(&created_at).execute(transaction.connection()).await.is_err() {
        return rollback_error(transaction, StatusCode::INTERNAL_SERVER_ERROR, "IMPORT_WRITE_FAILED", "Could not persist import preview").await;
    }
    match transaction.commit().await {
        Ok(()) => Json(PreviewResponse {
            import_batch_id,
            document: report.document,
            loss_report: report.loss_report,
            base_revision_id,
            base_revision_no,
        })
        .into_response(),
        Err(_) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "IMPORT_UNAVAILABLE",
            "Could not commit import preview",
        ),
    }
}

pub(super) async fn commit(
    State(state): State<AnnotationState>,
    Path(import_batch_id): Path<String>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<CommitRequest>,
) -> Response {
    if Uuid::parse_str(&request.operation_id).is_err() {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_OPERATION_ID",
            "operation_id must be a UUID",
        );
    }
    let mut transaction = match state.repository.begin_write().await {
        Ok(transaction) => transaction,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "IMPORT_UNAVAILABLE",
                "Could not start import transaction",
            )
        }
    };
    let row = sqlx::query("SELECT b.*, m.role FROM annotation_import_batches b JOIN memberships m ON m.project_id=b.project_id AND m.user_id=? WHERE b.import_batch_id=? AND b.actor_id=?")
        .bind(&principal.user_id).bind(&import_batch_id).bind(&principal.user_id).fetch_optional(transaction.connection()).await;
    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => {
            return rollback_error(
                transaction,
                StatusCode::NOT_FOUND,
                "IMPORT_PREVIEW_NOT_FOUND",
                "Import preview not found",
            )
            .await
        }
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_READ_FAILED",
                "Could not read import preview",
            )
            .await
        }
    };
    let role: String = row.try_get("role").unwrap_or_default();
    if !Role::parse(&role).is_some_and(Role::can_write) {
        return rollback_error(
            transaction,
            StatusCode::FORBIDDEN,
            "PROJECT_WRITE_REQUIRED",
            "Project write access is required",
        )
        .await;
    }
    let request_hash = format!(
        "{:x}",
        Sha256::digest(format!("{import_batch_id}:{}", request.loss_ack).as_bytes())
    );
    let existing = sqlx::query(
        "SELECT request_hash, response_json FROM idempotency_keys \
         WHERE actor_id=? AND operation_id=? AND operation_kind='annotation_import_commit'",
    )
    .bind(&principal.user_id)
    .bind(&request.operation_id)
    .fetch_optional(transaction.connection())
    .await;
    match existing {
        Ok(Some(existing)) => {
            let existing_hash: String = existing.try_get("request_hash").unwrap_or_default();
            if existing_hash != request_hash {
                return rollback_error(
                    transaction,
                    StatusCode::CONFLICT,
                    "IDEMPOTENCY_CONFLICT",
                    "operation_id was already used with a different request",
                )
                .await;
            }
            let response_json: String = existing.try_get("response_json").unwrap_or_default();
            let mut response: CommitResponse = match serde_json::from_str(&response_json) {
                Ok(response) => response,
                Err(_) => {
                    return rollback_error(
                        transaction,
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "IMPORT_CORRUPT",
                        "Stored import response is invalid",
                    )
                    .await
                }
            };
            response.idempotent_replay = true;
            if transaction.rollback().await.is_err() {
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "IMPORT_ROLLBACK_FAILED",
                    "Could not close import transaction",
                );
            }
            return Json(response).into_response();
        }
        Ok(None) => {}
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_READ_FAILED",
                "Could not read import idempotency record",
            )
            .await
        }
    }
    let status: String = row.try_get("status").unwrap_or_default();
    if status != "preview" {
        return rollback_error(
            transaction,
            StatusCode::CONFLICT,
            "IMPORT_ALREADY_COMMITTED",
            "Import preview has already been committed",
        )
        .await;
    }
    let loss_json: String = row.try_get("loss_report_json").unwrap_or_default();
    let loss_report: LossReport = match serde_json::from_str(&loss_json) {
        Ok(value) => value,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_CORRUPT",
                "Stored loss report is invalid",
            )
            .await
        }
    };
    if loss_report.requires_ack() && !request.loss_ack {
        return rollback_error(
            transaction,
            StatusCode::UNPROCESSABLE_ENTITY,
            "LOSS_ACK_REQUIRED",
            "Loss acknowledgement is required before committing this import",
        )
        .await;
    }
    let project_id: String = row.try_get("project_id").unwrap_or_default();
    let asset_revision_id: String = row.try_get("asset_revision_id").unwrap_or_default();
    let ontology_version_id: String = row.try_get("ontology_version_id").unwrap_or_default();
    let base_revision_id: Option<String> = row.try_get("base_revision_id").unwrap_or(None);
    let base_revision_no: i64 = row.try_get("base_revision_no").unwrap_or(0);
    let current_head = sqlx::query("SELECT h.annotation_revision_id, r.revision_no FROM annotation_heads h JOIN annotation_revisions r ON r.project_id=h.project_id AND r.annotation_revision_id=h.annotation_revision_id WHERE h.project_id=? AND h.asset_revision_id=? AND h.ontology_version_id=?")
        .bind(&project_id).bind(&asset_revision_id).bind(&ontology_version_id).fetch_optional(transaction.connection()).await;
    let (current_id, current_no) = match current_head {
        Ok(Some(row)) => (
            row.try_get::<String, _>("annotation_revision_id").ok(),
            row.try_get::<i64, _>("revision_no").unwrap_or(-1),
        ),
        Ok(None) => (None, 0),
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_READ_FAILED",
                "Could not read current annotation head",
            )
            .await
        }
    };
    if base_revision_id != current_id
        || current_no != base_revision_no
        || current_no >= 9_007_199_254_740_991
    {
        return rollback_error(
            transaction,
            StatusCode::CONFLICT,
            "REVISION_CONFLICT",
            "Annotation head changed after preview",
        )
        .await;
    }
    let document_json: String = row.try_get("document_json").unwrap_or_default();
    let document: AnnotationDocument = match serde_json::from_str(&document_json) {
        Ok(value) => value,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_CORRUPT",
                "Stored import document is invalid",
            )
            .await
        }
    };
    let ontology_json: Option<String> = sqlx::query_scalar(
        "SELECT body_json FROM ontology_versions WHERE project_id=? AND ontology_version_id=?",
    )
    .bind(&project_id)
    .bind(&ontology_version_id)
    .fetch_optional(transaction.connection())
    .await
    .unwrap_or(None);
    let ontology: OntologyVersion =
        match ontology_json.and_then(|json| serde_json::from_str(&json).ok()) {
            Some(value) => value,
            None => {
                return rollback_error(
                    transaction,
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "ONTOLOGY_CORRUPT",
                    "Stored ontology is invalid",
                )
                .await
            }
        };
    if annotation_domain::validate_document(&document, &ontology).is_err() {
        return rollback_error(
            transaction,
            StatusCode::UNPROCESSABLE_ENTITY,
            "IMPORT_INVALID",
            "Preview document no longer validates against ontology",
        )
        .await;
    }
    let serialized = match serialize_document(&document) {
        Ok(value) => value,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_SERIALIZE_FAILED",
                "Could not hash imported revision",
            )
            .await
        }
    };
    let revision = AnnotationRevision {
        annotation_revision_id: Id::from(Uuid::new_v4().to_string()),
        parent_revision_id: current_id.clone().map(Id::from),
        revision_no: (current_no + 1) as u64,
        document,
        created_at: now_rfc3339(),
        created_by: Id::from(principal.user_id.clone()),
        content_hash: serialized.content_hash,
    };
    if sqlx::query("INSERT INTO annotation_revisions(annotation_revision_id, project_id, asset_revision_id, ontology_version_id, parent_revision_id, revision_no, body_json, content_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&*revision.annotation_revision_id).bind(&project_id).bind(&asset_revision_id).bind(&ontology_version_id).bind(current_id.as_deref()).bind(current_no + 1).bind(&serialized.json).bind(&revision.content_hash).bind(&principal.user_id).bind(&revision.created_at).execute(transaction.connection()).await.is_err() {
        return rollback_error(transaction, StatusCode::INTERNAL_SERVER_ERROR, "IMPORT_WRITE_FAILED", "Could not persist imported revision").await;
    }
    let head_write = if let Some(current_id) = current_id.as_deref() {
        sqlx::query("UPDATE annotation_heads SET annotation_revision_id=? WHERE project_id=? AND asset_revision_id=? AND ontology_version_id=? AND annotation_revision_id=?")
            .bind(&*revision.annotation_revision_id).bind(&project_id).bind(&asset_revision_id).bind(&ontology_version_id).bind(current_id).execute(transaction.connection()).await
    } else {
        sqlx::query("INSERT INTO annotation_heads(project_id, asset_revision_id, ontology_version_id, annotation_revision_id) VALUES (?, ?, ?, ?)")
            .bind(&project_id).bind(&asset_revision_id).bind(&ontology_version_id).bind(&*revision.annotation_revision_id).execute(transaction.connection()).await
    };
    if !matches!(head_write, Ok(result) if result.rows_affected() == 1) {
        return rollback_error(
            transaction,
            StatusCode::CONFLICT,
            "REVISION_CONFLICT",
            "Annotation head changed during import commit",
        )
        .await;
    }
    let committed_at = now_rfc3339();
    let batch_updated = sqlx::query("UPDATE annotation_import_batches SET status='committed', committed_revision_id=?, committed_at=? WHERE import_batch_id=? AND status='preview'")
        .bind(&*revision.annotation_revision_id).bind(&committed_at).bind(&import_batch_id).execute(transaction.connection()).await;
    if !matches!(batch_updated, Ok(result) if result.rows_affected() == 1) {
        return rollback_error(
            transaction,
            StatusCode::CONFLICT,
            "IMPORT_ALREADY_COMMITTED",
            "Import preview has already been committed",
        )
        .await;
    }
    let response = CommitResponse {
        import_batch_id: import_batch_id.clone(),
        revision,
        idempotent_replay: false,
    };
    let response_json = match serde_json::to_string(&response) {
        Ok(json) => json,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "IMPORT_SERIALIZE_FAILED",
                "Could not serialize commit response",
            )
            .await
        }
    };
    if sqlx::query("INSERT INTO idempotency_keys(actor_id, operation_id, operation_kind, request_hash, response_json, created_at) VALUES (?, ?, 'annotation_import_commit', ?, ?, ?)")
        .bind(&principal.user_id).bind(&request.operation_id).bind(request_hash).bind(response_json).bind(&response.revision.created_at).execute(transaction.connection()).await.is_err() {
        return rollback_error(transaction, StatusCode::CONFLICT, "IDEMPOTENCY_CONFLICT", "operation_id was already used").await;
    }
    match transaction.commit().await {
        Ok(()) => Json(response).into_response(),
        Err(_) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "IMPORT_UNAVAILABLE",
            "Could not commit imported revision",
        ),
    }
}

async fn rollback_error(
    transaction: crate::storage::WriteTransaction,
    status: StatusCode,
    code: &'static str,
    message: &'static str,
) -> Response {
    if transaction.rollback().await.is_err() {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "IMPORT_ROLLBACK_FAILED",
            "Could not roll back import transaction",
        )
    } else {
        error(status, code, message)
    }
}
