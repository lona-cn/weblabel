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

#[cfg(test)]
tokio::task_local! {
    pub(crate) static TEST_LEASE_CLOCK: std::sync::Arc<std::sync::Mutex<chrono::DateTime<chrono::Utc>>>;
}

#[inline]
pub(crate) fn lease_now() -> chrono::DateTime<chrono::Utc> {
    #[cfg(test)]
    if let Ok(now) = TEST_LEASE_CLOCK.try_with(|clock| *clock.lock().unwrap()) {
        return now;
    }
    chrono::Utc::now()
}

pub(crate) struct PreparedJobResult {
    json: String,
}

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

    pub(crate) fn prepare_enqueue_payload(
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

    pub(crate) async fn enqueue_prepared_on(
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
        match Self::lease_next_on(tx.connection(), worker_id, lease_for, kind).await {
            Ok(value) => {
                tx.commit().await?;
                Ok(value)
            }
            Err(error) => {
                tx.rollback().await?;
                Err(error)
            }
        }
    }

    async fn lease_next_on(
        connection: &mut SqliteConnection,
        worker_id: &str,
        lease_for: Duration,
        kind: Option<&str>,
    ) -> Result<Option<LeasedJob>, QueueError> {
        let now = lease_now();
        let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let lease_until = (now
            + chrono::Duration::from_std(lease_for).map_err(|_| QueueError::InvalidRequest)?)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let row = sqlx::query("SELECT job_id, kind, payload_json, attempt, fencing_token FROM jobs WHERE (? IS NULL OR kind=?) AND (state='queued' OR (state='running' AND lease_until<=?)) ORDER BY created_at, job_id LIMIT 1")
            .bind(kind).bind(kind).bind(&now_text).fetch_optional(&mut *connection).await?;
        let Some(row) = row else {
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
            .execute(&mut *connection).await?;
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
            .execute(tx.connection()).await;
        let updated = match updated {
            Ok(updated) => updated,
            Err(error) => {
                tx.rollback().await?;
                return Err(error.into());
            }
        };
        if updated.rows_affected() != 1 {
            tx.rollback().await?;
            return Err(QueueError::InvalidRequest);
        }
        tx.commit().await?;
        Ok(())
    }

    pub(crate) fn prepare_result(
        result: &impl serde::Serialize,
    ) -> Result<PreparedJobResult, QueueError> {
        let json = serde_json::to_string(result).map_err(|_| QueueError::InvalidRequest)?;
        if json.len() > MAX_JOB_RESULT_BYTES {
            return Err(QueueError::InvalidRequest);
        }
        Ok(PreparedJobResult { json })
    }

    pub(crate) async fn finish_prepared_on(
        connection: &mut SqliteConnection,
        lease: &LeasedJob,
        succeeded: bool,
        result: &PreparedJobResult,
    ) -> Result<(), QueueError> {
        let now = lease_now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        Self::finish_prepared_at_on(connection, lease, succeeded, result, &now).await
    }

    async fn finish_prepared_at_on(
        connection: &mut SqliteConnection,
        lease: &LeasedJob,
        succeeded: bool,
        result: &PreparedJobResult,
        now: &str,
    ) -> Result<(), QueueError> {
        let updated = sqlx::query("UPDATE jobs SET state=?,result_json=?,lease_until=NULL,updated_at=? WHERE job_id=? AND state='running' AND worker_id=? AND fencing_token=? AND lease_until>?")
            .bind(if succeeded { "succeeded" } else { "failed" }).bind(&result.json).bind(now)
            .bind(&lease.job_id).bind(&lease.worker_id).bind(lease.fencing_token as i64).bind(&now)
            .execute(connection).await?;
        if updated.rows_affected() != 1 {
            return Err(QueueError::InvalidRequest);
        }
        Ok(())
    }

    pub(crate) async fn renew_lease(
        &self,
        lease: &LeasedJob,
        lease_for: Duration,
    ) -> Result<(), QueueError> {
        if lease_for.is_zero() || lease_for > Duration::from_secs(MAX_JOB_LEASE_SECONDS) {
            return Err(QueueError::InvalidRequest);
        }
        let mut tx = self.repository.begin_write().await?;
        let now = lease_now();
        let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let until = (now
            + chrono::Duration::from_std(lease_for).map_err(|_| QueueError::InvalidRequest)?)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let updated = sqlx::query("UPDATE jobs SET lease_until=?,updated_at=? WHERE job_id=? AND state='running' AND worker_id=? AND fencing_token=? AND lease_until>?")
            .bind(until).bind(&now_text).bind(&lease.job_id).bind(&lease.worker_id)
            .bind(lease.fencing_token as i64).bind(&now_text).execute(tx.connection()).await;
        let updated = match updated {
            Ok(updated) => updated,
            Err(error) => {
                tx.rollback().await?;
                return Err(error.into());
            }
        };
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
        let result = Self::prepare_result(result)?;
        let mut tx = self.repository.begin_write().await?;
        if let Err(error) =
            Self::finish_prepared_on(tx.connection(), lease, succeeded, &result).await
        {
            tx.rollback().await?;
            return Err(error);
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

#[cfg(test)]
mod commercial_d_private_tests {
    use super::*;
    use serde_json::json;
    use sqlx::Connection;
    use std::{future::Future, task::Poll};

    async fn fixture() -> (tempfile::TempDir, Repository, JobQueue) {
        let root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/queue-tests");
        std::fs::create_dir_all(&root).unwrap();
        let directory = tempfile::tempdir_in(root).unwrap();
        let repository = Repository::open(
            &format!("sqlite:{}", directory.path().join("queue.sqlite").display()),
            directory.path().join("objects"),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        let queue = JobQueue::new(repository.clone());
        (directory, repository, queue)
    }

    fn exact_json_string(size: usize) -> Value {
        let prefix = "中\"\\";
        let overhead = serde_json::to_vec(&Value::String(prefix.into()))
            .unwrap()
            .len();
        let value = Value::String(format!("{prefix}{}", "x".repeat(size - overhead)));
        assert_eq!(serde_json::to_vec(&value).unwrap().len(), size);
        value
    }

    async fn row(
        repository: &Repository,
        id: &str,
    ) -> (
        String,
        Option<String>,
        i64,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
    ) {
        // Observation must not join writer admission: the controlled write
        // future can be ahead of us in FIFO order without being polled again.
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(
                repository
                    .object_store()
                    .root()
                    .parent()
                    .unwrap()
                    .join("queue.sqlite"),
            )
            .read_only(true);
        let mut connection = sqlx::SqliteConnection::connect_with(&options)
            .await
            .unwrap();
        let value = sqlx::query_as("SELECT state,result_json,progress_completed,progress_total,progress_json,lease_until,worker_id,fencing_token FROM jobs WHERE job_id=?")
            .bind(id).fetch_one(&mut connection).await.unwrap();
        connection.close().await.unwrap();
        value
    }

    #[tokio::test]
    async fn payload_exact_utf8_limit_and_rejected_enqueue_leave_no_idempotency() {
        let (directory, repository, queue) = fixture().await;
        let accepted = exact_json_string(1024 * 1024);
        let job = queue
            .enqueue(None, "dataset_export", "at-limit", &accepted)
            .await
            .unwrap();
        let replay = queue
            .enqueue(None, "dataset_export", "at-limit", &accepted)
            .await
            .unwrap();
        assert_eq!(replay.job_id, job.job_id);
        assert!(replay.duplicate);
        assert!(matches!(
            queue
                .enqueue(
                    None,
                    "dataset_export",
                    "over-limit",
                    &exact_json_string(1024 * 1024 + 1)
                )
                .await,
            Err(QueueError::InvalidRequest)
        ));
        let mut tx = repository.begin_write().await.unwrap();
        let counts: (i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM jobs),(SELECT COUNT(*) FROM job_idempotency)",
        )
        .fetch_one(tx.connection())
        .await
        .unwrap();
        assert_eq!(counts, (1, 1));
        tx.rollback().await.unwrap();
        let lease = queue
            .lease_next("worker", Duration::from_secs(30))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(lease.payload, accepted);
        repository.close_for_test().await;
        directory.close().unwrap();
    }

    #[tokio::test]
    async fn progress_and_result_exact_limits_preserve_durable_state_on_overflow() {
        let (directory, repository, queue) = fixture().await;
        queue
            .enqueue(None, "dataset_export", "progress", &json!({}))
            .await
            .unwrap();
        let lease = queue
            .lease_next("worker", Duration::from_secs(30))
            .await
            .unwrap()
            .unwrap();
        let exact = exact_json_string(256 * 1024);
        queue.report_progress(&lease, 1, 2, &exact).await.unwrap();
        let before = row(&repository, &lease.job_id).await;
        assert_eq!(before.2, 1);
        assert_eq!(before.3, 2);
        assert_eq!(
            serde_json::from_str::<Value>(before.4.as_ref().unwrap()).unwrap(),
            exact
        );
        let over = exact_json_string(256 * 1024 + 1);
        assert!(matches!(
            queue.report_progress(&lease, 2, 2, &over).await,
            Err(QueueError::InvalidRequest)
        ));
        assert_eq!(row(&repository, &lease.job_id).await, before);
        queue
            .finish(&lease, true, &json!({"progress_finished":true}))
            .await
            .unwrap();
        queue
            .enqueue(None, "dataset_export", "result", &json!({}))
            .await
            .unwrap();
        let lease = queue
            .lease_next("worker", Duration::from_secs(30))
            .await
            .unwrap()
            .unwrap();
        let before = row(&repository, &lease.job_id).await;
        assert!(matches!(
            queue.finish(&lease, true, &over).await,
            Err(QueueError::InvalidRequest)
        ));
        assert_eq!(row(&repository, &lease.job_id).await, before);
        queue.finish(&lease, true, &exact).await.unwrap();
        let after = row(&repository, &lease.job_id).await;
        assert_eq!(after.0, "succeeded");
        assert_eq!(
            serde_json::from_str::<Value>(after.1.as_ref().unwrap()).unwrap(),
            exact
        );
        assert_eq!(after.5, None);
        repository.close_for_test().await;
        directory.close().unwrap();
    }

    #[tokio::test]
    async fn expired_and_reclaimed_workers_cannot_mutate_job() {
        let (directory, repository, queue) = fixture().await;
        queue
            .enqueue(None, "dataset_export", "fencing", &json!({}))
            .await
            .unwrap();
        let a = queue
            .lease_next("a", Duration::from_secs(30))
            .await
            .unwrap()
            .unwrap();
        let mut tx = repository.begin_write().await.unwrap();
        sqlx::query("UPDATE jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE job_id=?")
            .bind(&a.job_id)
            .execute(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let expired = row(&repository, &a.job_id).await;
        assert!(matches!(
            queue.report_progress(&a, 1, 1, &json!({})).await,
            Err(QueueError::InvalidRequest)
        ));
        assert!(matches!(
            queue.finish(&a, true, &json!({})).await,
            Err(QueueError::InvalidRequest)
        ));
        assert!(matches!(
            queue.finish(&a, false, &json!({})).await,
            Err(QueueError::InvalidRequest)
        ));
        assert_eq!(row(&repository, &a.job_id).await, expired);
        let b = queue
            .lease_next("b", Duration::from_secs(30))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(b.job_id, a.job_id);
        assert_eq!(b.fencing_token, a.fencing_token + 1);
        assert_eq!(b.attempt, a.attempt + 1);
        let reclaimed = row(&repository, &a.job_id).await;
        assert!(matches!(
            queue.report_progress(&a, 1, 1, &json!({})).await,
            Err(QueueError::InvalidRequest)
        ));
        for succeeded in [false, true] {
            assert!(matches!(
                queue.finish(&a, succeeded, &json!({})).await,
                Err(QueueError::InvalidRequest)
            ));
        }
        assert_eq!(row(&repository, &a.job_id).await, reclaimed);
        queue
            .finish(&b, true, &json!({"winner":"b"}))
            .await
            .unwrap();
        let after = row(&repository, &a.job_id).await;
        assert_eq!(after.0, "succeeded");
        assert_eq!(after.1.unwrap(), r#"{"winner":"b"}"#);
        assert_eq!(after.6.as_deref(), Some("b"));
        assert_eq!(after.7, b.fencing_token as i64);
        repository.close_for_test().await;
        directory.close().unwrap();
    }

    async fn lock_wait_does_not_revive(finish: bool) {
        let (directory, repository, queue) = fixture().await;
        queue
            .enqueue(None, "dataset_export", "lock-wait", &json!({}))
            .await
            .unwrap();
        let lease = queue
            .lease_next("worker", Duration::from_secs(2))
            .await
            .unwrap()
            .unwrap();
        let before = row(&repository, &lease.job_id).await;
        let lock = repository.begin_write().await.unwrap();
        let result = json!({"done":true});
        let operation = async {
            if finish {
                queue.finish(&lease, true, &result).await
            } else {
                queue.report_progress(&lease, 1, 1, &result).await
            }
        };
        tokio::pin!(operation);
        let deadline = chrono::DateTime::parse_from_rfc3339(&lease.lease_until).unwrap();
        assert!(
            chrono::Utc::now() < deadline,
            "lock contention starts with a live lease"
        );
        // Poll the actual wrapper through its pre-BEGIN clock read while our
        // owned writer holds BEGIN. There is no scheduler race or guessed sleep.
        std::future::poll_fn(|cx| match operation.as_mut().poll(cx) {
            Poll::Pending => Poll::Ready(()),
            Poll::Ready(value) => panic!("operation escaped the held write lock: {value:?}"),
        })
        .await;
        tokio::time::timeout(Duration::from_secs(4), async {
            while chrono::Utc::now() <= deadline {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        lock.rollback().await.unwrap();
        let outcome = operation.await;
        let after = row(&repository, &lease.job_id).await;
        assert_eq!(
            after, before,
            "expired lock waiter must not renew or finish"
        );
        assert!(matches!(outcome, Err(QueueError::InvalidRequest)));
        repository.close_for_test().await;
        directory.close().unwrap();
    }

    #[tokio::test]
    async fn progress_uses_clock_after_waiting_for_begin() {
        lock_wait_does_not_revive(false).await;
    }

    #[tokio::test]
    async fn finish_uses_clock_after_waiting_for_begin() {
        lock_wait_does_not_revive(true).await;
    }
    #[tokio::test]
    async fn prepared_finish_equality_is_expired_and_caller_rollback_restores_state() {
        let (directory, repository, queue) = fixture().await;
        queue
            .enqueue(None, "dataset_export", "prepared-equality", &json!({}))
            .await
            .unwrap();
        let lease = queue
            .lease_next("worker", Duration::from_secs(30))
            .await
            .unwrap()
            .unwrap();
        let prepared = JobQueue::prepare_result(&json!({"done":true})).unwrap();
        let before = row(&repository, &lease.job_id).await;
        let mut tx = repository.begin_write().await.unwrap();
        let exact = "2099-01-01T00:00:00.000Z";
        sqlx::query("UPDATE jobs SET lease_until=? WHERE job_id=?")
            .bind(exact)
            .bind(&lease.job_id)
            .execute(tx.connection())
            .await
            .unwrap();
        assert!(matches!(
            JobQueue::finish_prepared_at_on(tx.connection(), &lease, true, &prepared, exact).await,
            Err(QueueError::InvalidRequest)
        ));
        let state: String = sqlx::query_scalar("SELECT state FROM jobs WHERE job_id=?")
            .bind(&lease.job_id)
            .fetch_one(tx.connection())
            .await
            .unwrap();
        assert_eq!(state, "running");
        JobQueue::finish_prepared_at_on(
            tx.connection(),
            &lease,
            true,
            &prepared,
            "2098-12-31T23:59:59.999Z",
        )
        .await
        .unwrap();
        tx.rollback().await.unwrap();
        assert_eq!(row(&repository, &lease.job_id).await, before);
        repository.close_for_test().await;
        directory.close().unwrap();
    }

    #[tokio::test]
    async fn all_queue_writes_recheck_fresh_clock_after_begin_with_and_without_reclaim() {
        for mode in 0..3 {
            for reclaim in [false, true] {
                let (directory, repository, queue) = fixture().await;
                queue
                    .enqueue(None, "dataset_export", "fresh-reclaim", &json!({}))
                    .await
                    .unwrap();
                let a = queue
                    .lease_next("a", Duration::from_secs(2))
                    .await
                    .unwrap()
                    .unwrap();
                let mut lock = repository.begin_write().await.unwrap();
                let result = json!({"done":true});
                let operation = async {
                    match mode {
                        0 => queue.report_progress(&a, 1, 1, &result).await,
                        1 => queue.renew_lease(&a, Duration::from_secs(30)).await,
                        _ => queue.finish(&a, true, &result).await,
                    }
                };
                tokio::pin!(operation);
                std::future::poll_fn(|cx| match operation.as_mut().poll(cx) {
                    Poll::Pending => Poll::Ready(()),
                    Poll::Ready(value) => panic!("escaped BEGIN: {value:?}"),
                })
                .await;
                let deadline = chrono::DateTime::parse_from_rfc3339(&a.lease_until).unwrap();
                tokio::time::timeout(Duration::from_secs(4), async {
                    while chrono::Utc::now() <= deadline {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .unwrap();
                if reclaim {
                    let b = JobQueue::lease_next_on(
                        lock.connection(),
                        "b",
                        Duration::from_secs(30),
                        Some("dataset_export"),
                    )
                    .await
                    .unwrap()
                    .unwrap();
                    assert_eq!(b.job_id, a.job_id);
                    assert_eq!(b.fencing_token, a.fencing_token + 1);
                }
                lock.commit().await.unwrap();
                let before = row(&repository, &a.job_id).await;
                assert!(matches!(operation.await, Err(QueueError::InvalidRequest)));
                assert_eq!(row(&repository, &a.job_id).await, before);
                let mut tx = repository.begin_write().await.unwrap();
                sqlx::query(
                    "UPDATE jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE job_id=?",
                )
                .bind(&a.job_id)
                .execute(tx.connection())
                .await
                .unwrap();
                tx.commit().await.unwrap();
                let b = queue
                    .lease_next("real-b", Duration::from_secs(30))
                    .await
                    .unwrap()
                    .unwrap();
                assert!(b.fencing_token > a.fencing_token);
                queue
                    .finish(&b, true, &json!({"winner":"real-b"}))
                    .await
                    .unwrap();
                assert_eq!(row(&repository, &b.job_id).await.0, "succeeded");
                repository.close_for_test().await;
                directory.close().unwrap();
            }
        }
    }
}
