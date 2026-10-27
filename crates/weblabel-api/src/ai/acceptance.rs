//! Server-side suggestion acceptance: decision journal and provenance checks.
//!
//! Accepting or reverting a suggestion is never a standalone write: the
//! decision journal rows, the new annotation revision and the head update all
//! run in the caller's single SQLite save transaction (contract C1/§6). The
//! journal is append-only and records the ordered accept/revert transitions of
//! every change, so `accept -> revert` is never silently deduplicated and a
//! change can only be accepted again after it was reverted. Source predictions
//! are immutable: acceptance only references them.

use std::collections::{BTreeMap, HashSet};

use annotation_domain::{
    suggestion_validation::{
        change_id as change_id_of, validate_suggestions, AcceptanceContext, RunGate, MAX_CHANGE_IDS,
    },
    AnnotationDocument, AnnotationObject, Change, DomainError, Id, ModelCapabilities, ModelProfile,
    OntologyVersion, OriginType, ProviderId, RunContext, RunIntent, SuggestionDecision,
};
use axum::{
    body::{to_bytes, Body},
    extract::{Path, State},
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::{
    ai::{failure_response, AiState},
    auth::Principal,
};

use sqlx::{Row, SqliteConnection};

use crate::annotations::Failure;

/// Identity of the save being prepared: the pins the decisions must match.
pub(crate) struct SavePins<'a> {
    pub project_id: &'a str,
    pub asset_revision_id: &'a str,
    pub canonical_sha256: &'a str,
    pub base_document: &'a AnnotationDocument,
    pub ontology: &'a OntologyVersion,
}

/// One journal row to write for the save, in intent/change order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct JournalRow {
    pub suggestion_set_id: String,
    pub change_id: String,
    pub decision: SuggestionDecision,
}

/// A net-accepted creation whose provenance may appear in the saved document.
#[derive(Debug, Clone)]
pub(crate) struct VerifiedCreate {
    pub prediction_id: Id,
    pub model_run_id: Id,
}

/// Everything `record` needs; produced by `prepare` without any write so a
/// rejected save can never leave partial state behind.
#[derive(Debug, Default)]
pub(crate) struct PreparedDecisions {
    pub rows: Vec<JournalRow>,
    /// Coverage keyed by created object id.
    pub creates: BTreeMap<String, VerifiedCreate>,
    /// Recomputed `suggestion_set_states` for the touched sets.
    pub set_states: Vec<(String, &'static str)>,
}

impl PreparedDecisions {
    /// Prediction provenance in the saved document must be covered by a
    /// net-accepted create change of the exact same prediction and run
    /// (contract C1: origin references must really exist and belong here).
    pub(crate) fn verify_prediction_object(
        &self,
        object: &AnnotationObject,
    ) -> Result<(), Failure> {
        let covered = object.origin.kind == OriginType::Prediction
            && self
                .creates
                .get(&*object.object_id)
                .is_some_and(|verified| {
                    object.origin.prediction_id.as_ref() == Some(&verified.prediction_id)
                        && object.origin.model_run_id.as_ref() == Some(&verified.model_run_id)
                });
        if covered {
            Ok(())
        } else {
            Err(failure(
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                "UNVERIFIED_PROVENANCE",
                "prediction provenance must be covered by an accepted create change",
            ))
        }
    }
}

/// Everything the validator needs about one stored suggestion set.
struct SetFacts {
    prediction_id: Id,
    model_run_id: Id,
    context: RunContext,
    changes: Vec<Change>,
    run_intent: RunIntent,
    provider_id: ProviderId,
    capabilities: ModelCapabilities,
    state: String,
}

/// Final decision state per change of a set after this save's intents.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ChangeState {
    Accepted,
    Reverted,
}

fn state_of(decision: SuggestionDecision) -> ChangeState {
    match decision {
        SuggestionDecision::Accept => ChangeState::Accepted,
        SuggestionDecision::Revert => ChangeState::Reverted,
    }
}

/// A stored suggestion set of the save's asset with its journal state.
struct AssetSet {
    prediction_id: Id,
    model_run_id: Id,
    changes: Vec<Change>,
    journal: BTreeMap<String, ChangeState>,
}

/// Validates the ordered decision intents of one save against the stored
/// suggestion sets, the base revision document and the journal history.
pub(crate) async fn prepare(
    connection: &mut SqliteConnection,
    pins: &SavePins<'_>,
    request: &annotation_domain::SaveRequest,
) -> Result<PreparedDecisions, Failure> {
    if request.suggestion_decisions.is_empty() {
        return Ok(PreparedDecisions::default());
    }
    let mut prepared = PreparedDecisions::default();
    let mut facts: BTreeMap<String, SetFacts> = BTreeMap::new();
    // Journal state per touched set, including this save's rows in order.
    let mut states: BTreeMap<String, BTreeMap<String, ChangeState>> = BTreeMap::new();

    for intent in &request.suggestion_decisions {
        let set_id = &*intent.suggestion_set_id;
        if !facts.contains_key(set_id) {
            let loaded = load_set_facts(connection, pins, set_id).await?;
            facts.insert(set_id.to_owned(), loaded);
            states.insert(set_id.to_owned(), load_journal(connection, set_id).await?);
        }
        let facts = facts.get(set_id).expect("facts loaded above");
        if intent.decision == SuggestionDecision::Accept
            && matches!(facts.state.as_str(), "rejected" | "stale")
        {
            return Err(failure(
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                "SUGGESTION_SET_NOT_APPLICABLE",
                "rejected or stale suggestion sets cannot be accepted",
            ));
        }
        match intent.decision {
            SuggestionDecision::Accept => {
                for change_id in &intent.change_ids {
                    let rejected: i64 = sqlx::query_scalar("SELECT count(*) FROM suggestion_change_rejections WHERE suggestion_set_id=? AND change_id=?")
                        .bind(set_id).bind(&**change_id).fetch_one(&mut *connection).await.map_err(|_| storage_failure())?;
                    if rejected != 0 {
                        return Err(failure(
                            axum::http::StatusCode::CONFLICT,
                            "CHANGE_REJECTED",
                            "Rejected changes cannot be accepted",
                        ));
                    }
                }
                // The same shared validation the editor core runs, pinned to
                // the base revision document of this save transaction.
                let context = AcceptanceContext {
                    document: pins.base_document,
                    ontology: pins.ontology,
                    expected_generation: None,
                    current_generation: None,
                    base_revision_id: None,
                    canonical_sha256: Some(pins.canonical_sha256),
                    run: Some(RunGate {
                        intent: facts.run_intent,
                        provider_id: facts.provider_id,
                        capabilities: &facts.capabilities,
                    }),
                };
                let set = suggestion_set(facts, set_id);
                validate_suggestions(&context, &set, &intent.change_ids).map_err(domain_failure)?;
            }
            SuggestionDecision::Revert => {
                // Symmetric with the accept path: same caps, same non-empty
                // requirement, and O(1) membership instead of per-id scans.
                if intent.change_ids.is_empty() {
                    return Err(failure(
                        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                        "EMPTY_SELECTION",
                        "a decision must name at least one change",
                    ));
                }
                if intent.change_ids.len() > MAX_CHANGE_IDS {
                    return Err(failure(
                        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                        "TOO_MANY_CHANGES",
                        "at most 1000 changes may be referenced at once",
                    ));
                }
                let known: HashSet<&str> = facts
                    .changes
                    .iter()
                    .map(|change| &**change_id_of(change))
                    .collect();
                for change_id in &intent.change_ids {
                    if !known.contains(&**change_id) {
                        return Err(failure(
                            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                            "CHANGE_NOT_FOUND",
                            "reverted change_id does not belong to the suggestion set",
                        ));
                    }
                }
            }
        }

        let journal = states.get_mut(set_id).expect("journal loaded above");
        for change_id in &intent.change_ids {
            let previous = journal.get(&**change_id);
            let allowed = match intent.decision {
                SuggestionDecision::Accept => {
                    previous.is_none_or(|state| *state == ChangeState::Reverted)
                }
                SuggestionDecision::Revert => previous == Some(&ChangeState::Accepted),
            };
            if !allowed {
                let (code, message) = match intent.decision {
                    SuggestionDecision::Accept => (
                        "ALREADY_ACCEPTED",
                        "change is already accepted; revert it before accepting again",
                    ),
                    SuggestionDecision::Revert => (
                        "REVERT_WITHOUT_ACCEPT",
                        "only accepted changes can be reverted",
                    ),
                };
                return Err(failure(
                    axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                    code,
                    message,
                ));
            }
            journal.insert(change_id.to_string(), state_of(intent.decision));
            prepared.rows.push(JournalRow {
                suggestion_set_id: set_id.to_owned(),
                change_id: change_id.to_string(),
                decision: intent.decision,
            });
        }
    }

    // Provenance coverage and set states are computed over the complete valid
    // sequence: every stored journal row plus this save's rows in order.
    let mut asset_sets = load_asset_sets(connection, pins).await?;
    for row in &prepared.rows {
        if let Some(asset_set) = asset_sets.get_mut(&row.suggestion_set_id) {
            asset_set
                .journal
                .insert(row.change_id.clone(), state_of(row.decision));
        }
    }
    let mut coverage: BTreeMap<String, VerifiedCreate> = BTreeMap::new();
    for asset_set in asset_sets.values() {
        for change in &asset_set.changes {
            let Change::Create { object, .. } = change else {
                continue;
            };
            if asset_set.journal.get(&**change_id_of(change)) != Some(&ChangeState::Accepted) {
                continue;
            }
            if coverage.contains_key(&*object.object_id) {
                return Err(failure(
                    axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                    "DUPLICATE_OBJECT_ID",
                    "one object cannot be created by two accepted changes",
                ));
            }
            coverage.insert(
                object.object_id.to_string(),
                VerifiedCreate {
                    prediction_id: asset_set.prediction_id.clone(),
                    model_run_id: asset_set.model_run_id.clone(),
                },
            );
        }
    }
    prepared.creates = coverage;

    // Reverts may remove historical accepted effects, but never reopen a
    // terminal set. Only non-terminal states are derived from journal counts.
    for (set_id, facts) in &facts {
        let journal = states.get(set_id).expect("journal loaded above");
        let mut accepted = 0usize;
        for change in &facts.changes {
            if journal.get(&**change_id_of(change)) == Some(&ChangeState::Accepted) {
                accepted += 1;
            }
        }
        let state = if facts.state == "rejected" {
            "rejected"
        } else if facts.state == "stale" {
            "stale"
        } else if accepted == 0 {
            "pending"
        } else if accepted == facts.changes.len() {
            "accepted"
        } else {
            "partially_accepted"
        };
        prepared.set_states.push((set_id.clone(), state));
    }
    Ok(prepared)
}

/// Writes the journal rows and set states inside the caller's transaction,
/// bound to the revision id created by the same transaction.
pub(crate) async fn record(
    connection: &mut SqliteConnection,
    prepared: &PreparedDecisions,
    bound_revision_id: &str,
    actor_id: &str,
    created_at: &str,
) -> Result<(), Failure> {
    for row in &prepared.rows {
        sqlx::query(
            "INSERT INTO suggestion_decisions( \
                decision_id, suggestion_set_id, change_id, decision, bound_revision_id, \
                actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&row.suggestion_set_id)
        .bind(&row.change_id)
        .bind(match row.decision {
            SuggestionDecision::Accept => "accept",
            SuggestionDecision::Revert => "revert",
        })
        .bind(bound_revision_id)
        .bind(actor_id)
        .bind(created_at)
        .execute(&mut *connection)
        .await
        .map_err(|_| storage_failure())?;
    }
    for (set_id, state) in &prepared.set_states {
        sqlx::query(
            "INSERT INTO suggestion_set_states(suggestion_set_id, state, updated_at) \
             VALUES (?, ?, ?) \
             ON CONFLICT(suggestion_set_id) DO UPDATE SET \
                state=excluded.state, updated_at=excluded.updated_at",
        )
        .bind(set_id)
        .bind(*state)
        .bind(created_at)
        .execute(&mut *connection)
        .await
        .map_err(|_| storage_failure())?;
    }
    Ok(())
}

fn suggestion_set(facts: &SetFacts, set_id: &str) -> annotation_domain::SuggestionSet {
    annotation_domain::SuggestionSet {
        suggestion_set_id: Id::from(set_id),
        model_run_id: facts.model_run_id.clone(),
        prediction_id: facts.prediction_id.clone(),
        context: facts.context.clone(),
        changes: facts.changes.clone(),
        issues: Vec::new(),
        score: None,
        state: annotation_domain::SuggestionState::Pending,
    }
}

async fn load_set_facts(
    connection: &mut SqliteConnection,
    pins: &SavePins<'_>,
    set_id: &str,
) -> Result<SetFacts, Failure> {
    let row = sqlx::query(
        "SELECT s.prediction_id, s.asset_revision_id AS set_asset, s.changes_json, \
                COALESCE(st.state,'pending') AS set_state, \
                r.run_id, r.provider_id, r.intent, r.profile_snapshot_json, r.context_json \
         FROM suggestion_sets s JOIN model_runs r ON r.run_id = s.run_id \
         LEFT JOIN suggestion_set_states st ON st.suggestion_set_id=s.suggestion_set_id \
         WHERE s.suggestion_set_id=? AND s.project_id=?",
    )
    .bind(set_id)
    .bind(pins.project_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|_| storage_failure())?;
    let Some(row) = row else {
        return Err(failure(
            axum::http::StatusCode::NOT_FOUND,
            "SUGGESTION_SET_NOT_FOUND",
            "suggestion set does not exist in this project",
        ));
    };
    let state: String = row.try_get("set_state").map_err(|_| storage_failure())?;
    let set_asset: String = row.try_get("set_asset").map_err(|_| storage_failure())?;
    if set_asset != pins.asset_revision_id {
        return Err(failure(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "STALE_ASSET",
            "suggestion set belongs to a different asset revision",
        ));
    }
    let prediction_id: String = row
        .try_get("prediction_id")
        .map_err(|_| storage_failure())?;
    let prediction_owned: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM predictions \
         WHERE prediction_id=? AND project_id=? AND asset_revision_id=?)",
    )
    .bind(&prediction_id)
    .bind(pins.project_id)
    .bind(pins.asset_revision_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| storage_failure())?;
    if prediction_owned == 0 {
        return Err(failure(
            axum::http::StatusCode::NOT_FOUND,
            "SUGGESTION_SET_NOT_FOUND",
            "source prediction does not exist in this project and asset",
        ));
    }

    let context: annotation_domain::RunContext = parse_context(
        &row.try_get::<String, _>("context_json")
            .map_err(|_| storage_failure())?,
    )?;
    if context.canonical_sha256 != pins.canonical_sha256 {
        return Err(failure(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "STALE_CANONICAL_HASH",
            "canonical media hash changed since the run",
        ));
    }
    if context.ontology_version_id != pins.base_document.ontology_version_id {
        return Err(failure(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "STALE_ONTOLOGY",
            "suggestion set was produced against another ontology version",
        ));
    }
    // The run's pinned revision must belong to this asset's history.
    let pinned_owned: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM annotation_revisions \
         WHERE annotation_revision_id=? AND project_id=? AND asset_revision_id=?)",
    )
    .bind(&*context.annotation_revision_id)
    .bind(pins.project_id)
    .bind(pins.asset_revision_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| storage_failure())?;
    if pinned_owned == 0 {
        return Err(failure(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "STALE_BASE_REVISION",
            "suggestion set was produced against another annotation revision",
        ));
    }

    let changes_json: String = row.try_get("changes_json").map_err(|_| storage_failure())?;
    let changes: Vec<Change> = serde_json::from_str(&changes_json).map_err(|_| corrupt_record())?;
    let intent: String = row.try_get("intent").map_err(|_| storage_failure())?;
    let run_intent = parse_intent(&intent).ok_or_else(corrupt_record)?;
    let provider_id: String = row.try_get("provider_id").map_err(|_| storage_failure())?;
    let provider_id = parse_provider(&provider_id).ok_or_else(corrupt_record)?;
    let snapshot_json: String = row
        .try_get("profile_snapshot_json")
        .map_err(|_| storage_failure())?;
    let snapshot: ModelProfile =
        serde_json::from_str(&snapshot_json).map_err(|_| corrupt_record())?;
    let model_run_id: String = row.try_get("run_id").map_err(|_| storage_failure())?;
    Ok(SetFacts {
        prediction_id: Id::from(prediction_id),
        model_run_id: Id::from(model_run_id),
        context,
        changes,
        run_intent,
        provider_id,
        capabilities: snapshot.capabilities,
        state,
    })
}

/// Loads every suggestion set of the save's asset with its journal state.
async fn load_asset_sets(
    connection: &mut SqliteConnection,
    pins: &SavePins<'_>,
) -> Result<BTreeMap<String, AssetSet>, Failure> {
    let rows = sqlx::query(
        "SELECT suggestion_set_id, prediction_id, run_id, changes_json FROM suggestion_sets \
         WHERE project_id=? AND asset_revision_id=?",
    )
    .bind(pins.project_id)
    .bind(pins.asset_revision_id)
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| storage_failure())?;
    let mut sets = BTreeMap::new();
    for row in rows {
        let set_id: String = row
            .try_get("suggestion_set_id")
            .map_err(|_| storage_failure())?;
        let changes_json: String = row.try_get("changes_json").map_err(|_| storage_failure())?;
        let changes: Vec<Change> =
            serde_json::from_str(&changes_json).map_err(|_| corrupt_record())?;
        sets.insert(
            set_id.clone(),
            AssetSet {
                prediction_id: Id::from(
                    row.try_get::<String, _>("prediction_id")
                        .map_err(|_| storage_failure())?,
                ),
                model_run_id: Id::from(
                    row.try_get::<String, _>("run_id")
                        .map_err(|_| storage_failure())?,
                ),
                changes,
                journal: load_journal(connection, &set_id).await?,
            },
        );
    }
    Ok(sets)
}

async fn load_journal(
    connection: &mut SqliteConnection,
    set_id: &str,
) -> Result<BTreeMap<String, ChangeState>, Failure> {
    let rows = sqlx::query(
        "SELECT change_id, decision FROM suggestion_decisions \
         WHERE suggestion_set_id=? ORDER BY rowid",
    )
    .bind(set_id)
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| storage_failure())?;
    let mut journal = BTreeMap::new();
    for row in rows {
        let change_id: String = row.try_get("change_id").map_err(|_| storage_failure())?;
        let decision: String = row.try_get("decision").map_err(|_| storage_failure())?;
        let decision = match decision.as_str() {
            "accept" => SuggestionDecision::Accept,
            "revert" => SuggestionDecision::Revert,
            _ => return Err(corrupt_record()),
        };
        journal.insert(change_id, state_of(decision));
    }
    Ok(journal)
}

fn parse_context(json: &str) -> Result<annotation_domain::RunContext, Failure> {
    serde_json::from_str(json).map_err(|_| corrupt_record())
}

/// Parses the run intent string stored with the model run.
fn parse_intent(value: &str) -> Option<RunIntent> {
    match value {
        "detect" => Some(RunIntent::Detect),
        "audit_attributes" => Some(RunIntent::AuditAttributes),
        "find_issues" => Some(RunIntent::FindIssues),
        _ => None,
    }
}

/// Parses the provider id string stored with the profile snapshot.
fn parse_provider(value: &str) -> Option<ProviderId> {
    match value {
        "codex_local" => Some(ProviderId::CodexLocal),
        "claude_local" => Some(ProviderId::ClaudeLocal),
        "openai_api" => Some(ProviderId::OpenaiApi),
        "anthropic_api" => Some(ProviderId::AnthropicApi),
        "mimo_api" => Some(ProviderId::MimoApi),
        "detector_local" => Some(ProviderId::DetectorLocal),
        "mock" => Some(ProviderId::Mock),
        _ => None,
    }
}

/// Maps a domain error from the shared validation to the save failure shape.
fn domain_failure(error: DomainError) -> Failure {
    failure(
        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        error.code,
        "suggestion decision rejected by domain validation",
    )
}

fn failure(status: axum::http::StatusCode, code: &'static str, message: &'static str) -> Failure {
    Failure::new(status, code, message)
}

fn corrupt_record() -> Failure {
    failure(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "RUN_RECORD_CORRUPT",
        "stored run or suggestion record is invalid",
    )
}

fn storage_failure() -> Failure {
    failure(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "SUGGESTION_DECISION_FAILED",
        "could not read suggestion decision state",
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DecisionRequest {
    decision: String,
}

/// A standalone accept is forbidden: only the annotation save transaction can
/// append accept/revert journal entries. Reject is an idempotent state update.
pub(super) async fn decision_route(
    State(state): State<AiState>,
    Extension(principal): Extension<Principal>,
    Path(set_id): Path<String>,
    request: Request<Body>,
) -> Response {
    let body = match to_bytes(request.into_body(), 4096).await {
        Ok(body) => body,
        Err(_) => {
            return failure_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "DECISION_TOO_LARGE",
                "Decision request is too large",
            )
        }
    };
    let body: DecisionRequest = match serde_json::from_slice(&body) {
        Ok(body) => body,
        Err(_) => {
            return failure_response(
                StatusCode::BAD_REQUEST,
                "INVALID_DECISION",
                "Request must contain a supported decision",
            )
        }
    };
    if body.decision == "accept" {
        return failure_response(
            StatusCode::CONFLICT,
            "ACCEPT_REQUIRES_SAVE",
            "Acceptance must be included in the annotation save transaction",
        );
    }
    if body.decision != "reject" {
        return failure_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_DECISION",
            "decision must be reject or accept",
        );
    }
    #[cfg(not(test))]
    let transaction = state.repository.begin_write().await;
    #[cfg(test)]
    let transaction = contention::begin_write(&state.repository).await;
    let mut tx = match transaction {
        Ok(tx) => tx,
        Err(_) => {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DECISION_FAILED",
                "Could not start decision transaction",
            )
        }
    };
    let row = match sqlx::query(
        "SELECT s.project_id, COALESCE(st.state,'pending') AS state FROM suggestion_sets s \
         LEFT JOIN suggestion_set_states st ON st.suggestion_set_id=s.suggestion_set_id \
         WHERE s.suggestion_set_id=?",
    )
    .bind(&set_id)
    .fetch_optional(tx.connection())
    .await
    {
        Ok(Some(row)) => row,
        Ok(None) => {
            return failure_response(
                StatusCode::NOT_FOUND,
                "SUGGESTION_NOT_FOUND",
                "Suggestion set was not found",
            )
        }
        Err(_) => {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DECISION_FAILED",
                "Could not read suggestion state",
            )
        }
    };
    let project_id: String = match row.try_get("project_id") {
        Ok(value) => value,
        Err(_) => {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DECISION_FAILED",
                "Could not read suggestion state",
            )
        }
    };
    let current: String = match row.try_get("state") {
        Ok(value) => value,
        Err(_) => {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DECISION_FAILED",
                "Could not read suggestion state",
            )
        }
    };
    let role: Option<String> =
        match sqlx::query_scalar("SELECT role FROM memberships WHERE project_id=? AND user_id=?")
            .bind(&project_id)
            .bind(&principal.user_id)
            .fetch_optional(tx.connection())
            .await
        {
            Ok(role) => role,
            Err(_) => {
                return failure_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "DECISION_FAILED",
                    "Could not verify project membership",
                )
            }
        };
    if !matches!(role.as_deref(), Some("admin" | "annotator")) {
        return failure_response(
            StatusCode::NOT_FOUND,
            "SUGGESTION_NOT_FOUND",
            "Suggestion set was not found",
        );
    }
    if let Err(response) =
        super::suggestions::rejection_scope(tx.connection(), &set_id, &principal.user_id, true)
            .await
    {
        return response;
    }
    // Read the latest decision for every change under the same immediate
    // write transaction as rejection; a cached aggregate is not authoritative.
    let journal = match load_journal(tx.connection(), &set_id).await {
        Ok(journal) => journal,
        Err(_) => {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DECISION_FAILED",
                "Could not read suggestion decisions",
            )
        }
    };
    if journal
        .values()
        .any(|state| *state == ChangeState::Accepted)
    {
        return failure_response(
            StatusCode::CONFLICT,
            "ACCEPTED_SET_REQUIRES_REVERT",
            "Accepted changes must be reverted in an annotation save before rejection",
        );
    }
    if current == "rejected" {
        if tx.commit().await.is_err() {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DECISION_FAILED",
                "Could not confirm decision",
            );
        }
        return (StatusCode::OK, Json(json!({"suggestion_set_id": set_id, "state": "rejected", "idempotent_replay": true}))).into_response();
    }
    let updated = sqlx::query(
        "INSERT INTO suggestion_set_states(suggestion_set_id,state,updated_at) VALUES(?,'rejected',?) \
         ON CONFLICT(suggestion_set_id) DO UPDATE SET state='rejected',updated_at=excluded.updated_at \
         WHERE suggestion_set_states.state IN ('pending','partially_accepted')",
    ).bind(&set_id).bind(crate::projects::now_rfc3339()).execute(tx.connection()).await;
    if updated.is_err() || tx.commit().await.is_err() {
        return failure_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "DECISION_FAILED",
            "Could not persist suggestion rejection",
        );
    }
    (
        StatusCode::OK,
        Json(json!({"suggestion_set_id": set_id, "state": "rejected", "idempotent_replay": false})),
    )
        .into_response()
}

// Request-local test synchronization; absent from production builds.
#[cfg(test)]
pub(super) mod contention {
    use crate::storage::{Repository, WriteTransaction};
    use std::{future::Future, sync::Arc};
    use tokio::sync::Notify;

    #[derive(Default)]
    pub struct Hook {
        pub acquired: Notify,
        pub waiting: Notify,
        pub release: Notify,
        pub hold: bool,
    }
    tokio::task_local! { pub static HOOK: Arc<Hook>; }

    pub async fn begin_write(repository: &Repository) -> Result<WriteTransaction, sqlx::Error> {
        let hook = HOOK.try_with(Arc::clone).ok();
        let mut begin = std::pin::pin!(repository.begin_write());
        let mut signaled = false;
        let tx = std::future::poll_fn(|cx| {
            let result = begin.as_mut().poll(cx);
            if result.is_pending() && !signaled {
                if let Some(hook) = &hook {
                    hook.waiting.notify_one();
                }
                signaled = true;
            }
            result
        })
        .await?;
        if let Some(hook) = hook {
            hook.acquired.notify_one();
            if hook.hold {
                hook.release.notified().await;
            }
        }
        Ok(tx)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use annotation_domain::{
        object_hash, AnnotationDocument, SaveRequest, SuggestionDecisionIntent,
    };
    use serde_json::{json, Value};
    use sqlx::Row;

    use super::*;
    use crate::storage::Repository;

    const PROJECT: &str = "project-1";
    const ASSET: &str = "asset-1";
    const ONTOLOGY: &str = "onto-1";
    const BASE_REVISION: &str = "rev-1";
    const USER: &str = "user-1";
    const CANONICAL: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    struct Graph {
        _directory: tempfile::TempDir,
        repository: Repository,
    }

    fn base_document() -> AnnotationDocument {
        serde_json::from_value(json!({
            "schema_version": 1,
            "asset_revision_id": ASSET,
            "ontology_version_id": ONTOLOGY,
            "coordinate_space": {"type": "canonical_image_pixels", "width": 640, "height": 480},
            "completion": "in_progress",
            "objects": [{
                "object_id": "object_person_001",
                "label_id": "label_person",
                "geometry": {"type": "bbox_xyxy", "x_min": 10.0, "y_min": 20.0, "x_max": 110.0, "y_max": 220.0},
                "attributes": {"helmet_state": "unknown"},
                "origin": {"type": "manual", "prediction_id": null, "model_run_id": null, "import_batch_id": null}
            }]
        }))
        .unwrap()
    }

    fn fixture_ontology() -> OntologyVersion {
        serde_json::from_value(json!({
            "ontology_version_id": ONTOLOGY,
            "project_id": PROJECT,
            "version_no": 1,
            "labels": [{
                "label_id": "label_person",
                "name": "person",
                "color": "#3366ff",
                "shortcut": null,
                "allowed_geometry_types": ["bbox_xyxy"],
                "attributes": [{
                    "key": "helmet_state", "kind": "enum", "required": true, "default_value": "unknown",
                    "enum_values": ["wearing", "not_wearing", "unknown"], "min": null, "max": null
                }]
            }],
            "guidelines_markdown": "acceptance fixture",
            "allow_out_of_bounds": false
        }))
        .unwrap()
    }

    fn attributes_change(change_id: &str, before_hash: &str) -> Value {
        json!({
            "kind": "set_attributes",
            "change_id": change_id,
            "object_id": "object_person_001",
            "values": {"helmet_state": "wearing"},
            "before_hash": before_hash,
            "reason": "helmet audit"
        })
    }

    fn create_change(change_id: &str, object_id: &str) -> Value {
        json!({
            "kind": "create",
            "change_id": change_id,
            "object": {
                "object_id": object_id,
                "label_id": "label_person",
                "geometry": {"type": "bbox_xyxy", "x_min": 120.0, "y_min": 20.0, "x_max": 180.0, "y_max": 80.0},
                "attributes": {"helmet_state": "unknown"},
                "origin": {"type": "prediction", "prediction_id": "prediction-1", "model_run_id": "run-1", "import_batch_id": null}
            },
            "before_hash": null,
            "reason": "detector candidate"
        })
    }

    struct Seed {
        intent: String,
        provider_id: String,
        capabilities: Value,
        changes: Value,
    }

    impl Seed {
        fn audit(changes: Value) -> Self {
            Self {
                intent: "audit_attributes".to_owned(),
                provider_id: "mock".to_owned(),
                capabilities: json!({
                    "image_input": true, "tools": false, "structured_output": true,
                    "bbox_output": true, "attributes": true
                }),
                changes,
            }
        }
    }

    async fn seeded_graph(seed: &Seed) -> Graph {
        seeded_graph_in(
            seed,
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target"),
        )
        .await
    }

    async fn seeded_graph_in(seed: &Seed, target: &std::path::Path) -> Graph {
        std::fs::create_dir_all(target).unwrap();
        let directory = tempfile::tempdir_in(target).unwrap();
        let repository = Repository::open(
            &format!(
                "sqlite:{}",
                directory.path().join("acceptance.sqlite").display()
            ),
            directory.path().join("objects"),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        let document = base_document();
        let base_object_hash = object_hash(&document.objects[0]);
        let document_json = serde_json::to_string(&document).unwrap();
        let mut tx = repository.begin_write().await.unwrap();
        for statement in [
            "INSERT INTO users(user_id, username, password_hash, created_at) VALUES ('user-1','tester','hash','2026-01-01T00:00:00.000Z')",
            "INSERT INTO projects(project_id, name, description, allow_self_review, created_at) VALUES ('project-1','p','d',0,'2026-01-01T00:00:00.000Z')",
            "INSERT INTO memberships(project_id, user_id, role) VALUES ('project-1','user-1','admin')",
            "INSERT INTO jobs(job_id, project_id, kind, state, payload_json, created_at, updated_at) VALUES ('job-1','project-1','model','succeeded','{}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
            "INSERT INTO media_assets(asset_id, project_id, created_at) VALUES ('media-1','project-1','2026-01-01T00:00:00.000Z')",
        ] {
            sqlx::query(statement).execute(tx.connection()).await.unwrap();
        }
        sqlx::query(
            "INSERT INTO media_revisions(asset_revision_id, project_id, asset_id, original_sha256, canonical_sha256, original_name, created_at) \
             VALUES ('asset-1','project-1','media-1','original-sha',?,'fixture.png','2026-01-01T00:00:00.000Z')",
        )
        .bind(CANONICAL)
        .execute(tx.connection())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO ontology_versions(ontology_version_id, project_id, version_no, body_json, created_at) \
             VALUES ('onto-1','project-1',1,?,'2026-01-01T00:00:00.000Z')",
        )
        .bind(serde_json::to_string(&fixture_ontology()).unwrap())
        .execute(tx.connection())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO annotation_revisions(annotation_revision_id, project_id, asset_revision_id, ontology_version_id, \
             parent_revision_id, revision_no, body_json, content_hash, created_by, created_at) \
             VALUES ('rev-1','project-1','asset-1','onto-1',NULL,1,?,'base-hash','user-1','2026-01-01T00:00:00.000Z')",
        )
        .bind(&document_json)
        .execute(tx.connection())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO annotation_heads(project_id, asset_revision_id, ontology_version_id, annotation_revision_id) \
             VALUES ('project-1','asset-1','onto-1','rev-1')",
        )
        .execute(tx.connection())
        .await
        .unwrap();
        let profile = json!({
            "profile_id": "profile-1",
            "provider_id": seed.provider_id,
            "model_id": "model-1",
            "auth_kind": "none",
            "capabilities": seed.capabilities,
            "availability": "ready",
            "verification": "mock_only",
            "runtime_version": null,
            "verified_at": null
        });
        let context = json!({
            "project_id": PROJECT,
            "asset_revision_id": ASSET,
            "annotation_revision_id": BASE_REVISION,
            "ontology_version_id": ONTOLOGY,
            "draft_generation": 0,
            "canonical_sha256": CANONICAL,
            "selected_object_ids": ["object_person_001"],
            "object_hashes": {"object_person_001": base_object_hash},
            "input_fingerprint": "fingerprint-1"
        });
        sqlx::query(
            "INSERT INTO model_runs(run_id, operation_id, project_id, asset_revision_id, annotation_revision_id, \
             ontology_version_id, actor_id, job_id, profile_id, profile_snapshot_json, provider_id, source, intent, \
             prompt, consent_id, context_json, input_fingerprint, request_hash, state, cancel_requested, cost_display, \
             usage_json, created_at, started_at, finished_at) \
             VALUES ('run-1','op-run-1','project-1','asset-1','rev-1','onto-1','user-1','job-1','profile-1',?,?, \
             'mock',?,'prompt',NULL,?,'fingerprint-1',?, 'succeeded',0,'none',NULL,'2026-01-01T00:00:00.000Z', \
             '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
        )
        .bind(profile.to_string())
        .bind(seed.provider_id.as_str())
        .bind(seed.intent.as_str())
        .bind(context.to_string())
        .bind("1111111111111111111111111111111111111111111111111111111111111111")
        .execute(tx.connection())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO predictions(prediction_id, run_id, project_id, asset_revision_id, source, raw_output_json, \
             raw_output_bytes, usage_json, created_at) \
             VALUES ('prediction-1','run-1','project-1','asset-1','mock','{}',2,NULL,'2026-01-01T00:00:00.000Z')",
        )
        .execute(tx.connection())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO suggestion_sets(suggestion_set_id, run_id, prediction_id, project_id, asset_revision_id, \
             changes_json, issues_json, score, created_at) \
             VALUES ('suggestion-1','run-1','prediction-1','project-1','asset-1',?,'[]',NULL,'2026-01-01T00:00:00.000Z')",
        )
        .bind(seed.changes.to_string())
        .execute(tx.connection())
        .await
        .unwrap();
        tx.commit().await.unwrap();
        Graph {
            _directory: directory,
            repository,
        }
    }

    fn save_request(intents: Vec<SuggestionDecisionIntent>) -> SaveRequest {
        SaveRequest {
            operation_id: Id::from("op-save-1"),
            base_revision_id: Id::from(BASE_REVISION),
            document: base_document(),
            lease: None,
            suggestion_decisions: intents,
        }
    }

    fn accept(change_id: &str) -> SuggestionDecisionIntent {
        SuggestionDecisionIntent {
            suggestion_set_id: Id::from("suggestion-1"),
            change_ids: vec![Id::from(change_id)],
            decision: SuggestionDecision::Accept,
        }
    }

    fn revert(change_id: &str) -> SuggestionDecisionIntent {
        SuggestionDecisionIntent {
            suggestion_set_id: Id::from("suggestion-1"),
            change_ids: vec![Id::from(change_id)],
            decision: SuggestionDecision::Revert,
        }
    }

    fn ok<T>(result: Result<T, Failure>) -> T {
        match result {
            Ok(value) => value,
            Err(failure) => panic!("unexpected failure {}: {}", failure.code, failure.message),
        }
    }

    #[tokio::test]
    async fn journal_keeps_ordered_accept_revert_accept_without_dedup() {
        let before_hash = object_hash(&base_document().objects[0]);
        let seed = Seed::audit(json!([attributes_change("change-1", &before_hash)]));
        let graph = seeded_graph(&seed).await;
        let document = base_document();
        let ontology = fixture_ontology();
        let pins = SavePins {
            project_id: PROJECT,
            asset_revision_id: ASSET,
            canonical_sha256: CANONICAL,
            base_document: &document,
            ontology: &ontology,
        };
        let request = save_request(vec![
            accept("change-1"),
            revert("change-1"),
            accept("change-1"),
        ]);
        let mut tx = graph.repository.begin_write().await.unwrap();
        let prepared = ok(prepare(tx.connection(), &pins, &request).await);
        assert_eq!(
            prepared
                .rows
                .iter()
                .map(|row| row.decision)
                .collect::<Vec<_>>(),
            vec![
                SuggestionDecision::Accept,
                SuggestionDecision::Revert,
                SuggestionDecision::Accept
            ],
            "accept -> revert -> accept must all be journaled in order"
        );
        ok(record(
            tx.connection(),
            &prepared,
            "rev-2",
            USER,
            "2026-01-02T00:00:00.000Z",
        )
        .await);
        tx.commit().await.unwrap();

        let mut tx = graph.repository.begin_write().await.unwrap();
        let rows: Vec<(String, String)> = sqlx::query(
            "SELECT change_id, decision FROM suggestion_decisions \
             WHERE suggestion_set_id='suggestion-1' ORDER BY rowid",
        )
        .map(|row: sqlx::sqlite::SqliteRow| {
            (
                row.try_get::<String, _>(0).unwrap(),
                row.try_get::<String, _>(1).unwrap(),
            )
        })
        .fetch_all(tx.connection())
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                ("change-1".to_owned(), "accept".to_owned()),
                ("change-1".to_owned(), "revert".to_owned()),
                ("change-1".to_owned(), "accept".to_owned()),
            ]
        );
        let state: String = sqlx::query_scalar(
            "SELECT state FROM suggestion_set_states WHERE suggestion_set_id='suggestion-1'",
        )
        .fetch_one(tx.connection())
        .await
        .unwrap();
        assert_eq!(state, "accepted");
        tx.commit().await.unwrap();
    }

    #[tokio::test]
    async fn repeat_accept_is_rejected_and_revert_requires_accept() {
        let before_hash = object_hash(&base_document().objects[0]);
        let seed = Seed::audit(json!([attributes_change("change-1", &before_hash)]));
        let graph = seeded_graph(&seed).await;
        let document = base_document();
        let ontology = fixture_ontology();
        let pins = SavePins {
            project_id: PROJECT,
            asset_revision_id: ASSET,
            canonical_sha256: CANONICAL,
            base_document: &document,
            ontology: &ontology,
        };
        let mut tx = graph.repository.begin_write().await.unwrap();
        let prepared = ok(prepare(
            tx.connection(),
            &pins,
            &save_request(vec![accept("change-1")]),
        )
        .await);
        ok(record(
            tx.connection(),
            &prepared,
            "rev-2",
            USER,
            "2026-01-02T00:00:00.000Z",
        )
        .await);
        tx.commit().await.unwrap();

        let mut tx = graph.repository.begin_write().await.unwrap();
        let failure = prepare(
            tx.connection(),
            &pins,
            &save_request(vec![accept("change-1")]),
        )
        .await
        .expect_err("repeated accept must be rejected");
        assert_eq!(failure.code, "ALREADY_ACCEPTED");
        tx.rollback().await.unwrap();

        // A change that is not currently accepted cannot be reverted.
        let before_hash = object_hash(&base_document().objects[0]);
        let seed = Seed::audit(json!([attributes_change("change-1", &before_hash)]));
        let graph = seeded_graph(&seed).await;
        let document = base_document();
        let ontology = fixture_ontology();
        let pins = SavePins {
            project_id: PROJECT,
            asset_revision_id: ASSET,
            canonical_sha256: CANONICAL,
            base_document: &document,
            ontology: &ontology,
        };
        let mut tx = graph.repository.begin_write().await.unwrap();
        let failure = prepare(
            tx.connection(),
            &pins,
            &save_request(vec![revert("change-1")]),
        )
        .await
        .expect_err("revert without accept must be rejected");
        assert_eq!(failure.code, "REVERT_WITHOUT_ACCEPT");
        tx.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn revert_selection_is_non_empty_and_capped_like_accept() {
        let before_hash = object_hash(&base_document().objects[0]);
        let seed = Seed::audit(json!([attributes_change("change-1", &before_hash)]));
        let graph = seeded_graph(&seed).await;
        let document = base_document();
        let ontology = fixture_ontology();
        let pins = SavePins {
            project_id: PROJECT,
            asset_revision_id: ASSET,
            canonical_sha256: CANONICAL,
            base_document: &document,
            ontology: &ontology,
        };
        let mut tx = graph.repository.begin_write().await.unwrap();
        let empty = save_request(vec![SuggestionDecisionIntent {
            suggestion_set_id: Id::from("suggestion-1"),
            change_ids: Vec::new(),
            decision: SuggestionDecision::Revert,
        }]);
        let failure = prepare(tx.connection(), &pins, &empty)
            .await
            .expect_err("an empty revert selection must be rejected");
        assert_eq!(failure.code, "EMPTY_SELECTION");
        let oversized = save_request(vec![SuggestionDecisionIntent {
            suggestion_set_id: Id::from("suggestion-1"),
            change_ids: (0..=MAX_CHANGE_IDS)
                .map(|index| Id::from(format!("change-{index}")))
                .collect(),
            decision: SuggestionDecision::Revert,
        }]);
        let failure = prepare(tx.connection(), &pins, &oversized)
            .await
            .expect_err("a revert selection above the cap must be rejected");
        assert_eq!(failure.code, "TOO_MANY_CHANGES");
        tx.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn stale_and_unknown_suggestions_are_rejected() {
        let before_hash = object_hash(&base_document().objects[0]);
        let seed = Seed::audit(json!([attributes_change("change-1", &before_hash)]));
        let graph = seeded_graph(&seed).await;
        let document = base_document();
        let ontology = fixture_ontology();

        let mut tx = graph.repository.begin_write().await.unwrap();
        let unknown = SavePins {
            project_id: PROJECT,
            asset_revision_id: ASSET,
            canonical_sha256: CANONICAL,
            base_document: &document,
            ontology: &ontology,
        };
        let mut missing = save_request(vec![accept("change-1")]);
        missing.suggestion_decisions[0].suggestion_set_id = Id::from("suggestion-missing");
        let failure = prepare(tx.connection(), &unknown, &missing)
            .await
            .expect_err("unknown sets must be rejected");
        assert_eq!(failure.code, "SUGGESTION_SET_NOT_FOUND");

        let wrong_asset = SavePins {
            project_id: PROJECT,
            asset_revision_id: "asset-other",
            canonical_sha256: CANONICAL,
            base_document: &document,
            ontology: &ontology,
        };
        let failure = prepare(
            tx.connection(),
            &wrong_asset,
            &save_request(vec![accept("change-1")]),
        )
        .await
        .expect_err("sets of other assets must be rejected");
        assert_eq!(failure.code, "STALE_ASSET");

        let wrong_hash = SavePins {
            project_id: PROJECT,
            asset_revision_id: ASSET,
            canonical_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            base_document: &document,
            ontology: &ontology,
        };
        let failure = prepare(
            tx.connection(),
            &wrong_hash,
            &save_request(vec![accept("change-1")]),
        )
        .await
        .expect_err("changed media must be rejected");
        assert_eq!(failure.code, "STALE_CANONICAL_HASH");
        tx.rollback().await.unwrap();

        // The stored change carries a before_hash that no longer matches the
        // base revision object: re-validation must reject it as stale.
        let seed = Seed::audit(json!([attributes_change("change-1", "stale-before-hash")]));
        let graph = seeded_graph(&seed).await;
        let document = base_document();
        let ontology = fixture_ontology();
        let pins = SavePins {
            project_id: PROJECT,
            asset_revision_id: ASSET,
            canonical_sha256: CANONICAL,
            base_document: &document,
            ontology: &ontology,
        };
        let mut tx = graph.repository.begin_write().await.unwrap();
        let failure = prepare(
            tx.connection(),
            &pins,
            &save_request(vec![accept("change-1")]),
        )
        .await
        .expect_err("stale before_hash must be rejected");
        assert_eq!(failure.code, "STALE_OBJECT");
        tx.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn capability_gates_reject_disallowed_changes() {
        // An attribute audit may never accept create changes, even if a stale
        // row somehow contains one.
        let seed = Seed::audit(json!([create_change("change-1", "object_new")]));
        let graph = seeded_graph(&seed).await;
        let document = base_document();
        let ontology = fixture_ontology();
        let pins = SavePins {
            project_id: PROJECT,
            asset_revision_id: ASSET,
            canonical_sha256: CANONICAL,
            base_document: &document,
            ontology: &ontology,
        };
        let mut tx = graph.repository.begin_write().await.unwrap();
        let failure = prepare(
            tx.connection(),
            &pins,
            &save_request(vec![accept("change-1")]),
        )
        .await
        .expect_err("audit runs must not create objects");
        assert_eq!(failure.code, "INVALID_CHANGE_KIND");
        tx.rollback().await.unwrap();

        // Detection creates require a detector or explicit bbox output.
        let mut seed = Seed::audit(json!([create_change("change-1", "object_new")]));
        seed.intent = "detect".to_owned();
        seed.provider_id = "openai_api".to_owned();
        seed.capabilities = json!({
            "image_input": true, "tools": false, "structured_output": true,
            "bbox_output": false, "attributes": false
        });
        let graph = seeded_graph(&seed).await;
        let document = base_document();
        let ontology = fixture_ontology();
        let pins = SavePins {
            project_id: PROJECT,
            asset_revision_id: ASSET,
            canonical_sha256: CANONICAL,
            base_document: &document,
            ontology: &ontology,
        };
        let mut tx = graph.repository.begin_write().await.unwrap();
        let failure = prepare(
            tx.connection(),
            &pins,
            &save_request(vec![accept("change-1")]),
        )
        .await
        .expect_err("create without bbox capability must be rejected");
        assert_eq!(failure.code, "INVALID_CHANGE_KIND");
        tx.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn prediction_provenance_requires_a_net_accepted_create() {
        let mut seed = Seed::audit(json!([create_change("change-1", "object_new")]));
        seed.intent = "detect".to_owned();
        let graph = seeded_graph(&seed).await;
        let document = base_document();
        let ontology = fixture_ontology();
        let pins = SavePins {
            project_id: PROJECT,
            asset_revision_id: ASSET,
            canonical_sha256: CANONICAL,
            base_document: &document,
            ontology: &ontology,
        };
        let mut created = document.clone();
        created.objects.push(serde_json::from_value(json!({
            "object_id": "object_new",
            "label_id": "label_person",
            "geometry": {"type": "bbox_xyxy", "x_min": 120.0, "y_min": 20.0, "x_max": 180.0, "y_max": 80.0},
            "attributes": {"helmet_state": "unknown"},
            "origin": {"type": "prediction", "prediction_id": "prediction-1", "model_run_id": "run-1", "import_batch_id": null}
        }))
        .unwrap());

        let mut tx = graph.repository.begin_write().await.unwrap();
        let mut request = save_request(vec![accept("change-1")]);
        request.document = created.clone();
        let prepared = ok(prepare(tx.connection(), &pins, &request).await);
        assert!(
            prepared
                .verify_prediction_object(&created.objects[1])
                .is_ok(),
            "a net-accepted create covers its prediction provenance"
        );
        let mut forged = created.objects[1].clone();
        forged.object_id = Id::from("object_forged");
        assert_eq!(
            prepared
                .verify_prediction_object(&forged)
                .expect_err("forged provenance must be rejected")
                .code,
            "UNVERIFIED_PROVENANCE"
        );
        tx.rollback().await.unwrap();

        // After a revert the coverage is gone: the saved document may no
        // longer carry the prediction provenance.
        let mut tx = graph.repository.begin_write().await.unwrap();
        let mut request = save_request(vec![accept("change-1"), revert("change-1")]);
        request.document = document.clone();
        let prepared = ok(prepare(tx.connection(), &pins, &request).await);
        assert!(
            prepared.creates.is_empty(),
            "reverted creates lose their coverage"
        );
        assert_eq!(
            prepared
                .verify_prediction_object(&created.objects[1])
                .expect_err("reverted provenance must be rejected")
                .code,
            "UNVERIFIED_PROVENANCE"
        );
        tx.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn decision_side_effects_commit_and_roll_back_with_the_revision() {
        let before_hash = object_hash(&base_document().objects[0]);
        let seed = Seed::audit(json!([attributes_change("change-1", &before_hash)]));
        let graph = seeded_graph(&seed).await;
        let document = base_document();
        let ontology = fixture_ontology();
        let pins = SavePins {
            project_id: PROJECT,
            asset_revision_id: ASSET,
            canonical_sha256: CANONICAL,
            base_document: &document,
            ontology: &ontology,
        };

        // One transaction: journal + revision + head, exactly like the save.
        let mut tx = graph.repository.begin_write().await.unwrap();
        let prepared = ok(prepare(
            tx.connection(),
            &pins,
            &save_request(vec![accept("change-1"), revert("change-1")]),
        )
        .await);
        sqlx::query(
            "INSERT INTO annotation_revisions(annotation_revision_id, project_id, asset_revision_id, ontology_version_id, \
             parent_revision_id, revision_no, body_json, content_hash, created_by, created_at) \
             VALUES ('rev-2','project-1','asset-1','onto-1','rev-1',2,?,'next-hash','user-1','2026-01-02T00:00:00.000Z')",
        )
        .bind(serde_json::to_string(&document).unwrap())
        .execute(tx.connection())
        .await
        .unwrap();
        ok(record(
            tx.connection(),
            &prepared,
            "rev-2",
            USER,
            "2026-01-02T00:00:00.000Z",
        )
        .await);
        let updated = sqlx::query(
            "UPDATE annotation_heads SET annotation_revision_id='rev-2' \
             WHERE project_id='project-1' AND asset_revision_id='asset-1' \
               AND ontology_version_id='onto-1' AND annotation_revision_id='rev-1'",
        )
        .execute(tx.connection())
        .await
        .unwrap();
        assert_eq!(updated.rows_affected(), 1);
        tx.commit().await.unwrap();

        let mut tx = graph.repository.begin_write().await.unwrap();
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM suggestion_decisions")
            .fetch_one(tx.connection())
            .await
            .unwrap();
        assert_eq!(rows, 2);
        tx.commit().await.unwrap();

        // A failure after the journal writes rolls everything back with the
        // save transaction: no orphan decisions and no half revision.
        let mut tx = graph.repository.begin_write().await.unwrap();
        let prepared = ok(prepare(
            tx.connection(),
            &pins,
            &save_request(vec![accept("change-1")]),
        )
        .await);
        ok(record(
            tx.connection(),
            &prepared,
            "rev-3",
            USER,
            "2026-01-03T00:00:00.000Z",
        )
        .await);
        let stale_head = sqlx::query(
            "UPDATE annotation_heads SET annotation_revision_id='rev-3' \
             WHERE project_id='project-1' AND asset_revision_id='asset-1' \
               AND ontology_version_id='onto-1' AND annotation_revision_id='rev-1'",
        )
        .execute(tx.connection())
        .await
        .unwrap();
        assert_eq!(stale_head.rows_affected(), 0, "the head already moved");
        tx.rollback().await.unwrap();

        let mut tx = graph.repository.begin_write().await.unwrap();
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM suggestion_decisions")
            .fetch_one(tx.connection())
            .await
            .unwrap();
        assert_eq!(rows, 2, "rolled back decisions must not persist");
        let revisions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM annotation_revisions WHERE annotation_revision_id='rev-3'",
        )
        .fetch_one(tx.connection())
        .await
        .unwrap();
        assert_eq!(revisions, 0);
        let head: String = sqlx::query_scalar(
            "SELECT annotation_revision_id FROM annotation_heads WHERE asset_revision_id='asset-1'",
        )
        .fetch_one(tx.connection())
        .await
        .unwrap();
        assert_eq!(head, "rev-2");
        tx.commit().await.unwrap();
    }

    #[tokio::test]
    async fn ux_granular_rejections_are_real_immutable_and_block_transactional_acceptance() {
        use crate::ai::{
            profiles::ux_tests::{auth_router, call, seed_session},
            suggestions,
        };
        use axum::{
            routing::{get, post},
            Router,
        };
        let hash = object_hash(&base_document().objects[0]);
        let graph = seeded_graph(&Seed::audit(json!([
            attributes_change("change-1", &hash),
            attributes_change("change-2", &hash)
        ])))
        .await;
        let db = format!(
            "sqlite:{}",
            graph._directory.path().join("acceptance.sqlite").display()
        );
        let mut tx = graph.repository.begin_write().await.unwrap();
        sqlx::query("INSERT INTO users(user_id,username,password_hash,created_at) VALUES('viewer','viewer','hash','0'),('other-actor','other','hash','0'),('outsider','outsider','hash','0')").execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO memberships(project_id,user_id,role) VALUES('project-1','viewer','viewer'),('project-1','other-actor','annotator')").execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO suggestion_sets(suggestion_set_id,run_id,prediction_id,project_id,asset_revision_id,changes_json,issues_json,score,created_at) SELECT 'suggestion-2',run_id,prediction_id,project_id,asset_revision_id,changes_json,issues_json,score,created_at FROM suggestion_sets WHERE suggestion_set_id='suggestion-1'").execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
        for (user, token) in [
            (USER, "actor-session"),
            ("viewer", "viewer-session"),
            ("other-actor", "other-session"),
            ("outsider", "outsider-session"),
        ] {
            seed_session(&graph.repository, user, token).await;
        }
        let app = auth_router(
            Router::new()
                .route(
                    "/api/ai/suggestions/{id}/rejections",
                    get(suggestions::rejection_list).post(suggestions::reject_changes),
                )
                .route("/api/ai/suggestions/{id}/decision", post(decision_route))
                .route(
                    "/api/ai/runs/{id}/outcome-summary",
                    get(crate::ai::runs::outcome_summary),
                ),
            graph.repository.clone(),
            &db,
            Ok(None),
        )
        .await;
        let path = "/api/ai/suggestions/suggestion-1/rejections";
        let payload = json!({"operation_id":"op-reject","change_ids":["change-1"]});
        assert_eq!(
            call(&app, "POST", path, None, true, payload.clone())
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &app,
                "POST",
                path,
                Some("actor-session"),
                false,
                payload.clone()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &app,
                "POST",
                path,
                Some("viewer-session"),
                true,
                payload.clone()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &app,
                "GET",
                path,
                Some("outsider-session"),
                false,
                json!({})
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        let (status, receipt) = call(
            &app,
            "POST",
            path,
            Some("actor-session"),
            true,
            payload.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(receipt["change_ids"], json!(["change-1"]));
        assert_eq!(receipt["idempotent_replay"], false);
        let (_, replay) = call(
            &app,
            "POST",
            path,
            Some("actor-session"),
            true,
            payload.clone(),
        )
        .await;
        assert_eq!(replay["idempotent_replay"], true);
        assert_eq!(replay["created_at"], receipt["created_at"]);
        let reply = crate::ai::profiles::ux_tests::loopback_smoke(
            app.clone(),
            "POST",
            path,
            "actor-session",
            payload.clone(),
        )
        .await;
        assert!(reply.contains("idempotent_replay"));
        assert_eq!(
            call(
                &app,
                "POST",
                path,
                Some("actor-session"),
                true,
                json!({"operation_id":"op-reject","change_ids":["change-2"]})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            call(
                &app,
                "POST",
                path,
                Some("other-session"),
                true,
                payload.clone()
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/ai/suggestions/suggestion-2/rejections",
                Some("actor-session"),
                true,
                payload
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let (status, state) = call(
            &app,
            "GET",
            "/api/ai/suggestions/suggestion-1/rejections?operation_id=op-reject",
            Some("viewer-session"),
            false,
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(state["rejected_change_ids"], json!(["change-1"]));
        assert_eq!(state["operations"][0]["operation_id"], "op-reject");
        let document = base_document();
        let ontology = fixture_ontology();
        let pins = SavePins {
            project_id: PROJECT,
            asset_revision_id: ASSET,
            canonical_sha256: CANONICAL,
            base_document: &document,
            ontology: &ontology,
        };
        let mut tx = graph.repository.begin_write().await.unwrap();
        let failure = prepare(
            tx.connection(),
            &pins,
            &save_request(vec![accept("change-1")]),
        )
        .await
        .unwrap_err();
        assert_eq!(failure.code, "CHANGE_REJECTED");
        let prepared = ok(prepare(
            tx.connection(),
            &pins,
            &save_request(vec![accept("change-2")]),
        )
        .await);
        ok(record(
            tx.connection(),
            &prepared,
            BASE_REVISION,
            USER,
            "2026-01-01T00:00:00.000Z",
        )
        .await);
        tx.commit().await.unwrap();
        assert_eq!(
            call(
                &app,
                "POST",
                path,
                Some("actor-session"),
                true,
                json!({"operation_id":"op-accepted-reject","change_ids":["change-2"]})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let mut tx = graph.repository.begin_write().await.unwrap();
        let prepared = ok(prepare(
            tx.connection(),
            &pins,
            &save_request(vec![revert("change-2")]),
        )
        .await);
        ok(record(
            tx.connection(),
            &prepared,
            BASE_REVISION,
            USER,
            "2026-01-01T00:00:01.000Z",
        )
        .await);
        tx.commit().await.unwrap();
        assert_eq!(
            call(
                &app,
                "POST",
                path,
                Some("actor-session"),
                true,
                json!({"operation_id":"op-after-revert","change_ids":["change-2"]})
            )
            .await
            .0,
            StatusCode::OK
        );
        let (status, summary) = call(
            &app,
            "GET",
            "/api/ai/runs/run-1/outcome-summary",
            Some("viewer-session"),
            false,
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(summary["candidate_change_count"], 4);
        assert_eq!(summary["accepted_change_count"], 0);
        assert_eq!(summary["accept_journal_count"], 1);
        assert_eq!(summary["revert_journal_count"], 1);
        assert_eq!(summary["rejected_change_count"], 2);
        assert_eq!(summary["recorded_work_seconds"], Value::Null);
        assert_eq!(summary["usage"], Value::Null);
        assert_eq!(summary["task_binding"], Value::Null);
        assert_eq!(
            call(
                &app,
                "GET",
                "/api/ai/runs/run-1/outcome-summary",
                Some("outsider-session"),
                false,
                json!({})
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        // Legacy whole-set rejection stays a separate state, and neither path can reopen a rejected change.
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/ai/suggestions/suggestion-2/decision",
                Some("actor-session"),
                true,
                json!({"decision":"reject"})
            )
            .await
            .0,
            StatusCode::OK
        );
        let mut tx = graph.repository.begin_write().await.unwrap();
        let mut intent = accept("change-1");
        intent.suggestion_set_id = Id::from("suggestion-2");
        assert_eq!(
            prepare(tx.connection(), &pins, &save_request(vec![intent]))
                .await
                .unwrap_err()
                .code,
            "SUGGESTION_SET_NOT_APPLICABLE"
        );
        let bytes: String = sqlx::query_scalar(
            "SELECT changes_json FROM suggestion_sets WHERE suggestion_set_id='suggestion-1'",
        )
        .fetch_one(tx.connection())
        .await
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&bytes).unwrap(),
            json!([
                attributes_change("change-1", &hash),
                attributes_change("change-2", &hash)
            ])
        );
        assert!(sqlx::query("DELETE FROM suggestion_change_rejections")
            .execute(tx.connection())
            .await
            .is_err());
        tx.commit().await.unwrap();
    }

    #[tokio::test]
    async fn ux_correction_rejection_payload_and_both_authorization_boundaries() {
        use crate::ai::profiles::ux_tests::{auth_router, call, seed_session};
        use crate::ai::suggestions;
        use axum::{
            routing::{get, post},
            Router,
        };
        let hash = object_hash(&base_document().objects[0]);
        for fault in ["none", "media", "ontology", "revision", "run", "permission"] {
            let graph = seeded_graph(&Seed::audit(json!([
                attributes_change("change-1", &hash),
                attributes_change("change-2", &hash)
            ])))
            .await;
            seed_session(&graph.repository, USER, "actor-session").await;
            let mut tx = graph.repository.begin_write().await.unwrap();
            let permission_sql = "UPDATE memberships SET role='viewer'";
            // Foreign IDs remain real rows; relational mismatches, not absent IDs.
            if matches!(fault, "ontology" | "revision" | "run") {
                sqlx::query("PRAGMA defer_foreign_keys=ON")
                    .execute(tx.connection())
                    .await
                    .unwrap();
                sqlx::query("INSERT INTO media_revisions SELECT 'missing',project_id,asset_id,original_sha256,canonical_sha256,original_name,created_at FROM media_revisions WHERE asset_revision_id='asset-1'").execute(tx.connection()).await.unwrap();
                sqlx::query("INSERT INTO ontology_versions SELECT 'missing',project_id,2,body_json,created_at FROM ontology_versions WHERE ontology_version_id='onto-1'").execute(tx.connection()).await.unwrap();
                sqlx::query("INSERT INTO annotation_revisions SELECT 'missing',project_id,'missing','missing',NULL,1,body_json,content_hash,created_by,created_at FROM annotation_revisions WHERE annotation_revision_id='rev-1'").execute(tx.connection()).await.unwrap();
            }
            if fault == "permission" {
                sqlx::query(permission_sql)
                    .execute(tx.connection())
                    .await
                    .unwrap();
            }
            sqlx::query("INSERT INTO model_runs(run_id,operation_id,project_id,asset_revision_id,annotation_revision_id,ontology_version_id,actor_id,job_id,profile_id,profile_snapshot_json,provider_id,source,intent,prompt,consent_id,context_json,input_fingerprint,request_hash,state,cancel_requested,cost_display,usage_json,created_at,started_at,finished_at) SELECT 'run-2','op-run-2',project_id,CASE WHEN ?='run' THEN 'missing' ELSE asset_revision_id END,CASE WHEN ?='revision' THEN 'missing' ELSE annotation_revision_id END,CASE WHEN ?='ontology' THEN 'missing' ELSE ontology_version_id END,actor_id,job_id,profile_id,profile_snapshot_json,provider_id,source,intent,prompt,consent_id,CASE WHEN ?='media' THEN json_set(context_json,'$.canonical_sha256','other') ELSE context_json END,input_fingerprint,request_hash,state,cancel_requested,cost_display,usage_json,created_at,started_at,finished_at FROM model_runs WHERE run_id='run-1'").bind(fault).bind(fault).bind(fault).bind(fault).execute(tx.connection()).await.unwrap();
            sqlx::query("INSERT INTO suggestion_sets SELECT 'suggestion-2','run-2',prediction_id,project_id,asset_revision_id,changes_json,issues_json,score,created_at FROM suggestion_sets WHERE suggestion_set_id='suggestion-1'").execute(tx.connection()).await.unwrap();
            tx.commit().await.unwrap();
            let db = format!(
                "sqlite:{}",
                graph._directory.path().join("acceptance.sqlite").display()
            );
            let app = auth_router(
                Router::new()
                    .route(
                        "/api/ai/suggestions/{id}/rejections",
                        get(suggestions::rejection_list).post(suggestions::reject_changes),
                    )
                    .route("/api/ai/suggestions/{id}/decision", post(decision_route)),
                graph.repository.clone(),
                &db,
                Ok(None),
            )
            .await;
            let path = "/api/ai/suggestions/suggestion-2/rejections";
            let payload = json!({"operation_id":"op-order", "change_ids":["change-1","change-2"]});
            let status = call(&app, "POST", path, Some("actor-session"), true, payload)
                .await
                .0;
            if fault == "none" {
                assert_eq!(status, StatusCode::OK);
                for ids in [
                    json!(["change-2", "change-1"]),
                    json!(["Change-1", "change-2"]),
                ] {
                    assert_eq!(
                        call(
                            &app,
                            "POST",
                            path,
                            Some("actor-session"),
                            true,
                            json!({"operation_id":"op-order","change_ids":ids})
                        )
                        .await
                        .0,
                        StatusCode::CONFLICT
                    );
                }
            } else {
                assert!(
                    matches!(status, StatusCode::NOT_FOUND | StatusCode::FORBIDDEN),
                    "{fault}: {status}"
                );
                let status = call(
                    &app,
                    "POST",
                    "/api/ai/suggestions/suggestion-2/decision",
                    Some("actor-session"),
                    true,
                    json!({"decision":"reject"}),
                )
                .await
                .0;
                assert!(
                    matches!(status, StatusCode::NOT_FOUND | StatusCode::FORBIDDEN),
                    "whole {fault}: {status}"
                );
            }
        }
    }

    #[tokio::test]
    async fn ux_correction_loopback_tcp_enforces_csrf_without_model_calls() {
        use crate::ai::profiles::ux_tests::{auth_router, seed_session};
        use axum::{routing::post, Router};
        let hash = object_hash(&base_document().objects[0]);
        let graph = seeded_graph(&Seed::audit(json!([attributes_change("change-1", &hash)]))).await;
        seed_session(&graph.repository, USER, "actor-session").await;
        let db = format!(
            "sqlite:{}",
            graph._directory.path().join("acceptance.sqlite").display()
        );
        let app = auth_router(
            Router::new().route("/api/ai/suggestions/{id}/decision", post(decision_route)),
            graph.repository.clone(),
            &db,
            Ok(None),
        )
        .await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        for (csrf, status) in [("", "403"), ("x-csrf-token: ux-csrf\r\n", "200")] {
            let request = format!("POST /api/ai/suggestions/suggestion-1/decision HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost\r\nCookie: weblabel_session=actor-session\r\n{csrf}Content-Type: application/json\r\nContent-Length: 21\r\nConnection: close\r\n\r\n{{\"decision\":\"reject\"}}");
            let reply = tokio::task::spawn_blocking(move || {
                use std::io::{Read, Write};
                let mut socket = std::net::TcpStream::connect(address).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                socket.write_all(request.as_bytes()).unwrap();
                let mut reply = String::new();
                socket.take(1024 * 1024).read_to_string(&mut reply).unwrap();
                reply
            })
            .await
            .unwrap();
            assert!(reply.starts_with(&format!("HTTP/1.1 {status}")), "{reply}");
        }
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn ux_correction_whole_reject_requires_revert_and_terminal_states_never_reopen() {
        use crate::ai::profiles::ux_tests::{auth_router, call, loopback_smoke, seed_session};
        use axum::{routing::post, Router};
        let hash = object_hash(&base_document().objects[0]);
        for terminal in [None, Some("rejected"), Some("stale")] {
            let graph = seeded_graph(&Seed::audit(json!([
                attributes_change("change-1", &hash),
                attributes_change("change-2", &hash)
            ])))
            .await;
            seed_session(&graph.repository, USER, "actor-session").await;
            let db = format!(
                "sqlite:{}",
                graph._directory.path().join("acceptance.sqlite").display()
            );
            let app = auth_router(
                Router::new().route("/api/ai/suggestions/{id}/decision", post(decision_route)),
                graph.repository.clone(),
                &db,
                Ok(None),
            )
            .await;
            let document = base_document();
            let ontology = fixture_ontology();
            let pins = SavePins {
                project_id: PROJECT,
                asset_revision_id: ASSET,
                canonical_sha256: CANONICAL,
                base_document: &document,
                ontology: &ontology,
            };
            let mut tx = graph.repository.begin_write().await.unwrap();
            let prepared = ok(prepare(
                tx.connection(),
                &pins,
                &save_request(vec![accept("change-1")]),
            )
            .await);
            ok(record(tx.connection(), &prepared, BASE_REVISION, USER, "0").await);
            if let Some(state) = terminal {
                sqlx::query("UPDATE suggestion_set_states SET state=? WHERE suggestion_set_id='suggestion-1'").bind(state).execute(tx.connection()).await.unwrap();
            }
            tx.commit().await.unwrap();
            let path = "/api/ai/suggestions/suggestion-1/decision";
            assert_eq!(
                call(
                    &app,
                    "POST",
                    path,
                    Some("actor-session"),
                    true,
                    json!({"decision":"reject"})
                )
                .await
                .0,
                StatusCode::CONFLICT
            );
            let mut tx = graph.repository.begin_write().await.unwrap();
            let prepared = ok(prepare(
                tx.connection(),
                &pins,
                &save_request(vec![revert("change-1")]),
            )
            .await);
            ok(record(tx.connection(), &prepared, BASE_REVISION, USER, "1").await);
            let state: String = sqlx::query_scalar(
                "SELECT state FROM suggestion_set_states WHERE suggestion_set_id='suggestion-1'",
            )
            .fetch_one(tx.connection())
            .await
            .unwrap();
            assert_eq!(state, terminal.unwrap_or("pending"));
            tx.commit().await.unwrap();
            if terminal.is_none() {
                let reply = loopback_smoke(
                    app.clone(),
                    "POST",
                    path,
                    "actor-session",
                    json!({"decision":"reject"}),
                )
                .await;
                assert!(reply.contains("rejected"));
            }
            let mut tx = graph.repository.begin_write().await.unwrap();
            for id in ["change-1", "change-2"] {
                assert_eq!(
                    prepare(tx.connection(), &pins, &save_request(vec![accept(id)]))
                        .await
                        .unwrap_err()
                        .code,
                    "SUGGESTION_SET_NOT_APPLICABLE"
                );
            }
            tx.commit().await.unwrap();
        }
    }

    #[tokio::test]
    async fn ux_outcome_observes_changes_and_actual_reviews_without_human_attribution_or_fabricated_cost(
    ) {
        use crate::ai::profiles::ux_tests::{auth_router, call, seed_session};
        use axum::{routing::get, Router};
        let hash = object_hash(&base_document().objects[0]);
        let graph = seeded_graph(&Seed::audit(json!([attributes_change("change-1", &hash)]))).await;
        seed_session(&graph.repository, USER, "actor-session").await;
        let db = format!(
            "sqlite:{}",
            graph._directory.path().join("acceptance.sqlite").display()
        );
        let app = auth_router(
            Router::new().route(
                "/api/ai/runs/{id}/outcome-summary",
                get(crate::ai::runs::outcome_summary),
            ),
            graph.repository.clone(),
            &db,
            Ok(None),
        )
        .await;
        let document = base_document();
        let ontology = fixture_ontology();
        let pins = SavePins {
            project_id: PROJECT,
            asset_revision_id: ASSET,
            canonical_sha256: CANONICAL,
            base_document: &document,
            ontology: &ontology,
        };
        let mut tx = graph.repository.begin_write().await.unwrap();
        let prepared = ok(prepare(
            tx.connection(),
            &pins,
            &save_request(vec![accept("change-1")]),
        )
        .await);
        ok(record(
            tx.connection(),
            &prepared,
            BASE_REVISION,
            USER,
            "2026-01-01T00:00:00.000Z",
        )
        .await);
        tx.commit().await.unwrap();
        let (_, summary) = call(
            &app,
            "GET",
            "/api/ai/runs/run-1/outcome-summary",
            Some("actor-session"),
            false,
            json!({}),
        )
        .await;
        assert_eq!(summary["accepted_change_count"], 1);
        assert_eq!(
            summary["object_observations"][0]["current_status"],
            "unchanged_since_acceptance"
        );
        let mut modified = base_document();
        modified.objects[0].attributes.insert(
            "helmet_state".to_owned(),
            serde_json::from_value(json!("wearing")).unwrap(),
        );
        let mut tx = graph.repository.begin_write().await.unwrap();
        sqlx::query("INSERT INTO annotation_revisions(annotation_revision_id,project_id,asset_revision_id,ontology_version_id,parent_revision_id,revision_no,body_json,content_hash,created_by,created_at) VALUES('ux-later','project-1','asset-1','onto-1','rev-1',2,?,'later-hash','user-1','2026-01-01T00:00:02.000Z')").bind(serde_json::to_string(&modified).unwrap()).execute(tx.connection()).await.unwrap();
        sqlx::query("UPDATE annotation_heads SET annotation_revision_id='ux-later' WHERE asset_revision_id='asset-1'").execute(tx.connection()).await.unwrap();
        sqlx::query(
            "UPDATE model_runs SET usage_json=?,cost_display='recorded' WHERE run_id='run-1'",
        )
        .bind(json!({"input_tokens":123,"output_tokens":7,"cost_usd":0.12}).to_string())
        .execute(tx.connection())
        .await
        .unwrap();
        sqlx::query("INSERT INTO review_tasks(task_id,project_id,asset_revision_id,ontology_version_id,assignee_id,created_by,state,created_at) VALUES('ux-task','project-1','asset-1','onto-1','user-1','user-1','submitted','2026-01-01T00:00:03.000Z')").execute(tx.connection()).await.unwrap();
        sqlx::query("INSERT INTO review_submissions(review_id,task_id,project_id,submitted_by,revision_ids_json,state,created_at) VALUES('ux-review','ux-task','project-1','user-1','[\"ux-later\"]','approved','2026-01-01T00:00:04.000Z')").execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
        let (status, summary) = call(
            &app,
            "GET",
            "/api/ai/runs/run-1/outcome-summary",
            Some("actor-session"),
            false,
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            summary["object_observations"][0]["current_status"],
            "changed_since_acceptance"
        );
        assert_eq!(summary["object_observations"][0]["attribution"], "unknown");
        assert_eq!(summary["task_binding"], Value::Null);
        assert!(summary.get("media_tasks").is_none());
        assert_eq!(summary["usage"]["cost_usd"], 0.12);
        assert_eq!(summary["usage"]["input_tokens"], 123);
        assert_eq!(summary["recorded_work_seconds"], Value::Null);
        assert_eq!(summary["accuracy"], Value::Null);
        assert_eq!(summary["roi"], Value::Null);
    }

    #[tokio::test]
    async fn ux23_exact_history_and_voluntary_work_public_http() {
        use crate::ai::profiles::ux_tests::{auth_router, call, loopback_smoke, seed_session};
        use crate::auth::{AuthConfig, AuthState};
        use axum::{routing::get, Router};
        let report = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../reports/T24/ux-improvement/ux23-binding-api");
        let temp_root = report.join("temp");
        let hash = object_hash(&base_document().objects[0]);
        let graph = seeded_graph_in(
            &Seed::audit(json!([attributes_change("change-1", &hash)])),
            &temp_root,
        )
        .await;
        let database = format!(
            "sqlite:{}",
            graph._directory.path().join("acceptance.sqlite").display()
        );
        let mut tx = graph.repository.begin_write().await.unwrap();
        for sql in [
            "INSERT INTO users(user_id,username,password_hash,created_at) VALUES('viewer','viewer','synthetic','0'),('other','other','synthetic','0'),('outsider','outsider','synthetic','0')",
            "INSERT INTO memberships(project_id,user_id,role) VALUES('project-1','viewer','viewer'),('project-1','other','annotator')",
            "INSERT INTO projects(project_id,name,description,created_at) VALUES('foreign-project','synthetic','','0')",
            "INSERT INTO media_assets(asset_id,project_id,created_at) VALUES('foreign-media','foreign-project','0'),('second-media','project-1','0')",
            "INSERT INTO media_revisions(asset_revision_id,project_id,asset_id,original_sha256,canonical_sha256,original_name,created_at) VALUES('foreign-asset','foreign-project','foreign-media','original','canonical','synthetic','0'),('second-asset','project-1','second-media','original','canonical','synthetic','0')",
            "INSERT INTO ontology_versions(ontology_version_id,project_id,version_no,body_json,created_at) VALUES('foreign-ontology','foreign-project',1,'{}','0'),('second-ontology','project-1',2,'{}','0')",
            "INSERT INTO annotation_revisions(annotation_revision_id,project_id,asset_revision_id,ontology_version_id,parent_revision_id,revision_no,body_json,content_hash,created_by,created_at) SELECT 'rev-descendant',project_id,asset_revision_id,ontology_version_id,annotation_revision_id,2,body_json,'descendant',created_by,'1' FROM annotation_revisions WHERE annotation_revision_id='rev-1'",
            "INSERT INTO annotation_revisions(annotation_revision_id,project_id,asset_revision_id,ontology_version_id,parent_revision_id,revision_no,body_json,content_hash,created_by,created_at) SELECT 'foreign-revision','foreign-project','foreign-asset','foreign-ontology',NULL,1,body_json,'foreign',created_by,'1' FROM annotation_revisions WHERE annotation_revision_id='rev-1'",
            "INSERT INTO model_runs(run_id,operation_id,project_id,asset_revision_id,annotation_revision_id,ontology_version_id,actor_id,job_id,profile_id,profile_snapshot_json,provider_id,source,intent,prompt,context_json,input_fingerprint,request_hash,state,cost_display,created_at) SELECT 'foreign-run','foreign-operation','foreign-project','foreign-asset','foreign-revision','foreign-ontology',actor_id,job_id,profile_id,profile_snapshot_json,provider_id,source,intent,prompt,context_json,input_fingerprint,request_hash,state,cost_display,created_at FROM model_runs WHERE run_id='run-1'",
            "INSERT INTO review_tasks(task_id,project_id,asset_revision_id,ontology_version_id,assignee_id,created_by,state,created_at) VALUES('task-exact','project-1','asset-1','onto-1','user-1','user-1','submitted','0'),('task-media','project-1','second-asset','onto-1','user-1','user-1','submitted','0'),('task-ontology','project-1','asset-1','second-ontology','user-1','user-1','submitted','0'),('task-foreign','foreign-project','foreign-asset','foreign-ontology','user-1','user-1','submitted','0'),('task-disposable','project-1','asset-1','onto-1','user-1','user-1','submitted','0')",
            "INSERT INTO review_submissions(review_id,task_id,project_id,submitted_by,revision_ids_json,state,created_at) VALUES('review-exact','task-exact','project-1','user-1','[\"rev-1\",\"rev-1\"]','approved','0'),('review-later','task-exact','project-1','user-1','[\"rev-descendant\"]','rejected','1'),('review-wrong-media','task-media','project-1','user-1','[\"rev-1\"]','approved','1'),('review-wrong-ontology','task-ontology','project-1','user-1','[\"rev-1\"]','approved','1'),('review-missing','task-exact','project-1','user-1','[\"not-a-revision\"]','approved','1')",
            "INSERT INTO suggestion_sets(suggestion_set_id,run_id,prediction_id,project_id,asset_revision_id,changes_json,issues_json,score,created_at) SELECT 'suggestion-2',run_id,prediction_id,project_id,asset_revision_id,changes_json,issues_json,score,created_at FROM suggestion_sets WHERE suggestion_set_id='suggestion-1'",
            "INSERT INTO suggestion_decisions(decision_id,suggestion_set_id,change_id,decision,bound_revision_id,actor_id,created_at) VALUES('decision-accept','suggestion-1','change-1','accept','rev-1','user-1','0'),('decision-revert','suggestion-1','change-1','revert','rev-descendant','user-1','1'),('decision-second-accept','suggestion-2','change-1','accept','rev-1','user-1','0'),('decision-second-revert','suggestion-2','change-1','revert','rev-1','user-1','1'),('decision-missing','suggestion-2','missing','revert','not-a-revision','user-1','1')",
        ] { sqlx::query(sql).execute(tx.connection()).await.unwrap(); }
        tx.commit().await.unwrap();
        for (user, token) in [
            (USER, "actor-session"),
            ("viewer", "viewer-session"),
            ("other", "other-session"),
            ("outsider", "outsider-session"),
        ] {
            seed_session(&graph.repository, user, token).await;
        }
        let auth = AuthState::new(
            sqlx::SqlitePool::connect(&database).await.unwrap(),
            AuthConfig {
                bind: "127.0.0.1:48100".parse().unwrap(),
                cookie_secure: false,
                allowed_origins: vec!["http://localhost".into()],
                allowed_hosts: vec!["localhost".into()],
                launch_code: String::new(),
                launch_code_expires_at: 0,
            },
            std::time::Duration::from_secs(2),
        )
        .unwrap();
        let app = auth_router(
            Router::new().route(
                "/api/ai/runs/{id}/outcome-summary",
                get(crate::ai::runs::outcome_summary),
            ),
            graph.repository.clone(),
            &database,
            Ok(None),
        )
        .await
        .merge(crate::review::router(graph.repository.clone(), auth));
        let outcome_path = "/api/ai/runs/run-1/outcome-summary";
        let (_, summary) = call(
            &app,
            "GET",
            outcome_path,
            Some("actor-session"),
            false,
            json!({}),
        )
        .await;
        assert_eq!(summary["accepted_change_count"], 0);
        assert_eq!(
            summary["task_binding"]["basis"],
            "exact_decision_revision_submission"
        );
        assert_eq!(
            summary["task_binding"]["submissions"],
            json!([
                {"task_id":"task-exact","review_id":"review-exact","annotation_revision_id":"rev-1","asset_revision_id":"asset-1","ontology_version_id":"onto-1","task_state":"submitted","review_state":"approved","decision_kinds":["accept","revert"],"suggestion_set_ids":["suggestion-1","suggestion-2"]},
                {"task_id":"task-exact","review_id":"review-later","annotation_revision_id":"rev-descendant","asset_revision_id":"asset-1","ontology_version_id":"onto-1","task_state":"submitted","review_state":"rejected","decision_kinds":["revert"],"suggestion_set_ids":["suggestion-1"]}
            ])
        );
        assert_eq!(summary["task_binding"]["truncated"], false);
        assert_eq!(summary["recorded_work_seconds"], Value::Null);
        assert_eq!(summary["activity_task_bindings"], json!([]));
        assert!(summary.get("media_tasks").is_none());
        assert_eq!(
            call(&app, "GET", outcome_path, None, false, json!({}))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &app,
                "GET",
                outcome_path,
                Some("outsider-session"),
                false,
                json!({})
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        let activity_path = "/api/projects/project-1/activity-sessions/work";
        let old = json!({"seq":0,"kind":"annotation","duration_ms":8000});
        let checkpoint =
            |version, intervals: Value| json!({"expected_version":version,"intervals":intervals});
        assert_eq!(
            call(
                &app,
                "PUT",
                activity_path,
                Some("actor-session"),
                true,
                checkpoint(0, json!([old]))
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(
                &app,
                "GET",
                outcome_path,
                Some("actor-session"),
                false,
                json!({})
            )
            .await
            .1["recorded_work_seconds"],
            Value::Null
        );
        for binding in [
            json!({"run_id":"invalid/id"}),
            json!({"task_id":"invalid/id"}),
            json!({"run_id":"foreign-run"}),
            json!({"task_id":"task-foreign"}),
            json!({"run_id":"missing-run"}),
            json!({"task_id":"missing-task"}),
            json!({"run_id":"run-1","task_id":"task-media"}),
            json!({"run_id":"run-1","task_id":"task-ontology"}),
        ] {
            let mut appended = json!({"seq":1,"kind":"annotation","duration_ms":1000});
            appended
                .as_object_mut()
                .unwrap()
                .extend(binding.as_object().unwrap().clone());
            let result = call(
                &app,
                "PUT",
                activity_path,
                Some("actor-session"),
                true,
                checkpoint(1, json!([old, appended])),
            )
            .await;
            assert_eq!(
                result.0,
                StatusCode::UNPROCESSABLE_ENTITY,
                "{binding}: {result:?}"
            );
        }
        let wait = json!({"seq":1,"kind":"model_wait","duration_ms":7000,"run_id":"run-1","task_id":"task-exact"});
        assert_eq!(
            call(
                &app,
                "PUT",
                activity_path,
                Some("actor-session"),
                true,
                checkpoint(1, json!([old, wait]))
            )
            .await
            .0,
            StatusCode::OK
        );
        let (_, measured_zero) = call(
            &app,
            "GET",
            outcome_path,
            Some("actor-session"),
            false,
            json!({}),
        )
        .await;
        assert_eq!(measured_zero["recorded_work_seconds"], 0.0);
        assert_eq!(
            measured_zero["activity_task_bindings"][0]["recorded_work_seconds"],
            0.0
        );
        let human = json!({"seq":2,"kind":"correction","duration_ms":1250,"run_id":"run-1","task_id":"task-exact"});
        let run_only = json!({"seq":3,"kind":"review","duration_ms":375,"run_id":"run-1"});
        let task_only = json!({"seq":4,"kind":"task","duration_ms":6000,"task_id":"task-exact"});
        let full = json!([old, wait, human, run_only, task_only]);
        assert_eq!(
            call(
                &app,
                "PUT",
                activity_path,
                Some("actor-session"),
                true,
                checkpoint(2, full.clone())
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(
                &app,
                "PUT",
                activity_path,
                Some("actor-session"),
                true,
                checkpoint(0, full.clone())
            )
            .await
            .1["version"],
            3
        );
        let mut altered = full.clone();
        altered[0]["run_id"] = json!("run-1");
        assert_eq!(
            call(
                &app,
                "PUT",
                activity_path,
                Some("actor-session"),
                true,
                checkpoint(3, altered)
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let mut appended = full.clone();
        appended
            .as_array_mut()
            .unwrap()
            .push(json!({"seq":5,"kind":"task","duration_ms":1}));
        assert_eq!(
            call(
                &app,
                "PUT",
                activity_path,
                Some("actor-session"),
                true,
                checkpoint(2, appended)
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let other = checkpoint(
            0,
            json!([{"seq":0,"kind":"annotation","duration_ms":99000,"run_id":"run-1","task_id":"task-exact"}]),
        );
        assert_eq!(
            call(
                &app,
                "PUT",
                activity_path,
                Some("other-session"),
                true,
                other
            )
            .await
            .0,
            StatusCode::OK
        );
        let (_, measured) = call(
            &app,
            "GET",
            outcome_path,
            Some("actor-session"),
            false,
            json!({}),
        )
        .await;
        assert_eq!(measured["recorded_work_seconds"], 1.625);
        assert_eq!(
            measured["activity_task_bindings"],
            json!([{"task_id":"task-exact","recorded_work_seconds":1.25,"basis":"explicit_voluntary_run_task_interval"}])
        );
        assert_eq!(
            measured["work_time_scope"],
            "current_actor_explicit_run_intervals"
        );
        assert_eq!(
            call(
                &app,
                "GET",
                outcome_path,
                Some("viewer-session"),
                false,
                json!({})
            )
            .await
            .1["recorded_work_seconds"],
            Value::Null
        );
        // Viewer membership permits voluntary metrics, never annotation-write rights.
        let viewer = checkpoint(
            0,
            json!([{"seq":0,"kind":"review","duration_ms":20,"run_id":"run-1"}]),
        );
        assert_eq!(
            call(
                &app,
                "PUT",
                activity_path,
                Some("viewer-session"),
                true,
                viewer
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(
                &app,
                "PUT",
                activity_path,
                Some("outsider-session"),
                true,
                checkpoint(0, json!([old]))
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let disposable_path = "/api/projects/project-1/activity-sessions/disposable";
        let disposable = json!({"seq":0,"kind":"task","duration_ms":1,"run_id":"run-1","task_id":"task-disposable"});
        assert_eq!(
            call(
                &app,
                "PUT",
                disposable_path,
                Some("actor-session"),
                true,
                checkpoint(0, json!([disposable]))
            )
            .await
            .0,
            StatusCode::OK
        );
        let mut tx = graph.repository.begin_write().await.unwrap();
        sqlx::query("UPDATE review_tasks SET asset_revision_id='second-asset' WHERE task_id='task-disposable'").execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
        let historical = json!([disposable,{"seq":1,"kind":"task","duration_ms":1}]);
        assert_eq!(
            call(
                &app,
                "PUT",
                disposable_path,
                Some("actor-session"),
                true,
                checkpoint(1, historical.clone())
            )
            .await
            .0,
            StatusCode::OK
        );
        let mut tx = graph.repository.begin_write().await.unwrap();
        sqlx::query("DELETE FROM review_tasks WHERE task_id='task-disposable'")
            .execute(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            call(
                &app,
                "PUT",
                disposable_path,
                Some("actor-session"),
                true,
                checkpoint(0, historical.clone())
            )
            .await
            .0,
            StatusCode::OK
        );
        let mut after_deletion = historical;
        after_deletion
            .as_array_mut()
            .unwrap()
            .push(json!({"seq":2,"kind":"task","duration_ms":1}));
        assert_eq!(
            call(
                &app,
                "PUT",
                disposable_path,
                Some("actor-session"),
                true,
                checkpoint(2, after_deletion)
            )
            .await
            .0,
            StatusCode::OK
        );
        // Real loopback service + session authentication, no inference/model invocation.
        let wire =
            loopback_smoke(app.clone(), "GET", outcome_path, "actor-session", json!({})).await;
        let wire_body: Value =
            serde_json::from_str(wire.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(wire_body["recorded_work_seconds"], 1.626);
        let put_wire = loopback_smoke(app.clone(),"PUT","/api/projects/project-1/activity-sessions/http-smoke","actor-session",checkpoint(0,json!([{"seq":0,"kind":"review","duration_ms":10,"run_id":"run-1","task_id":"task-exact"}]))).await;
        let list_wire = loopback_smoke(
            app.clone(),
            "GET",
            "/api/projects/project-1/activity-sessions",
            "actor-session",
            json!({}),
        )
        .await;
        std::fs::write(report.join("synthetic-http-smoke.log"),format!("Synthetic owned fixture; no model calls.\nGET outcome-summary\n{wire}\nPUT activity checkpoint\n{put_wire}\nGET activity sessions\n{list_wire}")).unwrap();
        // A review can submit multiple exact revisions; each (review, revision) is evidence.
        let mut tx = graph.repository.begin_write().await.unwrap();
        sqlx::query("INSERT INTO review_submissions(review_id,task_id,project_id,submitted_by,revision_ids_json,state,created_at) VALUES('review-mixed','task-exact','project-1','user-1','[\"rev-1\",\"rev-descendant\",\"rev-1\"]','approved','2')").execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
        let mixed = call(
            &app,
            "GET",
            outcome_path,
            Some("actor-session"),
            false,
            json!({}),
        )
        .await
        .1;
        assert_eq!(
            mixed["task_binding"]["submissions"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        let mut tx = graph.repository.begin_write().await.unwrap();
        for index in 0..101 {
            sqlx::query("INSERT INTO review_submissions(review_id,task_id,project_id,submitted_by,revision_ids_json,state,created_at) VALUES(?,'task-exact','project-1','user-1','[\"rev-1\"]','approved','3')")
                .bind(format!("review-cap-{index:03}")).execute(tx.connection()).await.unwrap();
        }
        tx.commit().await.unwrap();
        let capped = call(
            &app,
            "GET",
            outcome_path,
            Some("actor-session"),
            false,
            json!({}),
        )
        .await
        .1;
        assert_eq!(
            capped["task_binding"]["submissions"]
                .as_array()
                .unwrap()
                .len(),
            100
        );
        assert_eq!(capped["task_binding"]["truncated"], true);
    }

    // Both contenders use separate Repository pools against one on-disk WAL DB.
    // Accept deliberately exercises the service's prepare/record save fixture,
    // not a complete HTTP annotation-save consumer.
    async fn contention_accept(repository: Repository) -> Result<(), String> {
        let document = base_document();
        let ontology = fixture_ontology();
        let pins = SavePins {
            project_id: PROJECT,
            asset_revision_id: ASSET,
            canonical_sha256: CANONICAL,
            base_document: &document,
            ontology: &ontology,
        };
        let mut tx = contention::begin_write(&repository).await.unwrap();
        let prepared = match prepare(
            tx.connection(),
            &pins,
            &save_request(vec![accept("change-1")]),
        )
        .await
        {
            Ok(prepared) => prepared,
            Err(error) => {
                tx.rollback().await.unwrap();
                return Err(error.code.to_owned());
            }
        };
        ok(record(
            tx.connection(),
            &prepared,
            BASE_REVISION,
            USER,
            "contention",
        )
        .await);
        tx.commit().await.unwrap();
        Ok(())
    }

    async fn controlled_contention(whole: bool, accept_first: bool, iteration: usize) {
        use crate::ai::{
            profiles::ux_tests::{auth_router, call, seed_session},
            suggestions,
        };
        use axum::{routing::post, Router};
        use contention::{Hook, HOOK};
        use std::sync::Arc;

        let hash = object_hash(&base_document().objects[0]);
        let graph = seeded_graph(&Seed::audit(json!([attributes_change("change-1", &hash)]))).await;
        seed_session(&graph.repository, USER, "actor-session").await;
        let database = format!(
            "sqlite:{}",
            graph._directory.path().join("acceptance.sqlite").display()
        );
        let second = Repository::open(
            &database,
            graph._directory.path().join("objects"),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        let reject_repository = if accept_first {
            second.clone()
        } else {
            graph.repository.clone()
        };
        let accept_repository = if accept_first {
            graph.repository.clone()
        } else {
            second
        };
        let app = auth_router(
            Router::new()
                .route("/api/ai/suggestions/{id}/decision", post(decision_route))
                .route(
                    "/api/ai/suggestions/{id}/rejections",
                    post(suggestions::reject_changes),
                ),
            reject_repository,
            &database,
            Ok(None),
        )
        .await;
        let (path, payload) = if whole {
            (
                "/api/ai/suggestions/suggestion-1/decision",
                json!({"decision":"reject"}),
            )
        } else {
            (
                "/api/ai/suggestions/suggestion-1/rejections",
                json!({"operation_id":"op-contention", "change_ids":["change-1"]}),
            )
        };
        // The very same middleware rejects missing session and CSRF before any seam.
        assert_eq!(
            call(&app, "POST", path, None, true, payload.clone())
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &app,
                "POST",
                path,
                Some("actor-session"),
                false,
                payload.clone()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let holder = Arc::new(Hook {
            hold: true,
            ..Default::default()
        });
        let waiter = Arc::new(Hook::default());
        let timeout = Duration::from_secs(5);
        let (accept_task, reject_task) = if accept_first {
            let accept_task =
                tokio::spawn(HOOK.scope(holder.clone(), contention_accept(accept_repository)));
            tokio::time::timeout(timeout, holder.acquired.notified())
                .await
                .unwrap();
            let reject_task = tokio::spawn(HOOK.scope(waiter.clone(), async move {
                call(&app, "POST", path, Some("actor-session"), true, payload).await
            }));
            (accept_task, reject_task)
        } else {
            let reject_task = tokio::spawn(HOOK.scope(holder.clone(), async move {
                call(&app, "POST", path, Some("actor-session"), true, payload).await
            }));
            tokio::time::timeout(timeout, holder.acquired.notified())
                .await
                .unwrap();
            let accept_task =
                tokio::spawn(HOOK.scope(waiter.clone(), contention_accept(accept_repository)));
            (accept_task, reject_task)
        };
        // Not a scheduling sleep: the second actual begin_write future has
        // already been polled Pending while the first BEGIN IMMEDIATE is held.
        tokio::time::timeout(timeout, waiter.waiting.notified())
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), waiter.acquired.notified())
                .await
                .is_err()
        );
        assert!(!accept_task.is_finished() && !reject_task.is_finished());
        holder.release.notify_one();
        let accepted = tokio::time::timeout(timeout, accept_task)
            .await
            .unwrap()
            .unwrap();
        let (status, response) = tokio::time::timeout(timeout, reject_task)
            .await
            .unwrap()
            .unwrap();
        if accept_first {
            assert_eq!(accepted, Ok(()));
            assert_eq!(status, StatusCode::CONFLICT);
            assert!(
                response.to_string().contains(if whole {
                    "ACCEPTED_SET_REQUIRES_REVERT"
                } else {
                    "ACCEPTED_CHANGE_REQUIRES_REVERT"
                }),
                "{response}"
            );
        } else {
            assert_eq!(status, StatusCode::OK, "{response}");
            assert_eq!(
                accepted.unwrap_err(),
                if whole {
                    "SUGGESTION_SET_NOT_APPLICABLE"
                } else {
                    "CHANGE_REJECTED"
                }
            );
        }
        let mut tx = graph.repository.begin_write().await.unwrap();
        let decisions: Vec<String> = sqlx::query_scalar("SELECT decision FROM suggestion_decisions WHERE suggestion_set_id='suggestion-1' ORDER BY rowid").fetch_all(tx.connection()).await.unwrap();
        assert_eq!(
            decisions,
            if accept_first {
                vec!["accept".to_owned()]
            } else {
                vec![]
            }
        );
        let fold = ok(load_journal(tx.connection(), "suggestion-1").await);
        assert!(
            fold.get("change-1")
                == if accept_first {
                    Some(&ChangeState::Accepted)
                } else {
                    None
                }
        );
        let rejection_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM suggestion_change_rejections WHERE suggestion_set_id='suggestion-1'").fetch_one(tx.connection()).await.unwrap();
        let operations: i64 = sqlx::query_scalar("SELECT count(*) FROM suggestion_rejection_operations WHERE suggestion_set_id='suggestion-1'").fetch_one(tx.connection()).await.unwrap();
        let expected_rejections = i64::from(!accept_first && !whole);
        assert_eq!(
            (rejection_rows, operations),
            (expected_rejections, expected_rejections)
        );
        let state: String = sqlx::query_scalar("SELECT COALESCE((SELECT state FROM suggestion_set_states WHERE suggestion_set_id='suggestion-1'),'pending')").fetch_one(tx.connection()).await.unwrap();
        assert_eq!(
            state,
            if accept_first {
                "accepted"
            } else if whole {
                "rejected"
            } else {
                "pending"
            }
        );
        assert!(
            !(fold.get("change-1") == Some(&ChangeState::Accepted)
                && (rejection_rows != 0 || state == "rejected"))
        );
        tx.commit().await.unwrap();
        println!("controlled contention iteration={iteration} whole={whole} accept_first={accept_first}: two independent write repositories, holder BEGIN acquired, waiter begin Pending and not acquired for 100ms before release; accept={accept_first}, reject_status={status}, journal={}, rejection_rows={rejection_rows}, receipts={operations}, state={state}", decisions.len());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ux_contention_two_connection_accept_holds_against_granular_and_whole_reject() {
        for iteration in 0..8 {
            for whole in [false, true] {
                controlled_contention(whole, true, iteration).await;
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ux_contention_two_connection_reject_holds_against_accept() {
        for iteration in 0..8 {
            for whole in [false, true] {
                controlled_contention(whole, false, iteration).await;
            }
        }
    }
}
