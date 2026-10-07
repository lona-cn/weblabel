use std::time::Duration;

use crate::storage::Repository;
use serde_json::Value;
use sqlx::{Row, SqliteConnection};
use thiserror::Error;
use uuid::Uuid;

const MAX_JOB_PAYLOAD_BYTES: usize = 1024 * 1024;
const MAX_JOB_RESULT_BYTES: usize = 256 * 1024;
const MAX_JOB_LEASE_SECONDS: u64 = 300;
const MAX_PENDING_JOBS: i64 = 1000;

#[derive(Debug, Error)]
pub enum QueueError {
    #[error("job request is invalid or exceeds its budget")]
    InvalidRequest,
    #[error("job operation ID was reused with a different payload")]
    IdempotencyConflict,
    #[error("the durable queue is full")]
    QueueFull,
    #[error("job storage operation failed")]
    Storage(#[from] sqlx::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnqueuedJob {
    pub job_id: String,
    pub duplicate: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct JobStatus {
    pub job_id: String,
    pub kind: String,
    pub state: String,
    pub progress_completed: u64,
    pub progress_total: u64,
    pub progress: Option<Value>,
    pub result: Option<Value>,
}

#[derive(Clone)]
pub struct JobQueue {
    repository: Repository,
}

impl JobQueue {
    pub fn new(repository: Repository) -> Self {
        Self { repository }
    }

    pub async fn enqueue(
        &self,
        project_id: Option<&str>,
        kind: &str,
        operation_id: &str,
        payload: &Value,
    ) -> Result<EnqueuedJob, QueueError> {
        let payload_json = Self::prepare_enqueue_payload(kind, operation_id, payload)?;
        let mut tx = self.repository.begin_write().await?;
        match Self::enqueue_prepared_on(
            tx.connection(),
            project_id,
            kind,
            operation_id,
            payload_json,
        )
        .await
        {
            Ok(job) => {
                if job.duplicate {
                    tx.rollback().await?;
                } else {
                    tx.commit().await?;
                }
                Ok(job)
            }
            Err(error) => {
                tx.rollback().await?;
                Err(error)
            }
        }
    }

    /// Caller owns BEGIN/COMMIT/ROLLBACK; job and idempotency share that transaction.
    pub async fn enqueue_on(
        connection: &mut SqliteConnection,
        project_id: Option<&str>,
        kind: &str,
        operation_id: &str,
        payload: &Value,
    ) -> Result<EnqueuedJob, QueueError> {
        let payload_json = Self::prepare_enqueue_payload(kind, operation_id, payload)?;
        Self::enqueue_prepared_on(connection, project_id, kind, operation_id, payload_json).await
    }

    fn prepare_enqueue_payload(
        kind: &str,
        operation_id: &str,
        payload: &Value,
    ) -> Result<String, QueueError> {
        if kind.is_empty()
            || kind.len() > 64
            || operation_id.is_empty()
            || operation_id.chars().count() > 128
        {
            return Err(QueueError::InvalidRequest);
        }
        let payload_json =
            serde_json::to_string(payload).map_err(|_| QueueError::InvalidRequest)?;
        if payload_json.len() > MAX_JOB_PAYLOAD_BYTES {
            return Err(QueueError::InvalidRequest);
        }
        Ok(payload_json)
    }

    async fn enqueue_prepared_on(
        connection: &mut SqliteConnection,
        project_id: Option<&str>,
        kind: &str,
        operation_id: &str,
        payload_json: String,
    ) -> Result<EnqueuedJob, QueueError> {
        let scope_id = project_id.unwrap_or("");
        let request_hash = crate::media::canonical::sha256_hex(payload_json.as_bytes());
        if let Some(row) = sqlx::query("SELECT job_id, request_hash FROM job_idempotency WHERE scope_id=? AND operation_id=? AND kind=?")
            .bind(scope_id).bind(operation_id).bind(kind).fetch_optional(&mut *connection).await?
        {
            let existing_hash: &str = row.try_get("request_hash")?;
            if existing_hash != request_hash { return Err(QueueError::IdempotencyConflict); }
            let job_id: String = row.try_get("job_id")?;
            return Ok(EnqueuedJob { job_id, duplicate: true });
        }
        let pending: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE state IN ('queued','running')")
                .fetch_one(&mut *connection)
                .await?;
        if pending >= MAX_PENDING_JOBS {
            return Err(QueueError::QueueFull);
        }
        let job_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query("INSERT INTO jobs(job_id, project_id, kind, state, payload_json, result_json, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, NULL, ?, ?)")
            .bind(&job_id).bind(project_id).bind(kind).bind(payload_json).bind(&now).bind(&now)
            .execute(&mut *connection).await?;
        sqlx::query("INSERT INTO job_idempotency(scope_id, operation_id, kind, job_id, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(scope_id).bind(operation_id).bind(kind).bind(&job_id).bind(request_hash).bind(now)
            .execute(&mut *connection).await?;
        Ok(EnqueuedJob {
            job_id,
            duplicate: false,
        })
    }

    pub async fn lease_next(
        &self,
        worker_id: &str,
        lease_for: Duration,
    ) -> Result<Option<LeasedJob>, QueueError> {
        self.lease_next_kind(worker_id, lease_for, None).await
    }

    /// Claims a job of one kind, or the oldest available job when `kind` is None.
    pub async fn lease_next_kind(
        &self,
        worker_id: &str,
        lease_for: Duration,
        kind: Option<&str>,
    ) -> Result<Option<LeasedJob>, QueueError> {
        if worker_id.is_empty()
            || worker_id.chars().count() > 128
            || lease_for.is_zero()
            || lease_for > Duration::from_secs(MAX_JOB_LEASE_SECONDS)
            || kind.is_some_and(str::is_empty)
        {
            return Err(QueueError::InvalidRequest);
        }
        let mut tx = self.repository.begin_write().await?;
        let now = chrono::Utc::now();
        let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let lease_until = (now
            + chrono::Duration::from_std(lease_for).map_err(|_| QueueError::InvalidRequest)?)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let row = sqlx::query("SELECT job_id, kind, payload_json, attempt, fencing_token FROM jobs WHERE (? IS NULL OR kind=?) AND (state='queued' OR (state='running' AND lease_until<=?)) ORDER BY created_at, job_id LIMIT 1")
            .bind(kind).bind(kind).bind(&now_text).fetch_optional(tx.connection()).await?;
        let Some(row) = row else {
            tx.commit().await?;
            return Ok(None);
        };
        let job_id: String = row.try_get("job_id")?;
        let kind: String = row.try_get("kind")?;
        let payload_json: String = row.try_get("payload_json")?;
        let attempt = row
            .try_get::<i64, _>("attempt")?
            .checked_add(1)
            .ok_or(QueueError::InvalidRequest)?;
        let fencing_token = row
            .try_get::<i64, _>("fencing_token")?
            .checked_add(1)
            .ok_or(QueueError::InvalidRequest)?;
        sqlx::query("UPDATE jobs SET state='running', worker_id=?, lease_until=?, attempt=?, fencing_token=?, updated_at=? WHERE job_id=?")
            .bind(worker_id).bind(&lease_until).bind(attempt).bind(fencing_token).bind(now_text).bind(&job_id)
            .execute(tx.connection()).await?;
        tx.commit().await?;
        let payload =
            serde_json::from_str(&payload_json).map_err(|_| QueueError::InvalidRequest)?;
        Ok(Some(LeasedJob {
            job_id,
            kind,
            payload,
            worker_id: worker_id.to_owned(),
            fencing_token: fencing_token as u64,
            attempt: attempt as u64,
            lease_until,
        }))
    }

    pub async fn report_progress(
        &self,
        lease: &LeasedJob,
        completed: u64,
        total: u64,
        progress: &Value,
    ) -> Result<(), QueueError> {
        if completed > total || total > i64::MAX as u64 {
            return Err(QueueError::InvalidRequest);
        }
        let progress_json =
            serde_json::to_string(progress).map_err(|_| QueueError::InvalidRequest)?;
        if progress_json.len() > MAX_JOB_RESULT_BYTES {
            return Err(QueueError::InvalidRequest);
        }
        let mut tx = self.repository.begin_write().await?;
        let now = chrono::Utc::now();
        let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let extended_until = (now + chrono::Duration::seconds(MAX_JOB_LEASE_SECONDS as i64))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let updated = sqlx::query("UPDATE jobs SET progress_completed=MAX(progress_completed,?), progress_total=?, progress_json=CASE WHEN progress_completed<=? THEN ? ELSE progress_json END, lease_until=?, updated_at=? WHERE job_id=? AND state='running' AND worker_id=? AND fencing_token=? AND lease_until>? AND (progress_total=0 OR progress_total=?)")
            .bind(completed as i64).bind(total as i64).bind(completed as i64).bind(progress_json)
            .bind(extended_until).bind(&now_text).bind(&lease.job_id).bind(&lease.worker_id)
            .bind(lease.fencing_token as i64).bind(&now_text).bind(total as i64)
            .execute(tx.connection()).await?;
        if updated.rows_affected() != 1 {
            tx.rollback().await?;
            return Err(QueueError::InvalidRequest);
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn finish(
        &self,
        lease: &LeasedJob,
        succeeded: bool,
        result: &Value,
    ) -> Result<(), QueueError> {
        let result_json = serde_json::to_string(result).map_err(|_| QueueError::InvalidRequest)?;
        if result_json.len() > MAX_JOB_RESULT_BYTES {
            return Err(QueueError::InvalidRequest);
        }
        let state = if succeeded { "succeeded" } else { "failed" };
        let mut tx = self.repository.begin_write().await?;
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let updated = sqlx::query("UPDATE jobs SET state=?, result_json=?, lease_until=NULL, updated_at=? WHERE job_id=? AND state='running' AND worker_id=? AND fencing_token=? AND lease_until>?")
            .bind(state).bind(result_json).bind(&now).bind(&lease.job_id).bind(&lease.worker_id)
            .bind(lease.fencing_token as i64).bind(&now).execute(tx.connection()).await?;
        if updated.rows_affected() != 1 {
            tx.rollback().await?;
            return Err(QueueError::InvalidRequest);
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn status(
        &self,
        project_id: &str,
        job_id: &str,
    ) -> Result<Option<JobStatus>, QueueError> {
        let mut tx = self.repository.begin_write().await?;
        let row = sqlx::query("SELECT job_id, kind, state, progress_completed, progress_total, progress_json, result_json FROM jobs WHERE project_id=? AND job_id=?")
            .bind(project_id).bind(job_id).fetch_optional(tx.connection()).await?;
        tx.commit().await?;
        row.map(|row| {
            let progress_json: Option<String> = row.try_get("progress_json")?;
            let result_json: Option<String> = row.try_get("result_json")?;
            Ok(JobStatus {
                job_id: row.try_get("job_id")?,
                kind: row.try_get("kind")?,
                state: row.try_get("state")?,
                progress_completed: u64::try_from(row.try_get::<i64, _>("progress_completed")?)
                    .map_err(|_| QueueError::InvalidRequest)?,
                progress_total: u64::try_from(row.try_get::<i64, _>("progress_total")?)
                    .map_err(|_| QueueError::InvalidRequest)?,
                progress: progress_json
                    .map(|json| serde_json::from_str(&json))
                    .transpose()
                    .map_err(|_| QueueError::InvalidRequest)?,
                result: result_json
                    .map(|json| serde_json::from_str(&json))
                    .transpose()
                    .map_err(|_| QueueError::InvalidRequest)?,
            })
        })
        .transpose()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LeasedJob {
    pub job_id: String,
    pub kind: String,
    pub payload: Value,
    pub worker_id: String,
    pub fencing_token: u64,
    pub attempt: u64,
    pub lease_until: String,
}
