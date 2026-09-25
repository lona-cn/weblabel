use std::sync::Arc;

use crate::storage::Repository;
use annotation_domain::{
    document::{
        AnnotationDocument, Completion, CoordinateSpace, CoordinateSpaceType, Id, MediaRevision,
    },
    hash::serialize_document,
    DomainError,
};
use serde_json::{json, Value};
use sqlx::{query, Row};
use thiserror::Error;
use uuid::Uuid;

use super::{
    limits::{check_filename, MediaError, MAX_UPLOAD_BYTES},
    previews::make_preview,
};
use crate::jobs::{
    queue::{EnqueuedJob, JobQueue, LeasedJob, QueueError},
    worker::MediaWorker,
};

pub const MAX_IMPORT_ITEMS: usize = 500;
pub const MAX_MEDIA_PAGE: usize = 100;

#[derive(Debug, Clone)]
pub struct ImportInput {
    pub project_id: String,
    pub ontology_version_id: String,
    pub actor_id: String,
    pub source_group_id: String,
    pub original_name: String,
    pub declared_mime: Option<String>,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ImportedMedia {
    pub asset_id: String,
    pub asset_revision_id: String,
    pub annotation_revision_id: String,
    pub original_sha256: String,
    pub canonical_sha256: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Error)]
pub enum ImportError {
    #[error(transparent)]
    Media(#[from] MediaError),
    #[error("media persistence failed")]
    Storage(#[from] sqlx::Error),
    #[error("object storage failed")]
    Object(#[from] std::io::Error),
    #[error("job queue operation failed")]
    Queue(#[from] QueueError),
    #[error("import batch must contain at least one image")]
    EmptyBatch,
    #[error("an import batch cannot exceed 500 images")]
    TooManyItems,
    #[error("media revision is not available in this project")]
    NotFound,
    #[error("stored canonical media is unavailable")]
    ObjectUnavailable,
    #[error("invalid persisted media metadata")]
    InvalidMetadata,
}

pub async fn enqueue_import_job(
    repository: &Repository,
    queue: &JobQueue,
    operation_id: &str,
    inputs: Vec<ImportInput>,
) -> Result<EnqueuedJob, ImportError> {
    if inputs.is_empty() {
        return Err(ImportError::EmptyBatch);
    }
    if inputs.len() > MAX_IMPORT_ITEMS {
        return Err(ImportError::TooManyItems);
    }
    let project_id = inputs[0].project_id.clone();
    let mut items = Vec::with_capacity(inputs.len());
    for (index, input) in inputs.into_iter().enumerate() {
        if input.project_id != project_id {
            return Err(ImportError::InvalidMetadata);
        }
        let pre_error = if check_filename(&input.original_name).is_err() {
            Some("FILENAME_TOO_LONG")
        } else if input.bytes.len() > MAX_UPLOAD_BYTES {
            Some("TOO_MANY_BYTES")
        } else {
            None
        };
        let source_hash = if pre_error.is_none() {
            Some(
                repository
                    .object_store()
                    .put_bytes(&input.original_name, &input.bytes)?
                    .sha256,
            )
        } else {
            None
        };
        items.push(json!({
            "item_index": index,
            "project_id": input.project_id,
            "ontology_version_id": input.ontology_version_id,
            "actor_id": input.actor_id,
            "source_group_id": input.source_group_id,
            "original_name": if pre_error.is_none() { Some(input.original_name) } else { None },
            "declared_mime": input.declared_mime,
            "source_sha256": source_hash,
            "pre_error": pre_error,
        }));
    }
    let payload = json!({"items": items});
    Ok(queue
        .enqueue(Some(&project_id), "media_import", operation_id, &payload)
        .await?)
}

pub async fn import_one(
    repository: &Repository,
    worker: &MediaWorker,
    input: ImportInput,
) -> Result<ImportedMedia, ImportError> {
    import_one_internal(repository, worker, input, None).await
}

pub async fn import_one_for_job(
    repository: &Repository,
    worker: &MediaWorker,
    lease: &LeasedJob,
    item_id: &str,
    input: ImportInput,
) -> Result<ImportedMedia, ImportError> {
    if lease.kind != "media_import" || item_id.is_empty() || item_id.len() > 128 {
        return Err(ImportError::InvalidMetadata);
    }
    let item_index = item_id
        .parse::<usize>()
        .map_err(|_| ImportError::InvalidMetadata)?;
    let item = lease
        .payload
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| items.get(item_index))
        .ok_or(ImportError::InvalidMetadata)?;
    if item.get("item_index").and_then(Value::as_u64) != Some(item_index as u64)
        || required_item_string(item, "project_id")? != input.project_id
        || required_item_string(item, "ontology_version_id")? != input.ontology_version_id
        || required_item_string(item, "actor_id")? != input.actor_id
        || required_item_string(item, "source_group_id")? != input.source_group_id
        || required_item_string(item, "original_name")? != input.original_name
        || item.get("declared_mime").and_then(Value::as_str) != input.declared_mime.as_deref()
    {
        return Err(ImportError::InvalidMetadata);
    }
    let source_hash = item
        .get("source_sha256")
        .and_then(Value::as_str)
        .ok_or(ImportError::InvalidMetadata)?;
    import_one_internal(
        repository,
        worker,
        input,
        Some((lease, item_id, source_hash)),
    )
    .await
}

async fn import_one_internal(
    repository: &Repository,
    worker: &MediaWorker,
    input: ImportInput,
    job_item: Option<(&LeasedJob, &str, &str)>,
) -> Result<ImportedMedia, ImportError> {
    if let Some((lease, item_id, _)) = job_item {
        if let Some(imported) = load_completed_job_item(repository, &lease.job_id, item_id).await? {
            return Ok(imported);
        }
    }
    check_filename(&input.original_name)?;
    let bytes: Arc<[u8]> = Arc::from(input.bytes);
    let canonical = worker
        .canonicalize(Arc::clone(&bytes), input.declared_mime.clone())
        .await?;
    let preview = make_preview(&canonical.rgba)?;
    let original = repository
        .object_store()
        .put_bytes(&input.original_name, &bytes)?;
    if job_item.is_some_and(|(_, _, expected_hash)| expected_hash != original.sha256) {
        return Err(ImportError::InvalidMetadata);
    }
    let canonical_object = repository
        .object_store()
        .put_bytes("canonical.png", &canonical.png)?;
    let preview_object = repository
        .object_store()
        .put_bytes("preview.png", &preview.png)?;
    let asset_id = Uuid::new_v4().to_string();
    let asset_revision_id = Uuid::new_v4().to_string();
    let annotation_revision_id = Uuid::new_v4().to_string();
    let original_sha256 = original.sha256;
    let canonical_sha256 = canonical_object.sha256;
    if canonical_sha256 != canonical.sha256 {
        return Err(MediaError::InvalidImage.into());
    }
    let document = AnnotationDocument {
        schema_version: 1,
        asset_revision_id: Id::from(asset_revision_id.clone()),
        ontology_version_id: Id::from(input.ontology_version_id.clone()),
        coordinate_space: CoordinateSpace {
            kind: CoordinateSpaceType::CanonicalImagePixels,
            width: canonical.width,
            height: canonical.height,
        },
        completion: Completion::Unprocessed,
        objects: Vec::new(),
    };
    document
        .validate_shape()
        .map_err(|_| MediaError::InvalidImage)?;
    let serialized_document =
        serialize_document(&document).map_err(|_| MediaError::InvalidImage)?;
    let document_json = serialized_document.json;
    let content_hash = serialized_document.content_hash;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut tx = repository.begin_write().await?;
    if let Some((lease, _, _)) = job_item {
        let active: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM jobs WHERE job_id=? AND state='running' \
             AND worker_id=? AND fencing_token=? AND lease_until>?)",
        )
        .bind(&lease.job_id)
        .bind(&lease.worker_id)
        .bind(lease.fencing_token as i64)
        .bind(&now)
        .fetch_one(tx.connection())
        .await?;
        if active == 0 {
            tx.rollback().await?;
            return Err(QueueError::InvalidRequest.into());
        }
    }
    query("INSERT INTO media_assets(asset_id, project_id, created_at) VALUES (?, ?, ?)")
        .bind(&asset_id)
        .bind(&input.project_id)
        .bind(&now)
        .execute(tx.connection())
        .await?;
    query("INSERT INTO media_revisions(asset_revision_id, project_id, asset_id, original_sha256, canonical_sha256, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&asset_revision_id).bind(&input.project_id).bind(&asset_id).bind(&original_sha256)
        .bind(&canonical_sha256).bind(&input.original_name).bind(&now).execute(tx.connection()).await?;
    query("INSERT INTO media_metadata(asset_revision_id, canonical_width, canonical_height, exif_orientation, original_to_canonical_json, source_group_id, original_object_sha256, canonical_object_sha256, preview_object_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&asset_revision_id).bind(i64::from(canonical.width)).bind(i64::from(canonical.height))
        .bind(i64::from(canonical.exif_orientation))
        .bind(serde_json::to_string(&canonical.original_to_canonical).map_err(|_| MediaError::InvalidImage)?)
        .bind(&input.source_group_id).bind(&original_sha256).bind(&canonical_sha256)
        .bind(&preview_object.sha256).execute(tx.connection()).await?;
    for sha in [&original_sha256, &canonical_sha256, &preview_object.sha256] {
        query("INSERT OR IGNORE INTO media_object_refs(asset_revision_id, sha256) VALUES (?, ?)")
            .bind(&asset_revision_id)
            .bind(sha)
            .execute(tx.connection())
            .await?;
    }
    query("INSERT INTO annotation_revisions(annotation_revision_id, project_id, asset_revision_id, ontology_version_id, parent_revision_id, revision_no, body_json, content_hash, created_by, created_at) VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?, ?)")
        .bind(&annotation_revision_id).bind(&input.project_id).bind(&asset_revision_id)
        .bind(&input.ontology_version_id).bind(&document_json).bind(&content_hash).bind(&input.actor_id)
        .bind(&now).execute(tx.connection()).await?;
    query("INSERT INTO annotation_heads(project_id, asset_revision_id, ontology_version_id, annotation_revision_id) VALUES (?, ?, ?, ?)")
        .bind(&input.project_id).bind(&asset_revision_id).bind(&input.ontology_version_id)
        .bind(&annotation_revision_id).execute(tx.connection()).await?;
    let imported = ImportedMedia {
        asset_id,
        asset_revision_id,
        annotation_revision_id,
        original_sha256,
        canonical_sha256,
        width: canonical.width,
        height: canonical.height,
    };
    if let Some((lease, item_id, _)) = job_item {
        let result_json = serde_json::to_string(&imported).map_err(|_| MediaError::InvalidImage)?;
        let inserted = query(
            "INSERT INTO job_items(job_id, item_id, state, result_json) \
             VALUES (?, ?, 'succeeded', ?) ON CONFLICT(job_id, item_id) DO NOTHING",
        )
        .bind(&lease.job_id)
        .bind(item_id)
        .bind(result_json)
        .execute(tx.connection())
        .await?;
        if inserted.rows_affected() == 0 {
            tx.rollback().await?;
            return load_completed_job_item(repository, &lease.job_id, item_id)
                .await?
                .ok_or(ImportError::InvalidMetadata);
        }
    }
    tx.commit().await?;
    Ok(imported)
}
async fn load_completed_job_item(
    repository: &Repository,
    job_id: &str,
    item_id: &str,
) -> Result<Option<ImportedMedia>, ImportError> {
    let mut tx = repository.begin_write().await?;
    let row = query("SELECT state, result_json FROM job_items WHERE job_id=? AND item_id=?")
        .bind(job_id)
        .bind(item_id)
        .fetch_optional(tx.connection())
        .await?;
    tx.commit().await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let state: String = row.try_get("state")?;
    if state != "succeeded" {
        return Ok(None);
    }
    let result_json: Option<String> = row.try_get("result_json")?;
    let result_json = result_json.ok_or(ImportError::InvalidMetadata)?;
    Ok(Some(
        serde_json::from_str(&result_json).map_err(|_| ImportError::InvalidMetadata)?,
    ))
}

pub async fn process_import_job(
    repository: &Repository,
    worker: &MediaWorker,
    queue: &JobQueue,
    lease: &LeasedJob,
) -> Result<(), QueueError> {
    if lease.kind != "media_import" {
        return Err(QueueError::InvalidRequest);
    }
    let items = lease
        .payload
        .get("items")
        .and_then(Value::as_array)
        .ok_or(QueueError::InvalidRequest)?;
    if items.is_empty() || items.len() > MAX_IMPORT_ITEMS {
        return Err(QueueError::InvalidRequest);
    }
    let mut item_results = Vec::with_capacity(items.len());
    let mut succeeded = 0_u64;
    for (position, item) in items.iter().enumerate() {
        let item_index = item
            .get("item_index")
            .and_then(Value::as_u64)
            .ok_or(QueueError::InvalidRequest)?;
        if item_index != position as u64 {
            return Err(QueueError::InvalidRequest);
        }
        let result = if let Some(code) = item.get("pre_error").and_then(Value::as_str) {
            Err(code.to_owned())
        } else {
            process_import_item(repository, worker, lease, &item_index.to_string(), item)
                .await
                .map_err(|error| error.to_string())
        };
        match &result {
            Ok(media) => {
                succeeded += 1;
                item_results.push(json!({"item_index":item_index,"state":"succeeded","asset_id":media.asset_id,"asset_revision_id":media.asset_revision_id}));
            }
            Err(error) => {
                item_results.push(json!({"item_index":item_index,"state":"failed","error":error}))
            }
        }
        queue
            .report_progress(
                lease,
                (position + 1) as u64,
                items.len() as u64,
                &json!({"succeeded":succeeded,"failed":(position + 1) as u64 - succeeded}),
            )
            .await?;
    }
    let failed = items.len() as u64 - succeeded;
    queue
        .finish(
            lease,
            failed == 0,
            &json!({"items":item_results,"succeeded":succeeded,"failed":failed}),
        )
        .await
}

async fn process_import_item(
    repository: &Repository,
    worker: &MediaWorker,
    lease: &LeasedJob,
    item_id: &str,
    item: &Value,
) -> Result<ImportedMedia, ImportError> {
    if let Some(imported) = load_completed_job_item(repository, &lease.job_id, item_id).await? {
        return Ok(imported);
    }
    let source_hash = item
        .get("source_sha256")
        .and_then(Value::as_str)
        .ok_or(ImportError::InvalidMetadata)?;
    let path = repository
        .object_store()
        .path_for_hash(source_hash)
        .ok_or(ImportError::InvalidMetadata)?;
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(path))
        .await
        .map_err(|_| ImportError::ObjectUnavailable)?
        .map_err(|_| ImportError::ObjectUnavailable)?;
    import_one_for_job(
        repository,
        worker,
        lease,
        item_id,
        ImportInput {
            project_id: required_item_string(item, "project_id")?,
            ontology_version_id: required_item_string(item, "ontology_version_id")?,
            actor_id: required_item_string(item, "actor_id")?,
            source_group_id: required_item_string(item, "source_group_id")?,
            original_name: required_item_string(item, "original_name")?,
            declared_mime: item
                .get("declared_mime")
                .and_then(Value::as_str)
                .map(str::to_owned),
            bytes,
        },
    )
    .await
}

fn required_item_string(item: &Value, key: &str) -> Result<String, ImportError> {
    item.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(ImportError::InvalidMetadata)
}

pub async fn import_each(
    repository: &Repository,
    worker: &MediaWorker,
    inputs: Vec<ImportInput>,
) -> Vec<Result<ImportedMedia, ImportError>> {
    if inputs.len() > MAX_IMPORT_ITEMS {
        return (0..inputs.len())
            .map(|_| Err(ImportError::TooManyItems))
            .collect();
    }
    let mut results = Vec::with_capacity(inputs.len());
    for input in inputs {
        results.push(import_one(repository, worker, input).await);
    }
    results
}

/// The caller must first authenticate the user and authorize project membership.
pub async fn list_media(
    repository: &Repository,
    project_id: &str,
    after_revision_id: Option<&str>,
    limit: usize,
) -> Result<Vec<MediaRevision>, ImportError> {
    if limit == 0 || limit > MAX_MEDIA_PAGE {
        return Err(ImportError::InvalidMetadata);
    }
    let mut tx = repository.begin_write().await?;
    let rows = query("SELECT r.asset_id, r.asset_revision_id, r.project_id, r.original_name, r.original_sha256, r.canonical_sha256, m.canonical_width, m.canonical_height, m.exif_orientation, m.original_to_canonical_json, m.source_group_id FROM media_revisions r JOIN media_metadata m USING(asset_revision_id) WHERE r.project_id=? AND (? IS NULL OR r.asset_revision_id > ?) ORDER BY r.asset_revision_id LIMIT ?")
        .bind(project_id).bind(after_revision_id).bind(after_revision_id).bind(limit as i64)
        .fetch_all(tx.connection()).await?;
    tx.commit().await?;
    rows.into_iter()
        .map(|row| {
            let matrix_json: String = row.try_get("original_to_canonical_json")?;
            let original_to_canonical: Vec<f64> =
                serde_json::from_str(&matrix_json).map_err(|_| ImportError::InvalidMetadata)?;
            let media = MediaRevision {
                asset_id: Id::from(row.try_get::<String, _>("asset_id")?),
                asset_revision_id: Id::from(row.try_get::<String, _>("asset_revision_id")?),
                project_id: Id::from(row.try_get::<String, _>("project_id")?),
                original_name: row.try_get("original_name")?,
                original_sha256: row.try_get("original_sha256")?,
                canonical_sha256: row.try_get("canonical_sha256")?,
                canonical_width: u32::try_from(row.try_get::<i64, _>("canonical_width")?)
                    .map_err(|_| ImportError::InvalidMetadata)?,
                canonical_height: u32::try_from(row.try_get::<i64, _>("canonical_height")?)
                    .map_err(|_| ImportError::InvalidMetadata)?,
                exif_orientation: u8::try_from(row.try_get::<i64, _>("exif_orientation")?)
                    .map_err(|_| ImportError::InvalidMetadata)?,
                original_to_canonical,
                source_group_id: Id::from(row.try_get::<String, _>("source_group_id")?),
            };
            media
                .validate()
                .map_err(|_: DomainError| ImportError::InvalidMetadata)?;
            Ok(media)
        })
        .collect()
}

/// The caller must first authenticate the user and authorize membership in `project_id`.
pub async fn load_canonical_png(
    repository: &Repository,
    project_id: &str,
    asset_revision_id: &str,
) -> Result<Vec<u8>, ImportError> {
    let mut tx = repository.begin_write().await?;
    let row = query("SELECT m.canonical_object_sha256 FROM media_revisions r JOIN media_metadata m USING(asset_revision_id) WHERE r.project_id=? AND r.asset_revision_id=?")
        .bind(project_id).bind(asset_revision_id).fetch_optional(tx.connection()).await?;
    tx.commit().await?;
    let hash: String = row
        .ok_or(ImportError::NotFound)?
        .try_get("canonical_object_sha256")?;
    let path = repository
        .object_store()
        .path_for_hash(&hash)
        .ok_or(ImportError::InvalidMetadata)?;
    tokio::task::spawn_blocking(move || std::fs::read(path))
        .await
        .map_err(|_| ImportError::ObjectUnavailable)?
        .map_err(|_| ImportError::ObjectUnavailable)
}

pub fn job_result(items: &[Result<ImportedMedia, ImportError>]) -> serde_json::Value {
    let results = items.iter().map(|item| match item {
        Ok(media) => json!({"state":"succeeded", "asset_id":media.asset_id, "asset_revision_id":media.asset_revision_id}),
        Err(error) => json!({"state":"failed", "error": error.to_string()}),
    });
    json!({"items": results.collect::<Vec<_>>()})
}
