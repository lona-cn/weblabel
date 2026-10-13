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
    jobs::queue::JobQueue,
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

const RUN_ID_NAMESPACE: Uuid = Uuid::from_u128(0x9b6d_1f2a_4c8e_4a17_9b0d_3e5f_7a9c_2b41);

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
    authorization: super::consent::RunAuthorization,
}

/// Creates one or more runs as a single idempotent operation. All requests must
/// share `operation_id`, and a replay of the exact same payload never creates a
/// second billing run.
pub async fn create_batch(
    repository: &Repository,
    _queue: &JobQueue,
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

    let mut tx = repository.begin_write().await.map_err(|_| {
        storage_failure(
            "RUN_CREATE_FAILED",
            "Could not start the model run transaction",
        )
    })?;
    // A successful START is a durable receipt, not a fresh capability request.
    // Compare against the pinned profile used by that START before revalidating
    // mutable inputs or the preview window. Visibility still applies today.
    if let Some(existing) = find_idempotency_on(tx.connection(), actor_id, operation_id)
        .await
        .map_err(|_| {
            storage_failure("RUN_CREATE_FAILED", "Could not read the idempotency record")
        })?
    {
        #[derive(Deserialize)]
        struct StoredStartReceipt {
            runs: Vec<RunSummary>,
        }
        let StoredStartReceipt { runs: summaries } = serde_json::from_str(&existing.response_json)
            .map_err(|_| {
                storage_failure(
                    "IDEMPOTENCY_RECORD_CORRUPT",
                    "Stored idempotency response is invalid",
                )
            })?;
        let conflict = || {
            RunFailure::new(
                StatusCode::CONFLICT,
                "IDEMPOTENCY_KEY_REUSE",
                "operation_id was reused with a different run request",
            )
        };
        if summaries.len() != requests.len() {
            return Err(conflict());
        }
        let mut combined = String::with_capacity(summaries.len() * 64);
        for (summary, request) in summaries.iter().zip(&requests) {
            let record = load_record(tx.connection(), &summary.run_id)
                .await
                .map_err(|_| storage_failure("RUN_LOOKUP_FAILED", "Could not look up model run"))?
                .ok_or_else(|| {
                    storage_failure("IDEMPOTENCY_RECORD_CORRUPT", "Stored model run is missing")
                })?;
            if record.actor_id != actor_id || record.operation_id != operation_id {
                return Err(storage_failure(
                    "IDEMPOTENCY_RECORD_CORRUPT",
                    "Stored model run identity is invalid",
                ));
            }
            if member_role(tx.connection(), &record.project_id, actor_id)
                .await
                .map_err(|_| storage_failure("RUN_LOOKUP_FAILED", "Could not authorize model run"))?
                .is_none()
            {
                return Err(RunFailure::new(
                    StatusCode::NOT_FOUND,
                    "RUN_NOT_FOUND",
                    "Model run not found",
                ));
            }
            let snapshot: ModelProfile = serde_json::from_str(&record.profile_snapshot_json)
                .map_err(|_| {
                    storage_failure("IDEMPOTENCY_RECORD_CORRUPT", "Stored profile is invalid")
                })?;
            combined.push_str(&hash_request(&snapshot, request).map_err(|_| {
                RunFailure::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "INVALID_RUN_REQUEST",
                    "run request cannot be serialized",
                )
            })?);
        }
        if existing.request_hash != sha256_hex(combined.as_bytes()) {
            return Err(conflict());
        }
        return Ok(CreateOutcome {
            runs: summaries,
            idempotent_replay: true,
        });
    }
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
                resolve_profile_on(tx.connection(), &request.profile_id, allow_mock_runs).await?;
            profile_cache.insert(request.profile_id.to_string(), snapshot.clone());
            snapshot
        };
        let source = if snapshot.provider_id == annotation_domain::ProviderId::Mock {
            "mock"
        } else {
            "provider"
        };

        validate_context_on(tx.connection(), actor_id, &request).await?;
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
        let authorization =
            super::consent::authorize_request(tx.connection(), actor_id, &request).await?;
        validated.push(ValidatedRequest {
            authorization,
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

    let run_ids: Vec<&str> = validated.iter().map(|item| item.run_id.as_str()).collect();
    let enqueued = JobQueue::enqueue_on(
        tx.connection(),
        Some(&project_id),
        "model_run",
        operation_id,
        &json!({"run_ids": run_ids}),
    )
    .await
    .map_err(|error| match error {
        crate::jobs::queue::QueueError::QueueFull => RunFailure::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "RUN_QUEUE_FULL",
            "The model job queue is full",
        ),
        crate::jobs::queue::QueueError::IdempotencyConflict => RunFailure::new(
            StatusCode::CONFLICT,
            "IDEMPOTENCY_KEY_REUSE",
            "operation_id was reused with a different request",
        ),
        _ => storage_failure("RUN_CREATE_FAILED", "Could not enqueue the model run job"),
    })?;
    let mut summaries = Vec::with_capacity(validated.len());
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
        super::consent::record_authorization(tx.connection(), &item.run_id, &item.authorization)
            .await?;
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

pub(crate) async fn resolve_profile_on(
    connection: &mut SqliteConnection,
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

    let row = sqlx::query(
        "SELECT provider_id, model_id, auth_kind, capabilities_json, availability, verification, \
                runtime_version, verified_at FROM model_profiles WHERE profile_id=?",
    )
    .bind(profile_id)
    .fetch_optional(&mut *connection)
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
    if provider_id == annotation_domain::ProviderId::CodexLocal {
        return Err(RunFailure::new(
            StatusCode::CONFLICT,
            "PROVIDER_RETIRED",
            "Codex is retained for historical records only",
        ));
    }
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

pub(crate) async fn validate_context_on(
    connection: &mut SqliteConnection,
    actor_id: &str,
    request: &StartRunRequest,
) -> Result<(), RunFailure> {
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
    .fetch_optional(&mut *connection)
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
    if *project_id != *context.project_id {
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
    .fetch_optional(&mut *connection)
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
    Ok(())
}

/// Cancels a run. Idempotent: repeating the call returns the same summary and
/// never appends a second cancellation event or moves a terminal run.
pub async fn cancel(
    repository: &Repository,
    run_tokens: &crate::runtime::run_tokens::RunTokenStore,
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
    // User cancel invalidates the run's bearer tokens immediately (C5): the
    // tool endpoint also re-checks run state per call, but the token itself
    // must die here, wherever the cancel came from.
    run_tokens.revoke_run(run_id);
    let mut record = record;
    record.state = RunState::Cancelled;
    record.cancel_requested = true;
    record.cost_display = cost_display.to_owned();
    record.finished_at = Some(now);
    Ok(record.summary())
}

/// Startup recovery: runs left in flight by a crash become `interrupted` and
/// their cost display becomes `unknown`. Interrupted runs are never resent.
pub async fn recover_interrupted(
    repository: &Repository,
    run_tokens: &crate::runtime::run_tokens::RunTokenStore,
) -> Result<u64, sqlx::Error> {
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
        // An interrupted run is terminal: its bearer tokens die with it.
        run_tokens.revoke_run(&run_id);
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
        &state.run_tokens,
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

/// Read-only observations, not accuracy, human attribution or ROI.
pub(super) async fn outcome_summary(
    State(state): State<AiState>,
    Path(run_id): Path<String>,
    Extension(actor): Extension<Principal>,
) -> Response {
    let result = async {
        let failed = || crate::ai::failure_response(StatusCode::INTERNAL_SERVER_ERROR,"OUTCOME_SUMMARY_FAILED","Could not read outcome summary");
        let mut tx = state.repository.begin_write().await.map_err(|_|failed())?;
        let record = load_record(tx.connection(), &run_id).await.map_err(|_|failed())?.ok_or_else(||crate::ai::failure_response(StatusCode::NOT_FOUND,"RUN_NOT_FOUND","Model run not found"))?;
        if member_role(tx.connection(),&record.project_id,&actor.user_id).await.map_err(|_|failed())?.is_none() { return Err(crate::ai::failure_response(StatusCode::NOT_FOUND,"RUN_NOT_FOUND","Model run not found")); }
        let count: i64 = sqlx::query_scalar("SELECT COALESCE(sum(json_array_length(changes_json)),0) FROM suggestion_sets WHERE run_id=?").bind(&run_id).fetch_one(tx.connection()).await.map_err(|_|failed())?;
        let totals=sqlx::query("SELECT count(CASE WHEN d.decision='accept' THEN 1 END) AS accepts,count(CASE WHEN d.decision='revert' THEN 1 END) AS reverts FROM suggestion_decisions d JOIN suggestion_sets s ON s.suggestion_set_id=d.suggestion_set_id WHERE s.run_id=?").bind(&run_id).fetch_one(tx.connection()).await.map_err(|_|failed())?;
        let accepts: i64=totals.get("accepts");let reverts: i64=totals.get("reverts");
        // Fold append-only journal transitions in SQLite: only the latest accepted state of each change is effective.
        let accepted_rows=sqlx::query("SELECT d.suggestion_set_id,d.change_id,d.bound_revision_id,(SELECT COALESCE(json_extract(c.value,'$.object.object_id'),json_extract(c.value,'$.object_id')) FROM json_each(s.changes_json) c WHERE json_extract(c.value,'$.change_id')=d.change_id) AS object_id FROM suggestion_decisions d JOIN suggestion_sets s ON s.suggestion_set_id=d.suggestion_set_id WHERE s.run_id=? AND d.decision='accept' AND NOT EXISTS(SELECT 1 FROM suggestion_decisions later WHERE later.suggestion_set_id=d.suggestion_set_id AND later.change_id=d.change_id AND later.rowid>d.rowid) ORDER BY d.rowid").bind(&run_id).fetch_all(tx.connection()).await.map_err(|_|failed())?;
        let rejected: i64=sqlx::query_scalar("SELECT count(*) FROM suggestion_sets s,json_each(s.changes_json) c WHERE s.run_id=? AND (EXISTS(SELECT 1 FROM suggestion_change_rejections r WHERE r.suggestion_set_id=s.suggestion_set_id AND r.change_id=json_extract(c.value,'$.change_id')) OR EXISTS(SELECT 1 FROM suggestion_set_states st WHERE st.suggestion_set_id=s.suggestion_set_id AND st.state='rejected'))").bind(&run_id).fetch_one(tx.connection()).await.map_err(|_|failed())?;
        let head: Option<String>=sqlx::query_scalar("SELECT r.body_json FROM annotation_heads h JOIN annotation_revisions r ON r.annotation_revision_id=h.annotation_revision_id WHERE h.project_id=? AND h.asset_revision_id=? AND h.ontology_version_id=?").bind(&record.project_id).bind(&record.asset_revision_id).bind(&record.ontology_version_id).fetch_optional(tx.connection()).await.map_err(|_|failed())?;
        let head: Option<annotation_domain::AnnotationDocument> = head.map(|v|serde_json::from_str(&v)).transpose().map_err(|_|failed())?;
        let head_objects: BTreeMap<&str,&annotation_domain::AnnotationObject>=head.as_ref().into_iter().flat_map(|document|document.objects.iter().map(|object|(&*object.object_id,object))).collect();
        let mut accepted_documents: BTreeMap<&str,annotation_domain::AnnotationDocument>=BTreeMap::new();
        let mut observations=Vec::with_capacity(accepted_rows.len());
        for row in &accepted_rows {
            let set_id: &str=row.get("suggestion_set_id");let change_id: &str=row.get("change_id");let revision: &str=row.get("bound_revision_id");
            let object_id: &str=row.try_get::<Option<&str>,_>("object_id").map_err(|_|failed())?.ok_or_else(failed)?;
            // Several changes can belong to one saved revision: deserialize that immutable document only once.
            if !accepted_documents.contains_key(revision) {
                let body: String=sqlx::query_scalar("SELECT body_json FROM annotation_revisions WHERE annotation_revision_id=? AND project_id=?").bind(revision).bind(&record.project_id).fetch_one(tx.connection()).await.map_err(|_|failed())?;
                accepted_documents.insert(revision,serde_json::from_str(&body).map_err(|_|failed())?);
            }
            let accepted=accepted_documents.get(revision).expect("accepted revision loaded above");
            let before=accepted.objects.iter().find(|object|&*object.object_id==object_id);
            let current=head_objects.get(object_id).copied();
            let status=if head.is_none() || before.is_none() {"unknown"} else if current.is_none() {"absent_from_current_head"} else if before.map(object_hash)==current.map(object_hash) {"unchanged_since_acceptance"} else {"changed_since_acceptance"};
            observations.push(json!({"suggestion_set_id":set_id,"change_id":change_id,"object_id":object_id,"accepted_revision_id":revision,"current_status":status,"attribution":"unknown"}));
        }
        // Match every historical decision only to a submitted exact, existing revision.
        let task_rows = sqlx::query(r#"
            SELECT t.task_id, t.state AS task_state, rs.review_id, rs.state AS review_state,
                   r.annotation_revision_id, r.asset_revision_id, r.ontology_version_id,
                   json_group_array(DISTINCT d.decision) AS decision_kinds,
                   json_group_array(DISTINCT s.suggestion_set_id) AS suggestion_set_ids
            FROM suggestion_decisions d
            JOIN suggestion_sets s ON s.suggestion_set_id=d.suggestion_set_id
            JOIN annotation_revisions r ON r.annotation_revision_id=d.bound_revision_id
                 AND r.project_id=s.project_id AND r.asset_revision_id=s.asset_revision_id
            JOIN review_submissions rs ON rs.project_id=r.project_id
            JOIN json_each(rs.revision_ids_json) submitted
                 ON submitted.type='text' AND submitted.value=r.annotation_revision_id
            JOIN review_tasks t ON t.task_id=rs.task_id AND t.project_id=r.project_id
                 AND t.asset_revision_id=r.asset_revision_id AND t.ontology_version_id=r.ontology_version_id
            WHERE s.run_id=? AND r.project_id=? AND r.asset_revision_id=? AND r.ontology_version_id=?
            GROUP BY rs.review_id,r.annotation_revision_id
            ORDER BY rs.review_id,r.annotation_revision_id LIMIT 101
        "#)
            .bind(&run_id).bind(&record.project_id).bind(&record.asset_revision_id).bind(&record.ontology_version_id).fetch_all(tx.connection()).await.map_err(|_|failed())?;
        let mut submissions = Vec::with_capacity(task_rows.len().min(100));
        for row in task_rows.iter().take(100) {
            let mut kinds: Vec<String> = serde_json::from_str(row.get::<&str,_>("decision_kinds")).map_err(|_|failed())?;
            let mut sets: Vec<String> = serde_json::from_str(row.get::<&str,_>("suggestion_set_ids")).map_err(|_|failed())?;
            kinds.sort(); sets.sort();
            submissions.push(json!({"task_id":row.get::<&str,_>("task_id"),"review_id":row.get::<&str,_>("review_id"),"annotation_revision_id":row.get::<&str,_>("annotation_revision_id"),"asset_revision_id":row.get::<&str,_>("asset_revision_id"),"ontology_version_id":row.get::<&str,_>("ontology_version_id"),"task_state":row.get::<&str,_>("task_state"),"review_state":row.get::<&str,_>("review_state"),"decision_kinds":kinds,"suggestion_set_ids":sets}));
        }
        let task_binding = if submissions.is_empty() { Value::Null } else { json!({"basis":"exact_decision_revision_submission","submissions":submissions,"truncated":task_rows.len()>100}) };
        // Published intervals are actor-owned. Old unbound records are unknown, not zero.
        // Integer milliseconds are summed before conversion to seconds.
        let work = sqlx::query("SELECT count(*) AS matched,COALESCE(sum(CASE WHEN json_extract(i.value,'$.kind')!='model_wait' THEN CAST(json_extract(i.value,'$.duration_ms') AS INTEGER) ELSE 0 END),0) AS human_ms FROM activity_sessions a,json_each(a.intervals_json) i WHERE a.project_id=? AND a.actor_id=? AND json_extract(i.value,'$.run_id')=?")
            .bind(&record.project_id).bind(&actor.user_id).bind(&run_id).fetch_one(tx.connection()).await.map_err(|_|failed())?;
        let matched: i64 = work.get("matched");
        let recorded_work_seconds = if matched == 0 { None } else { Some(work.get::<i64,_>("human_ms") as f64 / 1000.0) };
        let work_time_reason = if matched == 0 { "No current-actor published interval explicitly binds this run" } else { "Measured current-actor explicit run intervals; model_wait excluded" };
        let task_work = sqlx::query("SELECT json_extract(i.value,'$.task_id') AS task_id,COALESCE(sum(CASE WHEN json_extract(i.value,'$.kind')!='model_wait' THEN CAST(json_extract(i.value,'$.duration_ms') AS INTEGER) ELSE 0 END),0) AS human_ms FROM activity_sessions a,json_each(a.intervals_json) i WHERE a.project_id=? AND a.actor_id=? AND json_extract(i.value,'$.run_id')=? AND json_type(i.value,'$.task_id')='text' GROUP BY task_id ORDER BY task_id")
            .bind(&record.project_id).bind(&actor.user_id).bind(&run_id).fetch_all(tx.connection()).await.map_err(|_|failed())?;
        let activity_task_bindings: Vec<Value> = task_work.iter().map(|row| json!({"task_id":row.get::<&str,_>("task_id"),"recorded_work_seconds":row.get::<i64,_>("human_ms") as f64/1000.0,"basis":"explicit_voluntary_run_task_interval"})).collect();
        let usage: Option<String>=sqlx::query_scalar("SELECT usage_json FROM model_runs WHERE run_id=?").bind(&run_id).fetch_one(tx.connection()).await.map_err(|_|failed())?;
        let mut usage: Value=usage.map(|s|serde_json::from_str(&s)).transpose().map_err(|_|failed())?.unwrap_or(Value::Null);
        crate::ai::redact_json(&mut usage);
        let net_accepted=accepted_rows.len();
        tx.commit().await.map_err(|_|failed())?;
        Ok(Json(json!({"run":record.summary(),"candidate_change_count":count,"accepted_change_count":net_accepted,"accept_journal_count":accepts,"revert_journal_count":reverts,"rejected_change_count":rejected,"object_observations":observations,"task_binding":task_binding,"activity_task_bindings":activity_task_bindings,"recorded_work_seconds":recorded_work_seconds,"work_time_scope":"current_actor_explicit_run_intervals","work_time_reason":work_time_reason,"usage":usage,"cost_display":record.cost_display,"accuracy":null,"roi":null})).into_response())
    }.await;
    result.unwrap_or_else(|e| e)
}
