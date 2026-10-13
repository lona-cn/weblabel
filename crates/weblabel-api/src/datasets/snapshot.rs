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

const MAX_SNAPSHOT_ITEMS: usize = 1024;
const MAX_SNAPSHOT_MEDIA_MEMBERS: usize = MAX_SNAPSHOT_ITEMS * 2;
const MAX_SNAPSHOT_MEDIA_BYTES: u64 = 96 * 1024 * 1024;
const SNAPSHOT_REVISION_CAPTURE_SQL: &str = "SELECT r.annotation_revision_id,r.parent_revision_id,r.revision_no,CASE WHEN length(CAST(r.body_json AS BLOB))<=16777216 THEN r.body_json END AS body_json,r.content_hash,r.created_by,r.created_at,r.project_id,mr.asset_id,CASE WHEN length(CAST(mr.original_name AS BLOB))<=16777216 THEN mr.original_name END AS original_name,mr.original_sha256,mr.canonical_sha256,mm.canonical_width,mm.canonical_height,mm.exif_orientation,mm.original_to_canonical_json,mm.source_group_id,mm.original_object_sha256,mm.canonical_object_sha256,json_array(r.annotation_revision_id,r.parent_revision_id,r.revision_no,r.content_hash,r.created_by,r.created_at,r.project_id,mr.asset_id,mr.original_sha256,mr.canonical_sha256,mm.canonical_width,mm.canonical_height,mm.exif_orientation,mm.original_to_canonical_json,mm.source_group_id,mm.original_object_sha256,mm.canonical_object_sha256) AS binding FROM annotation_revisions r JOIN media_revisions mr ON mr.project_id=r.project_id AND mr.asset_revision_id=r.asset_revision_id JOIN media_metadata mm ON mm.asset_revision_id=mr.asset_revision_id WHERE r.project_id=? AND r.asset_revision_id=? AND r.annotation_revision_id=? AND r.ontology_version_id=?";

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

pub(super) fn validate_logical_scope<'a>(
    included: impl Iterator<Item = &'a str>,
    excluded: impl Iterator<Item = &'a str>,
) -> Result<(), &'static str> {
    let mut seen = std::collections::HashSet::new();
    let mut count = 0usize;
    for id in included {
        count += 1;
        if !seen.insert(id) {
            return Err("DATASET_ITEMS_INVALID");
        }
    }
    if count == 0 {
        return Err("DATASET_ITEMS_INVALID");
    }
    for id in excluded {
        count += 1;
        if !seen.insert(id) {
            return Err("DATASET_ITEMS_INVALID");
        }
    }
    if count > MAX_SNAPSHOT_ITEMS {
        return Err("DATASET_SIZE_LIMIT");
    }
    Ok(())
}

#[derive(Default)]
pub(super) struct MediaVerificationBudget {
    members: usize,
    bytes: u64,
}
impl MediaVerificationBudget {
    pub(super) fn remaining(&self) -> u64 {
        MAX_SNAPSHOT_MEDIA_BYTES.saturating_sub(self.bytes)
    }
    pub(super) fn charge(&mut self, bytes: u64) -> Result<(), &'static str> {
        let members = self.members.checked_add(1).ok_or("DATASET_SIZE_LIMIT")?;
        let total = self.bytes.checked_add(bytes).ok_or("DATASET_SIZE_LIMIT")?;
        if members > MAX_SNAPSHOT_MEDIA_MEMBERS || total > MAX_SNAPSHOT_MEDIA_BYTES {
            return Err("DATASET_SIZE_LIMIT");
        }
        self.members = members;
        self.bytes = total;
        Ok(())
    }
}

struct CapturedSnapshot {
    project_id: String,
    principal: Principal,
    request: SnapshotRequest,
    ontology_binding: String,
    rows: Vec<(sqlx::sqlite::SqliteRow, sqlx::sqlite::SqliteRow)>,
}
struct PreparedSnapshot {
    capture: CapturedSnapshot,
    dataset_version_id: String,
    created_at: String,
    manifest_json: String,
    manifest_sha256: String,
    response_json: String,
    response: SnapshotResponse,
}
fn build_snapshot(
    capture: CapturedSnapshot,
    store: &crate::storage::ObjectStore,
) -> Result<PreparedSnapshot, axum::response::Response> {
    let CapturedSnapshot {
        project_id,
        principal,
        request,
        ontology_binding,
        rows: captured,
    } = capture;
    let ontology: OntologyVersion = match serde_json::from_str::<OntologyVersion>(&ontology_binding)
    {
        Ok(value) if &*value.project_id == project_id.as_str() => value,
        _ => {
            return Err(error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "ONTOLOGY_CORRUPT",
                "Stored ontology is invalid",
            ))
        }
    };
    let dataset_version_id = Uuid::new_v4().to_string();
    let mut frozen = Vec::with_capacity(request.items.len());
    let mut media_budget = MediaVerificationBudget::default();
    for (item, (row, review)) in request.items.iter().zip(&captured) {
        let body_json: String = match row.try_get("body_json") {
            Ok(value) => value,
            Err(_) => {
                return Err(error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "ANNOTATION_CORRUPT",
                    "Stored annotation revision is invalid",
                ));
            }
        };
        let document: AnnotationDocument = match serde_json::from_str(&body_json) {
            Ok(value) => value,
            Err(_) => {
                return Err(error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "ANNOTATION_CORRUPT",
                    "Stored annotation document is invalid",
                ));
            }
        };
        let stored_revision_id: String = row.try_get("annotation_revision_id").unwrap_or_default();
        let stored_content_hash: String = row.try_get("content_hash").unwrap_or_default();
        let serialized = match serialize_document(&document) {
            Ok(value) => value,
            Err(_) => {
                return Err(error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "ANNOTATION_CORRUPT",
                    "Stored annotation document cannot be serialized",
                ));
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
            return Err(error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "ANNOTATION_CORRUPT",
                "Stored annotation revision identity or content hash is inconsistent",
            ));
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
            let message = if code == "SNAPSHOT_NOT_READY" {
                "Annotation must be complete or explicitly confirmed negative before review"
            } else {
                "Complete annotations need objects and confirmed negatives must be empty"
            };
            return Err(error(StatusCode::UNPROCESSABLE_ENTITY, code, message));
        }
        let review_id: String = review.try_get("review_id").unwrap_or_default();
        let reviewed_by: String = review.try_get("decided_by").unwrap_or_default();
        let review_reason: String = review.try_get("reason").unwrap_or_default();
        let reviewed_at: String = review.try_get("created_at").unwrap_or_default();
        let original_media_hash: String = row.try_get("original_sha256").unwrap_or_default();
        let canonical_media_hash: String = row.try_get("canonical_sha256").unwrap_or_default();
        let original_hash: String = row.try_get("original_object_sha256").unwrap_or_default();
        let canonical_hash: String = row.try_get("canonical_object_sha256").unwrap_or_default();
        if original_hash != original_media_hash || canonical_hash != canonical_media_hash {
            return Err(error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "MEDIA_METADATA_CORRUPT",
                "Media object hashes do not match the frozen media revision",
            ));
        }
        for digest in [&original_hash, &canonical_hash] {
            let remaining = MAX_SNAPSHOT_MEDIA_BYTES.saturating_sub(media_budget.bytes);
            match verify_media_object_with_limit(store, digest, remaining) {
                Ok(size) => {
                    if media_budget.charge(size).is_err() {
                        return Err(error(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "DATASET_SIZE_LIMIT",
                            "Snapshot media budget exceeded",
                        ));
                    }
                }
                Err(code) => {
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
                    return Err(error(status, code, message));
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
        return Err(error(
            StatusCode::BAD_REQUEST,
            "SPLIT_CONFIG_INVALID",
            "split_seed must not be empty",
        ));
    }
    if request.split_seed.is_some() != request.split_ratios.is_some() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "SPLIT_CONFIG_INVALID",
            "split_seed and split_ratios must be provided together",
        ));
    }
    if let (Some(seed), Some(ratios)) = (&request.split_seed, request.split_ratios) {
        let groups = frozen
            .iter()
            .map(|asset| asset.media_revision.source_group_id.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        let assigned = match super::split::grouped(seed, groups, ratios) {
            Ok(value) => value,
            Err(code) => {
                return Err(error(
                    StatusCode::BAD_REQUEST,
                    code,
                    "Split ratios are invalid",
                ));
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
            return Err(error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "SOURCE_GROUP_SPLIT",
                "Assets sharing a source_group_id must use the same split",
            ));
        }
    }
    let excluded = request.excluded.clone();
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
        ontology,
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
            return Err(error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATASET_SERIALIZE_FAILED",
                "Could not serialize frozen snapshot",
            ));
        }
    };
    if manifest_json.len() > 16 * 1024 * 1024 {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "DATASET_SIZE_LIMIT",
            "Snapshot manifest exceeds the 16 MiB export limit",
        ));
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
    let response_json = serde_json::to_string(&response).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "DATASET_SERIALIZE_FAILED",
            "Could not serialize snapshot response",
        )
    })?;
    Ok(PreparedSnapshot {
        capture: CapturedSnapshot {
            project_id,
            principal,
            request,
            ontology_binding,
            rows: captured,
        },
        dataset_version_id,
        created_at,
        manifest_json,
        manifest_sha256,
        response_json,
        response,
    })
}

pub(super) async fn create(
    State(state): State<DatasetState>,
    Path(project_id): Path<String>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<SnapshotRequest>,
) -> axum::response::Response {
    create_phases(
        state,
        project_id,
        principal,
        request,
        #[cfg(test)]
        None,
    )
    .await
}
#[cfg(test)]
struct SnapshotPrepareGate {
    entered: tokio::sync::oneshot::Sender<()>,
    release: tokio::sync::oneshot::Receiver<()>,
}

async fn create_phases(
    state: DatasetState,
    project_id: String,
    principal: Principal,
    request: SnapshotRequest,
    #[cfg(test)] gate: Option<SnapshotPrepareGate>,
) -> axum::response::Response {
    if Uuid::parse_str(&request.operation_id).is_err() || request.items.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "DATASET_REQUEST_INVALID",
            "Snapshot request is invalid",
        );
    }
    if let Err(code) = validate_logical_scope(
        request
            .items
            .iter()
            .map(|item| item.asset_revision_id.as_str()),
        request
            .excluded
            .iter()
            .map(|item| item.asset_revision_id.as_str()),
    ) {
        return if code == "DATASET_SIZE_LIMIT" {
            error(
                StatusCode::BAD_REQUEST,
                "DATASET_REQUEST_INVALID",
                "Snapshot request is invalid",
            )
        } else {
            error(
                StatusCode::BAD_REQUEST,
                "DATASET_ITEMS_INVALID",
                "Snapshot contains duplicate asset assignments",
            )
        };
    }
    if request
        .excluded
        .iter()
        .any(|item| item.reason.trim().is_empty())
    {
        return error(
            StatusCode::BAD_REQUEST,
            "DATASET_ITEMS_INVALID",
            "Snapshot contains invalid exclusion reasons",
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
    let capture = capture_snapshot_on(
        tx.connection(),
        project_id,
        principal,
        request,
        &request_hash,
    )
    .await;
    if tx.rollback().await.is_err() {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "DATASET_UNAVAILABLE",
            "Could not release capture transaction",
        );
    }
    let capture = match capture {
        Ok(CaptureOutcome::Inputs(capture)) => capture,
        Ok(CaptureOutcome::Replay(body)) => return snapshot_replay_response(&body),
        Err(response) => return response,
    };
    #[cfg(test)]
    if let Some(gate) = gate {
        let _ = gate.entered.send(());
        let _ = gate.release.await;
    }
    let store = state.repository.object_store().clone();
    let prepared = match tokio::task::spawn_blocking(move || build_snapshot(capture, &store)).await
    {
        Ok(Ok(value)) => value,
        Ok(Err(response)) => return response,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATASET_SERIALIZE_FAILED",
                "Snapshot preparation failed",
            )
        }
    };
    let mut tx = match state.repository.begin_write().await {
        Ok(tx) => tx,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "DATASET_UNAVAILABLE",
                "Could not publish snapshot",
            )
        }
    };
    match publish_snapshot_on(tx.connection(), &prepared, &request_hash).await {
        Ok(Some(body)) => {
            let _ = tx.rollback().await;
            snapshot_replay_response(&body)
        }
        Ok(None) => {
            if tx.commit().await.is_err() {
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "DATASET_PERSIST_FAILED",
                    "Could not commit dataset snapshot",
                );
            }
            (StatusCode::CREATED, Json(prepared.response)).into_response()
        }
        Err(response) => {
            let _ = tx.rollback().await;
            response
        }
    }
}

enum CaptureOutcome {
    Replay(String),
    Inputs(CapturedSnapshot),
}
async fn capture_snapshot_on(
    connection: &mut sqlx::SqliteConnection,
    project_id: String,
    principal: Principal,
    request: SnapshotRequest,
    request_hash: &str,
) -> Result<CaptureOutcome, axum::response::Response> {
    let member = sqlx::query("SELECT 1 FROM memberships WHERE project_id=? AND user_id=?")
        .bind(&project_id)
        .bind(&principal.user_id)
        .fetch_optional(&mut *connection)
        .await;
    match member {
        Ok(Some(_)) => {}
        Ok(None) => {
            return Err(error(
                StatusCode::NOT_FOUND,
                "PROJECT_NOT_FOUND",
                "Project not found",
            ));
        }
        Err(_) => {
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "DATASET_UNAVAILABLE",
                "Could not verify membership",
            ));
        }
    }
    let previous = sqlx::query("SELECT request_hash,response_json FROM idempotency_keys WHERE actor_id=? AND operation_id=? AND operation_kind='dataset_snapshot'").bind(&principal.user_id).bind(&request.operation_id).fetch_optional(&mut *connection).await;
    match previous {
        Ok(Some(row)) => {
            let hash: String = row.try_get("request_hash").unwrap_or_default();
            let body: String = row.try_get("response_json").unwrap_or_default();
            if hash != request_hash {
                return Err(error(
                    StatusCode::CONFLICT,
                    "IDEMPOTENCY_KEY_REUSE",
                    "operation_id was already used with another request",
                ));
            }
            return Ok(CaptureOutcome::Replay(body));
        }
        Err(_) => {
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "DATASET_UNAVAILABLE",
                "Could not check snapshot idempotency",
            ));
        }
        Ok(None) => {}
    }
    for excluded in &request.excluded {
        let known =
            sqlx::query("SELECT 1 FROM media_revisions WHERE project_id=? AND asset_revision_id=?")
                .bind(&project_id)
                .bind(&excluded.asset_revision_id)
                .fetch_optional(&mut *connection)
                .await;
        if !matches!(known, Ok(Some(_))) {
            return Err(error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "SNAPSHOT_EXCLUSION_INVALID",
                "Excluded media must belong to the requested project",
            ));
        }
    }
    let ontology_row = sqlx::query(
        "SELECT length(CAST(body_json AS BLOB)) AS byte_size,CASE WHEN length(CAST(body_json AS BLOB))<=16777216 THEN body_json END AS body_json FROM ontology_versions WHERE project_id=? AND ontology_version_id=?",
    )
    .bind(&project_id)
    .bind(&request.ontology_version_id)
    .fetch_optional(&mut *connection)
    .await;
    let ontology_binding: String = match ontology_row {
        Ok(Some(row)) => {
            let size: i64 = row.try_get("byte_size").unwrap_or(i64::MAX);
            if size > 16 * 1024 * 1024 {
                return Err(error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "DATASET_SIZE_LIMIT",
                    "Ontology exceeds snapshot manifest budget",
                ));
            }
            match row.try_get("body_json") {
                Ok(value) => value,
                Err(_) => {
                    return Err(error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "ONTOLOGY_CORRUPT",
                        "Stored ontology is invalid",
                    ))
                }
            }
        }
        Ok(None) => {
            return Err(error(
                StatusCode::NOT_FOUND,
                "ONTOLOGY_NOT_FOUND",
                "Ontology not found in project",
            ))
        }
        Err(_) => {
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "DATASET_UNAVAILABLE",
                "Could not capture ontology",
            ))
        }
    };

    let mut captured = Vec::with_capacity(request.items.len());
    let mut capture_bytes = 0usize;
    let mut retained_bytes = 0usize;
    for item in &request.items {
        let row = match sqlx::query(SNAPSHOT_REVISION_CAPTURE_SQL)
            .bind(&project_id)
            .bind(&item.asset_revision_id)
            .bind(&item.annotation_revision_id)
            .bind(&request.ontology_version_id)
            .fetch_optional(&mut *connection)
            .await
        {
            Ok(Some(row)) => row,
            Ok(None) => {
                return Err(error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "SNAPSHOT_REVISION_INVALID",
                    "Requested revision is unavailable",
                ))
            }
            Err(_) => {
                return Err(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "DATASET_UNAVAILABLE",
                    "Could not capture revision",
                ))
            }
        };
        let review = match sqlx::query("SELECT d.review_id,d.decided_by,d.reason,d.created_at,json_array(d.review_id,d.decided_by,d.reason,d.created_at,d.revision_ids_json,d.decision,s.project_id,s.task_id,s.revision_ids_json,t.project_id,t.asset_revision_id,t.ontology_version_id) AS binding FROM review_decisions d JOIN review_submissions s ON s.review_id=d.review_id JOIN review_tasks t ON t.task_id=s.task_id AND t.project_id=s.project_id WHERE d.decision='approve' AND s.project_id=? AND t.asset_revision_id=? AND t.ontology_version_id=? AND EXISTS (SELECT 1 FROM json_each(d.revision_ids_json) WHERE value=?) AND EXISTS (SELECT 1 FROM json_each(s.revision_ids_json) WHERE value=?) ORDER BY d.created_at DESC LIMIT 1").bind(&project_id).bind(&item.asset_revision_id).bind(&request.ontology_version_id).bind(&item.annotation_revision_id).bind(&item.annotation_revision_id).fetch_optional(&mut *connection).await {
            Ok(Some(row)) => row,
            Ok(None) => return Err(error(StatusCode::UNPROCESSABLE_ENTITY,"SNAPSHOT_NOT_APPROVED","Each revision requires approval")),
            Err(_) => return Err(error(StatusCode::SERVICE_UNAVAILABLE,"DATASET_UNAVAILABLE","Could not capture approval")),
        };
        let raw: Option<&str> = row.try_get("body_json").unwrap_or(None);
        let Some(raw) = raw else {
            return Err(error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "DATASET_SIZE_LIMIT",
                "Captured revision exceeds raw capture budget",
            ));
        };
        capture_bytes = capture_bytes.saturating_add(raw.len());
        let name: Option<&str> = row.try_get("original_name").unwrap_or(None);
        let Some(name) = name else {
            return Err(error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "DATASET_SIZE_LIMIT",
                "Retained filename exceeds manifest budget",
            ));
        };
        let reason: &str = review.try_get("reason").unwrap_or_default();
        retained_bytes = retained_bytes
            .saturating_add(name.len())
            .saturating_add(reason.len());
        if retained_bytes > 16 * 1024 * 1024 {
            return Err(error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "DATASET_SIZE_LIMIT",
                "Retained snapshot strings exceed manifest budget",
            ));
        }
        if capture_bytes > 16 * 1024 * 1024 {
            return Err(error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "DATASET_SIZE_LIMIT",
                "Snapshot exceeds manifest budget",
            ));
        }
        captured.push((row, review));
    }
    Ok(CaptureOutcome::Inputs(CapturedSnapshot {
        project_id,
        principal,
        request,
        ontology_binding,
        rows: captured,
    }))
}

async fn publish_snapshot_on(
    connection: &mut sqlx::SqliteConnection,
    prepared: &PreparedSnapshot,
    request_hash: &str,
) -> Result<Option<String>, axum::response::Response> {
    let CapturedSnapshot {
        project_id,
        principal,
        request,
        ontology_binding,
        rows: captured,
    } = &prepared.capture;
    let PreparedSnapshot {
        dataset_version_id,
        created_at,
        manifest_json,
        manifest_sha256,
        response_json,
        ..
    } = prepared;
    match sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM memberships WHERE project_id=? AND user_id=?",
    )
    .bind(&project_id)
    .bind(&principal.user_id)
    .fetch_one(&mut *connection)
    .await
    {
        Ok(1) => {}
        Ok(_) => {
            return Err(error(
                StatusCode::NOT_FOUND,
                "PROJECT_NOT_FOUND",
                "Project not found",
            ))
        }
        Err(_) => {
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "DATASET_UNAVAILABLE",
                "Could not revalidate membership",
            ))
        }
    }
    match sqlx::query("SELECT request_hash,response_json FROM idempotency_keys WHERE actor_id=? AND operation_id=? AND operation_kind='dataset_snapshot'")
        .bind(&principal.user_id).bind(&request.operation_id).fetch_optional(&mut *connection).await {
        Ok(Some(row)) => {
            let hash: String = row.try_get("request_hash").unwrap_or_default();
            if hash != request_hash { return Err(error(StatusCode::CONFLICT,"IDEMPOTENCY_KEY_REUSE","operation_id was already used with another request")); }
            let body: String = row.try_get("response_json").unwrap_or_default();
            return Ok(Some(body));
        }, Ok(None) => {}, Err(_) => return Err(error(StatusCode::SERVICE_UNAVAILABLE,"DATASET_UNAVAILABLE","Could not check replay")),
    }
    let ontology_now: Result<String, _> = sqlx::query_scalar(
        "SELECT body_json FROM ontology_versions WHERE project_id=? AND ontology_version_id=?",
    )
    .bind(&project_id)
    .bind(&request.ontology_version_id)
    .fetch_one(&mut *connection)
    .await;
    if ontology_now.as_ref().ok() != Some(ontology_binding) {
        return Err(error(
            StatusCode::CONFLICT,
            "SNAPSHOT_BINDING_CHANGED",
            "Snapshot ontology changed during preparation",
        ));
    }
    for (item, (captured_row, captured_review)) in request.items.iter().zip(captured.iter()) {
        let current = sqlx::query(SNAPSHOT_REVISION_CAPTURE_SQL)
            .bind(&project_id)
            .bind(&item.asset_revision_id)
            .bind(&item.annotation_revision_id)
            .bind(&request.ontology_version_id)
            .fetch_optional(&mut *connection)
            .await;
        let same = match current {
            Ok(Some(row)) => {
                row.try_get::<&str, _>("binding").ok()
                    == captured_row.try_get::<&str, _>("binding").ok()
                    && row.try_get::<&str, _>("body_json").ok()
                        == captured_row.try_get::<&str, _>("body_json").ok()
                    && row.try_get::<&str, _>("original_name").ok()
                        == captured_row.try_get::<&str, _>("original_name").ok()
            }
            Ok(None) => false,
            Err(_) => {
                return Err(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "DATASET_UNAVAILABLE",
                    "Could not revalidate revision",
                ))
            }
        };
        let review_id: String = captured_review.try_get("review_id").unwrap_or_default();
        let current_review: Result<Option<String>,_> = sqlx::query_scalar("SELECT json_array(d.review_id,d.decided_by,d.reason,d.created_at,d.revision_ids_json,d.decision,s.project_id,s.task_id,s.revision_ids_json,t.project_id,t.asset_revision_id,t.ontology_version_id) FROM review_decisions d JOIN review_submissions s ON s.review_id=d.review_id JOIN review_tasks t ON t.task_id=s.task_id AND t.project_id=s.project_id WHERE d.review_id=? AND d.decision='approve' AND s.project_id=? AND t.asset_revision_id=? AND t.ontology_version_id=? AND EXISTS(SELECT 1 FROM json_each(d.revision_ids_json) WHERE value=?) AND EXISTS(SELECT 1 FROM json_each(s.revision_ids_json) WHERE value=?)")
            .bind(review_id).bind(&project_id).bind(&item.asset_revision_id).bind(&request.ontology_version_id)
            .bind(&item.annotation_revision_id).bind(&item.annotation_revision_id).fetch_optional(&mut *connection).await;
        let same_review = match current_review {
            Ok(value) => value == captured_review.try_get::<String, _>("binding").ok(),
            Err(_) => {
                return Err(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "DATASET_UNAVAILABLE",
                    "Could not revalidate approval",
                ))
            }
        };
        if !same || !same_review {
            return Err(error(
                StatusCode::CONFLICT,
                "SNAPSHOT_BINDING_CHANGED",
                "Snapshot binding changed during preparation",
            ));
        }
    }
    for excluded in &request.excluded {
        match sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM media_revisions WHERE project_id=? AND asset_revision_id=?",
        )
        .bind(&project_id)
        .bind(&excluded.asset_revision_id)
        .fetch_one(&mut *connection)
        .await
        {
            Ok(1) => {}
            Ok(_) => {
                return Err(error(
                    StatusCode::CONFLICT,
                    "SNAPSHOT_BINDING_CHANGED",
                    "Excluded media binding changed",
                ))
            }
            Err(_) => {
                return Err(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "DATASET_UNAVAILABLE",
                    "Could not revalidate excluded media",
                ))
            }
        }
    }
    let inserted = sqlx::query("INSERT INTO dataset_versions(dataset_version_id,project_id,ontology_version_id,manifest_json,manifest_sha256,created_by,created_at) VALUES(?,?,?,?,?,?,?)").bind(&dataset_version_id).bind(&project_id).bind(&request.ontology_version_id).bind(&manifest_json).bind(&manifest_sha256).bind(&principal.user_id).bind(&created_at).execute(&mut *connection).await;
    let idem = sqlx::query("INSERT INTO idempotency_keys(actor_id,operation_id,operation_kind,request_hash,response_json,created_at) VALUES(?,?,'dataset_snapshot',?,?,?)").bind(&principal.user_id).bind(&request.operation_id).bind(request_hash).bind(response_json).bind(&created_at).execute(&mut *connection).await;

    if inserted.is_err() || idem.is_err() {
        return Err(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "DATASET_PERSIST_FAILED",
            "Could not persist dataset snapshot",
        ));
    }
    Ok(None)
}

fn snapshot_replay_response(body: &str) -> axum::response::Response {
    match serde_json::from_str::<SnapshotResponse>(body) {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "DATASET_CORRUPT",
            "Stored snapshot response is invalid",
        ),
    }
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

pub(super) fn verify_media_object_with_limit(
    store: &crate::storage::ObjectStore,
    hash: &str,
    limit: u64,
) -> Result<u64, &'static str> {
    let path = store.path_for_hash(hash).ok_or("MEDIA_OBJECT_INVALID")?;
    let declared = std::fs::metadata(&path)
        .map_err(|_| "MEDIA_OBJECT_MISSING")?
        .len();
    if declared > limit {
        return Err("DATASET_SIZE_LIMIT");
    }
    let mut reader = std::fs::File::open(path)
        .map_err(|_| "MEDIA_OBJECT_MISSING")?
        .take(limit.saturating_add(1));
    let mut buffer = [0u8; 16384];
    let mut total = 0u64;
    let mut digest = Sha256::new();
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| "MEDIA_OBJECT_MISSING")?;
        if read == 0 {
            break;
        }
        total = total.checked_add(read as u64).ok_or("DATASET_SIZE_LIMIT")?;
        if total > limit || total > declared {
            return Err("DATASET_SIZE_LIMIT");
        }
        digest.update(&buffer[..read]);
    }
    if total != declared {
        return Err("DATASET_SIZE_LIMIT");
    }
    if format!("{:x}", digest.finalize()) != hash {
        return Err("MEDIA_OBJECT_INVALID");
    }
    Ok(total)
}

#[cfg(test)]
mod commercial_d_private_tests {
    use super::*;
    use crate::storage::ObjectStore;

    #[test]
    fn media_verification_exact_production_byte_boundary() {
        let directory = tempfile::tempdir().unwrap();
        let store = ObjectStore::new(directory.path().join("objects")).unwrap();
        for extra in [0, 1] {
            let bytes = vec![7; (96 * 1024 * 1024) + extra];
            let object = store
                .stage_bytes("media", &bytes)
                .unwrap()
                .publish()
                .unwrap();
            drop(bytes);
            if extra == 0 {
                assert_eq!(
                    verify_media_object_with_limit(&store, &object.sha256, 96 * 1024 * 1024),
                    Ok(96 * 1024 * 1024)
                );
            } else {
                assert_eq!(
                    verify_media_object_with_limit(&store, &object.sha256, 96 * 1024 * 1024),
                    Err("DATASET_SIZE_LIMIT")
                );
            }
            std::fs::remove_file(object.path).unwrap();
        }
    }

    #[test]
    fn media_verification_checks_remaining_bytes_and_hash_including_zero() {
        let directory = tempfile::tempdir().unwrap();
        let store = ObjectStore::new(directory.path().join("objects")).unwrap();
        let empty = store.stage_bytes("empty", b"").unwrap().publish().unwrap();
        assert_eq!(
            verify_media_object_with_limit(&store, &empty.sha256, 0),
            Ok(0)
        );
        let object = store
            .stage_bytes("media", b"abc")
            .unwrap()
            .publish()
            .unwrap();
        assert_eq!(
            verify_media_object_with_limit(&store, &object.sha256, 3),
            Ok(3)
        );
        assert_eq!(
            verify_media_object_with_limit(&store, &object.sha256, 2),
            Err("DATASET_SIZE_LIMIT")
        );
        std::fs::write(&object.path, b"abd").unwrap();
        assert_eq!(
            verify_media_object_with_limit(&store, &object.sha256, 3),
            Err("MEDIA_OBJECT_INVALID")
        );
        std::fs::remove_file(&object.path).unwrap();
        assert_eq!(
            verify_media_object_with_limit(&store, &object.sha256, 3),
            Err("MEDIA_OBJECT_MISSING")
        );
    }
    use crate::storage::Repository;
    use serde_json::{json, Value};
    use std::{io::Cursor, time::Duration};
    struct SnapshotFixture {
        _directory: tempfile::TempDir,
        repository: Repository,
        manifest: SnapshotManifest,
    }
    async fn fixture(padding: usize) -> SnapshotFixture {
        let directory = tempfile::tempdir().unwrap();
        let repository = Repository::open(
            &format!(
                "sqlite:{}",
                directory.path().join("export.sqlite").display()
            ),
            directory.path().join("objects"),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        let id = || Uuid::new_v4().to_string();
        let project = id();
        let actor = id();
        let ontology_id = id();
        let dataset = id();
        let asset = id();
        let media_id = id();
        let revision_id = id();
        let review_id = id();
        let task_id = id();
        let now = now_rfc3339();
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::new(1, 1))
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let object = repository
            .object_store()
            .stage_bytes("image.png", png.get_ref())
            .unwrap()
            .publish()
            .unwrap();
        let ontology = json!({"ontology_version_id":ontology_id,"project_id":project,"version_no":1,"labels":[],"guidelines_markdown":"中\"\\","allow_out_of_bounds":false});
        let document: annotation_domain::AnnotationDocument = serde_json::from_value(json!({
            "schema_version":1,"asset_revision_id":media_id,"ontology_version_id":ontology_id,
            "coordinate_space":{"type":"canonical_image_pixels","width":1,"height":1},
            "completion":"confirmed_negative","objects":[]
        }))
        .unwrap();
        let serialized = annotation_domain::hash::serialize_document(&document).unwrap();
        let media = json!({"asset_id":asset,"asset_revision_id":media_id,"project_id":project,
            "original_name":"中-image.png","original_sha256":object.sha256,"canonical_sha256":object.sha256,
            "canonical_width":1,"canonical_height":1,"exif_orientation":1,
            "original_to_canonical":[1.0,0.0,0.0,0.0,1.0,0.0,0.0,0.0,1.0],"source_group_id":id()});
        let manifest: SnapshotManifest = serde_json::from_value(json!({
            "schema_version":1,"dataset_version_id":dataset,"project_id":project,"ontology":ontology,
            "items":[{"media_revision":media,"revision":{"annotation_revision_id":revision_id,"parent_revision_id":null,
                "revision_no":1,"document":document,"created_at":now,"created_by":actor,"content_hash":serialized.content_hash},
                "split":"train","review_id":review_id,"reviewed_by":actor,"review_reason":"approved negative",
                "reviewed_at":now,"original_object_sha256":object.sha256,"canonical_object_sha256":object.sha256}],
            "excluded":[],"category_mapping":[],"created_by":actor,"created_at":now,"split_seed":null,"split_ratios":null
        })).unwrap();
        manifest.ontology.validate().unwrap();
        manifest.items[0].media_revision.validate().unwrap();
        super::super::snapshot::validate_snapshot_document(&manifest.items[0].revision.document)
            .unwrap();
        let text = serde_json::to_string(&manifest).unwrap();
        let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
        let mut tx = repository.begin_write().await.unwrap();
        sqlx::query("INSERT INTO users(user_id,username,password_hash,created_at) VALUES(?,?,?,?)")
            .bind(&actor)
            .bind("export-test-admin")
            .bind("unused-test-hash")
            .bind(&now)
            .execute(tx.connection())
            .await
            .unwrap();
        sqlx::query("INSERT INTO projects(project_id,name,description,created_at) VALUES(?,?,?,?)")
            .bind(&project)
            .bind("export test")
            .bind("")
            .bind(&now)
            .execute(tx.connection())
            .await
            .unwrap();
        sqlx::query("INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,'admin')")
            .bind(&project)
            .bind(&actor)
            .execute(tx.connection())
            .await
            .unwrap();
        sqlx::query("INSERT INTO ontology_versions(ontology_version_id,project_id,version_no,body_json,created_at) VALUES(?,?,1,?,?)")
            .bind(&ontology_id).bind(&project).bind(ontology.to_string()).bind(&now).execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO media_assets(asset_id,project_id,created_at) VALUES(?,?,?)")
            .bind(&asset)
            .bind(&project)
            .bind(&now)
            .execute(tx.connection())
            .await
            .unwrap();
        sqlx::query("INSERT INTO media_revisions(asset_revision_id,project_id,asset_id,original_sha256,canonical_sha256,original_name,created_at) VALUES(?,?,?,?,?,?,?)")
            .bind(&media_id).bind(&project).bind(&asset).bind(&object.sha256).bind(&object.sha256).bind("中-image.png").bind(&now).execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO media_object_refs(asset_revision_id,sha256) VALUES(?,?)")
            .bind(&media_id)
            .bind(&object.sha256)
            .execute(tx.connection())
            .await
            .unwrap();
        sqlx::query("INSERT INTO media_metadata(asset_revision_id,canonical_width,canonical_height,exif_orientation,original_to_canonical_json,source_group_id,original_object_sha256,canonical_object_sha256,preview_object_sha256) VALUES(?,1,1,1,?,?,?,?,?)")
            .bind(&media_id).bind(media["original_to_canonical"].to_string()).bind(media["source_group_id"].as_str().unwrap())
            .bind(&object.sha256).bind(&object.sha256).bind(&object.sha256).execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO annotation_revisions(annotation_revision_id,project_id,asset_revision_id,ontology_version_id,parent_revision_id,revision_no,body_json,content_hash,created_by,created_at) VALUES(?,?,?,?,NULL,1,?,?,?,?)")
            .bind(&revision_id).bind(&project).bind(&media_id).bind(&ontology_id).bind(format!("{}{}",serialized.json," ".repeat(padding))).bind(&serialized.content_hash).bind(&actor).bind(&now).execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO annotation_heads(project_id,asset_revision_id,ontology_version_id,annotation_revision_id) VALUES(?,?,?,?)")
            .bind(&project).bind(&media_id).bind(&ontology_id).bind(&revision_id).execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO review_tasks(task_id,project_id,asset_revision_id,ontology_version_id,assignee_id,created_by,state,created_at) VALUES(?,?,?,?,?,?,'closed',?)")
            .bind(&task_id).bind(&project).bind(&media_id).bind(&ontology_id).bind(&actor).bind(&actor).bind(&now).execute(tx.connection()).await.unwrap();
        let revisions = json!([revision_id]).to_string();
        sqlx::query("INSERT INTO review_submissions(review_id,task_id,project_id,submitted_by,revision_ids_json,state,created_at) VALUES(?,?,?,?,?,'approved',?)")
            .bind(&review_id).bind(&task_id).bind(&project).bind(&actor).bind(&revisions).bind(&now).execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO review_decisions(review_id,decided_by,decision,reason,revision_ids_json,created_at) VALUES(?,?,'approve','approved negative',?,?)")
            .bind(&review_id).bind(&actor).bind(&revisions).bind(&now).execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO dataset_versions(dataset_version_id,project_id,ontology_version_id,manifest_json,manifest_sha256,created_by,created_at) VALUES(?,?,?,?,?,?,?)")
            .bind(&dataset).bind(&project).bind(&ontology_id).bind(text).bind(&digest).bind(&actor).bind(&now).execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
        SnapshotFixture {
            _directory: directory,
            repository,
            manifest,
        }
    }
    impl SnapshotFixture {
        fn principal(&self) -> Principal {
            Principal {
                user_id: self.manifest.created_by.clone(),
                username: "snapshot-test".into(),
                platform_admin: false,
            }
        }
        fn request(&self, operation: &str) -> SnapshotRequest {
            serde_json::from_value(json!({"operation_id":operation,"ontology_version_id":self.manifest.ontology.ontology_version_id,
                "items":[{"asset_revision_id":self.manifest.items[0].media_revision.asset_revision_id,
                    "annotation_revision_id":self.manifest.items[0].revision.annotation_revision_id,"split":"train"}],"excluded":[]})).unwrap()
        }
        async fn create(&self, request: SnapshotRequest) -> axum::response::Response {
            create(
                State(DatasetState {
                    repository: self.repository.clone(),
                }),
                Path(self.manifest.project_id.clone()),
                Extension(self.principal()),
                Json(request),
            )
            .await
        }
        async fn counts(&self) -> (i64, i64) {
            let mut tx = self.repository.begin_write().await.unwrap();
            let counts = sqlx::query_as("SELECT (SELECT COUNT(*) FROM dataset_versions),(SELECT COUNT(*) FROM idempotency_keys WHERE operation_kind='dataset_snapshot')")
                .fetch_one(tx.connection()).await.unwrap();
            tx.rollback().await.unwrap();
            counts
        }
    }
    async fn response_json(response: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), 32 * 1024 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
    fn prepare_gate() -> (
        SnapshotPrepareGate,
        tokio::sync::oneshot::Receiver<()>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let (entered, observed) = tokio::sync::oneshot::channel();
        let (release, wait) = tokio::sync::oneshot::channel();
        (
            SnapshotPrepareGate {
                entered,
                release: wait,
            },
            observed,
            release,
        )
    }
    async fn prepare_real_snapshot(
        f: &SnapshotFixture,
        request: SnapshotRequest,
    ) -> (PreparedSnapshot, String) {
        let request_hash = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(f.manifest.project_id.as_str(), &request)).unwrap()
            )
        );
        let mut tx = f.repository.begin_write().await.unwrap();
        let captured = capture_snapshot_on(
            tx.connection(),
            f.manifest.project_id.clone(),
            f.principal(),
            request,
            &request_hash,
        )
        .await;
        tx.rollback().await.unwrap();
        let capture = match captured {
            Ok(CaptureOutcome::Inputs(capture)) => capture,
            Ok(CaptureOutcome::Replay(_)) => panic!("fresh snapshot unexpectedly replayed"),
            Err(response) => panic!("real snapshot capture failed: {}", response.status()),
        };
        let prepared = match build_snapshot(capture, f.repository.object_store()) {
            Ok(prepared) => prepared,
            Err(response) => panic!("real snapshot preparation failed: {}", response.status()),
        };
        (prepared, request_hash)
    }

    #[test]
    fn logical_scope_and_media_budget_count_every_reference() {
        let ids: Vec<_> = (0..1025).map(|i| format!("id-{i}")).collect();
        assert!(validate_logical_scope(
            ids[..1].iter().map(String::as_str),
            ids[1..1024].iter().map(String::as_str)
        )
        .is_ok());
        assert!(validate_logical_scope(
            ids[..1].iter().map(String::as_str),
            ids[1..].iter().map(String::as_str)
        )
        .is_err());
        assert!(
            validate_logical_scope(std::iter::empty(), ids[..1].iter().map(String::as_str))
                .is_err()
        );
        assert!(validate_logical_scope(
            ids[..1].iter().map(String::as_str),
            ids[..1].iter().map(String::as_str)
        )
        .is_err());
        let mut budget = MediaVerificationBudget::default();
        for _ in 0..2048 {
            budget.charge(0).unwrap();
        }
        assert!(budget.charge(0).is_err());
        assert_eq!(budget.members, 2048);
        assert_eq!(budget.bytes, 0);
        let mut budget = MediaVerificationBudget::default();
        budget.charge(48 * 1024 * 1024).unwrap();
        budget.charge(48 * 1024 * 1024).unwrap();
        assert!(budget.charge(1).is_err());
        assert_eq!(budget.bytes, 96 * 1024 * 1024);
        assert_eq!(budget.members, 2);
    }

    #[tokio::test]
    async fn exact_db_manifest_utf8_boundary_and_removed_body_estimator() {
        let f = fixture(0).await;
        let baseline = f.create(f.request(&Uuid::new_v4().to_string())).await;
        assert_eq!(baseline.status(), StatusCode::CREATED);
        let body = response_json(baseline).await;
        let mut tx = f.repository.begin_write().await.unwrap();
        let base: String = sqlx::query_scalar(
            "SELECT manifest_json FROM dataset_versions WHERE dataset_version_id=?",
        )
        .bind(body["dataset_version_id"].as_str().unwrap())
        .fetch_one(tx.connection())
        .await
        .unwrap();
        let original = &f.manifest.items[0].media_revision.original_name;
        let padded = format!("{}{}", original, "x".repeat(16 * 1024 * 1024 - base.len()));
        sqlx::query("UPDATE media_revisions SET original_name=? WHERE asset_revision_id=?")
            .bind(&padded)
            .bind(&*f.manifest.items[0].media_revision.asset_revision_id)
            .execute(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let exact = f.create(f.request(&Uuid::new_v4().to_string())).await;
        assert_eq!(exact.status(), StatusCode::CREATED);
        let exact = response_json(exact).await;
        let mut tx = f.repository.begin_write().await.unwrap();
        let text: String = sqlx::query_scalar(
            "SELECT manifest_json FROM dataset_versions WHERE dataset_version_id=?",
        )
        .bind(exact["dataset_version_id"].as_str().unwrap())
        .fetch_one(tx.connection())
        .await
        .unwrap();
        assert_eq!(text.len(), 16 * 1024 * 1024);
        assert_eq!(
            format!("{:x}", Sha256::digest(text.as_bytes())),
            exact["manifest_sha256"].as_str().unwrap()
        );
        sqlx::query("UPDATE media_revisions SET original_name=? WHERE asset_revision_id=?")
            .bind(format!("{padded}x"))
            .bind(&*f.manifest.items[0].media_revision.asset_revision_id)
            .execute(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let before = f.counts().await;
        let oversized = f.create(f.request(&Uuid::new_v4().to_string())).await;
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(f.counts().await, before);
        let f = fixture(16 * 1024 * 1024 - 1024).await;
        let mut tx = f.repository.begin_write().await.unwrap();
        let stored: String =
            sqlx::query_scalar("SELECT body_json FROM annotation_revisions LIMIT 1")
                .fetch_one(tx.connection())
                .await
                .unwrap();
        assert!(stored.len() + 2048 > 16 * 1024 * 1024);
        assert!(stored.len() < 16 * 1024 * 1024);
        tx.rollback().await.unwrap();
        let response = f.create(f.request(&Uuid::new_v4().to_string())).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let result = response_json(response).await;
        let mut tx = f.repository.begin_write().await.unwrap();
        let text: String = sqlx::query_scalar(
            "SELECT manifest_json FROM dataset_versions WHERE dataset_version_id=?",
        )
        .bind(result["dataset_version_id"].as_str().unwrap())
        .fetch_one(tx.connection())
        .await
        .unwrap();
        let manifest: SnapshotManifest = serde_json::from_str(&text).unwrap();
        assert_eq!(manifest.items[0].revision, f.manifest.items[0].revision);
        assert!(text.len() < 16 * 1024 * 1024);
        tx.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn snapshot_capture_allows_writers_and_revalidates_membership_group_media_and_replay() {
        for mutation in 0..7 {
            let f = fixture(0).await;
            let operation = Uuid::new_v4().to_string();
            let request = f.request(&operation);
            let (gate, observed, release) = prepare_gate();
            let state = DatasetState {
                repository: f.repository.clone(),
            };
            let project = f.manifest.project_id.clone();
            let principal = f.principal();
            let worker = tokio::spawn(create_phases(
                state,
                project,
                principal,
                request,
                Some(gate),
            ));
            tokio::time::timeout(Duration::from_secs(3), observed)
                .await
                .unwrap()
                .unwrap();
            let mut tx = tokio::time::timeout(Duration::from_secs(2), f.repository.begin_write())
                .await
                .unwrap()
                .unwrap();
            if mutation == 0 {
                sqlx::query("DELETE FROM memberships WHERE project_id=? AND user_id=?")
                    .bind(&f.manifest.project_id)
                    .bind(&f.manifest.created_by)
                    .execute(tx.connection())
                    .await
                    .unwrap();
            } else if mutation == 1 {
                sqlx::query(
                    "UPDATE media_metadata SET source_group_id=? WHERE asset_revision_id=?",
                )
                .bind(Uuid::new_v4().to_string())
                .bind(&*f.manifest.items[0].media_revision.asset_revision_id)
                .execute(tx.connection())
                .await
                .unwrap();
            } else if mutation == 2 {
                sqlx::query("UPDATE media_revisions SET original_name='concurrent rename' WHERE asset_revision_id=?").bind(&*f.manifest.items[0].media_revision.asset_revision_id).execute(tx.connection()).await.unwrap();
            } else if mutation == 3 {
                let revision = &f.manifest.items[0].revision;
                let id = Uuid::new_v4().to_string();
                sqlx::query("INSERT INTO annotation_revisions(annotation_revision_id,project_id,asset_revision_id,ontology_version_id,parent_revision_id,revision_no,body_json,content_hash,created_by,created_at) SELECT ?,project_id,asset_revision_id,ontology_version_id,annotation_revision_id,2,body_json,content_hash,created_by,created_at FROM annotation_revisions WHERE annotation_revision_id=?")
                    .bind(&id).bind(&*revision.annotation_revision_id).execute(tx.connection()).await.unwrap();
                sqlx::query("UPDATE annotation_heads SET annotation_revision_id=? WHERE asset_revision_id=?").bind(id).bind(&*f.manifest.items[0].media_revision.asset_revision_id).execute(tx.connection()).await.unwrap();
            } else if mutation == 4 {
                sqlx::query(
                    "UPDATE projects SET description='concurrent writer' WHERE project_id=?",
                )
                .bind(&f.manifest.project_id)
                .execute(tx.connection())
                .await
                .unwrap();
            } else if mutation == 5 {
                // Approved submissions are immutable. Exercise the real guard,
                // then preserve the unchanged approval as a valid publish control.
                let rejected = sqlx::query(
                    "UPDATE review_submissions SET revision_ids_json='[]' WHERE review_id=?",
                )
                .bind(&f.manifest.items[0].review_id)
                .execute(tx.connection())
                .await;
                assert!(matches!(rejected, Err(sqlx::Error::Database(_))));
                let revisions: String = sqlx::query_scalar(
                    "SELECT revision_ids_json FROM review_submissions WHERE review_id=?",
                )
                .bind(&f.manifest.items[0].review_id)
                .fetch_one(tx.connection())
                .await
                .unwrap();
                let revisions: Value = serde_json::from_str(&revisions).unwrap();
                assert_eq!(
                    revisions,
                    json!([f.manifest.items[0].revision.annotation_revision_id])
                );
            } else {
                // A missing object reference is rejected at COMMIT, not UPDATE.
                // Observe rollback through a fresh connection before testing a
                // legal, referenced media mutation against final publication.
                sqlx::query(
                    "UPDATE media_metadata SET canonical_object_sha256=? WHERE asset_revision_id=?",
                )
                .bind("0".repeat(64))
                .bind(&*f.manifest.items[0].media_revision.asset_revision_id)
                .execute(tx.connection())
                .await
                .unwrap();
                let rejected = tx.commit().await;
                assert!(matches!(rejected, Err(sqlx::Error::Database(_))));
                let mut observer = f.repository.begin_write().await.unwrap();
                let durable: String = sqlx::query_scalar(
                    "SELECT canonical_object_sha256 FROM media_metadata WHERE asset_revision_id=?",
                )
                .bind(&*f.manifest.items[0].media_revision.asset_revision_id)
                .fetch_one(observer.connection())
                .await
                .unwrap();
                assert_eq!(durable, f.manifest.items[0].canonical_object_sha256);
                let approval: String = sqlx::query_scalar("SELECT t.asset_revision_id FROM review_tasks t JOIN review_submissions s ON s.task_id=t.task_id WHERE s.review_id=?")
                    .bind(&f.manifest.items[0].review_id).fetch_one(observer.connection()).await.unwrap();
                assert_eq!(
                    approval,
                    &*f.manifest.items[0].media_revision.asset_revision_id
                );
                observer.rollback().await.unwrap();
                let mut png = Cursor::new(Vec::new());
                image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
                    1,
                    1,
                    image::Rgb([99, 88, 77]),
                ))
                .write_to(&mut png, image::ImageFormat::Png)
                .unwrap();
                let alternate = f
                    .repository
                    .object_store()
                    .stage_bytes("alternate-canonical.png", png.get_ref())
                    .unwrap()
                    .publish()
                    .unwrap();
                tx = f.repository.begin_write().await.unwrap();
                sqlx::query("INSERT INTO media_object_refs(asset_revision_id,sha256) VALUES(?,?)")
                    .bind(&*f.manifest.items[0].media_revision.asset_revision_id)
                    .bind(&alternate.sha256)
                    .execute(tx.connection())
                    .await
                    .unwrap();
                sqlx::query(
                    "UPDATE media_metadata SET canonical_object_sha256=? WHERE asset_revision_id=?",
                )
                .bind(&alternate.sha256)
                .bind(&*f.manifest.items[0].media_revision.asset_revision_id)
                .execute(tx.connection())
                .await
                .unwrap();
                sqlx::query(
                    "UPDATE media_revisions SET canonical_sha256=? WHERE asset_revision_id=?",
                )
                .bind(&alternate.sha256)
                .bind(&*f.manifest.items[0].media_revision.asset_revision_id)
                .execute(tx.connection())
                .await
                .unwrap();
            }
            tx.commit().await.unwrap();
            let winner = if mutation == 4 {
                let response = f.create(f.request(&operation)).await;
                assert_eq!(response.status(), StatusCode::CREATED);
                Some(response_json(response).await)
            } else {
                None
            };
            release.send(()).unwrap();
            let response = worker.await.unwrap();
            if mutation == 0 {
                assert_eq!(response.status(), StatusCode::NOT_FOUND);
                assert_eq!(f.counts().await, (1, 0));
            } else if matches!(mutation, 1 | 2 | 6) {
                assert_eq!(response.status(), StatusCode::CONFLICT);
                assert_eq!(f.counts().await, (1, 0));
            } else {
                assert_eq!(
                    response.status(),
                    if mutation == 4 {
                        StatusCode::OK
                    } else {
                        StatusCode::CREATED
                    }
                );
                let body = response_json(response).await;
                assert_eq!(
                    body["items"][0]["annotation_revision_id"],
                    f.manifest.items[0]
                        .revision
                        .annotation_revision_id
                        .to_string()
                );
                if mutation == 5 {
                    assert_eq!(f.counts().await, (2, 1));
                    let mut observer = f.repository.begin_write().await.unwrap();
                    let text: String = sqlx::query_scalar(
                        "SELECT manifest_json FROM dataset_versions WHERE dataset_version_id=?",
                    )
                    .bind(body["dataset_version_id"].as_str().unwrap())
                    .fetch_one(observer.connection())
                    .await
                    .unwrap();
                    let frozen: SnapshotManifest = serde_json::from_str(&text).unwrap();
                    assert_eq!(frozen.items[0].review_id, f.manifest.items[0].review_id);
                    assert_eq!(
                        frozen.items[0].review_reason,
                        f.manifest.items[0].review_reason
                    );
                    assert_eq!(frozen.items[0].revision, f.manifest.items[0].revision);
                    observer.rollback().await.unwrap();
                }
                if let Some(winner) = winner {
                    assert_eq!(body, winner);
                    assert_eq!(f.counts().await, (2, 1));
                    let mut changed = f.request(&operation);
                    changed.items[0].split = Split::Val;
                    assert_eq!(f.create(changed).await.status(), StatusCode::CONFLICT);
                    assert_eq!(f.counts().await, (2, 1));
                }
            }
        }
        // Both approvals below are immutable, real committed DB rows. Swap
        // only the captured approval after the real builder has prepared the
        // original manifest; the final publisher must revalidate exact scope.
        let f = fixture(0).await;
        let alternate_revision = Uuid::new_v4().to_string();
        let alternate_review = Uuid::new_v4().to_string();
        let alternate_task = Uuid::new_v4().to_string();
        let revisions = json!([alternate_revision]).to_string();
        let now = now_rfc3339();
        let mut tx = f.repository.begin_write().await.unwrap();
        sqlx::query("INSERT INTO annotation_revisions(annotation_revision_id,project_id,asset_revision_id,ontology_version_id,parent_revision_id,revision_no,body_json,content_hash,created_by,created_at) SELECT ?,project_id,asset_revision_id,ontology_version_id,annotation_revision_id,2,body_json,content_hash,created_by,created_at FROM annotation_revisions WHERE annotation_revision_id=?")
            .bind(&alternate_revision).bind(&*f.manifest.items[0].revision.annotation_revision_id).execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO review_tasks(task_id,project_id,asset_revision_id,ontology_version_id,assignee_id,created_by,state,created_at) VALUES(?,?,?,?,?,?,'closed',?)")
            .bind(&alternate_task).bind(&f.manifest.project_id).bind(&*f.manifest.items[0].media_revision.asset_revision_id)
            .bind(&*f.manifest.ontology.ontology_version_id).bind(&f.manifest.created_by).bind(&f.manifest.created_by).bind(&now).execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO review_submissions(review_id,task_id,project_id,submitted_by,revision_ids_json,state,created_at) VALUES(?,?,?,?,?,'approved',?)")
            .bind(&alternate_review).bind(&alternate_task).bind(&f.manifest.project_id).bind(&f.manifest.created_by).bind(&revisions).bind(&now).execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO review_decisions(review_id,decided_by,decision,reason,revision_ids_json,created_at) VALUES(?,?,'approve','independently approved revision',?,?)")
            .bind(&alternate_review).bind(&f.manifest.created_by).bind(&revisions).bind(&now).execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
        let (mut prepared, request_hash) =
            prepare_real_snapshot(&f, f.request(&Uuid::new_v4().to_string())).await;
        let mut alternate_request = f.request(&Uuid::new_v4().to_string());
        alternate_request.items[0].annotation_revision_id = alternate_revision;
        let (alternate, _) = prepare_real_snapshot(&f, alternate_request).await;
        let (_, alternate_approval) = alternate.capture.rows.into_iter().next().unwrap();
        assert_eq!(
            alternate_approval
                .try_get::<String, _>("review_id")
                .unwrap(),
            alternate_review
        );
        let original_approval =
            std::mem::replace(&mut prepared.capture.rows[0].1, alternate_approval);
        let mut tx = f.repository.begin_write().await.unwrap();
        let rejected = publish_snapshot_on(tx.connection(), &prepared, &request_hash).await;
        tx.rollback().await.unwrap();
        let response = match rejected {
            Err(response) => response,
            Ok(_) => panic!("publisher accepted approval for another revision"),
        };
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            response_json(response).await["code"],
            "SNAPSHOT_BINDING_CHANGED"
        );
        assert_eq!(f.counts().await, (1, 0));
        prepared.capture.rows[0].1 = original_approval;
        let mut tx = f.repository.begin_write().await.unwrap();
        let accepted = publish_snapshot_on(tx.connection(), &prepared, &request_hash).await;
        assert!(matches!(accepted, Ok(None)));
        tx.commit().await.unwrap();
        assert_eq!(f.counts().await, (2, 1));
        let mut observer = f.repository.begin_write().await.unwrap();
        let text: String = sqlx::query_scalar(
            "SELECT manifest_json FROM dataset_versions WHERE dataset_version_id=?",
        )
        .bind(&prepared.dataset_version_id)
        .fetch_one(observer.connection())
        .await
        .unwrap();
        observer.rollback().await.unwrap();
        let manifest: SnapshotManifest = serde_json::from_str(&text).unwrap();
        assert_eq!(manifest.items[0].review_id, f.manifest.items[0].review_id);
        assert_eq!(
            manifest.items[0].revision.annotation_revision_id,
            f.manifest.items[0].revision.annotation_revision_id
        );
    }
    #[tokio::test]
    async fn real_snapshot_charges_same_digest_twice_at_media_limit_and_rejects_next_byte() {
        let f = fixture(0).await;
        let mut bytes = vec![7u8; 48 * 1024 * 1024];
        let exact = f
            .repository
            .object_store()
            .stage_bytes("synthetic-original.bin", &bytes)
            .unwrap()
            .publish()
            .unwrap();
        bytes.push(8);
        let over = f
            .repository
            .object_store()
            .stage_bytes("synthetic-canonical.bin", &bytes)
            .unwrap()
            .publish()
            .unwrap();
        drop(bytes);
        let media = &*f.manifest.items[0].media_revision.asset_revision_id;
        let mut tx = f.repository.begin_write().await.unwrap();
        sqlx::query("UPDATE media_revisions SET original_sha256=?,canonical_sha256=? WHERE asset_revision_id=?")
            .bind(&exact.sha256).bind(&exact.sha256).bind(media).execute(tx.connection()).await.unwrap();
        sqlx::query("UPDATE media_metadata SET original_object_sha256=?,canonical_object_sha256=? WHERE asset_revision_id=?")
            .bind(&exact.sha256).bind(&exact.sha256).bind(media).execute(tx.connection()).await.unwrap();
        for hash in [&exact.sha256, &over.sha256] {
            sqlx::query("INSERT INTO media_object_refs(asset_revision_id,sha256) VALUES(?,?)")
                .bind(media)
                .bind(hash)
                .execute(tx.connection())
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
        let response = f.create(f.request(&Uuid::new_v4().to_string())).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let body = response_json(response).await;
        let mut tx = f.repository.begin_write().await.unwrap();
        let text: String = sqlx::query_scalar(
            "SELECT manifest_json FROM dataset_versions WHERE dataset_version_id=?",
        )
        .bind(body["dataset_version_id"].as_str().unwrap())
        .fetch_one(tx.connection())
        .await
        .unwrap();
        let manifest: SnapshotManifest = serde_json::from_str(&text).unwrap();
        assert_eq!(manifest.items[0].original_object_sha256, exact.sha256);
        assert_eq!(manifest.items[0].canonical_object_sha256, exact.sha256);
        sqlx::query("UPDATE media_revisions SET canonical_sha256=? WHERE asset_revision_id=?")
            .bind(&over.sha256)
            .bind(media)
            .execute(tx.connection())
            .await
            .unwrap();
        sqlx::query(
            "UPDATE media_metadata SET canonical_object_sha256=? WHERE asset_revision_id=?",
        )
        .bind(&over.sha256)
        .bind(media)
        .execute(tx.connection())
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let before = f.counts().await;
        let response = f.create(f.request(&Uuid::new_v4().to_string())).await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(response_json(response).await["code"], "DATASET_SIZE_LIMIT");
        assert_eq!(f.counts().await, before);
    }
}
