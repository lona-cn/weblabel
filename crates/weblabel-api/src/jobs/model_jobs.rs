//! Model jobs on the shared T07 queue: lease-claimed execution of model runs
//! with per-item results, so one failing asset never drops a batch's successes.

use std::{collections::BTreeMap, future::Future, pin::Pin, time::Duration};

use annotation_domain::{AnnotationObject, LabelDef, ModelProfile, RunContext};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::{json, Value};
use sqlx::Row;
use thiserror::Error;

use crate::{
    ai::{
        events::{self, RecordEvent},
        failure_response,
        predictions::{self},
        runs::{self, RunRecord, RunState},
        AiState,
    },
    auth::Principal,
    jobs::queue::{EnqueuedJob, JobQueue, LeasedJob, QueueError},
    media::ingest,
    projects::now_rfc3339,
    storage::Repository,
};

pub use crate::ai::events::ProviderEvent;
pub use crate::ai::predictions::SubmitCandidates;

const MODEL_JOB_KIND: &str = "model_run";
pub const MAX_RUN_JOB_ITEMS: usize = 100;
const MAX_JOB_RESULT_BYTES: usize = 256 * 1024;
const DRAIN_MAX_JOBS: usize = 32;

#[derive(Debug, Error)]
pub enum ModelJobError {
    #[error("job queue operation failed")]
    Queue(#[from] QueueError),
    #[error("storage failed")]
    Storage(#[from] sqlx::Error),
    #[error("{code}: {message}")]
    Rejected { code: String, message: String },
    #[error("run state machine rejected a transition")]
    Run(#[from] runs::RunError),
    #[error("model job payload is invalid")]
    InvalidPayload,
}

/// Error surfaced by a provider runner; its code is recorded on the run's
/// failure event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerError {
    pub code: String,
    pub message: String,
}

impl RunnerError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
        }
    }
}

impl From<ModelJobError> for RunnerError {
    fn from(value: ModelJobError) -> Self {
        match value {
            ModelJobError::Rejected { code, message } => Self { code, message },
            other => Self::new("MODEL_JOB_ERROR", &other.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    Completed,
    Failed { code: String, message: String },
}

/// Provider execution boundary. T16/T25 plug the real runtimes here; the only
/// built-in source is explicitly labeled mock.
pub trait RunRunner: Send + Sync {
    fn execute<'a>(
        &'a self,
        driver: &'a RunDriver,
    ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, RunnerError>> + Send + 'a>>;
}

/// Everything a runner may touch while executing one run. All writes go through
/// the normalized event/prediction funnels.
pub struct RunDriver {
    repository: Repository,
    record: RunRecord,
    context: RunContext,
    profile: ModelProfile,
    width: u32,
    height: u32,
    labels: Vec<LabelDef>,
    objects: BTreeMap<String, AnnotationObject>,
}

impl RunDriver {
    pub fn run_id(&self) -> &str {
        &self.record.run_id
    }

    pub fn context(&self) -> &RunContext {
        &self.context
    }

    pub fn profile(&self) -> &ModelProfile {
        &self.profile
    }

    pub fn media_size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn labels(&self) -> &[LabelDef] {
        &self.labels
    }

    /// Records a provider event with normalized sequence numbering.
    pub async fn emit(&self, event: ProviderEvent) -> Result<(), ModelJobError> {
        let mut tx = self.repository.begin_write().await?;
        let provider_event_id = if event.provider_event_id.is_empty() {
            None
        } else {
            Some(event.provider_event_id.as_str())
        };
        events::record(
            tx.connection(),
            &self.record.run_id,
            RecordEvent {
                provider_event_id,
                provider_seq: event.provider_seq,
                event_type: event.event_type,
                message: &event.message,
                data: event.data,
            },
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Delivers one raw provider candidate batch. Late output after a terminal
    /// run is quarantined and never applied.
    pub async fn submit_candidates(&self, submit: SubmitCandidates) -> Result<(), ModelJobError> {
        let mut tx = self.repository.begin_write().await?;
        let target = predictions::CandidateTarget {
            width: self.width,
            height: self.height,
            labels: &self.labels,
            objects: &self.objects,
        };
        let outcome = predictions::record_candidate(
            tx.connection(),
            &self.record,
            &self.profile,
            &target,
            &submit,
        )
        .await?;
        tx.commit().await?;
        match outcome {
            predictions::CandidateOutcome::Rejected { code, message } => {
                Err(ModelJobError::Rejected {
                    code: code.to_owned(),
                    message,
                })
            }
            _ => Ok(()),
        }
    }
}

/// Enqueues the shared-queue job that executes the given runs.
pub async fn enqueue_run_job(
    queue: &JobQueue,
    project_id: &str,
    operation_id: &str,
    run_ids: &[String],
) -> Result<EnqueuedJob, QueueError> {
    if run_ids.is_empty() || run_ids.len() > MAX_RUN_JOB_ITEMS {
        return Err(QueueError::InvalidRequest);
    }
    queue
        .enqueue(
            Some(project_id),
            MODEL_JOB_KIND,
            operation_id,
            &json!({"run_ids": run_ids}),
        )
        .await
}

/// Claims and executes the next queued job of the shared queue. Media jobs and
/// model jobs use the same lease-based claim path.
pub async fn process_next(
    repository: &Repository,
    queue: &JobQueue,
    worker_id: &str,
    lease_for: Duration,
    runner: &dyn RunRunner,
) -> Result<Option<String>, ModelJobError> {
    let Some(lease) = queue.lease_next(worker_id, lease_for).await? else {
        return Ok(None);
    };
    let job_id = lease.job_id.clone();
    match lease.kind.as_str() {
        "media_import" => {
            ingest::process_import_job(repository, &media_worker(), queue, &lease).await?;
        }
        MODEL_JOB_KIND => {
            execute_model_run(repository, queue, &lease, runner).await?;
        }
        _ => {
            queue
                .finish(&lease, false, &json!({"code": "UNSUPPORTED_JOB_KIND"}))
                .await?;
        }
    }
    Ok(Some(job_id))
}

fn media_worker() -> crate::jobs::worker::MediaWorker {
    crate::jobs::worker::MediaWorker::new()
}

struct ItemResult {
    run_id: String,
    state: &'static str,
    code: Option<&'static str>,
}

async fn execute_model_run(
    repository: &Repository,
    queue: &JobQueue,
    lease: &LeasedJob,
    runner: &dyn RunRunner,
) -> Result<(), ModelJobError> {
    let run_ids = lease
        .payload
        .get("run_ids")
        .and_then(Value::as_array)
        .ok_or(ModelJobError::InvalidPayload)?;
    if run_ids.is_empty() || run_ids.len() > MAX_RUN_JOB_ITEMS {
        return Err(ModelJobError::InvalidPayload);
    }
    let total = run_ids.len() as u64;
    let mut results = Vec::with_capacity(run_ids.len());
    let mut completed = 0_u64;
    for run_id in run_ids {
        let run_id = run_id
            .as_str()
            .filter(|value| !value.is_empty() && value.chars().count() <= 128)
            .ok_or(ModelJobError::InvalidPayload)?;
        results.push(execute_run_item(repository, lease, runner, run_id).await?);
        completed += 1;
        queue_progress(queue, lease, completed, total, &results).await?;
    }

    let succeeded = results
        .iter()
        .filter(|item| item.state == "succeeded")
        .count() as u64;
    let cancelled = results
        .iter()
        .filter(|item| item.state == "cancelled")
        .count() as u64;
    let interrupted = results
        .iter()
        .filter(|item| item.state == "interrupted")
        .count() as u64;
    let job_state = if succeeded == total {
        "succeeded"
    } else if cancelled == total {
        "cancelled"
    } else if interrupted == total {
        "interrupted"
    } else {
        "failed"
    };
    let items: Vec<Value> = results
        .iter()
        .map(|item| {
            let mut entry = json!({"run_id": item.run_id, "state": item.state});
            if let Some(code) = item.code {
                entry["code"] = json!(code);
            }
            entry
        })
        .collect();
    let result = json!({
        "items": items,
        "succeeded": succeeded,
        "failed": total - succeeded,
    });
    finish_job(repository, lease, job_state, &result).await
}

async fn queue_progress(
    queue: &JobQueue,
    lease: &LeasedJob,
    completed: u64,
    total: u64,
    results: &[ItemResult],
) -> Result<(), ModelJobError> {
    let succeeded = results
        .iter()
        .filter(|item| item.state == "succeeded")
        .count() as u64;
    queue
        .report_progress(
            lease,
            completed,
            total,
            &json!({
                "succeeded": succeeded,
                "failed": completed - succeeded,
            }),
        )
        .await?;
    Ok(())
}

async fn execute_run_item(
    repository: &Repository,
    lease: &LeasedJob,
    runner: &dyn RunRunner,
    run_id: &str,
) -> Result<ItemResult, ModelJobError> {
    let mut tx = repository.begin_write().await?;
    let record = runs::load_record(tx.connection(), run_id).await?;
    tx.commit().await?;
    let Some(record) = record else {
        return Ok(ItemResult {
            run_id: run_id.to_owned(),
            state: "failed",
            code: Some("RUN_NOT_FOUND"),
        });
    };
    if record.state.is_terminal() {
        return Ok(ItemResult {
            run_id: run_id.to_owned(),
            state: record.state.as_str(),
            code: Some("ALREADY_TERMINAL"),
        });
    }
    // A model job is single-attempt: if its lease expired mid-flight the call
    // may already be billed, so it is never resent automatically.
    if lease.attempt > 1 && record.state == RunState::Running {
        mark_interrupted(repository, &record, "LEASE_EXPIRED_NO_RESEND").await?;
        return Ok(ItemResult {
            run_id: run_id.to_owned(),
            state: "interrupted",
            code: Some("LEASE_EXPIRED_NO_RESEND"),
        });
    }

    let now = now_rfc3339();
    if record.state == RunState::Queued {
        let applied = transition_run(
            repository,
            &record,
            RunState::Running,
            &now,
            Some("unknown"),
        )
        .await?;
        if !applied {
            // Cancel (or another terminal transition) won the race: never invoke
            // the provider for a run that is already terminal.
            let mut tx = repository.begin_write().await?;
            let current: Option<String> =
                sqlx::query_scalar("SELECT state FROM model_runs WHERE run_id=?")
                    .bind(run_id)
                    .fetch_optional(tx.connection())
                    .await?;
            tx.commit().await?;
            let state = current
                .as_deref()
                .and_then(RunState::parse)
                .map(RunState::as_str)
                .unwrap_or("failed");
            return Ok(ItemResult {
                run_id: run_id.to_owned(),
                state,
                code: Some("ALREADY_TERMINAL"),
            });
        }
    }
    {
        let mut tx = repository.begin_write().await?;
        events::record(
            tx.connection(),
            run_id,
            RecordEvent {
                provider_event_id: None,
                provider_seq: None,
                event_type: events::RunEventType::Started,
                message: "model run started",
                data: Some(json!({"source": record.source})),
            },
        )
        .await?;
        tx.commit().await?;
    }

    let driver = build_driver(repository, record.clone()).await?;
    let outcome = runner.execute(&driver).await;

    let mut tx = repository.begin_write().await?;
    let current = runs::load_record(tx.connection(), run_id)
        .await?
        .ok_or(ModelJobError::InvalidPayload)?;
    if current.state.is_terminal() {
        // The run was cancelled (or interrupted) while the provider was still
        // working: a late completion never revives a terminal run.
        tx.commit().await?;
        return Ok(ItemResult {
            run_id: run_id.to_owned(),
            state: current.state.as_str(),
            code: Some("TERMINAL_LATE_OUTCOME"),
        });
    }
    let now = now_rfc3339();
    match outcome {
        Ok(RunOutcome::Completed) => {
            runs::transition(RunState::Running, RunState::Succeeded)?;
            sqlx::query(
                "UPDATE model_runs SET state='succeeded', finished_at=? WHERE run_id=? AND state='running'",
            )
            .bind(&now)
            .bind(run_id)
            .execute(tx.connection())
            .await?;
            events::record(
                tx.connection(),
                run_id,
                RecordEvent {
                    provider_event_id: None,
                    provider_seq: None,
                    event_type: events::RunEventType::Succeeded,
                    message: "model run succeeded",
                    data: None,
                },
            )
            .await?;
            tx.commit().await?;
            Ok(ItemResult {
                run_id: run_id.to_owned(),
                state: "succeeded",
                code: None,
            })
        }
        Ok(RunOutcome::Failed { code, message }) | Err(RunnerError { code, message }) => {
            runs::transition(RunState::Running, RunState::Failed)?;
            sqlx::query(
                "UPDATE model_runs SET state='failed', finished_at=? WHERE run_id=? AND state='running'",
            )
            .bind(&now)
            .bind(run_id)
            .execute(tx.connection())
            .await?;
            events::record(
                tx.connection(),
                run_id,
                RecordEvent {
                    provider_event_id: None,
                    provider_seq: None,
                    event_type: events::RunEventType::Failed,
                    message: "model run failed",
                    data: Some(json!({"code": code, "message": message})),
                },
            )
            .await?;
            tx.commit().await?;
            Ok(ItemResult {
                run_id: run_id.to_owned(),
                state: "failed",
                code: Some("RUN_FAILED"),
            })
        }
    }
}

async fn mark_interrupted(
    repository: &Repository,
    record: &RunRecord,
    code: &'static str,
) -> Result<(), ModelJobError> {
    let now = now_rfc3339();
    let mut tx = repository.begin_write().await?;
    runs::transition(record.state, RunState::Interrupted)?;
    sqlx::query(
        "UPDATE model_runs SET state='interrupted', cost_display='unknown', finished_at=? \
         WHERE run_id=? AND state=?",
    )
    .bind(&now)
    .bind(&record.run_id)
    .bind(record.state.as_str())
    .execute(tx.connection())
    .await?;
    events::record(
        tx.connection(),
        &record.run_id,
        RecordEvent {
            provider_event_id: None,
            provider_seq: None,
            event_type: events::RunEventType::Failed,
            message: "run interrupted; provider cost is unknown and the request is never resent",
            data: Some(json!({
                "interrupted": true,
                "code": code,
                "cost_display": "unknown",
            })),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn transition_run(
    repository: &Repository,
    record: &RunRecord,
    to: RunState,
    now: &str,
    cost_display: Option<&str>,
) -> Result<bool, ModelJobError> {
    runs::transition(record.state, to)?;
    let mut tx = repository.begin_write().await?;
    let updated = if let Some(cost) = cost_display {
        sqlx::query(
            "UPDATE model_runs SET state=?, started_at=?, cost_display=? WHERE run_id=? AND state=?",
        )
        .bind(to.as_str())
        .bind(now)
        .bind(cost)
        .bind(&record.run_id)
        .bind(record.state.as_str())
        .execute(tx.connection())
        .await?
    } else {
        sqlx::query("UPDATE model_runs SET state=?, started_at=? WHERE run_id=? AND state=?")
            .bind(to.as_str())
            .bind(now)
            .bind(&record.run_id)
            .bind(record.state.as_str())
            .execute(tx.connection())
            .await?
    };
    tx.commit().await?;
    Ok(updated.rows_affected() == 1)
}

async fn finish_job(
    repository: &Repository,
    lease: &LeasedJob,
    state: &str,
    result: &Value,
) -> Result<(), ModelJobError> {
    let result_json = serde_json::to_string(result).map_err(|_| ModelJobError::InvalidPayload)?;
    if result_json.len() > MAX_JOB_RESULT_BYTES {
        return Err(ModelJobError::InvalidPayload);
    }
    let now = now_rfc3339();
    let mut tx = repository.begin_write().await?;
    let updated = sqlx::query(
        "UPDATE jobs SET state=?, result_json=?, lease_until=NULL, updated_at=? \
         WHERE job_id=? AND state='running' AND worker_id=? AND fencing_token=? AND lease_until>?",
    )
    .bind(state)
    .bind(&result_json)
    .bind(&now)
    .bind(&lease.job_id)
    .bind(&lease.worker_id)
    .bind(lease.fencing_token as i64)
    .bind(&now)
    .execute(tx.connection())
    .await?;
    if updated.rows_affected() != 1 {
        tx.rollback().await?;
        return Err(ModelJobError::Rejected {
            code: "JOB_LEASE_LOST".to_owned(),
            message: "model job lease is no longer held".to_owned(),
        });
    }
    tx.commit().await?;
    Ok(())
}

async fn build_driver(
    repository: &Repository,
    record: RunRecord,
) -> Result<RunDriver, ModelJobError> {
    let context: RunContext =
        serde_json::from_str(&record.context_json).map_err(|_| ModelJobError::InvalidPayload)?;
    let profile: ModelProfile = serde_json::from_str(&record.profile_snapshot_json)
        .map_err(|_| ModelJobError::InvalidPayload)?;
    let mut tx = repository.begin_write().await?;
    let media_row = sqlx::query(
        "SELECT canonical_width, canonical_height FROM media_metadata WHERE asset_revision_id=?",
    )
    .bind(&record.asset_revision_id)
    .fetch_optional(tx.connection())
    .await?;
    let media_row = media_row.ok_or(ModelJobError::InvalidPayload)?;
    let width: i64 = media_row.try_get("canonical_width")?;
    let height: i64 = media_row.try_get("canonical_height")?;
    let ontology_json: Option<String> = sqlx::query_scalar(
        "SELECT body_json FROM ontology_versions WHERE ontology_version_id=? AND project_id=?",
    )
    .bind(&record.ontology_version_id)
    .bind(&record.project_id)
    .fetch_optional(tx.connection())
    .await?;
    let ontology_json = ontology_json.ok_or(ModelJobError::InvalidPayload)?;
    let ontology: annotation_domain::OntologyVersion =
        serde_json::from_str(&ontology_json).map_err(|_| ModelJobError::InvalidPayload)?;
    let annotation_json: Option<String> = sqlx::query_scalar(
        "SELECT body_json FROM annotation_revisions WHERE annotation_revision_id=?",
    )
    .bind(&record.annotation_revision_id)
    .fetch_optional(tx.connection())
    .await?;
    let annotation_json = annotation_json.ok_or(ModelJobError::InvalidPayload)?;
    let objects =
        predictions::pinned_objects(&annotation_json).map_err(|_| ModelJobError::InvalidPayload)?;
    tx.commit().await?;
    Ok(RunDriver {
        repository: repository.clone(),
        record,
        context,
        profile,
        width: u32::try_from(width).unwrap_or(1),
        height: u32::try_from(height).unwrap_or(1),
        labels: ontology.labels,
        objects,
    })
}

/// One scripted step of the built-in mock source.
pub enum MockStep {
    Emit(ProviderEvent),
    Candidate(SubmitCandidates),
    Fail { code: String, message: String },
    Complete,
}

/// The built-in source. It only ever produces synthetic output and refuses to
/// act for any profile that is not explicitly `provider_id = mock`.
pub struct MockRunner {
    scripts: BTreeMap<String, Vec<MockStep>>,
}

impl MockRunner {
    pub fn standard() -> Self {
        Self {
            scripts: BTreeMap::new(),
        }
    }

    pub fn with_scripts(scripts: BTreeMap<String, Vec<MockStep>>) -> Self {
        Self { scripts }
    }

    async fn run_default(&self, driver: &RunDriver) -> Result<RunOutcome, RunnerError> {
        let (width, height) = driver.media_size();
        let raw = match driver.record.intent.as_str() {
            "detect" => default_detect_candidate(driver, width, height),
            "audit_attributes" => default_audit_candidate(driver),
            _ => default_issue_candidate(),
        };
        driver
            .submit_candidates(SubmitCandidates {
                provider_event_id: "mock-candidate-1".to_owned(),
                provider_seq: Some(1),
                raw,
            })
            .await
            .map_err(RunnerError::from)?;
        Ok(RunOutcome::Completed)
    }

    async fn run_script(
        &self,
        driver: &RunDriver,
        script: &[MockStep],
    ) -> Result<RunOutcome, RunnerError> {
        for step in script {
            match step {
                MockStep::Emit(event) => driver
                    .emit(event.clone())
                    .await
                    .map_err(RunnerError::from)?,
                MockStep::Candidate(submit) => driver
                    .submit_candidates(submit.clone())
                    .await
                    .map_err(RunnerError::from)?,
                MockStep::Fail { code, message } => {
                    return Ok(RunOutcome::Failed {
                        code: code.clone(),
                        message: message.clone(),
                    })
                }
                MockStep::Complete => return Ok(RunOutcome::Completed),
            }
        }
        Ok(RunOutcome::Completed)
    }
}

impl RunRunner for MockRunner {
    fn execute<'a>(
        &'a self,
        driver: &'a RunDriver,
    ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, RunnerError>> + Send + 'a>> {
        Box::pin(async move {
            if let Some(script) = self.scripts.get(driver.run_id()) {
                return self.run_script(driver, script).await;
            }
            if driver.profile().provider_id != annotation_domain::ProviderId::Mock {
                return Ok(RunOutcome::Failed {
                    code: "RUNNER_UNAVAILABLE".to_owned(),
                    message: "no provider runtime is configured for this profile".to_owned(),
                });
            }
            self.run_default(driver).await
        })
    }
}

fn default_issue_candidate() -> Value {
    json!({
        "changes": [],
        "issues": [{
            "issue_id": "mock-issue-1",
            "object_id": null,
            "code": "mock_observation",
            "message": "synthetic mock review output (source: mock)",
            "region": null
        }],
        "score": null
    })
}

fn default_detect_candidate(driver: &RunDriver, width: u32, height: u32) -> Value {
    let Some(label) = driver.labels().first() else {
        return default_issue_candidate();
    };
    let x_max = width.min(8) as f64;
    let y_max = height.min(8) as f64;
    let mut attributes = serde_json::Map::new();
    for definition in &label.attributes {
        if definition.required {
            attributes.insert(
                definition.key.clone(),
                serde_json::to_value(&definition.default_value).unwrap_or(Value::Null),
            );
        }
    }
    json!({
        "changes": [{
            "kind": "create",
            "change_id": "mock-change-1",
            "object": {
                "object_id": "mock-object-1",
                "label_id": &*label.label_id,
                "geometry": {"type": "bbox_xyxy", "x_min": 0.0, "y_min": 0.0, "x_max": x_max, "y_max": y_max},
                "attributes": Value::Object(attributes),
                "origin": {"type": "manual", "prediction_id": null, "model_run_id": null, "import_batch_id": null}
            },
            "before_hash": null,
            "reason": "synthetic mock detection (source: mock)"
        }],
        "issues": [],
        "score": null
    })
}

fn default_audit_candidate(driver: &RunDriver) -> Value {
    let Some(object_id) = driver.context().selected_object_ids.first() else {
        return default_issue_candidate();
    };
    let Some(before_hash) = driver.context().object_hashes.get(object_id) else {
        return default_issue_candidate();
    };
    json!({
        "changes": [{
            "kind": "set_attributes",
            "change_id": "mock-change-1",
            "object_id": &*object_id,
            "values": {},
            "before_hash": before_hash,
            "reason": "synthetic mock attribute audit (source: mock)"
        }],
        "issues": [],
        "score": null
    })
}

pub(crate) async fn job_status(
    State(state): State<AiState>,
    Path(job_id): Path<String>,
    Extension(principal): Extension<Principal>,
) -> Response {
    let mut tx = match state.repository.begin_write().await {
        Ok(tx) => tx,
        Err(_) => {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "JOB_READ_FAILED",
                "Could not read job status",
            )
        }
    };
    let row = match sqlx::query(
        "SELECT job_id, project_id, kind, state, progress_completed, progress_total, \
                progress_json, result_json FROM jobs WHERE job_id=?",
    )
    .bind(&job_id)
    .fetch_optional(tx.connection())
    .await
    {
        Ok(row) => row,
        Err(_) => {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "JOB_READ_FAILED",
                "Could not read job status",
            )
        }
    };
    let Some(row) = row else {
        return failure_response(StatusCode::NOT_FOUND, "JOB_NOT_FOUND", "Job not found");
    };
    let project_id: Option<String> = row.try_get("project_id").unwrap_or(None);
    if let Some(project_id) = &project_id {
        let role = runs::member_role(tx.connection(), project_id, &principal.user_id)
            .await
            .ok()
            .flatten();
        if role.is_none() {
            return failure_response(StatusCode::NOT_FOUND, "JOB_NOT_FOUND", "Job not found");
        }
    } else if !principal.platform_admin {
        return failure_response(StatusCode::NOT_FOUND, "JOB_NOT_FOUND", "Job not found");
    }
    tx.commit().await.ok();
    let progress_json: Option<String> = row.try_get("progress_json").unwrap_or(None);
    let result_json: Option<String> = row.try_get("result_json").unwrap_or(None);
    (
        StatusCode::OK,
        Json(json!({
            "job_id": row.try_get::<String, _>("job_id").unwrap_or_default(),
            "project_id": project_id,
            "kind": row.try_get::<String, _>("kind").unwrap_or_default(),
            "state": row.try_get::<String, _>("state").unwrap_or_default(),
            "progress_completed": row.try_get::<i64, _>("progress_completed").unwrap_or(0),
            "progress_total": row.try_get::<i64, _>("progress_total").unwrap_or(0),
            "progress": progress_json.and_then(|json| serde_json::from_str::<Value>(&json).ok()),
            "result": result_json.and_then(|json| serde_json::from_str::<Value>(&json).ok()),
        })),
    )
        .into_response()
}

/// Test builds only: drives the shared job queue through the real worker path.
#[cfg(debug_assertions)]
pub(crate) async fn drain(
    State(state): State<AiState>,
    Extension(principal): Extension<Principal>,
) -> Response {
    if !principal.platform_admin {
        return failure_response(
            StatusCode::FORBIDDEN,
            "PLATFORM_ADMIN_REQUIRED",
            "Platform administrator role required",
        );
    }
    let queue = JobQueue::new(state.repository.clone());
    let mut processed = Vec::new();
    for _ in 0..DRAIN_MAX_JOBS {
        match process_next(
            &state.repository,
            &queue,
            "drain-worker",
            Duration::from_secs(30),
            &MockRunner::standard(),
        )
        .await
        {
            Ok(Some(job_id)) => processed.push(job_id),
            Ok(None) => break,
            Err(failure) => {
                let message = failure.to_string();
                return failure_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "JOB_DRAIN_FAILED",
                    &message,
                );
            }
        }
    }
    let mut jobs = Vec::with_capacity(processed.len());
    let mut tx = match state.repository.begin_write().await {
        Ok(tx) => tx,
        Err(_) => {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "JOB_DRAIN_FAILED",
                "Could not read drained jobs",
            )
        }
    };
    for job_id in &processed {
        let row = sqlx::query("SELECT job_id, kind, state FROM jobs WHERE job_id=?")
            .bind(job_id)
            .fetch_optional(tx.connection())
            .await;
        if let Ok(Some(row)) = row {
            jobs.push(json!({
                "job_id": row.try_get::<String, _>("job_id").unwrap_or_default(),
                "kind": row.try_get::<String, _>("kind").unwrap_or_default(),
                "state": row.try_get::<String, _>("state").unwrap_or_default(),
            }));
        }
    }
    tx.commit().await.ok();
    (
        StatusCode::OK,
        Json(json!({"processed": processed.len(), "jobs": jobs})),
    )
        .into_response()
}
