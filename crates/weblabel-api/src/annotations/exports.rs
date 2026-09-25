use annotation_domain::{Id, MediaRevision, OntologyVersion};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use dataset_formats::{
    archive::{create_safe_zip, ArchiveLimits},
    coco::export_coco,
    native::{export_native, NativeBundle},
    yolo::export_yolo,
    LossReport,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    auth::{error, Principal},
    projects::now_rfc3339,
};

use super::{revision::parse_revision, AnnotationState};

#[derive(Deserialize)]
pub(super) struct ExportRequest {
    format: String,
    loss_ack: bool,
    operation_id: String,
}

#[derive(Serialize, Deserialize)]
struct ExportResponse {
    export_id: String,
    format: String,
    download_url: String,
    byte_size: u64,
    object_sha256: String,
    loss_report: LossReport,
}

pub(super) async fn create(
    State(state): State<AnnotationState>,
    Path(annotation_revision_id): Path<String>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<ExportRequest>,
) -> Response {
    if Uuid::parse_str(&request.operation_id).is_err() {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_OPERATION_ID",
            "operation_id must be a UUID",
        );
    }
    if !matches!(request.format.as_str(), "native" | "yolo" | "coco") {
        return error(
            StatusCode::BAD_REQUEST,
            "EXPORT_FORMAT_INVALID",
            "format must be native, yolo, or coco",
        );
    }
    let mut transaction = match state.repository.begin_write().await {
        Ok(transaction) => transaction,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "EXPORT_UNAVAILABLE",
                "Could not start export transaction",
            )
        }
    };
    let row = sqlx::query(
        "SELECT r.annotation_revision_id, r.parent_revision_id, r.revision_no, r.body_json, r.content_hash, r.created_by, r.created_at, \
                r.project_id, mr.asset_id, mr.original_name, mr.original_sha256, mr.canonical_sha256, \
                mm.canonical_width, mm.canonical_height, mm.exif_orientation, mm.original_to_canonical_json, mm.source_group_id, mm.canonical_object_sha256, \
                o.body_json AS ontology_json \
         FROM annotation_revisions r \
         JOIN media_revisions mr ON mr.project_id=r.project_id AND mr.asset_revision_id=r.asset_revision_id \
         JOIN media_metadata mm ON mm.asset_revision_id=mr.asset_revision_id \
         JOIN ontology_versions o ON o.project_id=r.project_id AND o.ontology_version_id=r.ontology_version_id \
         JOIN memberships m ON m.project_id=r.project_id AND m.user_id=? \
         WHERE r.annotation_revision_id=?"
    ).bind(&principal.user_id).bind(&annotation_revision_id).fetch_optional(transaction.connection()).await;
    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => {
            return rollback_error(
                transaction,
                StatusCode::NOT_FOUND,
                "ANNOTATION_REVISION_NOT_FOUND",
                "Annotation revision not found",
            )
            .await
        }
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "EXPORT_READ_FAILED",
                "Could not read annotation revision",
            )
            .await
        }
    };
    let revision = match parse_revision(&row) {
        Ok(revision) => revision,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "ANNOTATION_CORRUPT",
                "Stored annotation revision is invalid",
            )
            .await
        }
    };
    let ontology_json: String = row.try_get("ontology_json").unwrap_or_default();
    let ontology: OntologyVersion = match serde_json::from_str(&ontology_json) {
        Ok(ontology) => ontology,
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
    let project_id: String = row.try_get("project_id").unwrap_or_default();
    let media_revision = MediaRevision {
        asset_id: Id::from(row.try_get::<String, _>("asset_id").unwrap_or_default()),
        asset_revision_id: revision.document.asset_revision_id.clone(),
        project_id: Id::from(project_id.clone()),
        original_name: row.try_get("original_name").unwrap_or_default(),
        original_sha256: row.try_get("original_sha256").unwrap_or_default(),
        canonical_sha256: row.try_get("canonical_sha256").unwrap_or_default(),
        canonical_width: row.try_get::<i64, _>("canonical_width").unwrap_or(0) as u32,
        canonical_height: row.try_get::<i64, _>("canonical_height").unwrap_or(0) as u32,
        exif_orientation: row.try_get::<i64, _>("exif_orientation").unwrap_or(0) as u8,
        original_to_canonical: serde_json::from_str(
            &row.try_get::<String, _>("original_to_canonical_json")
                .unwrap_or_default(),
        )
        .unwrap_or_default(),
        source_group_id: Id::from(
            row.try_get::<String, _>("source_group_id")
                .unwrap_or_default(),
        ),
    };
    let canonical_hash: String = row.try_get("canonical_object_sha256").unwrap_or_default();
    let canonical_path = state
        .repository
        .object_store()
        .path_for_hash(&canonical_hash);
    let canonical_image = match canonical_path.and_then(|path| std::fs::read(path).ok()) {
        Some(bytes) => bytes,
        None => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "MEDIA_OBJECT_MISSING",
                "Canonical image object is unavailable",
            )
            .await
        }
    };
    let (bytes, loss_report) = match request.format.as_str() {
        "native" => match export_native(&NativeBundle {
            media_revision,
            ontology: ontology.clone(),
            revision: revision.clone(),
            canonical_image,
        }) {
            Ok(bytes) => (bytes, LossReport::default()),
            Err(_) => {
                return rollback_error(
                    transaction,
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "EXPORT_INVALID",
                    "Native bundle could not be created",
                )
                .await
            }
        },
        "coco" => match export_coco(&revision.document, &ontology, "image") {
            Ok(export) => (export.json, export.loss_report),
            Err(_) => {
                return rollback_error(
                    transaction,
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "EXPORT_INVALID",
                    "COCO export could not be created",
                )
                .await
            }
        },
        "yolo" => match export_yolo(&revision.document, &ontology) {
            Ok(export) => {
                let labels = serde_json::to_vec(&export.label_ids).unwrap_or_default();
                match create_safe_zip(
                    &[
                        ("labels.txt".to_owned(), export.annotations.into_bytes()),
                        ("label_ids.json".to_owned(), labels),
                    ],
                    &ArchiveLimits::default(),
                ) {
                    Ok(bytes) => (bytes, export.loss_report),
                    Err(_) => {
                        return rollback_error(
                            transaction,
                            StatusCode::UNPROCESSABLE_ENTITY,
                            "EXPORT_INVALID",
                            "YOLO archive could not be created",
                        )
                        .await
                    }
                }
            }
            Err(_) => {
                return rollback_error(
                    transaction,
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "EXPORT_INVALID",
                    "YOLO export could not be created",
                )
                .await
            }
        },
        _ => unreachable!(),
    };
    if loss_report.requires_ack() && !request.loss_ack {
        return rollback_error(
            transaction,
            StatusCode::UNPROCESSABLE_ENTITY,
            "LOSS_ACK_REQUIRED",
            "Loss acknowledgement is required before creating this export",
        )
        .await;
    }
    let request_hash = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{}:{}:{}",
                annotation_revision_id, request.format, request.loss_ack
            )
            .as_bytes(),
        )
    );
    let existing = sqlx::query("SELECT request_hash, response_json FROM idempotency_keys WHERE actor_id=? AND operation_id=? AND operation_kind='annotation_export'")
        .bind(&principal.user_id).bind(&request.operation_id).fetch_optional(transaction.connection()).await;
    match existing {
        Ok(Some(row)) => {
            let hash: String = row.try_get("request_hash").unwrap_or_default();
            if hash != request_hash {
                return rollback_error(
                    transaction,
                    StatusCode::CONFLICT,
                    "IDEMPOTENCY_CONFLICT",
                    "operation_id was already used with a different request",
                )
                .await;
            }
            let response_json: String = row.try_get("response_json").unwrap_or_default();
            let response: ExportResponse = match serde_json::from_str(&response_json) {
                Ok(response) => response,
                Err(_) => {
                    return rollback_error(
                        transaction,
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "EXPORT_CORRUPT",
                        "Stored export response is invalid",
                    )
                    .await
                }
            };
            if transaction.rollback().await.is_err() {
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "EXPORT_ROLLBACK_FAILED",
                    "Could not close export transaction",
                );
            }
            return Json(response).into_response();
        }
        Ok(None) => {}
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "EXPORT_READ_FAILED",
                "Could not read export idempotency record",
            )
            .await
        }
    }
    let object = match state.repository.object_store().put_bytes("export", &bytes) {
        Ok(object) => object,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "EXPORT_WRITE_FAILED",
                "Could not store export bytes",
            )
            .await
        }
    };
    let export_id = Uuid::new_v4().to_string();
    let created_at = now_rfc3339();
    let loss_json = match serde_json::to_string(&loss_report) {
        Ok(value) => value,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "EXPORT_SERIALIZE_FAILED",
                "Could not serialize loss report",
            )
            .await
        }
    };
    if sqlx::query("INSERT INTO annotation_exports(export_id, project_id, annotation_revision_id, actor_id, format, object_sha256, byte_size, loss_report_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&export_id).bind(&project_id).bind(&annotation_revision_id).bind(&principal.user_id).bind(&request.format).bind(&object.sha256).bind(bytes.len() as i64).bind(loss_json).bind(&created_at).execute(transaction.connection()).await.is_err() {
        return rollback_error(transaction, StatusCode::INTERNAL_SERVER_ERROR, "EXPORT_WRITE_FAILED", "Could not persist export metadata").await;
    }
    let response = ExportResponse {
        export_id: export_id.clone(),
        format: request.format.clone(),
        download_url: format!("/api/exports/{export_id}/download"),
        byte_size: bytes.len() as u64,
        object_sha256: object.sha256.clone(),
        loss_report,
    };
    let response_json = match serde_json::to_string(&response) {
        Ok(value) => value,
        Err(_) => {
            return rollback_error(
                transaction,
                StatusCode::INTERNAL_SERVER_ERROR,
                "EXPORT_SERIALIZE_FAILED",
                "Could not serialize export response",
            )
            .await
        }
    };
    if sqlx::query("INSERT INTO idempotency_keys(actor_id, operation_id, operation_kind, request_hash, response_json, created_at) VALUES (?, ?, 'annotation_export', ?, ?, ?)")
        .bind(&principal.user_id).bind(&request.operation_id).bind(request_hash).bind(response_json).bind(&created_at).execute(transaction.connection()).await.is_err() {
        return rollback_error(transaction, StatusCode::CONFLICT, "IDEMPOTENCY_CONFLICT", "operation_id was already used").await;
    }
    match transaction.commit().await {
        Ok(()) => ([(header::CONTENT_TYPE, "application/json")], Json(response)).into_response(),
        Err(_) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "EXPORT_UNAVAILABLE",
            "Could not commit export metadata",
        ),
    }
}

pub(super) async fn download(
    State(state): State<AnnotationState>,
    Path(export_id): Path<String>,
    Extension(principal): Extension<Principal>,
) -> Response {
    let row = sqlx::query("SELECT e.object_sha256, e.format, e.byte_size, e.loss_report_json FROM annotation_exports e JOIN memberships m ON m.project_id=e.project_id AND m.user_id=? WHERE e.export_id=?")
        .bind(&principal.user_id).bind(&export_id).fetch_optional(&state.auth.pool).await;
    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => {
            return error(
                StatusCode::NOT_FOUND,
                "EXPORT_NOT_FOUND",
                "Export not found",
            )
        }
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "EXPORT_READ_FAILED",
                "Could not read export metadata",
            )
        }
    };
    let hash: String = row.try_get("object_sha256").unwrap_or_default();
    let format: String = row.try_get("format").unwrap_or_default();
    let expected_size: i64 = row.try_get("byte_size").unwrap_or(-1);
    let loss_report_json: String = match row.try_get("loss_report_json") {
        Ok(report) => report,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "EXPORT_READ_FAILED",
                "Could not read export report",
            )
        }
    };
    let Some(path) = state.repository.object_store().path_for_hash(&hash) else {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EXPORT_OBJECT_MISSING",
            "Export object is unavailable",
        );
    };
    let bytes = match std::fs::read(path) {
        Ok(bytes)
            if bytes.len() as i64 == expected_size
                && format!("{:x}", Sha256::digest(&bytes)) == hash =>
        {
            bytes
        }
        _ => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "EXPORT_OBJECT_MISSING",
                "Export object is unavailable",
            )
        }
    };
    let (content_type, extension) = if format == "coco" {
        ("application/json", "json")
    } else {
        ("application/zip", "zip")
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, bytes.len())
        .header("x-weblabel-loss-report", loss_report_json)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"weblabel-{export_id}.{extension}\""),
        )
        .body(Body::from(bytes))
        .unwrap_or_else(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "EXPORT_DOWNLOAD_FAILED",
                "Could not construct download response",
            )
        })
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
            "EXPORT_ROLLBACK_FAILED",
            "Could not roll back export transaction",
        )
    } else {
        error(status, code, message)
    }
}
