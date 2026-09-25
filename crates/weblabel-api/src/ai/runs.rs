//! Persistent model runs: state machine, idempotent creation, cancellation and
//! restart recovery.

use std::collections::BTreeMap;

use annotation_domain::{
    document::validate_id, object_hash, Id, ModelProfile, RunContext, RunIntent, StartRunRequest,
};
use axum::{
    body::{to_bytes, Body},
    extract::{Path, State},
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    ai::{events, AiState},
    auth::{Principal, Role},
    jobs::{model_jobs, queue::JobQueue},
    media::canonical::sha256_hex,
    projects::now_rfc3339,
    storage::Repository,
};

/// Profile id of the built-in, explicitly labeled mock source. It is only
/// resolvable in non-production builds and is never presented as a real model.
pub const MOCK_PROFILE_ID: &str = "profile_mock_local";
const MOCK_MODEL_ID: &str = "weblabel-mock-source-v1";
const MOCK_RUNTIME_VERSION: &str = "builtin-mock-1";

pub const MAX_RUN_BATCH_ITEMS: usize = 100;
pub const MAX_PROMPT_CHARS: usize = 8192;
pub const MAX_OBJECT_HASHES: usize = 10_000;
pub const MAX_RUN_REQUEST_BYTES: usize = 4 * 1024 * 1024;

const RUN_ID_NAMESPACE: Uuid = Uuid::from_u128(0x9b6d_1f2a_4c8e_4a17_9b0d_3e5f7a9c2b41);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}

impl RunState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            "interrupted" => Some(Self::Interrupted),
            _ => None,
        }
    }

    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RunError {
    #[error("invalid model run state transition from {from:?} to {to:?}")]
    InvalidTransition { from: RunState, to: RunState },
}

/// The only legal state machine for model runs. Terminal states are final:
/// a late provider event can never move a terminal run back to running.
pub fn transition(from: RunState, to: RunState) -> Result<RunState, RunError> {
    let allowed = matches!(
        (from, to),
        (RunState::Queued, RunState::Running)
            | (RunState::Queued, RunState::Cancelled)
            | (RunState::Queued, RunState::Failed)
            // Restart recovery may conclude a queued run whose batch job died
            // mid-flight: it was never started, and it is never resent.
            | (RunState::Queued, RunState::Interrupted)
            | (RunState::Running, RunState::Succeeded)
            | (RunState::Running, RunState::Failed)
            | (RunState::Running, RunState::Cancelled)
            | (RunState::Running, RunState::Interrupted)
    );
    if allowed {
        Ok(to)
    } else {
        Err(RunError::InvalidTransition { from, to })
    }
}

#[derive(Debug, Clone)]
pub struct RunFailure {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl RunFailure {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn into_response(self) -> Response {
        crate::ai::failure_response(self.status, self.code, &self.message)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunSummary {
    pub run_id: String,
    pub project_id: String,
    pub state: RunState,
    pub source: String,
    pub intent: String,
    pub profile_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub verification: String,
    pub input_fingerprint: String,
    pub request_hash: String,
    pub job_id: String,
    pub cost_display: String,
    pub cancel_requested: bool,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CreateOutcome {
    pub runs: Vec<RunSummary>,
    pub idempotent_replay: bool,
}

#[derive(Debug, Clone)]
pub struct RunRecord {
    pub run_id: String,
    pub operation_id: String,
    pub project_id: String,
    pub asset_revision_id: String,
    pub annotation_revision_id: String,
    pub ontology_version_id: String,
    pub actor_id: String,
    pub job_id: String,
    pub profile_id: String,
    pub profile_snapshot_json: String,
    pub provider_id: String,
    pub source: String,
    pub intent: String,
    pub prompt: String,
    pub context_json: String,
    pub input_fingerprint: String,
    pub request_hash: String,
    pub state: RunState,
    pub cancel_requested: bool,
    pub cost_display: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

impl RunRecord {
    pub fn summary(&self) -> RunSummary {
        let snapshot: Value =
            serde_json::from_str(&self.profile_snapshot_json).unwrap_or(Value::Null);
        RunSummary {
            run_id: self.run_id.clone(),
            project_id: self.project_id.clone(),
            state: self.state,
            source: self.source.clone(),
            intent: self.intent.clone(),
            profile_id: self.profile_id.clone(),
            provider_id: self.provider_id.clone(),
            model_id: snapshot["model_id"].as_str().unwrap_or("").to_owned(),
            verification: snapshot["verification"].as_str().unwrap_or("").to_owned(),
            input_fingerprint: self.input_fingerprint.clone(),
            request_hash: self.request_hash.clone(),
            job_id: self.job_id.clone(),
            cost_display: self.cost_display.clone(),
            cancel_requested: self.cancel_requested,
            created_at: self.created_at.clone(),
            started_at: self.started_at.clone(),
            finished_at: self.finished_at.clone(),
        }
    }

    pub fn context(&self) -> Result<RunContext, serde_json::Error> {
        serde_json::from_str(&self.context_json)
    }
}

fn row_to_record(row: &SqliteRow) -> Result<RunRecord, sqlx::Error> {
    let state: String = row.try_get("state")?;
    Ok(RunRecord {
        run_id: row.try_get("run_id")?,
        operation_id: row.try_get("operation_id")?,
        project_id: row.try_get("project_id")?,
        asset_revision_id: row.try_get("asset_revision_id")?,
        annotation_revision_id: row.try_get("annotation_revision_id")?,
        ontology_version_id: row.try_get("ontology_version_id")?,
        actor_id: row.try_get("actor_id")?,
        job_id: row.try_get("job_id")?,
        profile_id: row.try_get("profile_id")?,
        profile_snapshot_json: row.try_get("profile_snapshot_json")?,
        provider_id: row.try_get("provider_id")?,
        source: row.try_get("source")?,
        intent: row.try_get("intent")?,
        prompt: row.try_get("prompt")?,
        context_json: row.try_get("context_json")?,
        input_fingerprint: row.try_get("input_fingerprint")?,
        request_hash: row.try_get("request_hash")?,
        state: RunState::parse(&state).ok_or(sqlx::Error::Decode("invalid run state".into()))?,
        cancel_requested: row.try_get::<i64, _>("cancel_requested")? != 0,
        cost_display: row.try_get("cost_display")?,
        created_at: row.try_get("created_at")?,
        started_at: row.try_get("started_at")?,
        finished_at: row.try_get("finished_at")?,
    })
}

type SqliteRow = sqlx::sqlite::SqliteRow;

const RECORD_COLUMNS: &str = "run_id, operation_id, project_id, asset_revision_id, \
     annotation_revision_id, ontology_version_id, actor_id, job_id, profile_id, \
     profile_snapshot_json, provider_id, source, intent, prompt, context_json, \
     input_fingerprint, request_hash, state, cancel_requested, cost_display, \
     created_at, started_at, finished_at";

pub(crate) async fn load_record(
    connection: &mut SqliteConnection,
    run_id: &str,
) -> Result<Option<RunRecord>, sqlx::Error> {
    let row = sqlx::query(&format!(
        "SELECT {RECORD_COLUMNS} FROM model_runs WHERE run_id=?"
    ))
    .bind(run_id)
    .fetch_optional(connection)
    .await?;
    row.map(|row| row_to_record(&row)).transpose()
}

/// Loads the run and enforces project visibility: non-members cannot observe
/// the existence of a run, and write actions additionally need a write role.
pub(crate) async fn load_visible_summary(
    repository: &Repository,
    run_id: &str,
    user_id: &str,
    require_write: bool,
) -> Result<RunSummary, RunFailure> {
    let mut tx = repository
        .begin_write()
        .await
        .map_err(|_| storage_failure("RUN_LOOKUP_FAILED", "Could not look up model run"))?;
    let record = load_record(tx.connection(), run_id)
        .await
        .map_err(|_| storage_failure("RUN_LOOKUP_FAILED", "Could not look up model run"))?
        .ok_or_else(|| {
            RunFailure::new(
                StatusCode::NOT_FOUND,
                "RUN_NOT_FOUND",
                "Model run not found",
            )
        })?;
    let role = member_role(tx.connection(), &record.project_id, user_id)
        .await
        .map_err(|_| storage_failure("RUN_LOOKUP_FAILED", "Could not authorize model run"))?;
    let Some(role) = role else {
        return Err(RunFailure::new(
            StatusCode::NOT_FOUND,
            "RUN_NOT_FOUND",
            "Model run not found",
        ));
    };
    if require_write && !role.can_write() {
        return Err(RunFailure::new(
            StatusCode::FORBIDDEN,
            "PROJECT_WRITE_REQUIRED",
            "Project write role required",
        ));
    }
    tx.commit()
        .await
        .map_err(|_| storage_failure("RUN_LOOKUP_FAILED", "Could not finish run lookup"))?;
    Ok(record.summary())
}

pub(crate) async fn member_role(
    connection: &mut SqliteConnection,
    project_id: &str,
    user_id: &str,
) -> Result<Option<Role>, sqlx::Error> {
    let row = sqlx::query("SELECT role FROM memberships WHERE project_id=? AND user_id=?")
        .bind(project_id)
        .bind(user_id)
        .fetch_optional(connection)
        .await?;
    Ok(row.and_then(|row| Role::parse(&row.try_get::<String, _>("role").ok()?)))
}

fn storage_failure(code: &'static str, message: &'static str) -> RunFailure {
    RunFailure::new(StatusCode::INTERNAL_SERVER_ERROR, code, message)
}

struct ValidatedRequest {
    request: StartRunRequest,
    snapshot: ModelProfile,
    source: &'static str,
    context_json: String,
    request_hash: String,
    run_id: String,
}

/// Creates one or more runs as a single idempotent operation. All requests must
/// share `operation_id`, and a replay of the exact same payload never creates a
/// second billing run.
pub async fn create_batch(
    repository: &Repository,
    queue: &JobQueue,
    actor_id: &str,
    operation_id: &str,
    requests: Vec<StartRunRequest>,
    allow_mock_runs: bool,
) -> Result<CreateOutcome, RunFailure> {
    if requests.is_empty() || requests.len() > MAX_RUN_BATCH_ITEMS {
        return Err(RunFailure::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "RUN_BATCH_TOO_LARGE",
            format!("a model run operation must contain 1 to {MAX_RUN_BATCH_ITEMS} runs"),
        ));
    }
    validate_id(operation_id).map_err(|error| {
        RunFailure::new(
            StatusCode::BAD_REQUEST,
            "INVALID_OPERATION_ID",
            error.message,
        )
    })?;

    let mut project_id: Option<String> = None;
    let mut validated = Vec::with_capacity(requests.len());
    let mut profile_cache: BTreeMap<String, ModelProfile> = BTreeMap::new();
    for (index, request) in requests.into_iter().enumerate() {
        if &*request.operation_id != operation_id {
            return Err(RunFailure::new(
                StatusCode::BAD_REQUEST,
                "INVALID_RUN_REQUEST",
                "every run in one operation must share the operation_id",
            ));
        }
        if request.prompt.chars().count() > MAX_PROMPT_CHARS {
            return Err(RunFailure::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "PROMPT_TOO_LARGE",
                format!("prompt must be at most {MAX_PROMPT_CHARS} characters"),
            ));
        }
        if request.context.input_fingerprint.is_empty()
            || request.context.input_fingerprint.chars().count() > 128
        {
            return Err(RunFailure::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "INPUT_FINGERPRINT_INVALID",
                "input_fingerprint must contain 1 to 128 characters",
            ));
        }
        if request.context.object_hashes.len() > MAX_OBJECT_HASHES {
            return Err(RunFailure::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "OBJECT_HASHES_TOO_LARGE",
                format!("object_hashes must contain at most {MAX_OBJECT_HASHES} entries"),
            ));
        }
        if let Some(consent_id) = request.consent_id.as_deref() {
            validate_id(consent_id).map_err(|error| {
                RunFailure::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "INVALID_CONSENT_ID",
                    error.message,
                )
            })?;
        }
        if project_id.is_none() {
            project_id = Some(request.context.project_id.to_string());
        } else if project_id.as_deref() != Some(&*request.context.project_id) {
            return Err(RunFailure::new(
                StatusCode::BAD_REQUEST,
                "INVALID_RUN_REQUEST",
                "one model run operation cannot span multiple projects",
            ));
        }

        let snapshot = if let Some(snapshot) = profile_cache.get(&*request.profile_id) {
            snapshot.clone()
        } else {
            let snapshot =
                resolve_profile(repository, &*request.profile_id, allow_mock_runs).await?;
            profile_cache.insert(request.profile_id.to_string(), snapshot.clone());
            snapshot
        };
        let source = if snapshot.provider_id == annotation_domain::ProviderId::Mock {
            "mock"
        } else {
            "provider"
        };

        validate_context(repository, actor_id, &request).await?;
        let context_json = serde_json::to_string(&request.context).map_err(|_| {
            RunFailure::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_RUN_REQUEST",
                "RunContext cannot be serialized",
            )
        })?;
        let request_hash = hash_request(&snapshot, &request).map_err(|_| {
            RunFailure::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_RUN_REQUEST",
                "run request cannot be serialized",
            )
        })?;
        let run_id = Uuid::new_v5(
            &RUN_ID_NAMESPACE,
            format!("weblabel.ai_run:{actor_id}:{operation_id}:{request_hash}:{index}").as_bytes(),
        )
        .to_string();
        validated.push(ValidatedRequest {
            request,
            snapshot,
            source,
            context_json,
            request_hash,
            run_id,
        });
    }
    let project_id = project_id.expect("validated non-empty batch");

    let batch_hash = {
        let mut combined = String::new();
        for item in &validated {
            combined.push_str(&item.request_hash);
        }
        sha256_hex(combined.as_bytes())
    };

    // Fast replay path before touching the queue.
    if let Some(existing) = find_idempotency(repository, actor_id, operation_id).await? {
        return replay_or_conflict(existing, batch_hash);
    }

    let run_ids: Vec<String> = validated.iter().map(|item| item.run_id.clone()).collect();
    let enqueued = model_jobs::enqueue_run_job(queue, &project_id, operation_id, &run_ids)
        .await
        .map_err(|failure| match failure {
            crate::jobs::queue::QueueError::IdempotencyConflict => RunFailure::new(
                StatusCode::CONFLICT,
                "IDEMPOTENCY_KEY_REUSE",
                "operation_id was reused with a different run request",
            ),
            crate::jobs::queue::QueueError::QueueFull => RunFailure::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "RUN_QUEUE_FULL",
                "the model job queue is full",
            ),
            _ => storage_failure("RUN_CREATE_FAILED", "Could not enqueue the model run job"),
        })?;

    let mut summaries = Vec::with_capacity(validated.len());
    let mut tx = match repository.begin_write().await {
        Ok(tx) => tx,
        Err(_) => {
            return Err(storage_failure(
                "RUN_CREATE_FAILED",
                "Could not start the model run transaction",
            ))
        }
    };
    let existing = find_idempotency_on(tx.connection(), actor_id, operation_id)
        .await
        .map_err(|_| {
            storage_failure(
                "RUN_CREATE_FAILED",
                "Could not store the idempotency record",
            )
        })?;
    if let Some(existing) = existing {
        tx.commit().await.ok();
        return replay_or_conflict(existing, batch_hash);
    }
    let created_at = now_rfc3339();
    for item in &validated {
        let snapshot_json = serde_json::to_string(&item.snapshot)
            .map_err(|_| storage_failure("RUN_CREATE_FAILED", "Could not serialize profile"))?;
        sqlx::query(
            "INSERT INTO model_runs(run_id, operation_id, project_id, asset_revision_id, \
             annotation_revision_id, ontology_version_id, actor_id, job_id, profile_id, \
             profile_snapshot_json, provider_id, source, intent, prompt, consent_id, \
             context_json, input_fingerprint, request_hash, state, cancel_requested, \
             cost_display, usage_json, created_at, started_at, finished_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 'none', NULL, ?, NULL, NULL)",
        )
        .bind(&item.run_id)
        .bind(operation_id)
        .bind(&project_id)
        .bind(&*item.request.context.asset_revision_id)
        .bind(&*item.request.context.annotation_revision_id)
        .bind(&*item.request.context.ontology_version_id)
        .bind(actor_id)
        .bind(&enqueued.job_id)
        .bind(&*item.request.profile_id)
        .bind(&snapshot_json)
        .bind(crate::ai::runs::provider_str(item.snapshot.provider_id))
        .bind(item.source)
        .bind(intent_str(item.request.intent))
        .bind(&item.request.prompt)
        .bind(item.request.consent_id.as_deref())
        .bind(&item.context_json)
        .bind(&item.request.context.input_fingerprint)
        .bind(&item.request_hash)
        .bind(&created_at)
        .execute(tx.connection())
        .await
        .map_err(|_| storage_failure("RUN_CREATE_FAILED", "Could not persist the model run"))?;
        events::record(
            tx.connection(),
            &item.run_id,
            events::RecordEvent {
                provider_event_id: None,
                provider_seq: None,
                event_type: events::RunEventType::Queued,
                message: "run queued",
                data: Some(json!({
                    "source": item.source,
                    "profile_id": &*item.request.profile_id,
                    "model_id": item.snapshot.model_id,
                    "verification": verification_str(item.snapshot.verification),
                    "intent": intent_str(item.request.intent),
                })),
            },
        )
        .await
        .map_err(|_| storage_failure("RUN_CREATE_FAILED", "Could not record the queued event"))?;
        let record = RunRecord {
            run_id: item.run_id.clone(),
            operation_id: operation_id.to_owned(),
            project_id: project_id.clone(),
            asset_revision_id: item.request.context.asset_revision_id.to_string(),
            annotation_revision_id: item.request.context.annotation_revision_id.to_string(),
            ontology_version_id: item.request.context.ontology_version_id.to_string(),
            actor_id: actor_id.to_owned(),
            job_id: enqueued.job_id.clone(),
            profile_id: item.request.profile_id.to_string(),
            profile_snapshot_json: snapshot_json.clone(),
            provider_id: provider_str(item.snapshot.provider_id).to_owned(),
            source: item.source.to_owned(),
            intent: intent_str(item.request.intent).to_owned(),
            prompt: item.request.prompt.clone(),
            context_json: item.context_json.clone(),
            input_fingerprint: item.request.context.input_fingerprint.clone(),
            request_hash: item.request_hash.clone(),
            state: RunState::Queued,
            cancel_requested: false,
            cost_display: "none".to_owned(),
            created_at: created_at.clone(),
            started_at: None,
            finished_at: None,
        };
        summaries.push(record.summary());
    }
    let stored_response = serde_json::to_string(&json!({"runs": summaries}))
        .map_err(|_| storage_failure("RUN_CREATE_FAILED", "Could not serialize run response"))?;
    sqlx::query(
        "INSERT INTO idempotency_keys(actor_id, operation_id, operation_kind, request_hash, response_json, created_at) \
         VALUES (?, ?, 'ai_run_start', ?, ?, ?)",
    )
    .bind(actor_id)
    .bind(operation_id)
    .bind(&batch_hash)
    .bind(&stored_response)
    .bind(&created_at)
    .execute(tx.connection())
    .await
    .map_err(|_| storage_failure("RUN_CREATE_FAILED", "Could not store the idempotency record"))?;
    tx.commit()
        .await
        .map_err(|_| storage_failure("RUN_CREATE_FAILED", "Could not commit the model run"))?;
    Ok(CreateOutcome {
        runs: summaries,
        idempotent_replay: false,
    })
}

struct ExistingOperation {
    request_hash: String,
    response_json: String,
}

async fn find_idempotency(
    repository: &Repository,
    actor_id: &str,
    operation_id: &str,
) -> Result<Option<ExistingOperation>, RunFailure> {
    let mut tx = repository
        .begin_write()
        .await
        .map_err(|_| storage_failure("RUN_CREATE_FAILED", "Could not check run idempotency"))?;
    let existing = find_idempotency_on(tx.connection(), actor_id, operation_id)
        .await
        .map_err(|_| storage_failure("RUN_CREATE_FAILED", "Could not check run idempotency"))?;
    tx.commit()
        .await
        .map_err(|_| storage_failure("RUN_CREATE_FAILED", "Could not finish idempotency check"))?;
    Ok(existing)
}

async fn find_idempotency_on(
    connection: &mut SqliteConnection,
    actor_id: &str,
    operation_id: &str,
) -> Result<Option<ExistingOperation>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT request_hash, response_json FROM idempotency_keys \
         WHERE actor_id=? AND operation_id=? AND operation_kind='ai_run_start'",
    )
    .bind(actor_id)
    .bind(operation_id)
    .fetch_optional(connection)
    .await?;
    row.map(|row| {
        Ok(ExistingOperation {
            request_hash: row.try_get("request_hash")?,
            response_json: row.try_get("response_json")?,
        })
    })
    .transpose()
}

fn replay_or_conflict(
    existing: ExistingOperation,
    batch_hash: String,
) -> Result<CreateOutcome, RunFailure> {
    if existing.request_hash != batch_hash {
        return Err(RunFailure::new(
            StatusCode::CONFLICT,
            "IDEMPOTENCY_KEY_REUSE",
            "operation_id was reused with a different run request",
        ));
    }
    let stored: Value = serde_json::from_str(&existing.response_json).map_err(|_| {
        storage_failure(
            "IDEMPOTENCY_RECORD_CORRUPT",
            "Stored idempotency response is invalid",
        )
    })?;
    let runs = stored["runs"]
        .as_array()
        .ok_or_else(|| {
            storage_failure(
                "IDEMPOTENCY_RECORD_CORRUPT",
                "Stored idempotency response is invalid",
            )
        })?
        .iter()
        .map(|value| serde_json::from_value(value.clone()))
        .collect::<Result<Vec<RunSummary>, _>>()
        .map_err(|_| {
            storage_failure(
                "IDEMPOTENCY_RECORD_CORRUPT",
                "Stored idempotency response is invalid",
            )
        })?;
    Ok(CreateOutcome {
        runs,
        idempotent_replay: true,
    })
}

fn hash_request(
    snapshot: &ModelProfile,
    request: &StartRunRequest,
) -> Result<String, serde_json::Error> {
    let bytes = serde_json::to_vec(&json!({
        "profile_snapshot": snapshot,
        "request": request,
    }))?;
    Ok(sha256_hex(&bytes))
}

pub(crate) fn intent_str(intent: RunIntent) -> &'static str {
    match intent {
        RunIntent::Detect => "detect",
        RunIntent::AuditAttributes => "audit_attributes",
        RunIntent::FindIssues => "find_issues",
    }
}

pub(crate) fn verification_str(verification: annotation_domain::Verification) -> &'static str {
    match verification {
        annotation_domain::Verification::NotRun => "not_run",
        annotation_domain::Verification::MockOnly => "mock_only",
        annotation_domain::Verification::LivePassed => "live_passed",
        annotation_domain::Verification::LiveFailed => "live_failed",
    }
}

pub(crate) fn provider_str(provider: annotation_domain::ProviderId) -> &'static str {
    match provider {
        annotation_domain::ProviderId::CodexLocal => "codex_local",
        annotation_domain::ProviderId::ClaudeLocal => "claude_local",
        annotation_domain::ProviderId::OpenaiApi => "openai_api",
        annotation_domain::ProviderId::AnthropicApi => "anthropic_api",
        annotation_domain::ProviderId::MimoApi => "mimo_api",
        annotation_domain::ProviderId::DetectorLocal => "detector_local",
        annotation_domain::ProviderId::Mock => "mock",
    }
}

/// Built-in mock profile: explicitly labeled, only available outside production.
pub fn mock_profile() -> ModelProfile {
    ModelProfile {
        profile_id: Id::from(MOCK_PROFILE_ID),
        provider_id: annotation_domain::ProviderId::Mock,
        model_id: MOCK_MODEL_ID.to_owned(),
        auth_kind: annotation_domain::AuthKind::None,
        capabilities: annotation_domain::ModelCapabilities {
            image_input: true,
            tools: false,
            structured_output: true,
            bbox_output: true,
            attributes: true,
        },
        availability: annotation_domain::Availability::Ready,
        verification: annotation_domain::Verification::MockOnly,
        runtime_version: Some(MOCK_RUNTIME_VERSION.to_owned()),
        verified_at: None,
    }
}

async fn resolve_profile(
    repository: &Repository,
    profile_id: &str,
    allow_mock_runs: bool,
) -> Result<ModelProfile, RunFailure> {
    if profile_id == MOCK_PROFILE_ID {
        return if allow_mock_runs {
            Ok(mock_profile())
        } else {
            Err(RunFailure::new(
                StatusCode::NOT_FOUND,
                "PROFILE_NOT_FOUND",
                "Model profile not found",
            ))
        };
    }
    validate_id(profile_id).map_err(|_| {
        RunFailure::new(
            StatusCode::NOT_FOUND,
            "PROFILE_NOT_FOUND",
            "Model profile not found",
        )
    })?;
    let mut tx = repository
        .begin_write()
        .await
        .map_err(|_| storage_failure("PROFILE_LOOKUP_FAILED", "Could not look up model profile"))?;
    let row = sqlx::query(
        "SELECT provider_id, model_id, auth_kind, capabilities_json, availability, verification, \
                runtime_version, verified_at FROM model_profiles WHERE profile_id=?",
    )
    .bind(profile_id)
    .fetch_optional(tx.connection())
    .await
    .map_err(|_| storage_failure("PROFILE_LOOKUP_FAILED", "Could not look up model profile"))?;
    tx.commit()
        .await
        .map_err(|_| storage_failure("PROFILE_LOOKUP_FAILED", "Could not look up model profile"))?;
    let Some(row) = row else {
        return Err(RunFailure::new(
            StatusCode::NOT_FOUND,
            "PROFILE_NOT_FOUND",
            "Model profile not found",
        ));
    };
    let provider_id = parse_provider(&row.try_get::<String, _>("provider_id").unwrap_or_default())
        .ok_or_else(|| storage_failure("PROFILE_INVALID", "Stored model profile is invalid"))?;
    let auth_kind = parse_auth_kind(&row.try_get::<String, _>("auth_kind").unwrap_or_default())
        .ok_or_else(|| storage_failure("PROFILE_INVALID", "Stored model profile is invalid"))?;
    let availability =
        parse_availability(&row.try_get::<String, _>("availability").unwrap_or_default())
            .ok_or_else(|| storage_failure("PROFILE_INVALID", "Stored model profile is invalid"))?;
    let verification =
        parse_verification(&row.try_get::<String, _>("verification").unwrap_or_default())
            .ok_or_else(|| storage_failure("PROFILE_INVALID", "Stored model profile is invalid"))?;
    let capabilities_json: String = row.try_get("capabilities_json").unwrap_or_default();
    let capabilities = serde_json::from_str(&capabilities_json)
        .map_err(|_| storage_failure("PROFILE_INVALID", "Stored model profile is invalid"))?;
    // Mock is refused by source, not just by the built-in profile id: a stored
    // row can never present mock output as a real, verified provider.
    if provider_id == annotation_domain::ProviderId::Mock {
        if !allow_mock_runs {
            return Err(RunFailure::new(
                StatusCode::NOT_FOUND,
                "PROFILE_NOT_FOUND",
                "Model profile not found",
            ));
        }
        return Ok(ModelProfile {
            profile_id: Id::from(profile_id),
            provider_id,
            model_id: row.try_get("model_id").unwrap_or_default(),
            auth_kind,
            capabilities,
            availability,
            verification: annotation_domain::Verification::MockOnly,
            runtime_version: row.try_get("runtime_version").unwrap_or(None),
            verified_at: row.try_get("verified_at").unwrap_or(None),
        });
    }
    Ok(ModelProfile {
        profile_id: Id::from(profile_id),
        provider_id,
        model_id: row.try_get("model_id").unwrap_or_default(),
        auth_kind,
        capabilities,
        availability,
        verification,
        runtime_version: row.try_get("runtime_version").unwrap_or(None),
        verified_at: row.try_get("verified_at").unwrap_or(None),
    })
}

fn parse_provider(value: &str) -> Option<annotation_domain::ProviderId> {
    match value {
        "codex_local" => Some(annotation_domain::ProviderId::CodexLocal),
        "claude_local" => Some(annotation_domain::ProviderId::ClaudeLocal),
        "openai_api" => Some(annotation_domain::ProviderId::OpenaiApi),
        "anthropic_api" => Some(annotation_domain::ProviderId::AnthropicApi),
        "mimo_api" => Some(annotation_domain::ProviderId::MimoApi),
        "detector_local" => Some(annotation_domain::ProviderId::DetectorLocal),
        "mock" => Some(annotation_domain::ProviderId::Mock),
        _ => None,
    }
}

fn parse_auth_kind(value: &str) -> Option<annotation_domain::AuthKind> {
    match value {
        "official_user_login" => Some(annotation_domain::AuthKind::OfficialUserLogin),
        "api_key" => Some(annotation_domain::AuthKind::ApiKey),
        "local_weights" => Some(annotation_domain::AuthKind::LocalWeights),
        "none" => Some(annotation_domain::AuthKind::None),
        _ => None,
    }
}

fn parse_availability(value: &str) -> Option<annotation_domain::Availability> {
    match value {
        "ready" => Some(annotation_domain::Availability::Ready),
        "needs_login" => Some(annotation_domain::Availability::NeedsLogin),
        "needs_configuration" => Some(annotation_domain::Availability::NeedsConfiguration),
        "unsupported" => Some(annotation_domain::Availability::Unsupported),
        "blocked" => Some(annotation_domain::Availability::Blocked),
        _ => None,
    }
}

fn parse_verification(value: &str) -> Option<annotation_domain::Verification> {
    match value {
        "not_run" => Some(annotation_domain::Verification::NotRun),
        "mock_only" => Some(annotation_domain::Verification::MockOnly),
        "live_passed" => Some(annotation_domain::Verification::LivePassed),
        "live_failed" => Some(annotation_domain::Verification::LiveFailed),
        _ => None,
    }
}

async fn validate_context(
    repository: &Repository,
    actor_id: &str,
    request: &StartRunRequest,
) -> Result<(), RunFailure> {
    let mut tx = repository
        .begin_write()
        .await
        .map_err(|_| storage_failure("RUN_LOOKUP_FAILED", "Could not validate run context"))?;
    let context = &request.context;
    let row = sqlx::query(
        "SELECT r.project_id, r.canonical_sha256, m.canonical_width, m.canonical_height, u.role \
         FROM media_revisions r \
         JOIN media_metadata m ON m.asset_revision_id=r.asset_revision_id \
         JOIN memberships u ON u.project_id=r.project_id \
         WHERE r.asset_revision_id=? AND u.user_id=?",
    )
    .bind(&*context.asset_revision_id)
    .bind(actor_id)
    .fetch_optional(tx.connection())
    .await
    .map_err(|_| storage_failure("RUN_LOOKUP_FAILED", "Could not validate run context"))?;
    let Some(row) = row else {
        return Err(RunFailure::new(
            StatusCode::NOT_FOUND,
            "ASSET_NOT_FOUND",
            "Run target not found",
        ));
    };
    let project_id: String = row
        .try_get("project_id")
        .map_err(|_| storage_failure("RUN_LOOKUP_FAILED", "Could not validate run context"))?;
    if &*project_id != &*context.project_id {
        return Err(RunFailure::new(
            StatusCode::NOT_FOUND,
            "ASSET_NOT_FOUND",
            "Run target not found",
        ));
    }
    let role: String = row
        .try_get("role")
        .map_err(|_| storage_failure("RUN_LOOKUP_FAILED", "Could not validate run context"))?;
    if !Role::parse(&role).is_some_and(Role::can_write) {
        return Err(RunFailure::new(
            StatusCode::FORBIDDEN,
            "PROJECT_WRITE_REQUIRED",
            "Project write role required",
        ));
    }
    let canonical_sha256: String = row
        .try_get("canonical_sha256")
        .map_err(|_| storage_failure("RUN_LOOKUP_FAILED", "Could not validate run context"))?;
    if canonical_sha256 != context.canonical_sha256 {
        return Err(RunFailure::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INPUT_HASH_MISMATCH",
            "canonical_sha256 does not match the pinned media revision",
        ));
    }
    let annotation_row = sqlx::query(
        "SELECT body_json FROM annotation_revisions \
         WHERE annotation_revision_id=? AND project_id=? AND asset_revision_id=? AND ontology_version_id=?",
    )
    .bind(&*context.annotation_revision_id)
    .bind(&project_id)
    .bind(&*context.asset_revision_id)
    .bind(&*context.ontology_version_id)
    .fetch_optional(tx.connection())
    .await
    .map_err(|_| storage_failure("RUN_LOOKUP_FAILED", "Could not validate run context"))?;
    let Some(annotation_row) = annotation_row else {
        return Err(RunFailure::new(
            StatusCode::NOT_FOUND,
            "ANNOTATION_NOT_FOUND",
            "Run target annotation revision not found",
        ));
    };
    let body_json: String = annotation_row
        .try_get("body_json")
        .map_err(|_| storage_failure("RUN_LOOKUP_FAILED", "Could not validate run context"))?;
    let document: annotation_domain::AnnotationDocument = serde_json::from_str(&body_json)
        .map_err(|_| {
            storage_failure("RUN_LOOKUP_FAILED", "Stored annotation document is invalid")
        })?;
    for selected in &context.selected_object_ids {
        if !context.object_hashes.contains_key(selected) {
            return Err(RunFailure::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "CONTEXT_OBJECT_UNKNOWN",
                "every selected object must be pinned in object_hashes",
            ));
        }
    }
    for (object_id, pinned_hash) in &context.object_hashes {
        let object = document
            .objects
            .iter()
            .find(|object| object.object_id == *object_id);
        let Some(object) = object else {
            return Err(RunFailure::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "CONTEXT_OBJECT_UNKNOWN",
                "object_hashes references an object outside the pinned revision",
            ));
        };
        if object_hash(object) != *pinned_hash {
            return Err(RunFailure::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "CONTEXT_HASH_MISMATCH",
                "object_hashes does not match the pinned revision content",
            ));
        }
    }
    tx.commit()
        .await
        .map_err(|_| storage_failure("RUN_LOOKUP_FAILED", "Could not validate run context"))?;
    Ok(())
}

/// Cancels a run. Idempotent: repeating the call returns the same summary and
/// never appends a second cancellation event or moves a terminal run.
pub async fn cancel(
    repository: &Repository,
    run_id: &str,
    actor_id: &str,
    reason: &str,
) -> Result<RunSummary, RunFailure> {
    let mut tx = repository
        .begin_write()
        .await
        .map_err(|_| storage_failure("RUN_CANCEL_FAILED", "Could not cancel the model run"))?;
    let record = load_record(tx.connection(), run_id)
        .await
        .map_err(|_| storage_failure("RUN_CANCEL_FAILED", "Could not cancel the model run"))?
        .ok_or_else(|| {
            RunFailure::new(
                StatusCode::NOT_FOUND,
                "RUN_NOT_FOUND",
                "Model run not found",
            )
        })?;
    let role = member_role(tx.connection(), &record.project_id, actor_id)
        .await
        .map_err(|_| {
            storage_failure("RUN_CANCEL_FAILED", "Could not authorize run cancellation")
        })?;
    let Some(role) = role else {
        return Err(RunFailure::new(
            StatusCode::NOT_FOUND,
            "RUN_NOT_FOUND",
            "Model run not found",
        ));
    };
    if !role.can_write() {
        return Err(RunFailure::new(
            StatusCode::FORBIDDEN,
            "PROJECT_WRITE_REQUIRED",
            "Project write role required",
        ));
    }
    if record.state.is_terminal() {
        tx.commit()
            .await
            .map_err(|_| storage_failure("RUN_CANCEL_FAILED", "Could not cancel the model run"))?;
        return Ok(record.summary());
    }
    transition(record.state, RunState::Cancelled).map_err(|_| {
        storage_failure(
            "RUN_CANCEL_FAILED",
            "Run state machine rejected cancellation",
        )
    })?;
    let now = now_rfc3339();
    let cost_display = if record.started_at.is_some() {
        "unknown"
    } else {
        "none"
    };
    sqlx::query(
        "UPDATE model_runs SET state='cancelled', cancel_requested=1, cost_display=?, finished_at=? \
         WHERE run_id=? AND state=?",
    )
    .bind(cost_display)
    .bind(&now)
    .bind(run_id)
    .bind(record.state.as_str())
    .execute(tx.connection())
    .await
    .map_err(|_| storage_failure("RUN_CANCEL_FAILED", "Could not cancel the model run"))?;
    events::record(
        tx.connection(),
        run_id,
        events::RecordEvent {
            provider_event_id: None,
            provider_seq: None,
            event_type: events::RunEventType::Cancelled,
            message: &format!("run cancelled: {}", crate::ai::redact_text(reason)),
            data: Some(json!({
                "reason": crate::ai::redact_text(reason),
                "cost_display": cost_display,
            })),
        },
    )
    .await
    .map_err(|_| storage_failure("RUN_CANCEL_FAILED", "Could not record the cancel event"))?;
    // A job that has not started is cancelled with the run; a running job
    // observes the terminal state when it tries to continue.
    sqlx::query(
        "UPDATE jobs SET state='cancelled', result_json=?, lease_until=NULL, updated_at=? \
         WHERE job_id=? AND kind='model_run' AND state='queued'",
    )
    .bind(json!({"cancelled": true}).to_string())
    .bind(&now)
    .bind(&record.job_id)
    .execute(tx.connection())
    .await
    .map_err(|_| storage_failure("RUN_CANCEL_FAILED", "Could not cancel the model run job"))?;
    tx.commit()
        .await
        .map_err(|_| storage_failure("RUN_CANCEL_FAILED", "Could not cancel the model run"))?;
    let mut record = record;
    record.state = RunState::Cancelled;
    record.cancel_requested = true;
    record.cost_display = cost_display.to_owned();
    record.finished_at = Some(now);
    Ok(record.summary())
}

/// Startup recovery: runs left in flight by a crash become `interrupted` and
/// their cost display becomes `unknown`. Interrupted runs are never resent.
pub async fn recover_interrupted(repository: &Repository) -> Result<u64, sqlx::Error> {
    let mut tx = repository.begin_write().await?;
    let now = now_rfc3339();
    sqlx::query(
        "UPDATE jobs SET state='interrupted', lease_until=NULL, updated_at=? \
         WHERE kind='model_run' AND state='running'",
    )
    .bind(&now)
    .execute(tx.connection())
    .await?;
    let rows = sqlx::query(
        "SELECT r.run_id, r.started_at FROM model_runs r \
         LEFT JOIN jobs j ON j.job_id=r.job_id \
         WHERE (r.state='running' OR (r.state='queued' AND j.state='interrupted'))",
    )
    .fetch_all(tx.connection())
    .await?;
    let mut recovered = 0_u64;
    for row in rows {
        let run_id: String = row.try_get("run_id")?;
        let started_at: Option<String> = row.try_get("started_at")?;
        let cost_display = if started_at.is_some() {
            "unknown"
        } else {
            "none"
        };
        let previous = if started_at.is_some() {
            "running"
        } else {
            "queued"
        };
        sqlx::query(
            "UPDATE model_runs SET state='interrupted', cost_display=?, finished_at=? \
             WHERE run_id=? AND state=?",
        )
        .bind(cost_display)
        .bind(&now)
        .bind(&run_id)
        .bind(previous)
        .execute(tx.connection())
        .await?;
        events::record(
            tx.connection(),
            &run_id,
            events::RecordEvent {
                provider_event_id: None,
                provider_seq: None,
                event_type: events::RunEventType::Failed,
                message: "run interrupted by service restart; provider cost is unknown",
                data: Some(json!({
                    "interrupted": true,
                    "cost_display": cost_display,
                })),
            },
        )
        .await?;
        recovered += 1;
    }
    tx.commit().await?;
    Ok(recovered)
}

pub(super) async fn create(
    State(state): State<AiState>,
    Extension(principal): Extension<Principal>,
    request: Request<Body>,
) -> Response {
    let bytes = match to_bytes(request.into_body(), MAX_RUN_REQUEST_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return RunFailure::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "RUN_REQUEST_TOO_LARGE",
                "Model run request exceeds the 4 MiB limit",
            )
            .into_response()
        }
    };
    let request: StartRunRequest = match serde_json::from_slice(&bytes) {
        Ok(request) => request,
        Err(_) => {
            return RunFailure::new(
                StatusCode::BAD_REQUEST,
                "INVALID_RUN_REQUEST",
                "Request body does not match StartRunRequest",
            )
            .into_response()
        }
    };
    let queue = JobQueue::new(state.repository.clone());
    let operation_id = request.operation_id.to_string();
    match create_batch(
        &state.repository,
        &queue,
        &principal.user_id,
        &operation_id,
        vec![request],
        state.allow_mock_runs,
    )
    .await
    {
        Ok(outcome) => {
            let summary = &outcome.runs[0];
            (
                StatusCode::ACCEPTED,
                Json(json!({
                    "run_id": summary.run_id,
                    "project_id": summary.project_id,
                    "state": summary.state,
                    "source": summary.source,
                    "intent": summary.intent,
                    "profile_id": summary.profile_id,
                    "provider_id": summary.provider_id,
                    "model_id": summary.model_id,
                    "verification": summary.verification,
                    "input_fingerprint": summary.input_fingerprint,
                    "request_hash": summary.request_hash,
                    "job_id": summary.job_id,
                    "cost_display": summary.cost_display,
                    "cancel_requested": summary.cancel_requested,
                    "created_at": summary.created_at,
                    "started_at": summary.started_at,
                    "finished_at": summary.finished_at,
                    "idempotent_replay": outcome.idempotent_replay,
                })),
            )
                .into_response()
        }
        Err(failure) => failure.into_response(),
    }
}

pub(super) async fn cancel_route(
    State(state): State<AiState>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<String>,
    request: Request<Body>,
) -> Response {
    // The optional body carries no semantics; cancellation is idempotent.
    let _ = to_bytes(request.into_body(), 4096).await;
    match cancel(
        &state.repository,
        &run_id,
        &principal.user_id,
        "user requested",
    )
    .await
    {
        Ok(summary) => (StatusCode::OK, Json(summary)).into_response(),
        Err(failure) => failure.into_response(),
    }
}
