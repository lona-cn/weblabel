//! Immutable per-asset predictions and the untrusted candidate funnel.
//!
//! Every provider submission is schema-validated, size-capped and redacted.
//! Candidates that arrive after the run reached a terminal state are stored in
//! the isolated audit store and can never become appliable suggestions.

use std::collections::{BTreeMap, BTreeSet};

use annotation_domain::{
    object_hash, Attrs, Change, LabelDef, ModelProfile, Origin, OriginType, QualityIssue, Scalar,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqliteConnection;

use crate::ai::{
    events::{self, RecordEvent},
    redact_json,
    runs::RunRecord,
};

pub const MAX_RAW_OUTPUT_BYTES: usize = 256 * 1024;
pub const MAX_CHANGES_PER_SET: usize = 1000;
pub const MAX_ISSUES_PER_SET: usize = 1000;

/// Raw provider submission. Unknown fields are rejected at the contract edge.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubmitCandidates {
    pub provider_event_id: String,
    pub provider_seq: Option<i64>,
    pub raw: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct CandidateEnvelope {
    changes: Vec<Change>,
    issues: Vec<QualityIssue>,
    #[serde(default)]
    score: Option<f64>,
}

#[derive(Debug, Clone)]
pub enum CandidateOutcome {
    Duplicate,
    Applied {
        prediction_id: String,
        suggestion_set_id: String,
    },
    Quarantined {
        audit_id: String,
    },
    Rejected {
        code: &'static str,
        message: String,
    },
}

/// Everything the validator needs from the pinned run context.
pub struct CandidateTarget<'a> {
    pub width: u32,
    pub height: u32,
    pub labels: &'a [LabelDef],
    pub objects: &'a BTreeMap<String, annotation_domain::AnnotationObject>,
}

pub async fn record_candidate(
    connection: &mut SqliteConnection,
    record: &RunRecord,
    profile: &ModelProfile,
    target: &CandidateTarget<'_>,
    submit: &SubmitCandidates,
) -> Result<CandidateOutcome, sqlx::Error> {
    if !submit.provider_event_id.is_empty() {
        let duplicate = sqlx::query_scalar::<_, i64>(
            "SELECT EXISTS(SELECT 1 FROM run_events WHERE run_id=? AND provider_event_id=?)",
        )
        .bind(&record.run_id)
        .bind(&submit.provider_event_id)
        .fetch_one(&mut *connection)
        .await?;
        if duplicate != 0 {
            return Ok(CandidateOutcome::Duplicate);
        }
    }
    let raw_bytes = serde_json::to_vec(&submit.raw).unwrap_or_default();
    if raw_bytes.len() > MAX_RAW_OUTPUT_BYTES {
        return Ok(CandidateOutcome::Rejected {
            code: "PREDICTION_TOO_LARGE",
            message: format!(
                "raw provider output exceeds the {} byte cap",
                MAX_RAW_OUTPUT_BYTES
            ),
        });
    }
    let mut redacted = submit.raw.clone();
    redact_json(&mut redacted);
    let envelope: CandidateEnvelope = match serde_json::from_value(redacted.clone()) {
        Ok(envelope) => envelope,
        Err(error) => {
            return Ok(CandidateOutcome::Rejected {
                code: "INVALID_CANDIDATE",
                message: format!("candidate does not match the schema: {error}"),
            })
        }
    };
    if envelope.changes.len() > MAX_CHANGES_PER_SET {
        return Ok(CandidateOutcome::Rejected {
            code: "TOO_MANY_CHANGES",
            message: format!("a suggestion set may contain at most {MAX_CHANGES_PER_SET} changes"),
        });
    }
    if envelope.issues.len() > MAX_ISSUES_PER_SET {
        return Ok(CandidateOutcome::Rejected {
            code: "TOO_MANY_ISSUES",
            message: format!("a suggestion set may contain at most {MAX_ISSUES_PER_SET} issues"),
        });
    }
    for issue in &envelope.issues {
        if let Some(region) = &issue.region {
            if let Err(error) =
                annotation_domain::validate_bbox(region, target.width, target.height)
            {
                return Ok(CandidateOutcome::Rejected {
                    code: "INVALID_GEOMETRY",
                    message: error.message.to_owned(),
                });
            }
        }
        if issue.message.chars().count() > 4096 || issue.code.chars().count() > 128 {
            return Ok(CandidateOutcome::Rejected {
                code: "INVALID_CANDIDATE",
                message: "quality issue text exceeds its budget".to_owned(),
            });
        }
    }
    let prediction_id = uuid::Uuid::new_v4().to_string();
    let changes = match validate_changes(
        record.intent.as_str(),
        profile,
        target,
        &envelope.changes,
        &prediction_id,
        &record.run_id,
    ) {
        Ok(changes) => changes,
        Err((code, message)) => return Ok(CandidateOutcome::Rejected { code, message }),
    };

    // Authoritative state check at delivery time: late output after a terminal
    // run is quarantined into the isolated audit store and never applied.
    let current_state: Option<String> =
        sqlx::query_scalar("SELECT state FROM model_runs WHERE run_id=?")
            .bind(&record.run_id)
            .fetch_optional(&mut *connection)
            .await?;
    let terminal = current_state
        .as_deref()
        .and_then(|state| runs_state(state))
        .is_some_and(|state| state.is_terminal());
    let redacted_json = serde_json::to_string(&redacted).unwrap_or_else(|_| "{}".to_owned());
    if terminal {
        let audit_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO prediction_audit(audit_id, run_id, project_id, asset_revision_id, source, \
             raw_output_json, raw_output_bytes, reason, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&audit_id)
        .bind(&record.run_id)
        .bind(&record.project_id)
        .bind(&record.asset_revision_id)
        .bind(&record.source)
        .bind(&redacted_json)
        .bind(raw_bytes.len() as i64)
        .bind(format!(
            "run_terminal:{}",
            current_state.unwrap_or_default()
        ))
        .bind(crate::projects::now_rfc3339())
        .execute(&mut *connection)
        .await?;
        events::record(
            &mut *connection,
            &record.run_id,
            RecordEvent {
                provider_event_id: Some(&submit.provider_event_id),
                provider_seq: submit.provider_seq,
                event_type: events::RunEventType::Candidate,
                message: "late candidate quarantined; run already terminal",
                data: Some(json!({
                    "quarantined": true,
                    "audit_id": audit_id,
                    "reason": "run_terminal",
                })),
            },
        )
        .await?;
        return Ok(CandidateOutcome::Quarantined { audit_id });
    }

    let suggestion_set_id = uuid::Uuid::new_v4().to_string();
    let created_at = crate::projects::now_rfc3339();
    sqlx::query(
        "INSERT INTO predictions(prediction_id, run_id, project_id, asset_revision_id, source, \
         raw_output_json, raw_output_bytes, usage_json, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    )
    .bind(&prediction_id)
    .bind(&record.run_id)
    .bind(&record.project_id)
    .bind(&record.asset_revision_id)
    .bind(&record.source)
    .bind(&redacted_json)
    .bind(raw_bytes.len() as i64)
    .bind(&created_at)
    .execute(&mut *connection)
    .await?;
    let changes_json = serde_json::to_string(&changes).unwrap_or_else(|_| "[]".to_owned());
    let issues_json = serde_json::to_string(&envelope.issues).unwrap_or_else(|_| "[]".to_owned());
    sqlx::query(
        "INSERT INTO suggestion_sets(suggestion_set_id, run_id, prediction_id, project_id, \
         asset_revision_id, changes_json, issues_json, score, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&suggestion_set_id)
    .bind(&record.run_id)
    .bind(&prediction_id)
    .bind(&record.project_id)
    .bind(&record.asset_revision_id)
    .bind(&changes_json)
    .bind(&issues_json)
    .bind(envelope.score)
    .bind(&created_at)
    .execute(&mut *connection)
    .await?;
    sqlx::query(
        "INSERT INTO suggestion_set_states(suggestion_set_id, state, updated_at) \
         VALUES (?, 'pending', ?)",
    )
    .bind(&suggestion_set_id)
    .bind(&created_at)
    .execute(&mut *connection)
    .await?;
    events::record(
        &mut *connection,
        &record.run_id,
        RecordEvent {
            provider_event_id: Some(&submit.provider_event_id),
            provider_seq: submit.provider_seq,
            event_type: events::RunEventType::Candidate,
            message: "candidate recorded",
            data: Some(json!({
                "suggestion_set_id": suggestion_set_id,
                "prediction_id": prediction_id,
                "source": record.source,
            })),
        },
    )
    .await?;
    Ok(CandidateOutcome::Applied {
        prediction_id,
        suggestion_set_id,
    })
}

fn runs_state(value: &str) -> Option<crate::ai::runs::RunState> {
    crate::ai::runs::RunState::parse(value)
}

fn validate_changes(
    intent: &str,
    profile: &ModelProfile,
    target: &CandidateTarget<'_>,
    changes: &[Change],
    prediction_id: &str,
    run_id: &str,
) -> Result<Vec<Change>, (&'static str, String)> {
    let mut change_ids = BTreeSet::new();
    let mut validated = Vec::with_capacity(changes.len());
    for change in changes {
        match change {
            Change::Create {
                change_id,
                object,
                before_hash,
                reason,
            } => {
                if intent != "detect" {
                    return Err((
                        "INVALID_CHANGE_KIND",
                        "create changes are only allowed for detect runs".to_owned(),
                    ));
                }
                // Contract C4: only a detector or a profile that explicitly
                // enables bbox output may produce new bounding boxes.
                if !profile.capabilities.bbox_output
                    && profile.provider_id != annotation_domain::ProviderId::DetectorLocal
                {
                    return Err((
                        "INVALID_CHANGE_KIND",
                        "create changes require a detector or a profile with bbox_output"
                            .to_owned(),
                    ));
                }
                if before_hash.is_some() {
                    return Err((
                        "INVALID_CHANGE_KIND",
                        "create changes must carry before_hash=null".to_owned(),
                    ));
                }
                if reason.chars().count() > 4096 {
                    return Err((
                        "INVALID_CANDIDATE",
                        "change reason exceeds 4096 characters".to_owned(),
                    ));
                }
                annotation_domain::validate_bbox(&object.geometry, target.width, target.height)
                    .map_err(|error| ("INVALID_GEOMETRY", error.message.to_owned()))?;
                let label = target
                    .labels
                    .iter()
                    .find(|label| label.label_id == object.label_id)
                    .ok_or_else(|| {
                        (
                            "UNKNOWN_LABEL",
                            format!("label {} is not in the pinned ontology", &*object.label_id),
                        )
                    })?;
                validate_attributes(label, &object.attributes, true)?;
                let mut object = object.clone();
                // Provenance is server-written: predictions can never claim a
                // manual or imported origin.
                object.origin = Origin {
                    kind: OriginType::Prediction,
                    prediction_id: Some(annotation_domain::Id::from(prediction_id)),
                    model_run_id: Some(annotation_domain::Id::from(run_id)),
                    import_batch_id: None,
                };
                validated.push(Change::Create {
                    change_id: change_id.clone(),
                    object,
                    before_hash: None,
                    reason: reason.clone(),
                });
            }
            Change::SetAttributes {
                change_id,
                object_id,
                values,
                before_hash,
                reason,
            } => {
                if intent != "audit_attributes" {
                    return Err((
                        "INVALID_CHANGE_KIND",
                        "set_attributes changes are only allowed for audit_attributes runs"
                            .to_owned(),
                    ));
                }
                if !profile.capabilities.attributes {
                    return Err((
                        "INVALID_CHANGE_KIND",
                        "set_attributes changes require a profile with attribute output".to_owned(),
                    ));
                }
                if reason.chars().count() > 4096 {
                    return Err((
                        "INVALID_CANDIDATE",
                        "change reason exceeds 4096 characters".to_owned(),
                    ));
                }
                let object = target.objects.get(&**object_id).ok_or_else(|| {
                    (
                        "CONTEXT_OBJECT_UNKNOWN",
                        format!("object {} is not in the pinned revision", &**object_id),
                    )
                })?;
                if object_hash(object) != *before_hash {
                    return Err((
                        "BEFORE_HASH_MISMATCH",
                        format!(
                            "before_hash does not match object {} ({})",
                            &**object_id, &**change_id
                        ),
                    ));
                }
                let label = target
                    .labels
                    .iter()
                    .find(|label| label.label_id == object.label_id)
                    .ok_or_else(|| {
                        (
                            "UNKNOWN_LABEL",
                            "object label is not in the pinned ontology".to_owned(),
                        )
                    })?;
                validate_attributes(label, values, false)?;
                validated.push(change.clone());
            }
            Change::SetLabel { .. } => {
                return Err((
                    "INVALID_CHANGE_KIND",
                    format!("set_label changes are not permitted for {intent} runs"),
                ));
            }
        }
        if !change_ids.insert(change_id_of(change).to_owned()) {
            return Err((
                "DUPLICATE_CHANGE_ID",
                "change_id values must be unique within a suggestion set".to_owned(),
            ));
        }
    }
    Ok(validated)
}

fn change_id_of(change: &Change) -> &str {
    match change {
        Change::Create { change_id, .. }
        | Change::SetAttributes { change_id, .. }
        | Change::SetLabel { change_id, .. } => change_id,
    }
}

fn validate_attributes(
    label: &LabelDef,
    values: &Attrs,
    require_complete: bool,
) -> Result<(), (&'static str, String)> {
    for (key, value) in values {
        let definition = label
            .attributes
            .iter()
            .find(|definition| definition.key == *key)
            .ok_or_else(|| {
                (
                    "UNKNOWN_ATTRIBUTE",
                    format!("attribute {key} is not defined for the label"),
                )
            })?;
        match (&definition.kind, value) {
            (annotation_domain::AttributeKind::Enum, Scalar::String(text)) => {
                if !definition.enum_values.iter().any(|entry| entry == text) {
                    return Err((
                        "INVALID_ATTRIBUTE_VALUE",
                        format!("attribute {key} must be one of the declared enum values"),
                    ));
                }
            }
            (annotation_domain::AttributeKind::Boolean, Scalar::Boolean(_)) => {}
            (annotation_domain::AttributeKind::Number, Scalar::Number(number)) => {
                if !number.is_finite() {
                    return Err((
                        "INVALID_ATTRIBUTE_VALUE",
                        format!("attribute {key} must be finite"),
                    ));
                }
                if let Some(min) = definition.min {
                    if *number < min {
                        return Err((
                            "INVALID_ATTRIBUTE_VALUE",
                            format!("attribute {key} is below its minimum"),
                        ));
                    }
                }
                if let Some(max) = definition.max {
                    if *number > max {
                        return Err((
                            "INVALID_ATTRIBUTE_VALUE",
                            format!("attribute {key} is above its maximum"),
                        ));
                    }
                }
            }
            (annotation_domain::AttributeKind::Text, Scalar::String(text)) => {
                if text.chars().count() > 4096 {
                    return Err((
                        "INVALID_ATTRIBUTE_VALUE",
                        format!("attribute {key} exceeds 4096 characters"),
                    ));
                }
            }
            _ => {
                return Err((
                    "INVALID_ATTRIBUTE_VALUE",
                    format!("attribute {key} does not match its declared kind"),
                ))
            }
        }
    }
    if require_complete {
        for definition in &label.attributes {
            if definition.required && !values.contains_key(&definition.key) {
                return Err((
                    "MISSING_ATTRIBUTE",
                    format!("required attribute {} is missing", definition.key),
                ));
            }
        }
    }
    Ok(())
}

/// Parses stored issue rows back into wire issues.
pub(crate) fn parse_issues(json: &str) -> Vec<QualityIssue> {
    serde_json::from_str(json).unwrap_or_default()
}

/// Parses stored change rows back into wire changes.
pub(crate) fn parse_changes(json: &str) -> Vec<Change> {
    serde_json::from_str(json).unwrap_or_default()
}

/// Loads the pinned objects of an annotation revision for candidate validation.
pub(crate) fn pinned_objects(
    body_json: &str,
) -> Result<BTreeMap<String, annotation_domain::AnnotationObject>, serde_json::Error> {
    let document: annotation_domain::AnnotationDocument = serde_json::from_str(body_json)?;
    Ok(document
        .objects
        .into_iter()
        .map(|object| (object.object_id.to_string(), object))
        .collect())
}
