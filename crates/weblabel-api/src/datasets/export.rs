use super::{snapshot::SnapshotManifest, DatasetState};
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

const MAX_EXPORT_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
static EXPORT_PERMIT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

pub(super) async fn create(
    State(state): State<DatasetState>,
    Path(dataset_version_id): Path<String>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<ExportRequest>,
) -> axum::response::Response {
    create_phases(
        state,
        dataset_version_id,
        principal,
        request,
        #[cfg(test)]
        None,
    )
    .await
}
#[cfg(test)]
struct ExportPrepareGate {
    entered: tokio::sync::oneshot::Sender<()>,
    release: tokio::sync::oneshot::Receiver<()>,
}
async fn create_phases(
    state: DatasetState,
    dataset_version_id: String,
    principal: Principal,
    request: ExportRequest,
    #[cfg(test)] gate: Option<ExportPrepareGate>,
) -> axum::response::Response {
    use crate::jobs::queue::JobQueue;
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
                "Could not capture export",
            )
        }
    };
    let captured =
        capture_export_on(tx.connection(), &dataset_version_id, &principal.user_id).await;
    if tx.rollback().await.is_err() {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "EXPORT_UNAVAILABLE",
            "Could not release snapshot capture",
        );
    }
    let (project_id, text, digest) = match captured {
        Ok(value) => value,
        Err(response) => return response,
    };
    #[cfg(test)]
    if let Some(gate) = gate {
        let _ = gate.entered.send(());
        let _ = gate.release.await;
    }
    let format = request.format.clone();
    let captured_project = project_id.clone();
    let captured_dataset = dataset_version_id.clone();
    let captured_digest = digest.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        if text.len() > MAX_EXPORT_MANIFEST_BYTES {
            return Err("EXPORT_SIZE_LIMIT");
        }
        if format!("{:x}", Sha256::digest(text.as_bytes())) != captured_digest {
            return Err("DATASET_CORRUPT");
        }
        let manifest: SnapshotManifest =
            serde_json::from_str(&text).map_err(|_| "DATASET_CORRUPT")?;
        if manifest.project_id != captured_project
            || manifest.dataset_version_id != captured_dataset
        {
            return Err("DATASET_CORRUPT");
        }
        super::snapshot::validate_logical_scope(
            manifest
                .items
                .iter()
                .map(|a| &*a.media_revision.asset_revision_id),
            manifest
                .excluded
                .iter()
                .map(|a| a.asset_revision_id.as_str()),
        )
        .map_err(|_| "EXPORT_SIZE_LIMIT")?;
        Ok::<_, &'static str>((text, loss_report_for(&manifest, &format)))
    })
    .await;
    let (text, loss_report) = match prepared {
        Ok(Ok(value)) => value,
        Ok(Err("EXPORT_SIZE_LIMIT")) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "EXPORT_SIZE_LIMIT",
                "Snapshot exceeds export budget",
            )
        }
        _ => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATASET_CORRUPT",
                "Stored dataset snapshot is invalid",
            )
        }
    };
    if loss_report.requires_ack() && !request.loss_ack {
        return (StatusCode::UNPROCESSABLE_ENTITY,Json(json!({"code":"LOSS_ACK_REQUIRED","message":"Loss acknowledgement is required before creating this export",
            "request_id":Uuid::new_v4().to_string(),"details":{"loss_report":loss_report}}))).into_response();
    }
    let payload = json!({"dataset_version_id":dataset_version_id,"project_id":project_id,"actor_id":principal.user_id,
        "format":request.format,"loss_ack":request.loss_ack,"manifest_sha256":digest});
    let payload_json =
        match JobQueue::prepare_enqueue_payload(EXPORT_JOB_KIND, &request.operation_id, &payload) {
            Ok(value) => value,
            Err(_) => {
                return error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "EXPORT_SIZE_LIMIT",
                    "Export payload exceeds queue budget",
                )
            }
        };
    let mut tx = match state.repository.begin_write().await {
        Ok(tx) => tx,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "EXPORT_UNAVAILABLE",
                "Could not publish export intent",
            )
        }
    };
    let enqueued = match enqueue_export_on(
        tx.connection(),
        &dataset_version_id,
        &project_id,
        &principal.user_id,
        &text,
        &digest,
        &request.operation_id,
        payload_json,
    )
    .await
    {
        Ok(value) => value,
        Err(response) => {
            let _ = tx.rollback().await;
            return response;
        }
    };
    if tx.commit().await.is_err() {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "EXPORT_UNAVAILABLE",
            "Could not commit export job",
        );
    }
    let queue = JobQueue::new(state.repository.clone());
    let status = match queue.status(&project_id, &enqueued.job_id).await {
        Ok(Some(job)) => job.state,
        _ => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "EXPORT_STATUS_UNAVAILABLE",
                "Export status is unavailable",
            )
        }
    };
    (
        if enqueued.duplicate {
            StatusCode::OK
        } else {
            StatusCode::ACCEPTED
        },
        Json(ExportJobResponse {
            job_id: enqueued.job_id,
            state: status,
            format: request.format,
            loss_report,
        }),
    )
        .into_response()
}

async fn capture_export_on(
    connection: &mut sqlx::SqliteConnection,
    dataset_version_id: &str,
    actor_id: &str,
) -> Result<(String, String, String), axum::response::Response> {
    let row = sqlx::query("SELECT d.project_id,CASE WHEN length(CAST(d.manifest_json AS BLOB))<=16777216 THEN d.manifest_json END AS manifest_json,d.manifest_sha256 FROM dataset_versions d JOIN memberships m ON m.project_id=d.project_id WHERE d.dataset_version_id=? AND m.user_id=?")
        .bind(&dataset_version_id).bind(actor_id).fetch_optional(connection).await;
    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => {
            return Err(error(
                StatusCode::NOT_FOUND,
                "DATASET_NOT_FOUND",
                "Dataset version not found",
            ))
        }
        Err(_) => {
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "EXPORT_UNAVAILABLE",
                "Could not read export snapshot",
            ))
        }
    };
    let project_id: String = match row.try_get("project_id") {
        Ok(v) => v,
        Err(_) => {
            return Err(error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATASET_CORRUPT",
                "Stored snapshot is invalid",
            ))
        }
    };
    let text: Option<String> = match row.try_get("manifest_json") {
        Ok(v) => v,
        Err(_) => {
            return Err(error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATASET_CORRUPT",
                "Stored snapshot is invalid",
            ))
        }
    };
    let Some(text) = text else {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "EXPORT_SIZE_LIMIT",
            "Snapshot exceeds manifest budget",
        ));
    };
    let digest: String = match row.try_get("manifest_sha256") {
        Ok(v) => v,
        Err(_) => {
            return Err(error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATASET_CORRUPT",
                "Stored snapshot is invalid",
            ))
        }
    };
    Ok((project_id, text, digest))
}

async fn enqueue_export_on(
    connection: &mut sqlx::SqliteConnection,
    dataset_version_id: &str,
    project_id: &str,
    actor_id: &str,
    text: &str,
    digest: &str,
    operation_id: &str,
    payload_json: String,
) -> Result<crate::jobs::queue::EnqueuedJob, axum::response::Response> {
    let current = sqlx::query("SELECT d.manifest_json,d.manifest_sha256 FROM dataset_versions d JOIN memberships m ON m.project_id=d.project_id AND m.user_id=? WHERE d.dataset_version_id=? AND d.project_id=?")
        .bind(actor_id).bind(&dataset_version_id).bind(&project_id).fetch_optional(&mut *connection).await;
    match current {
        Ok(Some(row)) => {
            if row.try_get::<&str, _>("manifest_json").ok() != Some(text)
                || row.try_get::<&str, _>("manifest_sha256").ok() != Some(digest)
            {
                return Err(error(
                    StatusCode::CONFLICT,
                    "SNAPSHOT_BINDING_CHANGED",
                    "Dataset snapshot changed during preparation",
                ));
            }
        }
        Ok(None) => {
            return Err(error(
                StatusCode::NOT_FOUND,
                "DATASET_NOT_FOUND",
                "Dataset version not found",
            ))
        }
        Err(_) => {
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "EXPORT_UNAVAILABLE",
                "Could not revalidate export snapshot",
            ))
        }
    }
    let enqueued = match crate::jobs::queue::JobQueue::enqueue_prepared_on(
        &mut *connection,
        Some(project_id),
        EXPORT_JOB_KIND,
        operation_id,
        payload_json,
    )
    .await
    {
        Ok(value) => value,
        Err(crate::jobs::queue::QueueError::IdempotencyConflict) => {
            return Err(error(
                StatusCode::CONFLICT,
                "IDEMPOTENCY_KEY_REUSE",
                "operation_id was already used with another export request",
            ))
        }
        Err(crate::jobs::queue::QueueError::QueueFull) => {
            return Err(error(
                StatusCode::TOO_MANY_REQUESTS,
                "JOB_QUEUE_FULL",
                "Export queue is full",
            ))
        }
        Err(_) => {
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "EXPORT_UNAVAILABLE",
                "Could not enqueue export job",
            ))
        }
    };
    Ok(enqueued)
}

/// Worker entry point invoked by the shared durable job dispatcher.
pub(crate) async fn process_job(
    repository: &crate::storage::Repository,
    queue: &crate::jobs::queue::JobQueue,
    lease: &crate::jobs::queue::LeasedJob,
) -> Result<(), crate::jobs::queue::QueueError> {
    process_job_with_permit(repository, queue, lease, &EXPORT_PERMIT).await
}

struct ExportHeartbeat<'a> {
    queue: &'a crate::jobs::queue::JobQueue,
    lease: &'a crate::jobs::queue::LeasedJob,
    interval: tokio::time::Interval,
    lease_for: std::time::Duration,
    #[cfg(test)]
    lost: Option<tokio::sync::oneshot::Sender<()>>,
}
impl<'a> ExportHeartbeat<'a> {
    async fn start(
        queue: &'a crate::jobs::queue::JobQueue,
        lease: &'a crate::jobs::queue::LeasedJob,
    ) -> Result<Self, crate::jobs::queue::QueueError> {
        let deadline = chrono::DateTime::parse_from_rfc3339(&lease.lease_until)
            .map_err(|_| crate::jobs::queue::QueueError::InvalidRequest)?;
        let remaining = (deadline.with_timezone(&chrono::Utc) - crate::jobs::queue::lease_now())
            .to_std()
            .map_err(|_| crate::jobs::queue::QueueError::InvalidRequest)?;
        let lease_for = remaining.min(std::time::Duration::from_secs(300));
        if lease_for.is_zero() {
            return Err(crate::jobs::queue::QueueError::InvalidRequest);
        }
        queue.renew_lease(lease, lease_for).await?;
        let cadence = (lease_for / 3).max(std::time::Duration::from_millis(1));
        let mut interval = tokio::time::interval(cadence);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;
        Ok(Self {
            queue,
            lease,
            interval,
            lease_for,
            #[cfg(test)]
            lost: None,
        })
    }
    async fn during<F: std::future::Future>(
        &mut self,
        future: F,
    ) -> Result<F::Output, crate::jobs::queue::QueueError> {
        tokio::pin!(future);
        loop {
            tokio::select! {
                biased;
                _ = self.interval.tick() => {
                    if let Err(error) = self.queue.renew_lease(self.lease,self.lease_for).await {
                        #[cfg(test)] if let Some(lost) = self.lost.take() { let _ = lost.send(()); }
                        return Err(error);
                    }
                },
                value = &mut future => return Ok(value),
            }
        }
    }
    async fn blocking<T: Send + 'static>(
        &mut self,
        mut task: tokio::task::JoinHandle<T>,
    ) -> Result<T, crate::jobs::queue::QueueError> {
        loop {
            tokio::select! {
                biased;
                _ = self.interval.tick() => {
                    if let Err(error) = self.queue.renew_lease(self.lease,self.lease_for).await {
                        #[cfg(test)] if let Some(lost) = self.lost.take() { let _ = lost.send(()); }
                        // Own and join work before the caller can release its permit.
                        let _ = task.await;
                        return Err(error);
                    }
                },
                result = &mut task => return result.map_err(|_| crate::jobs::queue::QueueError::InvalidRequest),
            }
        }
    }
}

async fn process_job_with_permit(
    repository: &crate::storage::Repository,
    queue: &crate::jobs::queue::JobQueue,
    lease: &crate::jobs::queue::LeasedJob,
    permit: &tokio::sync::Semaphore,
) -> Result<(), crate::jobs::queue::QueueError> {
    process_job_phases(
        repository,
        queue,
        lease,
        permit,
        #[cfg(test)]
        None,
    )
    .await
}

#[cfg(test)]
struct BlockingPhaseGate {
    entered: tokio::sync::oneshot::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}
#[cfg(test)]
impl BlockingPhaseGate {
    fn wait(self) {
        let _ = self.entered.send(());
        let _ = self.release.recv();
    }
}
#[cfg(test)]
#[derive(Default)]
struct ExportTestGates {
    build: Option<BlockingPhaseGate>,
    staging: Option<BlockingPhaseGate>,
    permit_entered: Option<tokio::sync::oneshot::Sender<()>>,
    lost: Option<tokio::sync::oneshot::Sender<()>>,
    archive_limits: Option<ArchiveLimits>,
}

async fn process_job_phases(
    repository: &crate::storage::Repository,
    queue: &crate::jobs::queue::JobQueue,
    lease: &crate::jobs::queue::LeasedJob,
    permit: &tokio::sync::Semaphore,
    #[cfg(test)] mut gates: Option<ExportTestGates>,
) -> Result<(), crate::jobs::queue::QueueError> {
    use crate::jobs::queue::QueueError;
    if lease.kind != EXPORT_JOB_KIND {
        return Err(QueueError::InvalidRequest);
    }
    let mut heartbeat = ExportHeartbeat::start(queue, lease).await?;
    #[cfg(test)]
    {
        heartbeat.lost = gates.as_mut().and_then(|g| g.lost.take());
    }
    #[cfg(test)]
    if let Some(entered) = gates.as_mut().and_then(|g| g.permit_entered.take()) {
        let _ = entered.send(());
    }
    let _permit = heartbeat
        .during(permit.acquire())
        .await?
        .map_err(|_| QueueError::InvalidRequest)?;
    let payload: ExportJobPayload =
        serde_json::from_value(lease.payload.clone()).map_err(|_| QueueError::InvalidRequest)?;
    if !matches!(payload.format.as_str(), "native" | "yolo" | "coco") {
        return Err(QueueError::InvalidRequest);
    }
    // Capture is a short SQL-only phase: never renew while holding our own write lock.
    let mut tx = repository.begin_write().await?;
    let captured = sqlx::query("SELECT CASE WHEN length(CAST(manifest_json AS BLOB))<=16777216 THEN manifest_json END AS manifest_json,manifest_sha256 FROM dataset_versions WHERE dataset_version_id=? AND project_id=?")
        .bind(&payload.dataset_version_id).bind(&payload.project_id).fetch_optional(tx.connection()).await?;
    tx.rollback().await?;
    let Some(row) = captured else {
        return queue
            .finish(lease, false, &json!({"code":"DATASET_NOT_FOUND"}))
            .await;
    };
    let text: Option<String> = row.try_get("manifest_json")?;
    let Some(text) = text else {
        return queue
            .finish(lease, false, &json!({"code":"EXPORT_SIZE_LIMIT"}))
            .await;
    };
    let digest: String = row.try_get("manifest_sha256")?;
    if text.len() > MAX_EXPORT_MANIFEST_BYTES {
        return queue
            .finish(lease, false, &json!({"code":"EXPORT_SIZE_LIMIT"}))
            .await;
    }
    let repository_clone = repository.clone();
    let format = payload.format.clone();
    let project = payload.project_id.clone();
    let dataset = payload.dataset_version_id.clone();
    let snapshot_hash = payload.manifest_sha256.clone();
    let acknowledged = payload.loss_ack;
    let archive_limits = ArchiveLimits::default();
    #[cfg(test)]
    let archive_limits = gates
        .as_ref()
        .and_then(|g| g.archive_limits)
        .unwrap_or(archive_limits);
    #[cfg(test)]
    let (build_gate, staging_gate) = gates.map(|g| (g.build, g.staging)).unwrap_or_default();
    let generated = heartbeat
        .blocking(tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            if let Some(gate) = build_gate {
                gate.wait();
            }
            if digest != snapshot_hash || format!("{:x}", Sha256::digest(text.as_bytes())) != digest
            {
                return Err(ExportFailure::from("DATASET_CORRUPT"));
            }
            let manifest: SnapshotManifest =
                serde_json::from_str(&text).map_err(|_| "DATASET_CORRUPT")?;
            if manifest.project_id != project
                || manifest.dataset_version_id != dataset
                || super::snapshot::validate_logical_scope(
                    manifest
                        .items
                        .iter()
                        .map(|a| &*a.media_revision.asset_revision_id),
                    manifest
                        .excluded
                        .iter()
                        .map(|a| a.asset_revision_id.as_str()),
                )
                .is_err()
            {
                return Err(ExportFailure::from("EXPORT_SIZE_LIMIT"));
            }
            if manifest
                .items
                .iter()
                .any(|a| super::snapshot::validate_snapshot_document(&a.revision.document).is_err())
            {
                return Err(ExportFailure::from("SNAPSHOT_COMPLETION_INVALID"));
            }
            if loss_report_for(&manifest, &format).requires_ack() && !acknowledged {
                return Err(ExportFailure::from("LOSS_ACK_REQUIRED"));
            }
            make_archive_with_limits(
                &DatasetState {
                    repository: repository_clone,
                },
                &manifest,
                &format,
                &snapshot_hash,
                archive_limits,
            )
        }))
        .await?;
    let (archive, losses) = match generated {
        Ok(value) => value,
        Err(failure) => return queue.finish(lease, false, &json!(failure)).await,
    };
    publish_archive(
        repository,
        lease,
        &payload,
        archive,
        &losses,
        &mut heartbeat,
        #[cfg(test)]
        staging_gate,
    )
    .await
}

#[derive(Serialize)]
struct ExportResult<'a> {
    export_id: &'a str,
    format: &'a str,
    download_url: String,
    byte_size: u64,
    object_sha256: &'a str,
    loss_report: &'a LossReport,
}
fn prepare_export_result(
    lease: &crate::jobs::queue::LeasedJob,
    payload: &ExportJobPayload,
    object_sha256: &str,
    byte_size: u64,
    loss_report: &LossReport,
) -> Result<crate::jobs::queue::PreparedJobResult, crate::jobs::queue::QueueError> {
    crate::jobs::queue::JobQueue::prepare_result(&ExportResult {
        export_id: &lease.job_id,
        format: &payload.format,
        download_url: format!("/api/exports/{}/download", lease.job_id),
        byte_size,
        object_sha256,
        loss_report,
    })
}

async fn publish_archive(
    repository: &crate::storage::Repository,
    lease: &crate::jobs::queue::LeasedJob,
    payload: &ExportJobPayload,
    archive: Vec<u8>,
    losses: &LossReport,
    heartbeat: &mut ExportHeartbeat<'_>,
    #[cfg(test)] staging_gate: Option<BlockingPhaseGate>,
) -> Result<(), crate::jobs::queue::QueueError> {
    use crate::jobs::queue::QueueError;
    let (archive, hash, size) = heartbeat
        .blocking(tokio::task::spawn_blocking(move || {
            let size = archive.len() as u64;
            let hash = format!("{:x}", Sha256::digest(&archive));
            (archive, hash, size)
        }))
        .await?;
    let result = prepare_export_result(lease, payload, &hash, size, losses)?;
    let loss_json = serde_json::to_string(losses).map_err(|_| QueueError::InvalidRequest)?;
    let storage = repository.object_store().clone();
    let published = heartbeat
        .blocking(tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            if let Some(gate) = staging_gate {
                gate.wait();
            }
            storage
                .stage_bytes("dataset-export.zip", &archive)?
                .publish()
        }))
        .await?
        .map_err(|_| QueueError::InvalidRequest)?;
    if published.sha256 != hash || published.size_bytes != size {
        return Err(QueueError::InvalidRequest);
    }
    let prepared = PreparedExport {
        hash,
        size,
        loss_json,
        result,
    };
    publish_prepared(repository, lease, payload, &prepared).await
}

struct PreparedExport {
    hash: String,
    size: u64,
    loss_json: String,
    result: crate::jobs::queue::PreparedJobResult,
}
async fn publish_prepared(
    repository: &crate::storage::Repository,
    lease: &crate::jobs::queue::LeasedJob,
    payload: &ExportJobPayload,
    prepared: &PreparedExport,
) -> Result<(), crate::jobs::queue::QueueError> {
    let mut tx = repository.begin_write().await?;
    if let Err(error) = publish_export_on(tx.connection(), lease, payload, prepared).await {
        tx.rollback().await?;
        return Err(error);
    }
    tx.commit().await?;
    Ok(())
}
async fn publish_export_on(
    connection: &mut sqlx::SqliteConnection,
    lease: &crate::jobs::queue::LeasedJob,
    payload: &ExportJobPayload,
    prepared: &PreparedExport,
) -> Result<(), crate::jobs::queue::QueueError> {
    use crate::jobs::queue::{JobQueue, QueueError};
    let admitted: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM jobs WHERE job_id=? AND project_id=? AND kind='dataset_export'",
    )
    .bind(&lease.job_id)
    .bind(&payload.project_id)
    .fetch_one(&mut *connection)
    .await?;
    if admitted != 1 {
        return Err(QueueError::InvalidRequest);
    }
    JobQueue::finish_prepared_on(connection, lease, true, &prepared.result).await?;
    let valid: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dataset_versions WHERE dataset_version_id=? AND project_id=? AND manifest_sha256=?")
        .bind(&payload.dataset_version_id).bind(&payload.project_id).bind(&payload.manifest_sha256).fetch_one(&mut *connection).await?;
    if valid != 1 {
        return Err(QueueError::InvalidRequest);
    }
    sqlx::query("INSERT INTO dataset_exports(export_id,project_id,dataset_version_id,manifest_sha256,actor_id,format,object_sha256,byte_size,loss_report_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(&lease.job_id).bind(&payload.project_id).bind(&payload.dataset_version_id).bind(&payload.manifest_sha256)
        .bind(&payload.actor_id).bind(&payload.format).bind(&prepared.hash).bind(prepared.size as i64).bind(&prepared.loss_json)
        .bind(now_rfc3339()).execute(connection).await?;
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

#[derive(Serialize)]
struct ZipManifest<'a> {
    schema_version: u8,
    dataset_version_id: &'a str,
    project_id: &'a str,
    snapshot_manifest_sha256: &'a str,
    ontology: &'a annotation_domain::OntologyVersion,
    category_mapping: Vec<&'a String>,
    items: Vec<ZipManifestItem<'a>>,
    excluded: &'a [super::snapshot::ExcludedItem],
    exporter_version: &'a str,
    params: ZipParams<'a>,
    loss_report: &'a LossReport,
    statistics: ZipStatistics,
    validation: ZipValidation,
}
#[derive(Serialize)]
struct ZipManifestItem<'a> {
    media_revision: &'a annotation_domain::MediaRevision,
    asset_revision_id: &'a annotation_domain::Id,
    original_name: &'a str,
    original_sha256: &'a str,
    original_object_sha256: &'a str,
    canonical_sha256: &'a str,
    annotation_revision_id: &'a annotation_domain::Id,
    annotation_content_hash: &'a str,
    split: super::split::Split,
    completion: &'a annotation_domain::Completion,
    review_status: &'a str,
    review_id: &'a str,
    reviewed_by: &'a str,
    review_reason: &'a str,
    reviewed_at: &'a str,
}
#[derive(Serialize)]
struct ZipParams<'a> {
    format: &'a str,
    split_seed: Option<&'a str>,
    split_ratios: Option<[u32; 3]>,
}
#[derive(Serialize)]
struct ZipStatistics {
    asset_count: usize,
    object_count: usize,
    splits: ZipSplits,
}
#[derive(Serialize)]
struct ZipSplits {
    train: usize,
    val: usize,
    test: usize,
}
#[derive(Serialize)]
struct ZipValidation {
    zip_member_readback: bool,
}

#[derive(Debug, Serialize)]
struct ExportFailure {
    code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    observed_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    budget: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}
impl From<&'static str> for ExportFailure {
    fn from(code: &'static str) -> Self {
        Self {
            code,
            limit_bytes: None,
            observed_bytes: None,
            budget: None,
            message: None,
        }
    }
}
impl ExportFailure {
    fn size_limit(budget: &'static str, limit: u64, observed: u64) -> Self {
        Self { code: "EXPORT_SIZE_LIMIT", limit_bytes: Some(limit), observed_bytes: Some(observed), budget: Some(budget), message: Some(format!("Export {budget} exceeds its budget: {observed} bytes currently known; limit {limit} bytes. A successful snapshot does not guarantee that its ZIP fits.")) }
    }
    fn archive(error: dataset_formats::FormatError) -> Self {
        match error {
            dataset_formats::FormatError::SizeLimit {
                budget,
                limit,
                observed,
            } => Self::size_limit(budget, limit, observed),
            _ => "EXPORT_INVALID".into(),
        }
    }
}

#[cfg(test)]
fn make_archive(
    state: &DatasetState,
    manifest: &SnapshotManifest,
    format: &str,
    snapshot_hash: &str,
) -> Result<(Vec<u8>, LossReport), ExportFailure> {
    make_archive_with_limits(
        state,
        manifest,
        format,
        snapshot_hash,
        ArchiveLimits::default(),
    )
}
fn make_archive_with_limits(
    state: &DatasetState,
    manifest: &SnapshotManifest,
    format: &str,
    snapshot_hash: &str,
    limits: ArchiveLimits,
) -> Result<(Vec<u8>, LossReport), ExportFailure> {
    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    // Shared production member accounting; tests can supply a small budget.
    let mut uncompressed_bytes = 0_u64;
    super::snapshot::validate_logical_scope(
        manifest
            .items
            .iter()
            .map(|a| &*a.media_revision.asset_revision_id),
        manifest
            .excluded
            .iter()
            .map(|a| a.asset_revision_id.as_str()),
    )?;
    let mut media_budget = super::snapshot::MediaVerificationBudget::default();
    let losses = loss_report_for(manifest, format);

    let mut export_category_mapping: Vec<_> = manifest.category_mapping.iter().collect();
    if format == "coco" {
        export_category_mapping.sort();
    }
    if format == "native" {
        for asset in &manifest.items {
            let original = read_object_with_limit(
                state.repository.object_store(),
                &asset.original_object_sha256,
                media_budget.remaining().min(
                    limits
                        .max_uncompressed_bytes
                        .saturating_sub(uncompressed_bytes),
                ),
            )?;
            media_budget.charge(original.len() as u64)?;
            let image = read_object_with_limit(
                state.repository.object_store(),
                &asset.canonical_object_sha256,
                media_budget.remaining().min(
                    limits
                        .max_uncompressed_bytes
                        .saturating_sub(uncompressed_bytes + original.len() as u64),
                ),
            )?;
            media_budget.charge(image.len() as u64)?;
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
            let original_size = super::snapshot::verify_media_object_with_limit(
                state.repository.object_store(),
                &asset.original_object_sha256,
                media_budget.remaining(),
            )?;
            media_budget.charge(original_size)?;
            let image = read_object_with_limit(
                state.repository.object_store(),
                &asset.canonical_object_sha256,
                media_budget.remaining().min(
                    limits
                        .max_uncompressed_bytes
                        .saturating_sub(uncompressed_bytes),
                ),
            )?;
            media_budget.charge(image.len() as u64)?;
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
                    return Err("EXPORT_CLASS_MAPPING_INVALID".into());
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
    let projection = ZipManifest {
        schema_version: 1,
        dataset_version_id: &manifest.dataset_version_id,
        project_id: &manifest.project_id,
        snapshot_manifest_sha256: snapshot_hash,
        ontology: &manifest.ontology,
        category_mapping: export_category_mapping,
        items: manifest
            .items
            .iter()
            .map(|item| ZipManifestItem {
                media_revision: &item.media_revision,
                asset_revision_id: &item.media_revision.asset_revision_id,
                original_name: &item.media_revision.original_name,
                original_sha256: &item.media_revision.original_sha256,
                original_object_sha256: &item.original_object_sha256,
                canonical_sha256: &item.media_revision.canonical_sha256,
                annotation_revision_id: &item.revision.annotation_revision_id,
                annotation_content_hash: &item.revision.content_hash,
                split: item.split,
                completion: &item.revision.document.completion,
                review_status: "approved",
                review_id: &item.review_id,
                reviewed_by: &item.reviewed_by,
                review_reason: &item.review_reason,
                reviewed_at: &item.reviewed_at,
            })
            .collect(),
        excluded: &manifest.excluded,
        exporter_version: "t27-v1",
        params: ZipParams {
            format,
            split_seed: manifest.split_seed.as_deref(),
            split_ratios: manifest.split_ratios,
        },
        loss_report: &losses,
        statistics: ZipStatistics {
            asset_count: manifest.items.len(),
            object_count: manifest
                .items
                .iter()
                .map(|a| a.revision.document.objects.len())
                .sum(),
            splits: ZipSplits {
                train: split_count("train"),
                val: split_count("val"),
                test: split_count("test"),
            },
        },
        validation: ZipValidation {
            zip_member_readback: true,
        },
    };
    let zip_manifest = serde_json::to_vec(&projection).map_err(|_| "EXPORT_SERIALIZE_FAILED")?;
    if zip_manifest.len() > MAX_EXPORT_MANIFEST_BYTES {
        return Err(ExportFailure::size_limit(
            "manifest",
            MAX_EXPORT_MANIFEST_BYTES as u64,
            zip_manifest.len() as u64,
        ));
    }
    insert_file(
        &mut files,
        &limits,
        &mut uncompressed_bytes,
        "manifest.json".into(),
        zip_manifest,
    )?;
    let entries: Vec<_> = files.into_iter().collect();
    let bytes =
        create_safe_zip(&entries, &ArchiveLimits::default()).map_err(ExportFailure::archive)?;
    let parsed =
        extract_safe_zip(&bytes, &ArchiveLimits::default()).map_err(ExportFailure::archive)?;
    if parsed.len() != entries.len()
        || parsed
            .iter()
            .zip(&entries)
            .any(|((name, bytes), (key, expected))| name != key || bytes != expected)
    {
        return Err("EXPORT_READBACK_FAILED".into());
    }
    Ok((bytes, losses))
}
fn insert_file(
    files: &mut BTreeMap<String, Vec<u8>>,
    limits: &ArchiveLimits,
    total: &mut u64,
    name: String,
    bytes: Vec<u8>,
) -> Result<(), ExportFailure> {
    let size = u64::try_from(bytes.len()).map_err(|_| "EXPORT_INVALID")?;
    let next_total = total.checked_add(size).ok_or("EXPORT_INVALID")?;
    if files.contains_key(&name) {
        return Err("EXPORT_INVALID".into());
    }
    if files.len() >= limits.max_entries {
        return Err("EXPORT_SIZE_LIMIT".into());
    }
    if next_total > limits.max_uncompressed_bytes {
        return Err(ExportFailure::size_limit(
            "uncompressed archive members",
            limits.max_uncompressed_bytes,
            next_total,
        ));
    }
    *total = next_total;
    files.insert(name, bytes);
    Ok(())
}

fn read_object_with_limit(
    store: &crate::storage::ObjectStore,
    hash: &str,
    remaining: u64,
) -> Result<Vec<u8>, &'static str> {
    use std::io::Read;
    let path = store.path_for_hash(hash).ok_or("MEDIA_OBJECT_INVALID")?;
    let declared = std::fs::metadata(&path)
        .map_err(|_| "MEDIA_OBJECT_MISSING")?
        .len();
    if declared > remaining {
        return Err("EXPORT_SIZE_LIMIT");
    }
    let capacity = usize::try_from(declared).map_err(|_| "EXPORT_SIZE_LIMIT")?;
    let mut bytes = Vec::with_capacity(capacity);
    let mut reader = std::fs::File::open(path)
        .map_err(|_| "MEDIA_OBJECT_MISSING")?
        .take(remaining.saturating_add(1));
    let mut buffer = [0u8; 16384];
    let mut digest = Sha256::new();
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| "MEDIA_OBJECT_MISSING")?;
        if read == 0 {
            break;
        }
        let next = bytes.len().checked_add(read).ok_or("EXPORT_SIZE_LIMIT")?;
        if next > capacity || next as u64 > remaining {
            return Err("EXPORT_SIZE_LIMIT");
        }
        digest.update(&buffer[..read]);
        bytes.extend_from_slice(&buffer[..read]);
    }
    if bytes.len() != capacity {
        return Err("EXPORT_SIZE_LIMIT");
    }
    if format!("{:x}", digest.finalize()) != hash {
        return Err("MEDIA_OBJECT_INVALID");
    }
    Ok(bytes)
}

#[cfg(test)]
mod commercial_d_private_tests {
    use super::*;
    use crate::{
        jobs::queue::{JobQueue, LeasedJob, QueueError},
        storage::Repository,
    };
    use std::{future::Future, io::Cursor, task::Poll, time::Duration};

    struct Fixture {
        _directory: tempfile::TempDir,
        repository: Repository,
        queue: JobQueue,
        manifest: SnapshotManifest,
        payload: ExportJobPayload,
    }

    async fn fixture() -> Fixture {
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
            .bind(&revision_id).bind(&project).bind(&media_id).bind(&ontology_id).bind(&serialized.json).bind(&serialized.content_hash).bind(&actor).bind(&now).execute(tx.connection()).await.unwrap();
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
        let queue = JobQueue::new(repository.clone());
        Fixture {
            _directory: directory,
            repository,
            queue,
            manifest,
            payload: ExportJobPayload {
                dataset_version_id: dataset,
                project_id: project,
                actor_id: actor,
                format: "native".into(),
                loss_ack: true,
                manifest_sha256: digest,
            },
        }
    }

    impl Fixture {
        async fn publish(
            &self,
            lease: &LeasedJob,
            archive: Vec<u8>,
            losses: &LossReport,
        ) -> Result<(), QueueError> {
            let mut heartbeat = ExportHeartbeat::start(&self.queue, lease).await?;
            publish_archive(
                &self.repository,
                lease,
                &self.payload,
                archive,
                losses,
                &mut heartbeat,
                None,
            )
            .await
        }
        async fn lease(&self, seconds: u64) -> LeasedJob {
            let payload = json!({"dataset_version_id":self.payload.dataset_version_id,"project_id":self.payload.project_id,
                "actor_id":self.payload.actor_id,"format":self.payload.format,"loss_ack":true,"manifest_sha256":self.payload.manifest_sha256});
            self.queue
                .enqueue(
                    Some(&self.payload.project_id),
                    EXPORT_JOB_KIND,
                    &Uuid::new_v4().to_string(),
                    &payload,
                )
                .await
                .unwrap();
            self.queue
                .lease_next_kind("a", Duration::from_secs(seconds), Some(EXPORT_JOB_KIND))
                .await
                .unwrap()
                .unwrap()
        }

        async fn expire(&self, lease: &LeasedJob) {
            let mut tx = self.repository.begin_write().await.unwrap();
            sqlx::query("UPDATE jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE job_id=?")
                .bind(&lease.job_id)
                .execute(tx.connection())
                .await
                .unwrap();
            tx.commit().await.unwrap();
        }

        async fn durable(&self, lease: &LeasedJob) -> (i64, String, Option<String>, String, i64) {
            let mut tx = self.repository.begin_write().await.unwrap();
            let row = sqlx::query_as("SELECT (SELECT COUNT(*) FROM dataset_exports WHERE export_id=jobs.job_id),state,result_json,worker_id,fencing_token FROM jobs WHERE job_id=?")
                .bind(&lease.job_id).fetch_one(tx.connection()).await.unwrap();
            tx.rollback().await.unwrap();
            row
        }

        fn archive(&self) -> Vec<u8> {
            make_archive(
                &DatasetState {
                    repository: self.repository.clone(),
                },
                &self.manifest,
                "native",
                &self.payload.manifest_sha256,
            )
            .unwrap()
            .0
        }
    }

    #[tokio::test]
    async fn archive_budget_rejection_survives_durable_job_result() {
        let f = fixture().await;
        let lease = f.lease(30).await;
        let media_bytes = 2 * std::fs::metadata(
            f.repository
                .object_store()
                .path_for_hash(&f.manifest.items[0].original_object_sha256)
                .unwrap(),
        )
        .unwrap()
        .len();
        process_job_phases(
            &f.repository,
            &f.queue,
            &lease,
            &tokio::sync::Semaphore::new(1),
            Some(ExportTestGates {
                archive_limits: Some(ArchiveLimits {
                    max_entries: 4096,
                    max_uncompressed_bytes: media_bytes,
                }),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
        let durable = f.durable(&lease).await;
        assert_eq!(durable.0, 0);
        assert_eq!(durable.1, "failed");
        let failure = serde_json::from_str::<Value>(&durable.2.unwrap()).unwrap();
        assert_eq!(failure["code"], "EXPORT_SIZE_LIMIT");
        assert_eq!(failure["limit_bytes"], media_bytes);
        assert!(failure["observed_bytes"].as_u64().unwrap() > media_bytes);
        assert_eq!(failure["budget"], "uncompressed archive members");
    }

    #[test]
    fn real_archive_size_errors_are_not_invalid_format_errors() {
        let files = vec![("a.bin".to_owned(), vec![1, 2, 3, 4])];
        let limits = ArchiveLimits {
            max_entries: 4,
            max_uncompressed_bytes: 3,
        };
        let failure = ExportFailure::archive(create_safe_zip(&files, &limits).unwrap_err());
        assert_eq!(failure.code, "EXPORT_SIZE_LIMIT");
        assert_eq!(failure.limit_bytes, Some(3));
        assert_eq!(failure.observed_bytes, Some(4));
        let bytes = create_safe_zip(&files, &ArchiveLimits::default()).unwrap();
        let failure = ExportFailure::archive(extract_safe_zip(&bytes, &limits).unwrap_err());
        assert_eq!(failure.code, "EXPORT_SIZE_LIMIT");
        assert_eq!(failure.observed_bytes, Some(4));
        let invalid = vec![("../a.bin".to_owned(), vec![1])];
        assert_eq!(
            ExportFailure::archive(
                create_safe_zip(&invalid, &ArchiveLimits::default()).unwrap_err()
            )
            .code,
            "EXPORT_INVALID"
        );
        assert_eq!(
            ExportFailure::archive(
                extract_safe_zip(b"not a ZIP", &ArchiveLimits::default()).unwrap_err()
            )
            .code,
            "EXPORT_INVALID"
        );
    }

    fn result(
        lease: &LeasedJob,
        payload: &ExportJobPayload,
        archive: &[u8],
        losses: &LossReport,
    ) -> Value {
        json!({"export_id":lease.job_id,"format":payload.format,"download_url":format!("/api/exports/{}/download",lease.job_id),
            "byte_size":archive.len() as u64,"object_sha256":format!("{:x}",Sha256::digest(archive)),"loss_report":losses})
    }

    async fn stale_persist_cannot_publish(reclaim: bool) {
        let f = fixture().await;
        let a = f.lease(30).await;
        f.expire(&a).await;
        if reclaim {
            let b = f
                .queue
                .lease_next_kind("b", Duration::from_secs(30), Some(EXPORT_JOB_KIND))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(b.job_id, a.job_id);
            assert_eq!(b.fencing_token, a.fencing_token + 1);
        }
        let before = f.durable(&a).await;
        let outcome = f.publish(&a, f.archive(), &LossReport::default()).await;
        assert_eq!(
            f.durable(&a).await,
            before,
            "stale publication must preserve job and leave zero business rows"
        );
        assert!(matches!(outcome, Err(QueueError::InvalidRequest)));
    }

    #[tokio::test]
    async fn expired_persist_cannot_publish_business_row() {
        stale_persist_cannot_publish(false).await;
    }

    #[tokio::test]
    async fn reclaimed_persist_cannot_publish_business_row() {
        stale_persist_cannot_publish(true).await;
    }

    #[tokio::test]
    async fn actual_export_result_limit_cannot_leave_persisted_partial_row() {
        for extra in [0, 1] {
            let f = fixture().await;
            let lease = f.lease(30).await;
            let archive = f.archive();
            let mut losses = LossReport {
                losses: vec![LossItem {
                    field: "annotation.attributes".into(),
                    reason: "中\"\\".into(),
                }],
            };
            let base = serde_json::to_vec(&result(&lease, &f.payload, &archive, &losses))
                .unwrap()
                .len();
            losses.losses[0]
                .reason
                .push_str(&"x".repeat(256 * 1024 + extra - base));
            let terminal = result(&lease, &f.payload, &archive, &losses);
            assert_eq!(
                serde_json::to_vec(&terminal).unwrap().len(),
                256 * 1024 + extra
            );
            let outcome = f.publish(&lease, archive, &losses).await;
            let durable = f.durable(&lease).await;
            if extra == 0 {
                outcome.unwrap();
                assert_eq!(durable.0, 1);
                assert_eq!(durable.1, "succeeded");
                assert_eq!(
                    serde_json::from_str::<Value>(durable.2.as_ref().unwrap()).unwrap(),
                    terminal
                );
                let mut tx = f.repository.begin_write().await.unwrap();
                let business: (String, i64, String) = sqlx::query_as("SELECT object_sha256,byte_size,loss_report_json FROM dataset_exports WHERE export_id=?")
                    .bind(&lease.job_id).fetch_one(tx.connection()).await.unwrap();
                tx.rollback().await.unwrap();
                assert_eq!(business.0, terminal["object_sha256"].as_str().unwrap());
                assert_eq!(business.1 as u64, terminal["byte_size"].as_u64().unwrap());
                assert_eq!(
                    serde_json::from_str::<LossReport>(&business.2).unwrap(),
                    losses
                );
                let path = f
                    .repository
                    .object_store()
                    .path_for_hash(&business.0)
                    .unwrap();
                let bytes = std::fs::read(path).unwrap();
                assert_eq!(bytes.len() as u64, business.1 as u64);
                assert_eq!(format!("{:x}", Sha256::digest(&bytes)), business.0);
                let parsed = extract_safe_zip(&bytes, &ArchiveLimits::default()).unwrap();
                let revision: annotation_domain::AnnotationRevision = serde_json::from_slice(
                    &parsed[&format!(
                        "annotations/{}.json",
                        &*f.manifest.items[0].media_revision.asset_revision_id
                    )],
                )
                .unwrap();
                assert_eq!(revision, f.manifest.items[0].revision);
            } else {
                assert!(matches!(outcome, Err(QueueError::InvalidRequest)));
                assert_eq!(durable.1, "running");
                assert_eq!(durable.2, None);
                assert_eq!(
                    durable.0, 0,
                    "result rejection cannot leave a downloadable business row"
                );
            }
        }
    }

    #[tokio::test]
    async fn zip_manifest_has_its_own_exact_utf8_budget() {
        let mut f = fixture().await;
        let state = DatasetState {
            repository: f.repository.clone(),
        };
        let archive = make_archive(&state, &f.manifest, "native", &f.payload.manifest_sha256)
            .unwrap()
            .0;
        let parsed = extract_safe_zip(&archive, &ArchiveLimits::default()).unwrap();
        let zip_base = parsed["manifest.json"].len();
        let db_base = serde_json::to_vec(&f.manifest).unwrap().len();
        drop(parsed);
        drop(archive);
        // original_name is retained once in the DB and twice in the ZIP
        // projection. Measure both serializers, then give the ZIP boundary
        // room to be crossed while the stored manifest remains legal.
        f.manifest.items[0]
            .media_revision
            .original_name
            .push_str(&"x".repeat(db_base.saturating_sub(zip_base) + 1024));
        let archive = make_archive(&state, &f.manifest, "native", &f.payload.manifest_sha256)
            .unwrap()
            .0;
        let parsed = extract_safe_zip(&archive, &ArchiveLimits::default()).unwrap();
        let base = parsed["manifest.json"].len();
        assert!(base > serde_json::to_vec(&f.manifest).unwrap().len());
        drop(parsed);
        drop(archive);
        f.manifest
            .ontology
            .guidelines_markdown
            .push_str(&"x".repeat(16 * 1024 * 1024 - base));
        for extra in [0, 1] {
            if extra == 1 {
                f.manifest.ontology.guidelines_markdown.push('x');
            }
            f.manifest.dataset_version_id = Uuid::new_v4().to_string();
            let text = serde_json::to_string(&f.manifest).unwrap();
            assert!(
                text.len() <= 16 * 1024 * 1024,
                "the DB budget must not mask the independent ZIP budget"
            );
            let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
            let mut tx = f.repository.begin_write().await.unwrap();
            sqlx::query("INSERT INTO dataset_versions(dataset_version_id,project_id,ontology_version_id,manifest_json,manifest_sha256,created_by,created_at) VALUES(?,?,?,?,?,?,?)")
                .bind(&f.manifest.dataset_version_id).bind(&f.manifest.project_id).bind(&*f.manifest.ontology.ontology_version_id)
                .bind(&text).bind(&digest).bind(&f.manifest.created_by).bind(&f.manifest.created_at).execute(tx.connection()).await.unwrap();
            tx.commit().await.unwrap();
            drop(text);
            let outcome = make_archive(&state, &f.manifest, "native", &digest);
            if extra == 0 {
                let archive = outcome.unwrap().0;
                let parsed = extract_safe_zip(&archive, &ArchiveLimits::default()).unwrap();
                assert_eq!(parsed["manifest.json"].len(), 16 * 1024 * 1024);
                let projection: Value = serde_json::from_slice(&parsed["manifest.json"]).unwrap();
                assert_eq!(
                    projection["ontology"]["guidelines_markdown"],
                    f.manifest.ontology.guidelines_markdown
                );
                assert!(archive.len() < 96 * 1024 * 1024);
            } else {
                assert!(
                    outcome.is_err(),
                    "16MiB+1 serialized ZIP manifest must be rejected"
                );
            }
        }
    }

    #[test]
    fn insert_file_counts_repeated_logical_bytes_and_members_without_mutating_on_rejection() {
        let limits = ArchiveLimits::default();
        let mut files = BTreeMap::new();
        let mut total = 0;
        // Identical bytes still represent separate logical members.
        for index in 0..4096 {
            insert_file(
                &mut files,
                &limits,
                &mut total,
                format!("file-{index}"),
                vec![7],
            )
            .unwrap();
        }
        assert_eq!(total, 4096);
        assert!(insert_file(&mut files, &limits, &mut total, "next".into(), vec![7]).is_err());
        assert_eq!(files.len(), 4096);
        assert_eq!(total, 4096);
        files.clear();
        total = 0;
        for name in ["original", "canonical"] {
            insert_file(
                &mut files,
                &limits,
                &mut total,
                name.into(),
                vec![7; 48 * 1024 * 1024],
            )
            .unwrap();
        }
        assert_eq!(total, 96 * 1024 * 1024);
        assert!(insert_file(&mut files, &limits, &mut total, "next".into(), vec![7]).is_err());
        assert_eq!(total, 96 * 1024 * 1024);
        assert_eq!(files.len(), 2);
        assert!(insert_file(
            &mut files,
            &limits,
            &mut total,
            "original".into(),
            Vec::new()
        )
        .is_err());
        assert_eq!(files["original"].len(), 48 * 1024 * 1024);
    }

    // The permit is invocation-owned, independent of other worker tests.
    #[tokio::test]
    async fn short_lease_is_renewed_while_waiting_for_export_permit() {
        let f = fixture().await;
        let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
        let permit = semaphore.acquire().await.unwrap();
        let lease = f.lease(2).await;
        let original_deadline = chrono::DateTime::parse_from_rfc3339(&lease.lease_until).unwrap();
        let repository = f.repository.clone();
        let queue = f.queue.clone();
        let worker_lease = lease.clone();
        let (entered, observed) = tokio::sync::oneshot::channel();
        let worker_permit = semaphore.clone();
        let worker = tokio::spawn(async move {
            let operation =
                process_job_with_permit(&repository, &queue, &worker_lease, &worker_permit);
            tokio::pin!(operation);
            let mut entered = Some(entered);
            std::future::poll_fn(|cx| {
                let poll = operation.as_mut().poll(cx);
                if poll.is_pending() {
                    if let Some(entered) = entered.take() {
                        let _ = entered.send(());
                    }
                }
                poll
            })
            .await
        });
        tokio::time::timeout(Duration::from_secs(1), observed)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(4), async {
            while chrono::Utc::now() <= original_deadline {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let mut tx = f.repository.begin_write().await.unwrap();
        let waiting: (String, String, i64, String) = sqlx::query_as(
            "SELECT state,worker_id,fencing_token,lease_until FROM jobs WHERE job_id=?",
        )
        .bind(&lease.job_id)
        .fetch_one(tx.connection())
        .await
        .unwrap();
        tx.rollback().await.unwrap();
        let observed_at = chrono::Utc::now();
        drop(permit);
        let outcome = tokio::time::timeout(Duration::from_secs(10), worker)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(waiting.0, "running");
        assert_eq!(waiting.1, lease.worker_id);
        assert_eq!(waiting.2, lease.fencing_token as i64);
        let renewed = chrono::DateTime::parse_from_rfc3339(&waiting.3).unwrap();
        assert!(
            renewed > observed_at,
            "permit waiter must keep its real durable lease alive"
        );
        outcome.unwrap();
        let durable = f.durable(&lease).await;
        assert_eq!(durable.0, 1);
        assert_eq!(durable.1, "succeeded");
    }
    fn blocking_gate() -> (
        BlockingPhaseGate,
        tokio::sync::oneshot::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        let (entered, observed) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        (
            BlockingPhaseGate {
                entered,
                release: wait,
            },
            observed,
            release,
        )
    }

    #[tokio::test]
    async fn real_worker_all_phases_renew_expire_and_reclaim_without_abandoning_permit() {
        for phase in 0..3 {
            for mode in 0..3 {
                // Only this invocation and its explicitly scoped worker share time.
                // SQLite admission/close and heartbeat timers remain real.
                let clock = std::sync::Arc::new(std::sync::Mutex::new(chrono::Utc::now()));
                crate::jobs::queue::TEST_LEASE_CLOCK
                    .scope(clock.clone(), async {
                        tokio::spawn(async {
                            assert!(
                                crate::jobs::queue::TEST_LEASE_CLOCK
                                    .try_with(|_| ())
                                    .is_err(),
                                "spawned sibling must not inherit a fixture clock"
                            );
                            let before = chrono::Utc::now();
                            let observed = crate::jobs::queue::lease_now();
                            assert!(observed >= before && observed <= chrono::Utc::now());
                        })
                        .await
                        .unwrap();
                        let f = fixture().await;
                        let lease = f.lease(2).await;
                        let deadline =
                            chrono::DateTime::parse_from_rfc3339(&lease.lease_until).unwrap();
                        let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
                        let held = if phase == 0 {
                            Some(semaphore.clone().acquire_owned().await.unwrap())
                        } else {
                            None
                        };
                        let (gate, observed, release) = blocking_gate();
                        let (lost, loss_observed) = tokio::sync::oneshot::channel();
                        let (permit_entered, permit_observed) = tokio::sync::oneshot::channel();
                        let gates = if phase == 1 {
                            ExportTestGates {
                                build: Some(gate),
                                staging: None,
                                lost: Some(lost),
                                permit_entered: Some(permit_entered),
                                archive_limits: None,
                            }
                        } else if phase == 2 {
                            ExportTestGates {
                                build: None,
                                staging: Some(gate),
                                lost: Some(lost),
                                permit_entered: Some(permit_entered),
                                archive_limits: None,
                            }
                        } else {
                            drop(gate);
                            ExportTestGates {
                                build: None,
                                staging: None,
                                lost: Some(lost),
                                permit_entered: Some(permit_entered),
                                archive_limits: None,
                            }
                        };
                        let repository = f.repository.clone();
                        let queue = f.queue.clone();
                        let a = lease.clone();
                        let worker_permit = semaphore.clone();
                        let worker_clock = clock.clone();
                        let worker = tokio::spawn(async move {
                            crate::jobs::queue::TEST_LEASE_CLOCK
                                .scope(
                                    worker_clock,
                                    process_job_phases(
                                        &repository,
                                        &queue,
                                        &a,
                                        &worker_permit,
                                        Some(gates),
                                    ),
                                )
                                .await
                        });
                        if phase == 0 {
                            tokio::time::timeout(Duration::from_secs(2), permit_observed)
                                .await
                                .unwrap()
                                .unwrap();
                        } else {
                            tokio::time::timeout(Duration::from_secs(5), observed)
                                .await
                                .unwrap()
                                .unwrap();
                        }
                        let replacement = if mode == 0 {
                            // Advance less than one lease per observed heartbeat, then
                            // cross the original deadline. Freeze time during publication
                            // so scheduler/SQLite shutdown latency is not artificial expiry.
                            for elapsed_ms in [700, 1400, 2100] {
                                let now = deadline.with_timezone(&chrono::Utc)
                                    - chrono::Duration::seconds(2)
                                    + chrono::Duration::milliseconds(elapsed_ms);
                                *clock.lock().unwrap() = now;
                                tokio::time::timeout(Duration::from_secs(5), async {
                                    loop {
                                        // Observe without competing with the heartbeat writer.
                                        let mut connection =
                                            f.repository.read_connection().await.unwrap();
                                        let until: String = sqlx::query_scalar(
                                            "SELECT lease_until FROM jobs WHERE job_id=?",
                                        )
                                        .bind(&lease.job_id)
                                        .fetch_one(&mut *connection)
                                        .await
                                        .unwrap();
                                        drop(connection);
                                        if chrono::DateTime::parse_from_rfc3339(&until).unwrap()
                                            > now + chrono::Duration::milliseconds(1400)
                                        {
                                            break;
                                        }
                                        tokio::time::sleep(Duration::from_millis(5)).await;
                                    }
                                })
                                .await
                                .unwrap();
                            }
                            assert!(crate::jobs::queue::lease_now() > deadline);
                            let mut connection = f.repository.read_connection().await.unwrap();
                            let (until, worker_id, fence): (String, String, i64) = sqlx::query_as(
                        "SELECT lease_until,worker_id,fencing_token FROM jobs WHERE job_id=?",
                    )
                    .bind(&lease.job_id)
                    .fetch_one(&mut *connection)
                    .await
                    .unwrap();
                            drop(connection);
                            assert!(
                                chrono::DateTime::parse_from_rfc3339(&until).unwrap()
                                    > crate::jobs::queue::lease_now()
                            );
                            assert_eq!(worker_id, lease.worker_id);
                            assert_eq!(fence, lease.fencing_token as i64);
                            None
                        } else {
                            f.expire(&lease).await;
                            tokio::time::timeout(Duration::from_secs(3), loss_observed)
                                .await
                                .unwrap()
                                .unwrap();
                            if phase != 0 {
                                assert!(
                                    !worker.is_finished(),
                                    "owned blocking work must be joined before return"
                                );
                                assert!(
                                    semaphore.try_acquire().is_err(),
                                    "lost worker still owns expensive-work permit until join"
                                );
                            }
                            if mode == 2 {
                                let b = f
                                    .queue
                                    .lease_next_kind(
                                        "b",
                                        Duration::from_secs(30),
                                        Some(EXPORT_JOB_KIND),
                                    )
                                    .await
                                    .unwrap()
                                    .unwrap();
                                assert_eq!(b.fencing_token, lease.fencing_token + 1);
                                Some(b)
                            } else {
                                None
                            }
                        };
                        let before_release = f.durable(&lease).await;
                        if phase == 0 {
                            drop(held);
                        } else {
                            release.send(()).unwrap();
                        }
                        let outcome = tokio::time::timeout(Duration::from_secs(10), worker)
                            .await
                            .unwrap_or_else(|_| {
                                panic!("export worker did not finish after release: phase={phase}, mode={mode}")
                            })
                            .unwrap();
                        if mode == 0 {
                            outcome.unwrap();
                            let durable = f.durable(&lease).await;
                            assert_eq!(durable.0, 1);
                            assert_eq!(durable.1, "succeeded");
                        } else {
                            assert!(matches!(outcome, Err(QueueError::InvalidRequest)));
                            assert_eq!(f.durable(&lease).await, before_release);
                            assert_eq!(before_release.0, 0);
                            assert_eq!(before_release.1, "running");
                            if let Some(b) = replacement {
                                process_job_with_permit(&f.repository, &f.queue, &b, &semaphore)
                                    .await
                                    .unwrap();
                                let durable = f.durable(&b).await;
                                assert_eq!(durable.0, 1);
                                assert_eq!(durable.1, "succeeded");
                                assert_eq!(durable.3, "b");
                                let result: Value =
                                    serde_json::from_str(durable.2.as_ref().unwrap()).unwrap();
                                let expected = f.archive();
                                assert_eq!(
                                    result["object_sha256"],
                                    format!("{:x}", Sha256::digest(&expected))
                                );
                                assert_eq!(result["byte_size"], expected.len() as u64);
                            }
                        }
                    })
                    .await;
            }
        }
    }

    #[tokio::test]
    async fn atomic_publisher_insert_terminal_and_deferred_commit_faults_roll_back() {
        for fault in 0..3 {
            let f = fixture().await;
            let lease = f.lease(30).await;
            let mut tx = f.repository.begin_write().await.unwrap();
            if fault == 0 {
                sqlx::raw_sql(&format!("CREATE TRIGGER d_insert_fault BEFORE INSERT ON dataset_exports WHEN NEW.export_id='{}' BEGIN SELECT RAISE(ABORT,'owned insert fault'); END;",lease.job_id))
                    .execute(tx.connection()).await.unwrap();
            } else if fault == 1 {
                sqlx::raw_sql(&format!("CREATE TRIGGER d_terminal_fault BEFORE UPDATE OF state ON jobs WHEN NEW.job_id='{}' AND NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'owned terminal fault'); END;",lease.job_id))
                    .execute(tx.connection()).await.unwrap();
            } else {
                sqlx::raw_sql("CREATE TABLE d_test_commit_parent(id TEXT PRIMARY KEY); CREATE TABLE d_test_commit_child(export_id TEXT PRIMARY KEY,parent_id TEXT NOT NULL REFERENCES d_test_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);")
                    .execute(tx.connection()).await.unwrap();
            }
            tx.commit().await.unwrap();
            if fault == 2 {
                let mut control = f.repository.begin_write().await.unwrap();
                sqlx::query("INSERT INTO d_test_commit_parent VALUES('valid-owned-parent')")
                    .execute(control.connection())
                    .await
                    .unwrap();
                sqlx::query(
                    "INSERT INTO d_test_commit_child VALUES('valid-control','valid-owned-parent')",
                )
                .execute(control.connection())
                .await
                .unwrap();
                control.commit().await.unwrap();
                let mut control = f.repository.begin_write().await.unwrap();
                let count: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM d_test_commit_child WHERE export_id='valid-control'",
                )
                .fetch_one(control.connection())
                .await
                .unwrap();
                assert_eq!(count, 1);
                sqlx::query("DELETE FROM d_test_commit_child")
                    .execute(control.connection())
                    .await
                    .unwrap();
                control.commit().await.unwrap();
                let mut dangling = f.repository.begin_write().await.unwrap();
                sqlx::query("INSERT INTO d_test_commit_child VALUES('dangling-control','missing-owned-parent')").execute(dangling.connection()).await.unwrap();
                assert!(
                    dangling.commit().await.is_err(),
                    "deferred INSERT succeeds; only actual COMMIT fails"
                );
                let mut tx = f.repository.begin_write().await.unwrap();
                let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM d_test_commit_child")
                    .fetch_one(tx.connection())
                    .await
                    .unwrap();
                assert_eq!(count, 0);
                sqlx::raw_sql(&format!("CREATE TRIGGER d_test_commit_fault AFTER INSERT ON dataset_exports WHEN NEW.export_id='{}' BEGIN INSERT INTO d_test_commit_child(export_id,parent_id) VALUES(NEW.export_id,'missing-owned-parent'); END;",lease.job_id))
                    .execute(tx.connection()).await.unwrap();
                tx.commit().await.unwrap();
            }
            let outcome = f.publish(&lease, f.archive(), &LossReport::default()).await;
            assert!(matches!(outcome, Err(QueueError::Storage(_))));
            if fault == 2 {
                let archive = f.archive();
                let hash = format!("{:x}", Sha256::digest(&archive));
                let size = archive.len() as u64;
                let prepared = PreparedExport {
                    hash: hash.clone(),
                    size,
                    loss_json: serde_json::to_string(&LossReport::default()).unwrap(),
                    result: prepare_export_result(
                        &lease,
                        &f.payload,
                        &hash,
                        size,
                        &LossReport::default(),
                    )
                    .unwrap(),
                };
                let mut probe = f.repository.begin_write().await.unwrap();
                publish_export_on(probe.connection(), &lease, &f.payload, &prepared)
                    .await
                    .unwrap();
                let inside: (i64,String,i64) = sqlx::query_as("SELECT (SELECT COUNT(*) FROM dataset_exports WHERE export_id=jobs.job_id),state,(SELECT COUNT(*) FROM d_test_commit_child WHERE export_id=jobs.job_id) FROM jobs WHERE job_id=?")
                    .bind(&lease.job_id).fetch_one(probe.connection()).await.unwrap();
                assert_eq!(
                    inside,
                    (1, "succeeded".into(), 1),
                    "both actual publication SQL operations succeed before deferred failure"
                );
                assert!(probe.commit().await.is_err());
            }
            let durable = f.durable(&lease).await;
            assert_eq!(durable.0, 0);
            assert_eq!(durable.1, "running");
            assert_eq!(durable.2, None);
            let mut later = f.repository.begin_write().await.unwrap();
            if fault == 2 {
                let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM d_test_commit_child")
                    .fetch_one(later.connection())
                    .await
                    .unwrap();
                assert_eq!(count, 0);
            }
            sqlx::query(
                "UPDATE projects SET description='later writer committed' WHERE project_id=?",
            )
            .bind(&f.payload.project_id)
            .execute(later.connection())
            .await
            .unwrap();
            later.commit().await.unwrap();
            let mut observer = f.repository.begin_write().await.unwrap();
            let description: String =
                sqlx::query_scalar("SELECT description FROM projects WHERE project_id=?")
                    .bind(&f.payload.project_id)
                    .fetch_one(observer.connection())
                    .await
                    .unwrap();
            assert_eq!(description, "later writer committed");
            observer.rollback().await.unwrap();
        }
    }
    #[tokio::test]
    async fn real_publication_rechecks_fresh_lease_after_held_begin() {
        let f = fixture().await;
        let lease = f.lease(2).await;
        let bytes = f.archive();
        let stored = f
            .repository
            .object_store()
            .stage_bytes("prepared.zip", &bytes)
            .unwrap()
            .publish()
            .unwrap();
        let prepared = PreparedExport {
            hash: stored.sha256.clone(),
            size: stored.size_bytes,
            loss_json: "{\"losses\":[]}".into(),
            result: prepare_export_result(
                &lease,
                &f.payload,
                &stored.sha256,
                stored.size_bytes,
                &LossReport::default(),
            )
            .unwrap(),
        };
        let before = f.durable(&lease).await;
        let lock = f.repository.begin_write().await.unwrap();
        let operation = publish_prepared(&f.repository, &lease, &f.payload, &prepared);
        tokio::pin!(operation);
        std::future::poll_fn(|cx| match operation.as_mut().poll(cx) {
            Poll::Pending => Poll::Ready(()),
            Poll::Ready(value) => panic!("publication escaped held BEGIN: {value:?}"),
        })
        .await;
        let deadline = chrono::DateTime::parse_from_rfc3339(&lease.lease_until).unwrap();
        tokio::time::timeout(Duration::from_secs(4), async {
            while chrono::Utc::now() <= deadline {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        lock.rollback().await.unwrap();
        assert!(matches!(operation.await, Err(QueueError::InvalidRequest)));
        assert_eq!(f.durable(&lease).await, before);
    }

    #[tokio::test]
    async fn bounded_export_object_read_checks_exact_actual_bytes_and_hash() {
        let directory = tempfile::tempdir().unwrap();
        let store = crate::storage::ObjectStore::new(directory.path().join("objects")).unwrap();
        let object = store
            .stage_bytes("media", b"abc")
            .unwrap()
            .publish()
            .unwrap();
        assert_eq!(
            read_object_with_limit(&store, &object.sha256, 3).unwrap(),
            b"abc"
        );
        assert_eq!(
            read_object_with_limit(&store, &object.sha256, 2),
            Err("EXPORT_SIZE_LIMIT")
        );
        std::fs::write(&object.path, b"abd").unwrap();
        assert_eq!(
            read_object_with_limit(&store, &object.sha256, 3),
            Err("MEDIA_OBJECT_INVALID")
        );
        std::fs::write(&object.path, b"abcd").unwrap();
        assert_eq!(
            read_object_with_limit(&store, &object.sha256, 3),
            Err("EXPORT_SIZE_LIMIT")
        );
        std::fs::remove_file(object.path).unwrap();
        assert_eq!(
            read_object_with_limit(&store, &object.sha256, 3),
            Err("MEDIA_OBJECT_MISSING")
        );
    }
    fn export_principal(f: &Fixture) -> Principal {
        Principal {
            user_id: f.payload.actor_id.clone(),
            username: "export-test".into(),
            platform_admin: false,
        }
    }
    fn export_request(operation: &str) -> ExportRequest {
        ExportRequest {
            operation_id: operation.into(),
            format: "native".into(),
            loss_ack: true,
        }
    }
    async fn export_response_json(response: axum::response::Response) -> Value {
        serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap(),
        )
        .unwrap()
    }
    #[tokio::test]
    async fn export_intent_short_capture_membership_snapshot_and_concurrent_replay() {
        for mutation in 0..3 {
            let f = fixture().await;
            let operation = Uuid::new_v4().to_string();
            let (entered, observed) = tokio::sync::oneshot::channel();
            let (release, wait) = tokio::sync::oneshot::channel();
            let gate = ExportPrepareGate {
                entered,
                release: wait,
            };
            let state = DatasetState {
                repository: f.repository.clone(),
            };
            let dataset = f.payload.dataset_version_id.clone();
            let principal = export_principal(&f);
            let request = export_request(&operation);
            let worker = tokio::spawn(create_phases(
                state,
                dataset,
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
                    .bind(&f.payload.project_id)
                    .bind(&f.payload.actor_id)
                    .execute(tx.connection())
                    .await
                    .unwrap();
            } else if mutation == 1 {
                let id = Uuid::new_v4().to_string();
                sqlx::query("INSERT INTO annotation_revisions(annotation_revision_id,project_id,asset_revision_id,ontology_version_id,parent_revision_id,revision_no,body_json,content_hash,created_by,created_at) SELECT ?,project_id,asset_revision_id,ontology_version_id,annotation_revision_id,2,body_json,content_hash,created_by,created_at FROM annotation_revisions WHERE annotation_revision_id=?")
                    .bind(&id).bind(&*f.manifest.items[0].revision.annotation_revision_id).execute(tx.connection()).await.unwrap();
                sqlx::query("UPDATE annotation_heads SET annotation_revision_id=? WHERE asset_revision_id=?").bind(id).bind(&*f.manifest.items[0].media_revision.asset_revision_id).execute(tx.connection()).await.unwrap();
            } else {
                sqlx::query("UPDATE projects SET description='writer during export prep' WHERE project_id=?").bind(&f.payload.project_id).execute(tx.connection()).await.unwrap();
            }
            tx.commit().await.unwrap();
            let winner = if mutation == 2 {
                let response = create(
                    State(DatasetState {
                        repository: f.repository.clone(),
                    }),
                    Path(f.payload.dataset_version_id.clone()),
                    Extension(export_principal(&f)),
                    Json(export_request(&operation)),
                )
                .await;
                assert_eq!(response.status(), StatusCode::ACCEPTED);
                Some(export_response_json(response).await)
            } else {
                None
            };
            release.send(()).unwrap();
            let response = worker.await.unwrap();
            if mutation == 0 {
                assert_eq!(response.status(), StatusCode::NOT_FOUND);
            } else {
                assert_eq!(
                    response.status(),
                    if mutation == 2 {
                        StatusCode::OK
                    } else {
                        StatusCode::ACCEPTED
                    }
                );
                let body = export_response_json(response).await;
                if let Some(winner) = winner {
                    assert_eq!(body, winner);
                }
                let mut tx = f.repository.begin_write().await.unwrap();
                let payload: String =
                    sqlx::query_scalar("SELECT payload_json FROM jobs WHERE job_id=?")
                        .bind(body["job_id"].as_str().unwrap())
                        .fetch_one(tx.connection())
                        .await
                        .unwrap();
                let payload: Value = serde_json::from_str(&payload).unwrap();
                assert_eq!(payload["dataset_version_id"], f.payload.dataset_version_id);
                assert_eq!(payload["manifest_sha256"], f.payload.manifest_sha256);
                tx.rollback().await.unwrap();
                if mutation == 2 {
                    let mut conflict = export_request(&operation);
                    conflict.loss_ack = false;
                    let response = create(
                        State(DatasetState {
                            repository: f.repository.clone(),
                        }),
                        Path(f.payload.dataset_version_id.clone()),
                        Extension(export_principal(&f)),
                        Json(conflict),
                    )
                    .await;
                    assert_eq!(response.status(), StatusCode::CONFLICT);
                }
            }
            let mut tx = f.repository.begin_write().await.unwrap();
            let counts: (i64, i64) = sqlx::query_as(
                "SELECT (SELECT COUNT(*) FROM jobs),(SELECT COUNT(*) FROM job_idempotency)",
            )
            .fetch_one(tx.connection())
            .await
            .unwrap();
            assert_eq!(counts, if mutation == 0 { (0, 0) } else { (1, 1) });
            tx.rollback().await.unwrap();
        }
    }

    #[tokio::test]
    async fn export_capture_database_error_is_not_concealed_as_not_found() {
        let f = fixture().await;
        let mut tx = f.repository.begin_write().await.unwrap();
        sqlx::query("ALTER TABLE memberships RENAME TO owned_memberships")
            .execute(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let response = create(
            State(DatasetState {
                repository: f.repository.clone(),
            }),
            Path(f.payload.dataset_version_id.clone()),
            Extension(export_principal(&f)),
            Json(export_request(&Uuid::new_v4().to_string())),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let mut tx = f.repository.begin_write().await.unwrap();
        sqlx::query("ALTER TABLE owned_memberships RENAME TO memberships")
            .execute(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    #[tokio::test]
    async fn matching_existing_export_never_bypasses_the_live_terminal_guard() {
        let f = fixture().await;
        let lease = f.lease(30).await;
        let archive = f.archive();
        let hash = format!("{:x}", Sha256::digest(&archive));
        let size = archive.len() as u64;
        f.publish(&lease, archive, &LossReport::default())
            .await
            .unwrap();
        let before = f.durable(&lease).await;
        let prepared = PreparedExport {
            hash: hash.clone(),
            size,
            loss_json: serde_json::to_string(&LossReport::default()).unwrap(),
            result: prepare_export_result(&lease, &f.payload, &hash, size, &LossReport::default())
                .unwrap(),
        };
        assert!(matches!(
            publish_prepared(&f.repository, &lease, &f.payload, &prepared).await,
            Err(QueueError::InvalidRequest)
        ));
        assert_eq!(f.durable(&lease).await, before);
    }

    #[tokio::test]
    async fn actual_business_publication_rejects_wrong_job_kind_or_project() {
        for wrong_kind in [false, true] {
            let f = fixture().await;
            let lease = f.lease(30).await;
            let mut tx = f.repository.begin_write().await.unwrap();
            if wrong_kind {
                sqlx::query("UPDATE jobs SET kind='media_ingest' WHERE job_id=?")
                    .bind(&lease.job_id)
                    .execute(tx.connection())
                    .await
                    .unwrap();
            } else {
                sqlx::query("UPDATE jobs SET project_id=NULL WHERE job_id=?")
                    .bind(&lease.job_id)
                    .execute(tx.connection())
                    .await
                    .unwrap();
            }
            tx.commit().await.unwrap();
            let before = f.durable(&lease).await;
            assert!(matches!(
                f.publish(&lease, f.archive(), &LossReport::default()).await,
                Err(QueueError::InvalidRequest)
            ));
            let after = f.durable(&lease).await;
            assert_eq!(after.0, 0);
            assert_eq!(after.1, before.1);
            assert_eq!(after.2, None);
            assert_eq!(after.3, before.3);
            assert_eq!(after.4, before.4);
        }
    }
}
