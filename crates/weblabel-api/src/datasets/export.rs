use super::{
    snapshot::{FrozenAsset, SnapshotManifest},
    DatasetState,
};
use crate::{
    auth::{error, Principal},
    projects::now_rfc3339,
};
use axum::response::IntoResponse;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use dataset_formats::{
    archive::{create_safe_zip, extract_safe_zip, ArchiveLimits},
    coco::export_coco,
    yolo::export_yolo,
    LossItem, LossReport,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, Deserialize, Serialize)]
pub(super) struct ExportRequest {
    format: String,
    loss_ack: bool,
    operation_id: String,
}
#[derive(Debug, Serialize, Deserialize)]
struct ExportJobResponse {
    job_id: String,
    state: String,
    format: String,
    loss_report: LossReport,
}
#[derive(Debug, Deserialize)]
struct ExportJobPayload {
    dataset_version_id: String,
    project_id: String,
    actor_id: String,
    format: String,
    loss_ack: bool,
    manifest_sha256: String,
}

const EXPORT_JOB_KIND: &str = "dataset_export";
const MAX_EXPORT_ITEMS: usize = 512;
const MAX_EXPORT_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
static EXPORT_PERMIT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

pub(super) async fn create(
    State(state): State<DatasetState>,
    Path(dataset_version_id): Path<String>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<ExportRequest>,
) -> axum::response::Response {
    if Uuid::parse_str(&request.operation_id).is_err()
        || !matches!(request.format.as_str(), "native" | "yolo" | "coco")
    {
        return error(
            StatusCode::BAD_REQUEST,
            "EXPORT_REQUEST_INVALID",
            "format and operation_id are invalid",
        );
    }
    let mut tx = match state.repository.begin_write().await {
        Ok(tx) => tx,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "EXPORT_UNAVAILABLE",
                "Could not start export transaction",
            )
        }
    };
    let row = sqlx::query("SELECT d.project_id,d.manifest_json,d.manifest_sha256 FROM dataset_versions d JOIN memberships m ON m.project_id=d.project_id WHERE d.dataset_version_id=? AND m.user_id=?")
        .bind(&dataset_version_id).bind(&principal.user_id).fetch_optional(tx.connection()).await;
    let (project_id, manifest_json, manifest_sha256): (String, String, String) =
        match row.ok().flatten() {
            Some(row) => (
                row.try_get("project_id").unwrap_or_default(),
                row.try_get("manifest_json").unwrap_or_default(),
                row.try_get("manifest_sha256").unwrap_or_default(),
            ),
            None => {
                let _ = tx.rollback().await;
                return error(
                    StatusCode::NOT_FOUND,
                    "DATASET_NOT_FOUND",
                    "Dataset version not found",
                );
            }
        };
    let manifest: SnapshotManifest = match serde_json::from_str::<SnapshotManifest>(&manifest_json)
    {
        Ok(value)
            if &*value.project_id == project_id.as_str()
                && value.dataset_version_id == dataset_version_id
                && format!("{:x}", Sha256::digest(manifest_json.as_bytes())) == manifest_sha256 =>
        {
            value
        }
        _ => {
            let _ = tx.rollback().await;
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATASET_CORRUPT",
                "Stored dataset snapshot is invalid",
            );
        }
    };
    if manifest.items.len() > MAX_EXPORT_ITEMS || manifest_json.len() > MAX_EXPORT_MANIFEST_BYTES {
        let _ = tx.rollback().await;
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "EXPORT_SIZE_LIMIT",
            "Snapshot exceeds the export worker budget",
        );
    }
    let loss_report = loss_report_for(&manifest, &request.format);
    if loss_report.requires_ack() && !request.loss_ack {
        let _ = tx.rollback().await;
        return (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"code":"LOSS_ACK_REQUIRED","message":"Loss acknowledgement is required before creating this export","loss_report":loss_report}))).into_response();
    }
    let queue = crate::jobs::queue::JobQueue::new(state.repository.clone());
    let payload = json!({"dataset_version_id":dataset_version_id,"project_id":project_id,"actor_id":principal.user_id,"format":request.format,"loss_ack":request.loss_ack,"manifest_sha256":manifest_sha256});
    let _ = tx.rollback().await;
    let enqueued = match queue
        .enqueue(
            Some(&project_id),
            EXPORT_JOB_KIND,
            &request.operation_id,
            &payload,
        )
        .await
    {
        Ok(value) => value,
        Err(crate::jobs::queue::QueueError::IdempotencyConflict) => {
            return error(
                StatusCode::CONFLICT,
                "IDEMPOTENCY_KEY_REUSE",
                "operation_id was already used with another export request",
            )
        }
        Err(crate::jobs::queue::QueueError::QueueFull) => {
            return error(
                StatusCode::TOO_MANY_REQUESTS,
                "JOB_QUEUE_FULL",
                "Export queue is full",
            )
        }
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "EXPORT_UNAVAILABLE",
                "Could not enqueue export job",
            )
        }
    };
    let status = match queue.status(&project_id, &enqueued.job_id).await {
        Ok(Some(job)) => job.state,
        _ => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "EXPORT_STATUS_UNAVAILABLE",
                "Export job was enqueued but its current status is unavailable",
            )
        }
    };
    let status_code = if enqueued.duplicate {
        StatusCode::OK
    } else {
        StatusCode::ACCEPTED
    };
    (
        status_code,
        Json(ExportJobResponse {
            job_id: enqueued.job_id,
            state: status,
            format: request.format,
            loss_report,
        }),
    )
        .into_response()
}

/// Worker entry point invoked by the shared durable job dispatcher.
pub(crate) async fn process_job(
    repository: &crate::storage::Repository,
    queue: &crate::jobs::queue::JobQueue,
    lease: &crate::jobs::queue::LeasedJob,
) -> Result<(), crate::jobs::queue::QueueError> {
    let _permit = EXPORT_PERMIT
        .acquire()
        .await
        .map_err(|_| crate::jobs::queue::QueueError::InvalidRequest)?;
    if lease.kind != EXPORT_JOB_KIND {
        return Err(crate::jobs::queue::QueueError::InvalidRequest);
    }
    let payload: ExportJobPayload = serde_json::from_value(lease.payload.clone())
        .map_err(|_| crate::jobs::queue::QueueError::InvalidRequest)?;
    let manifest_json = {
        let mut tx = repository.begin_write().await?;
        let row = sqlx::query("SELECT manifest_json,manifest_sha256 FROM dataset_versions WHERE dataset_version_id=? AND project_id=?")
            .bind(&payload.dataset_version_id).bind(&payload.project_id).fetch_optional(tx.connection()).await?;
        let Some(row) = row else {
            tx.rollback().await?;
            return queue
                .finish(lease, false, &json!({"code":"DATASET_NOT_FOUND"}))
                .await;
        };
        let text: String = row.try_get("manifest_json")?;
        let digest: String = row.try_get("manifest_sha256")?;
        if digest != payload.manifest_sha256
            || format!("{:x}", Sha256::digest(text.as_bytes())) != digest
        {
            tx.rollback().await?;
            return queue
                .finish(lease, false, &json!({"code":"DATASET_CORRUPT"}))
                .await;
        }
        tx.commit().await?;
        text
    };
    let manifest: SnapshotManifest = serde_json::from_str(&manifest_json)
        .map_err(|_| crate::jobs::queue::QueueError::InvalidRequest)?;
    if manifest.project_id != payload.project_id
        || manifest.dataset_version_id != payload.dataset_version_id
        || manifest.items.is_empty()
        || manifest.items.len() > MAX_EXPORT_ITEMS
        || manifest_json.len() > MAX_EXPORT_MANIFEST_BYTES
    {
        return queue
            .finish(lease, false, &json!({"code":"EXPORT_SIZE_LIMIT"}))
            .await;
    }
    if manifest
        .items
        .iter()
        .any(|asset| super::snapshot::validate_snapshot_document(&asset.revision.document).is_err())
    {
        return queue
            .finish(lease, false, &json!({"code":"SNAPSHOT_COMPLETION_INVALID"}))
            .await;
    }
    let report = loss_report_for(&manifest, &payload.format);
    if report.requires_ack() && !payload.loss_ack {
        return queue
            .finish(lease, false, &json!({"code":"LOSS_ACK_REQUIRED"}))
            .await;
    }
    let repository_clone = repository.clone();
    let format = payload.format.clone();
    let snapshot_hash = payload.manifest_sha256.clone();
    let generated = tokio::task::spawn_blocking(move || {
        let state = DatasetState {
            repository: repository_clone,
        };
        make_archive(&state, &manifest, &format, &snapshot_hash)
    })
    .await
    .map_err(|_| crate::jobs::queue::QueueError::InvalidRequest)?;
    let (archive, loss_report) = match generated {
        Ok(value) => value,
        Err(code) => return queue.finish(lease, false, &json!({"code":code})).await,
    };
    let byte_size = archive.len() as u64;
    let object_sha256 = format!("{:x}", Sha256::digest(&archive));
    persist_export(repository, lease, &payload, archive, &loss_report).await?;
    queue.finish(lease, true, &json!({"export_id":lease.job_id,"format":payload.format,"download_url":format!("/api/exports/{}/download",lease.job_id),"byte_size":byte_size,"object_sha256":object_sha256,"loss_report":loss_report})).await
}

async fn persist_export(
    repository: &crate::storage::Repository,
    lease: &crate::jobs::queue::LeasedJob,
    payload: &ExportJobPayload,
    archive: Vec<u8>,
    loss_report: &LossReport,
) -> Result<(), crate::jobs::queue::QueueError> {
    let storage = repository.object_store().clone();
    let published = tokio::task::spawn_blocking(move || {
        let staged = storage.stage_bytes("dataset-export.zip", &archive)?;
        staged.publish()
    })
    .await
    .map_err(|_| crate::jobs::queue::QueueError::InvalidRequest)?
    .map_err(|_| crate::jobs::queue::QueueError::InvalidRequest)?;
    let stored_hash = published.sha256;
    let stored_size = published.size_bytes;
    let mut tx = repository.begin_write().await?;
    let previous = sqlx::query("SELECT project_id,dataset_version_id,manifest_sha256,format,object_sha256 FROM dataset_exports WHERE export_id=?")
        .bind(&lease.job_id).fetch_optional(tx.connection()).await?;
    if let Some(row) = previous {
        let consistent = row.try_get::<String, _>("project_id")? == payload.project_id
            && row.try_get::<String, _>("dataset_version_id")? == payload.dataset_version_id
            && row.try_get::<String, _>("manifest_sha256")? == payload.manifest_sha256
            && row.try_get::<String, _>("format")? == payload.format
            && row.try_get::<String, _>("object_sha256")? == stored_hash;
        if !consistent {
            tx.rollback().await?;
            return Err(crate::jobs::queue::QueueError::InvalidRequest);
        }
        tx.commit().await?;
        return Ok(());
    }
    let manifest_row = sqlx::query("SELECT manifest_json FROM dataset_versions WHERE dataset_version_id=? AND project_id=? AND manifest_sha256=?")
        .bind(&payload.dataset_version_id).bind(&payload.project_id).bind(&payload.manifest_sha256).fetch_optional(tx.connection()).await?;
    let Some(_) = manifest_row else {
        tx.rollback().await?;
        return Err(crate::jobs::queue::QueueError::InvalidRequest);
    };
    let now = now_rfc3339();
    let loss_json = serde_json::to_string(loss_report)
        .map_err(|_| crate::jobs::queue::QueueError::InvalidRequest)?;
    sqlx::query("INSERT INTO dataset_exports(export_id,project_id,dataset_version_id,manifest_sha256,actor_id,format,object_sha256,byte_size,loss_report_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(&lease.job_id).bind(&payload.project_id).bind(&payload.dataset_version_id).bind(&payload.manifest_sha256).bind(&payload.actor_id).bind(&payload.format).bind(&stored_hash).bind(stored_size as i64).bind(loss_json).bind(now).execute(tx.connection()).await?;
    tx.commit().await?;
    Ok(())
}

fn loss_report_for(manifest: &SnapshotManifest, format: &str) -> LossReport {
    let mut fields = BTreeMap::<&str, usize>::new();
    if format == "native" {
        return LossReport::default();
    }
    for asset in &manifest.items {
        for object in &asset.revision.document.objects {
            if !object.attributes.is_empty() {
                *fields.entry("annotation.attributes").or_default() += 1;
            }
            *fields.entry("annotation.object_ids").or_default() += 1;
            if object.origin.kind != annotation_domain::OriginType::Manual {
                *fields.entry("annotation.provenance").or_default() += 1;
            }
        }
    }
    LossReport { losses: fields.into_iter().map(|(field, count)| LossItem {
        field: field.into(),
        reason: format!("{format} label members omit this information for {count} frozen object{}; completion and approval metadata remain in manifest.json", if count == 1 { "" } else { "s" }),
    }).collect() }
}

fn make_archive(
    state: &DatasetState,
    manifest: &SnapshotManifest,
    format: &str,
    snapshot_hash: &str,
) -> Result<(Vec<u8>, LossReport), &'static str> {
    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let limits = ArchiveLimits::default();
    let mut uncompressed_bytes = 0_u64;
    let losses = loss_report_for(manifest, format);
    let mut manifest_value = json!({"schema_version":1,"dataset_version_id":manifest.dataset_version_id,"project_id":manifest.project_id,"snapshot_manifest_sha256":snapshot_hash,"ontology":manifest.ontology,"category_mapping":manifest.category_mapping,"items":manifest.items.iter().map(|item| json!({"media_revision":item.media_revision,"asset_revision_id":item.media_revision.asset_revision_id,"original_name":item.media_revision.original_name,"original_sha256":item.media_revision.original_sha256,"original_object_sha256":item.original_object_sha256,"canonical_sha256":item.media_revision.canonical_sha256,"annotation_revision_id":item.revision.annotation_revision_id,"annotation_content_hash":item.revision.content_hash,"split":item.split,"completion":item.revision.document.completion,"review_status":"approved","review_id":item.review_id,"reviewed_by":item.reviewed_by,"review_reason":item.review_reason,"reviewed_at":item.reviewed_at})).collect::<Vec<_>>(),"excluded":manifest.excluded,"exporter_version":"t27-v1","params":{"format":format,"split_seed":manifest.split_seed,"split_ratios":manifest.split_ratios}});
    let mut export_category_mapping = manifest.category_mapping.clone();
    if format == "coco" {
        export_category_mapping.sort();
    }
    manifest_value["category_mapping"] = json!(export_category_mapping);
    if format == "native" {
        for asset in &manifest.items {
            let image = read_canonical(state, asset)?;
            let original = read_object(state, &asset.original_object_sha256)?;
            insert_file(
                &mut files,
                &limits,
                &mut uncompressed_bytes,
                format!("original/{}.bin", &*asset.media_revision.asset_revision_id),
                original,
            )?;
            insert_file(
                &mut files,
                &limits,
                &mut uncompressed_bytes,
                format!("media/{}.png", &*asset.media_revision.asset_revision_id),
                image,
            )?;
            let annotation_json =
                serde_json::to_vec(&asset.revision).map_err(|_| "EXPORT_SERIALIZE_FAILED")?;
            insert_file(
                &mut files,
                &limits,
                &mut uncompressed_bytes,
                format!(
                    "annotations/{}.json",
                    &*asset.media_revision.asset_revision_id
                ),
                annotation_json,
            )?;
        }
    } else {
        let label_ids = manifest
            .ontology
            .labels
            .iter()
            .map(|label| label.label_id.clone())
            .collect::<Vec<_>>();
        if format == "yolo" {
            insert_file(
                &mut files,
                &limits,
                &mut uncompressed_bytes,
                "label_ids.json".into(),
                serde_json::to_vec(&label_ids).map_err(|_| "EXPORT_SERIALIZE_FAILED")?,
            )?;
        }
        let mut coco_splits: BTreeMap<String, Value> = BTreeMap::new();
        if format == "coco" {
            let mut labels: Vec<_> = manifest.ontology.labels.iter().collect();
            labels.sort_by(|left, right| left.label_id.cmp(&right.label_id));
            let categories = labels.iter().enumerate().map(|(index, label)| json!({"id":index + 1,"name":label.name,"label_id":label.label_id})).collect::<Vec<_>>();
            for split in ["train", "val", "test"] {
                coco_splits.insert(
                    split.to_owned(),
                    json!({"images":[],"categories":categories.clone(),"annotations":[]}),
                );
            }
        }
        let mut image_ids = BTreeMap::new();
        let mut ordered_assets: Vec<_> = manifest.items.iter().collect();
        ordered_assets.sort_by_key(|asset| asset.media_revision.asset_revision_id.to_string());
        for (index, asset) in ordered_assets.iter().enumerate() {
            let image_id = i64::try_from(index + 1).map_err(|_| "EXPORT_INVALID")?;
            image_ids.insert(asset.media_revision.asset_revision_id.to_string(), image_id);
        }
        let mut annotation_id = 1_i64;
        for asset in &ordered_assets {
            let asset_id = asset.media_revision.asset_revision_id.to_string();
            let split = asset.split.as_str();
            let prefix = format!("{split}/{asset_id}");
            let image = read_canonical(state, asset)?;
            insert_file(
                &mut files,
                &limits,
                &mut uncompressed_bytes,
                format!("images/{prefix}.png"),
                image,
            )?;
            if format == "yolo" {
                let export = export_yolo(&asset.revision.document, &manifest.ontology)
                    .map_err(|_| "EXPORT_INVALID")?;
                if export.label_ids != label_ids {
                    return Err("EXPORT_CLASS_MAPPING_INVALID");
                }
                insert_file(
                    &mut files,
                    &limits,
                    &mut uncompressed_bytes,
                    format!("labels/{prefix}.txt"),
                    export.annotations.into_bytes(),
                )?;
            } else {
                let export = export_coco(
                    &asset.revision.document,
                    &manifest.ontology,
                    &format!("{asset_id}.png"),
                )
                .map_err(|_| "EXPORT_INVALID")?;
                let coco: Value =
                    serde_json::from_slice(&export.json).map_err(|_| "EXPORT_INVALID")?;
                let image_id = *image_ids.get(&asset_id).ok_or("EXPORT_INVALID")?;
                let image = coco
                    .get("images")
                    .and_then(Value::as_array)
                    .and_then(|images| images.first())
                    .ok_or("EXPORT_INVALID")?;
                let mut image = image.clone();
                image["id"] = json!(image_id);
                image["file_name"] = Value::String(format!("images/{prefix}.png"));
                image["split"] = Value::String(split.to_owned());
                image["asset_revision_id"] = Value::String(asset_id);
                let dataset = coco_splits.get_mut(split).ok_or("EXPORT_INVALID")?;
                dataset["images"]
                    .as_array_mut()
                    .ok_or("EXPORT_INVALID")?
                    .push(image);
                let annotations = coco
                    .get("annotations")
                    .and_then(Value::as_array)
                    .ok_or("EXPORT_INVALID")?;
                let target_annotations = dataset["annotations"]
                    .as_array_mut()
                    .ok_or("EXPORT_INVALID")?;
                for annotation in annotations {
                    let mut annotation = annotation.clone();
                    annotation["id"] = json!(annotation_id);
                    annotation["image_id"] = json!(image_id);
                    target_annotations.push(annotation);
                    annotation_id = annotation_id.checked_add(1).ok_or("EXPORT_INVALID")?;
                }
            }
        }
        if format == "coco" {
            for (split, coco) in coco_splits {
                insert_file(
                    &mut files,
                    &limits,
                    &mut uncompressed_bytes,
                    format!("coco/{split}.json"),
                    serde_json::to_vec(&coco).map_err(|_| "EXPORT_SERIALIZE_FAILED")?,
                )?;
            }
        }
    }
    let split_count = |name: &str| {
        manifest
            .items
            .iter()
            .filter(|asset| asset.split.as_str() == name)
            .count()
    };
    manifest_value["loss_report"] =
        serde_json::to_value(&losses).map_err(|_| "EXPORT_SERIALIZE_FAILED")?;
    manifest_value["statistics"] = json!({
        "asset_count": manifest.items.len(),
        "object_count": manifest.items.iter().map(|asset| asset.revision.document.objects.len()).sum::<usize>(),
        "splits": { "train": split_count("train"), "val": split_count("val"), "test": split_count("test") }
    });
    manifest_value["validation"] = json!({ "zip_member_readback": true });
    insert_file(
        &mut files,
        &limits,
        &mut uncompressed_bytes,
        "manifest.json".into(),
        serde_json::to_vec(&manifest_value).map_err(|_| "EXPORT_SERIALIZE_FAILED")?,
    )?;
    let entries: Vec<_> = files.into_iter().collect();
    let bytes =
        create_safe_zip(&entries, &ArchiveLimits::default()).map_err(|_| "EXPORT_INVALID")?;
    let parsed =
        extract_safe_zip(&bytes, &ArchiveLimits::default()).map_err(|_| "EXPORT_INVALID")?;
    if parsed.len() != entries.len()
        || parsed.iter().any(|(name, bytes)| {
            entries
                .iter()
                .find(|(key, _)| key == name)
                .is_none_or(|(_, expected)| expected != bytes)
        })
    {
        return Err("EXPORT_READBACK_FAILED");
    }
    Ok((bytes, losses))
}
fn insert_file(
    files: &mut BTreeMap<String, Vec<u8>>,
    limits: &ArchiveLimits,
    total: &mut u64,
    name: String,
    bytes: Vec<u8>,
) -> Result<(), &'static str> {
    let size = u64::try_from(bytes.len()).map_err(|_| "EXPORT_INVALID")?;
    let next_total = total.checked_add(size).ok_or("EXPORT_INVALID")?;
    if files.len() >= limits.max_entries
        || next_total > limits.max_uncompressed_bytes
        || files.contains_key(&name)
    {
        return Err("EXPORT_INVALID");
    }
    *total = next_total;
    files.insert(name, bytes);
    Ok(())
}

fn read_canonical(state: &DatasetState, asset: &FrozenAsset) -> Result<Vec<u8>, &'static str> {
    let path = state
        .repository
        .object_store()
        .path_for_hash(&asset.canonical_object_sha256)
        .ok_or("MEDIA_OBJECT_INVALID")?;
    let bytes = std::fs::read(path).map_err(|_| "MEDIA_OBJECT_MISSING")?;
    if format!("{:x}", Sha256::digest(&bytes)) != asset.canonical_object_sha256 {
        return Err("MEDIA_OBJECT_INVALID");
    }
    Ok(bytes)
}
fn read_object(state: &DatasetState, hash: &str) -> Result<Vec<u8>, &'static str> {
    let path = state
        .repository
        .object_store()
        .path_for_hash(hash)
        .ok_or("MEDIA_OBJECT_INVALID")?;
    let bytes = std::fs::read(path).map_err(|_| "MEDIA_OBJECT_MISSING")?;
    if format!("{:x}", Sha256::digest(&bytes)) != hash {
        return Err("MEDIA_OBJECT_INVALID");
    }
    Ok(bytes)
}
