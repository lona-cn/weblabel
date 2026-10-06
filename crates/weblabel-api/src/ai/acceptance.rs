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

    // Recompute the state row of every set touched by this save. When the C6
    // reject route lands (T25), a terminal "rejected"/"stale" state must not be
    // silently overwritten here: reject must block later accepts unless the
    // user explicitly re-confirms the set.
    for (set_id, facts) in &facts {
        let journal = states.get(set_id).expect("journal loaded above");
        let mut accepted = 0usize;
        for change in &facts.changes {
            if journal.get(&**change_id_of(change)) == Some(&ChangeState::Accepted) {
                accepted += 1;
            }
        }
        let state = if accepted == 0 {
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
    let mut tx = match state.repository.begin_write().await {
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
    if current == "accepted" {
        return failure_response(
            StatusCode::CONFLICT,
            "ACCEPTED_SET_REQUIRES_REVERT",
            "Accepted changes must be reverted in an annotation save before rejection",
        );
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use annotation_domain::{
        object_hash, AnnotationDocument, SaveRequest, SuggestionDecisionIntent,
    };
    use serde_json::{json, Value};
    use sqlx::Row;
    use tempfile::tempdir;

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
        let directory = tempdir().unwrap();
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
             VALUES ('asset-1','project-1','media-1','original-sha','canonical-sha','fixture.png','2026-01-01T00:00:00.000Z')",
        )
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
}
