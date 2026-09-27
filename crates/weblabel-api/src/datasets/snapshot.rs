use super::{split::Split, DatasetState};
use crate::{
    auth::{error, Principal},
    projects::now_rfc3339,
};
use annotation_domain::{
    hash::serialize_document, AnnotationDocument, AnnotationRevision, MediaRevision,
    OntologyVersion,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::io::Read;
use uuid::Uuid;

const MAX_SNAPSHOT_ITEMS: usize = 512;
const MAX_SNAPSHOT_MEDIA_MEMBERS: usize = MAX_SNAPSHOT_ITEMS * 2;
const MAX_SNAPSHOT_MEDIA_BYTES: u64 = 96 * 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
struct SnapshotItem {
    asset_revision_id: String,
    annotation_revision_id: String,
    split: Split,
}
#[derive(Debug, Deserialize, Serialize, Clone)]
pub(super) struct ExcludedItem {
    pub(super) asset_revision_id: String,
    pub(super) reason: String,
}
#[derive(Debug, Deserialize, Serialize)]
pub(super) struct SnapshotRequest {
    operation_id: String,
    ontology_version_id: String,
    items: Vec<SnapshotItem>,
    excluded: Vec<ExcludedItem>,
    split_seed: Option<String>,
    split_ratios: Option<[u32; 3]>,
}
#[derive(Debug, Serialize, Deserialize)]
pub(super) struct FrozenAsset {
    pub(super) media_revision: MediaRevision,
    pub(super) revision: AnnotationRevision,
    pub(super) split: Split,
    pub(super) review_id: String,
    pub(super) reviewed_by: String,
    pub(super) review_reason: String,
    pub(super) reviewed_at: String,
    pub(super) original_object_sha256: String,
    pub(super) canonical_object_sha256: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub(super) struct SnapshotManifest {
    pub(super) schema_version: u8,
    pub(super) dataset_version_id: String,
    pub(super) project_id: String,
    pub(super) ontology: OntologyVersion,
    pub(super) items: Vec<FrozenAsset>,
    pub(super) excluded: Vec<ExcludedItem>,
    pub(super) category_mapping: Vec<String>,
    pub(super) created_by: String,
    pub(super) created_at: String,
    pub(super) split_seed: Option<String>,
    pub(super) split_ratios: Option<[u32; 3]>,
}
#[derive(Debug, Serialize, Deserialize)]
struct SnapshotItemResponse {
    asset_revision_id: String,
    annotation_revision_id: String,
    split: Split,
}
#[derive(Debug, Serialize, Deserialize)]
pub(super) struct SnapshotResponse {
    dataset_version_id: String,
    project_id: String,
    ontology_version_id: String,
    items: Vec<SnapshotItemResponse>,
    excluded: Vec<ExcludedItem>,
    category_mapping: Vec<String>,
    manifest_sha256: String,
}

pub(super) async fn create(
    State(state): State<DatasetState>,
    Path(project_id): Path<String>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<SnapshotRequest>,
) -> axum::response::Response {
    if Uuid::parse_str(&request.operation_id).is_err()
        || request.items.is_empty()
        || request.items.len().saturating_add(request.excluded.len()) > MAX_SNAPSHOT_ITEMS
    {
        return error(
            StatusCode::BAD_REQUEST,
            "DATASET_REQUEST_INVALID",
            "Snapshot request is invalid",
        );
    }
    let mut seen = std::collections::HashSet::new();
    if request
        .items
        .iter()
        .any(|item| !seen.insert(item.asset_revision_id.as_str()))
        || request.excluded.iter().any(|item| {
            item.reason.trim().is_empty() || !seen.insert(item.asset_revision_id.as_str())
        })
    {
        return error(
            StatusCode::BAD_REQUEST,
            "DATASET_ITEMS_INVALID",
            "Snapshot contains duplicate or invalid asset assignments",
        );
    }
    let request_hash = match serde_json::to_vec(&(project_id.as_str(), &request)) {
        Ok(data) => format!("{:x}", Sha256::digest(data)),
        Err(_) => {
            return error(
                StatusCode::BAD_REQUEST,
                "DATASET_REQUEST_INVALID",
                "Snapshot request is invalid",
            )
        }
    };
    let mut tx = match state.repository.begin_write().await {
        Ok(tx) => tx,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "DATASET_UNAVAILABLE",
                "Could not start snapshot transaction",
            )
        }
    };
    let member = sqlx::query("SELECT 1 FROM memberships WHERE project_id=? AND user_id=?")
        .bind(&project_id)
        .bind(&principal.user_id)
        .fetch_optional(tx.connection())
        .await;
    if !matches!(member, Ok(Some(_))) {
        let _ = tx.rollback().await;
        return error(
            StatusCode::NOT_FOUND,
            "PROJECT_NOT_FOUND",
            "Project not found",
        );
    }
    let previous = sqlx::query("SELECT request_hash,response_json FROM idempotency_keys WHERE actor_id=? AND operation_id=? AND operation_kind='dataset_snapshot'").bind(&principal.user_id).bind(&request.operation_id).fetch_optional(tx.connection()).await;
    match previous {
        Ok(Some(row)) => {
            let hash: String = row.try_get("request_hash").unwrap_or_default();
            let body: String = row.try_get("response_json").unwrap_or_default();
            let _ = tx.rollback().await;
            if hash != request_hash {
                return error(
                    StatusCode::CONFLICT,
                    "IDEMPOTENCY_KEY_REUSE",
                    "operation_id was already used with another request",
                );
            }
            return match serde_json::from_str::<SnapshotResponse>(&body) {
                Ok(value) => (StatusCode::OK, Json(value)).into_response(),
                Err(_) => error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "DATASET_CORRUPT",
                    "Stored snapshot response is invalid",
                ),
            };
        }
        Err(_) => {
            let _ = tx.rollback().await;
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "DATASET_UNAVAILABLE",
                "Could not check snapshot idempotency",
            );
        }
        Ok(None) => {}
    }
    for excluded in &request.excluded {
        let known =
            sqlx::query("SELECT 1 FROM media_revisions WHERE project_id=? AND asset_revision_id=?")
                .bind(&project_id)
                .bind(&excluded.asset_revision_id)
                .fetch_optional(tx.connection())
                .await;
        if !matches!(known, Ok(Some(_))) {
            let _ = tx.rollback().await;
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "SNAPSHOT_EXCLUSION_INVALID",
                "Excluded media must belong to the requested project",
            );
        }
    }
    let ontology_row = sqlx::query(
        "SELECT body_json FROM ontology_versions WHERE project_id=? AND ontology_version_id=?",
    )
    .bind(&project_id)
    .bind(&request.ontology_version_id)
    .fetch_optional(tx.connection())
    .await;
    let ontology: OntologyVersion = match ontology_row
        .ok()
        .flatten()
        .and_then(|row| row.try_get::<String, _>("body_json").ok())
        .and_then(|body| serde_json::from_str::<OntologyVersion>(&body).ok())
    {
        Some(value) if &*value.project_id == project_id.as_str() => value,
        _ => {
            let _ = tx.rollback().await;
            return error(
                StatusCode::NOT_FOUND,
                "ONTOLOGY_NOT_FOUND",
                "Ontology not found in project",
            );
        }
    };
    let dataset_version_id = Uuid::new_v4().to_string();
    let mut frozen = Vec::with_capacity(request.items.len());
    let mut frozen_bytes = 0_usize;
    let mut verified_media_bytes = 0_u64;
    let mut verified_media_members = 0_usize;
    for item in &request.items {
        let row = sqlx::query("SELECT r.annotation_revision_id,r.parent_revision_id,r.revision_no,r.body_json,r.content_hash,r.created_by,r.created_at,r.project_id,mr.asset_id,mr.original_name,mr.original_sha256,mr.canonical_sha256,mm.canonical_width,mm.canonical_height,mm.exif_orientation,mm.original_to_canonical_json,mm.source_group_id,mm.original_object_sha256,mm.canonical_object_sha256 FROM annotation_revisions r JOIN media_revisions mr ON mr.project_id=r.project_id AND mr.asset_revision_id=r.asset_revision_id JOIN media_metadata mm ON mm.asset_revision_id=mr.asset_revision_id WHERE r.project_id=? AND r.asset_revision_id=? AND r.annotation_revision_id=? AND r.ontology_version_id=?")
            .bind(&project_id).bind(&item.asset_revision_id).bind(&item.annotation_revision_id).bind(&request.ontology_version_id).fetch_optional(tx.connection()).await;
        let row = match row {
            Ok(Some(row)) => row,
            _ => {
                let _ = tx.rollback().await;
                return error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "SNAPSHOT_REVISION_INVALID",
                    "Requested revisions do not belong to this project and ontology",
                );
            }
        };
        let body_json: String = match row.try_get("body_json") {
            Ok(value) => value,
            Err(_) => {
                let _ = tx.rollback().await;
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "ANNOTATION_CORRUPT",
                    "Stored annotation revision is invalid",
                );
            }
        };
        frozen_bytes = match frozen_bytes.checked_add(body_json.len().saturating_add(2048)) {
            Some(value) if value <= 16 * 1024 * 1024 => value,
            _ => {
                let _ = tx.rollback().await;
                return error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "DATASET_SIZE_LIMIT",
                    "Snapshot manifest exceeds the 16 MiB limit",
                );
            }
        };
        let document: AnnotationDocument = match serde_json::from_str(&body_json) {
            Ok(value) => value,
            Err(_) => {
                let _ = tx.rollback().await;
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "ANNOTATION_CORRUPT",
                    "Stored annotation document is invalid",
                );
            }
        };
        let stored_revision_id: String = row.try_get("annotation_revision_id").unwrap_or_default();
        let stored_content_hash: String = row.try_get("content_hash").unwrap_or_default();
        let serialized = match serialize_document(&document) {
            Ok(value) => value,
            Err(_) => {
                let _ = tx.rollback().await;
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "ANNOTATION_CORRUPT",
                    "Stored annotation document cannot be serialized",
                );
            }
        };
        let revision_no = row
            .try_get::<i64, _>("revision_no")
            .ok()
            .and_then(|value| u64::try_from(value).ok());
        if stored_revision_id != item.annotation_revision_id
            || document.asset_revision_id.to_string() != item.asset_revision_id
            || document.ontology_version_id.to_string() != request.ontology_version_id
            || serialized.content_hash != stored_content_hash
            || revision_no.is_none()
        {
            let _ = tx.rollback().await;
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "ANNOTATION_CORRUPT",
                "Stored annotation revision identity or content hash is inconsistent",
            );
        }
        let revision = AnnotationRevision {
            annotation_revision_id: annotation_domain::Id::from(stored_revision_id),
            parent_revision_id: row
                .try_get::<Option<String>, _>("parent_revision_id")
                .unwrap_or(None)
                .map(annotation_domain::Id::from),
            revision_no: revision_no.unwrap_or_default(),
            document,
            created_at: row.try_get("created_at").unwrap_or_default(),
            created_by: annotation_domain::Id::from(
                row.try_get::<String, _>("created_by").unwrap_or_default(),
            ),
            content_hash: stored_content_hash,
        };
        if let Err(code) = validate_snapshot_document(&revision.document) {
            let _ = tx.rollback().await;
            let message = if code == "SNAPSHOT_NOT_READY" {
                "Annotation must be complete or explicitly confirmed negative before review"
            } else {
                "Complete annotations need objects and confirmed negatives must be empty"
            };
            return error(StatusCode::UNPROCESSABLE_ENTITY, code, message);
        }
        let review = sqlx::query("SELECT d.review_id,d.decided_by,d.reason,d.created_at FROM review_decisions d WHERE d.decision='approve' AND EXISTS (SELECT 1 FROM json_each(d.revision_ids_json) WHERE value=?) ORDER BY d.created_at DESC LIMIT 1").bind(&item.annotation_revision_id).fetch_optional(tx.connection()).await;
        let review = match review {
            Ok(Some(row)) => row,
            _ => {
                let _ = tx.rollback().await;
                return error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "SNAPSHOT_NOT_APPROVED",
                    "Each annotation revision requires an exact approved review",
                );
            }
        };
        let review_id: String = review.try_get("review_id").unwrap_or_default();
        let reviewed_by: String = review.try_get("decided_by").unwrap_or_default();
        let review_reason: String = review.try_get("reason").unwrap_or_default();
        let reviewed_at: String = review.try_get("created_at").unwrap_or_default();
        let original_media_hash: String = row.try_get("original_sha256").unwrap_or_default();
        let canonical_media_hash: String = row.try_get("canonical_sha256").unwrap_or_default();
        let original_hash: String = row.try_get("original_object_sha256").unwrap_or_default();
        let canonical_hash: String = row.try_get("canonical_object_sha256").unwrap_or_default();
        if original_hash != original_media_hash || canonical_hash != canonical_media_hash {
            let _ = tx.rollback().await;
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "MEDIA_METADATA_CORRUPT",
                "Media object hashes do not match the frozen media revision",
            );
        }
        for digest in [&original_hash, &canonical_hash] {
            verified_media_members = match verified_media_members.checked_add(1) {
                Some(count) if count <= MAX_SNAPSHOT_MEDIA_MEMBERS => count,
                _ => {
                    let _ = tx.rollback().await;
                    return error(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "DATASET_SIZE_LIMIT",
                        "Snapshot exceeds the 1024 media-member verification limit",
                    );
                }
            };
            let remaining = MAX_SNAPSHOT_MEDIA_BYTES.saturating_sub(verified_media_bytes);
            match verify_media_object_with_limit(state.repository.object_store(), digest, remaining)
            {
                Ok(size) => verified_media_bytes += size,
                Err(code) => {
                    let _ = tx.rollback().await;
                    let (status, message) = if code == "DATASET_SIZE_LIMIT" {
                        (
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "Snapshot media exceeds the 96 MiB verification limit",
                        )
                    } else if code == "MEDIA_OBJECT_MISSING" {
                        (
                            StatusCode::UNPROCESSABLE_ENTITY,
                            "A frozen media object is unavailable",
                        )
                    } else {
                        (
                            StatusCode::UNPROCESSABLE_ENTITY,
                            "A frozen media object is missing or its hash is invalid",
                        )
                    };
                    return error(status, code, message);
                }
            }
        }
        let media_revision = MediaRevision {
            asset_id: annotation_domain::Id::from(
                row.try_get::<String, _>("asset_id").unwrap_or_default(),
            ),
            asset_revision_id: annotation_domain::Id::from(item.asset_revision_id.clone()),
            project_id: annotation_domain::Id::from(project_id.clone()),
            original_name: row.try_get("original_name").unwrap_or_default(),
            original_sha256: row.try_get("original_sha256").unwrap_or_default(),
            canonical_sha256: row.try_get("canonical_sha256").unwrap_or_default(),
            canonical_width: row.try_get::<i64, _>("canonical_width").unwrap_or_default() as u32,
            canonical_height: row
                .try_get::<i64, _>("canonical_height")
                .unwrap_or_default() as u32,
            exif_orientation: row.try_get::<i64, _>("exif_orientation").unwrap_or(1) as u8,
            original_to_canonical: serde_json::from_str(
                &row.try_get::<String, _>("original_to_canonical_json")
                    .unwrap_or_default(),
            )
            .unwrap_or_default(),
            source_group_id: annotation_domain::Id::from(
                row.try_get::<String, _>("source_group_id")
                    .unwrap_or_default(),
            ),
        };
        frozen.push(FrozenAsset {
            media_revision,
            revision,
            split: item.split,
            review_id,
            reviewed_by,
            review_reason,
            reviewed_at,
            original_object_sha256: original_hash,
            canonical_object_sha256: canonical_hash,
        });
    }
    if request
        .split_seed
        .as_deref()
        .is_some_and(|seed| seed.trim().is_empty())
    {
        let _ = tx.rollback().await;
        return error(
            StatusCode::BAD_REQUEST,
            "SPLIT_CONFIG_INVALID",
            "split_seed must not be empty",
        );
    }
    if request.split_seed.is_some() != request.split_ratios.is_some() {
        let _ = tx.rollback().await;
        return error(
            StatusCode::BAD_REQUEST,
            "SPLIT_CONFIG_INVALID",
            "split_seed and split_ratios must be provided together",
        );
    }
    if let (Some(seed), Some(ratios)) = (&request.split_seed, request.split_ratios) {
        let groups = frozen
            .iter()
            .map(|asset| asset.media_revision.source_group_id.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        let assigned = match super::split::grouped(seed, groups, ratios) {
            Ok(value) => value,
            Err(code) => {
                let _ = tx.rollback().await;
                return error(StatusCode::BAD_REQUEST, code, "Split ratios are invalid");
            }
        };
        for asset in &mut frozen {
            let group = asset.media_revision.source_group_id.to_string();
            asset.split = assigned[&group];
        }
    } else {
        let assignments = frozen.iter().map(|asset| {
            (
                asset.media_revision.source_group_id.to_string(),
                asset.split,
            )
        });
        if super::split::validate_explicit_group_splits(assignments).is_err() {
            let _ = tx.rollback().await;
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "SOURCE_GROUP_SPLIT",
                "Assets sharing a source_group_id must use the same split",
            );
        }
    }
    let excluded = request.excluded;
    let category_mapping = ontology
        .labels
        .iter()
        .map(|label| label.label_id.to_string())
        .collect::<Vec<_>>();
    let created_at = now_rfc3339();
    let manifest = SnapshotManifest {
        schema_version: 1,
        dataset_version_id: dataset_version_id.clone(),
        project_id: project_id.clone(),
        ontology: ontology.clone(),
        items: frozen,
        excluded: excluded.clone(),
        category_mapping: category_mapping.clone(),
        created_by: principal.user_id.clone(),
        created_at: created_at.clone(),
        split_seed: request.split_seed.clone(),
        split_ratios: request.split_ratios,
    };
    let manifest_json = match serde_json::to_string(&manifest) {
        Ok(value) => value,
        Err(_) => {
            let _ = tx.rollback().await;
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATASET_SERIALIZE_FAILED",
                "Could not serialize frozen snapshot",
            );
        }
    };
    if manifest_json.len() > 16 * 1024 * 1024 {
        let _ = tx.rollback().await;
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "DATASET_SIZE_LIMIT",
            "Snapshot manifest exceeds the 16 MiB export limit",
        );
    }
    let manifest_sha256 = format!("{:x}", Sha256::digest(manifest_json.as_bytes()));
    let response = SnapshotResponse {
        dataset_version_id: dataset_version_id.clone(),
        project_id: project_id.clone(),
        ontology_version_id: request.ontology_version_id.clone(),
        items: manifest
            .items
            .iter()
            .map(|item| SnapshotItemResponse {
                asset_revision_id: item.media_revision.asset_revision_id.to_string(),
                annotation_revision_id: item.revision.annotation_revision_id.to_string(),
                split: item.split,
            })
            .collect(),
        excluded,
        category_mapping,
        manifest_sha256: manifest_sha256.clone(),
    };
    let response_json = serde_json::to_string(&response).unwrap_or_default();
    let inserted = sqlx::query("INSERT INTO dataset_versions(dataset_version_id,project_id,ontology_version_id,manifest_json,manifest_sha256,created_by,created_at) VALUES(?,?,?,?,?,?,?)").bind(&dataset_version_id).bind(&project_id).bind(&request.ontology_version_id).bind(&manifest_json).bind(&manifest_sha256).bind(&principal.user_id).bind(&created_at).execute(tx.connection()).await;
    let idem = sqlx::query("INSERT INTO idempotency_keys(actor_id,operation_id,operation_kind,request_hash,response_json,created_at) VALUES(?,?,'dataset_snapshot',?,?,?)").bind(&principal.user_id).bind(&request.operation_id).bind(request_hash).bind(response_json).bind(&created_at).execute(tx.connection()).await;
    if inserted.is_err() || idem.is_err() || tx.commit().await.is_err() {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "DATASET_PERSIST_FAILED",
            "Could not commit dataset snapshot",
        );
    }
    (StatusCode::CREATED, Json(response)).into_response()
}

pub fn validate_snapshot_document(
    document: &annotation_domain::AnnotationDocument,
) -> Result<(), &'static str> {
    match document.completion {
        annotation_domain::Completion::Unprocessed | annotation_domain::Completion::InProgress => {
            Err("SNAPSHOT_NOT_READY")
        }
        annotation_domain::Completion::Complete if document.objects.is_empty() => {
            Err("SNAPSHOT_COMPLETION_INVALID")
        }
        annotation_domain::Completion::ConfirmedNegative if !document.objects.is_empty() => {
            Err("SNAPSHOT_COMPLETION_INVALID")
        }
        _ => Ok(()),
    }
}

pub fn verify_media_object(
    store: &crate::storage::ObjectStore,
    hash: &str,
) -> Result<(), &'static str> {
    verify_media_object_with_limit(store, hash, MAX_SNAPSHOT_MEDIA_BYTES).map(|_| ())
}

fn verify_media_object_with_limit(
    store: &crate::storage::ObjectStore,
    hash: &str,
    limit: u64,
) -> Result<u64, &'static str> {
    let path = store.path_for_hash(hash).ok_or("MEDIA_OBJECT_INVALID")?;
    let declared_size = std::fs::metadata(&path)
        .map_err(|_| "MEDIA_OBJECT_MISSING")?
        .len();
    if declared_size > limit {
        return Err("DATASET_SIZE_LIMIT");
    }
    let read_limit = limit.checked_add(1).ok_or("DATASET_SIZE_LIMIT")?;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| "MEDIA_OBJECT_MISSING")?
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|_| "MEDIA_OBJECT_MISSING")?;
    let actual_size = u64::try_from(bytes.len()).map_err(|_| "DATASET_SIZE_LIMIT")?;
    if actual_size > limit || actual_size != declared_size {
        return Err("DATASET_SIZE_LIMIT");
    }
    if format!("{:x}", Sha256::digest(bytes)) != hash {
        return Err("MEDIA_OBJECT_INVALID");
    }
    Ok(actual_size)
}
