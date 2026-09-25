//! Shared accept-time validation for untrusted suggestion batches.
//!
//! Candidate output is never trusted: before a batch of selected changes may be
//! accepted, the pinned run context, the object hashes, the ontology rules and
//! the capability gate must all match the current document. Any mismatch leaves
//! the caller's document untouched and returns a `DomainError`.
//!
//! The same function backs the editor core (native/WASM) and the server save
//! transaction so the rules cannot drift between surfaces.

use std::collections::{BTreeMap, HashSet};

use crate::{
    hash::object_hash, AnnotationDocument, AnnotationObject, Attrs, Change, DomainError, Id,
    LabelDef, ModelCapabilities, OntologyVersion, ProviderId, RunIntent, Scalar,
    SuggestionDecision, SuggestionDecisionIntent, SuggestionSet,
};

/// A suggestion set may describe at most this many changes.
pub const MAX_SUGGESTION_CHANGES: usize = 1000;
/// A single acceptance may select at most this many change IDs.
pub const MAX_CHANGE_IDS: usize = 1000;

/// Capability gate of the model run that produced the suggestion set.
#[derive(Debug, Clone, Copy)]
pub struct RunGate<'a> {
    pub intent: RunIntent,
    pub provider_id: ProviderId,
    pub capabilities: &'a ModelCapabilities,
}

/// Everything the caller knows about the state the batch must apply to.
///
/// Unknown pins are `None` and are then not enforced; callers that hold the
/// pin (the server always does) MUST pass it.
#[derive(Debug, Clone, Copy)]
pub struct AcceptanceContext<'a> {
    pub document: &'a AnnotationDocument,
    pub ontology: &'a OntologyVersion,
    pub expected_generation: Option<u64>,
    pub current_generation: Option<u64>,
    pub base_revision_id: Option<&'a Id>,
    pub canonical_sha256: Option<&'a str>,
    pub run: Option<RunGate<'a>>,
}

/// A fully validated, atomically acceptable subset of a suggestion set.
pub struct ValidatedBatch<'a> {
    /// Validated changes in the caller's `change_ids` order.
    pub changes: Vec<&'a Change>,
    /// The accept intent the caller must record together with its revision.
    pub decision: SuggestionDecisionIntent,
}

/// Validates the explicitly selected `change_ids` of `set` against `context`.
///
/// The batch is atomic: when any selected change is rejected the whole batch is
/// rejected and nothing may be applied.
pub fn validate_suggestions<'a, 'doc>(
    context: &AcceptanceContext<'doc>,
    set: &'a SuggestionSet,
    change_ids: &[Id],
) -> Result<ValidatedBatch<'a>, DomainError> {
    if change_ids.is_empty() {
        return Err(DomainError::new(
            "EMPTY_SELECTION",
            "accepting a suggestion requires at least one change",
        ));
    }
    if change_ids.len() > MAX_CHANGE_IDS {
        return Err(DomainError::new(
            "TOO_MANY_CHANGES",
            "at most 1000 changes may be accepted at once",
        ));
    }
    if set.changes.len() > MAX_SUGGESTION_CHANGES {
        return Err(DomainError::new(
            "TOO_MANY_CHANGES",
            "a suggestion set may contain at most 1000 changes",
        ));
    }

    // Pinned context: any drift marks the set stale; nothing is rebased.
    if set.context.asset_revision_id != context.document.asset_revision_id {
        return Err(DomainError::new(
            "STALE_ASSET",
            "suggestion set belongs to a different asset revision",
        ));
    }
    if set.context.ontology_version_id != context.document.ontology_version_id {
        return Err(DomainError::new(
            "STALE_ONTOLOGY",
            "suggestion set was produced against another ontology version",
        ));
    }
    if let Some(base_revision_id) = context.base_revision_id {
        if set.context.annotation_revision_id != *base_revision_id {
            return Err(DomainError::new(
                "STALE_BASE_REVISION",
                "suggestion set was produced against another annotation revision",
            ));
        }
    }
    if let Some(canonical_sha256) = context.canonical_sha256 {
        if set.context.canonical_sha256 != canonical_sha256 {
            return Err(DomainError::new(
                "STALE_CANONICAL_HASH",
                "canonical media hash changed since the run",
            ));
        }
    }
    if let (Some(expected), Some(current)) =
        (context.expected_generation, context.current_generation)
    {
        if expected != current {
            return Err(DomainError::new(
                "STALE_GENERATION",
                "document generation moved since the command was issued",
            ));
        }
    }

    // Resolve the explicitly selected subset and reject duplicate identities.
    let mut selected: Vec<&Change> = Vec::with_capacity(change_ids.len());
    let mut seen_change_ids: HashSet<&Id> = HashSet::with_capacity(change_ids.len());
    let mut touched_objects: HashSet<&Id> = HashSet::with_capacity(change_ids.len());
    for selected_id in change_ids {
        let change = set
            .changes
            .iter()
            .find(|change| change_id(change) == selected_id)
            .ok_or_else(|| {
                DomainError::new(
                    "CHANGE_NOT_FOUND",
                    "selected change_id does not belong to the suggestion set",
                )
            })?;
        if !seen_change_ids.insert(selected_id) {
            return Err(DomainError::new(
                "DUPLICATE_CHANGE_ID",
                "change_ids must be unique within one acceptance",
            ));
        }
        if !touched_objects.insert(change_object_id(change)) {
            return Err(DomainError::new(
                "DUPLICATE_OBJECT_ID",
                "one object may only be touched by one change per acceptance",
            ));
        }
        selected.push(change);
    }

    for change in &selected {
        validate_change(context, set, change)?;
    }

    Ok(ValidatedBatch {
        changes: selected,
        decision: SuggestionDecisionIntent {
            suggestion_set_id: set.suggestion_set_id.clone(),
            change_ids: change_ids.to_vec(),
            decision: SuggestionDecision::Accept,
        },
    })
}

fn validate_change(
    context: &AcceptanceContext<'_>,
    set: &SuggestionSet,
    change: &Change,
) -> Result<(), DomainError> {
    if let Some(gate) = context.run {
        enforce_run_gate(gate, change)?;
    }
    match change {
        Change::Create {
            object,
            before_hash,
            ..
        } => {
            if before_hash.is_some() {
                return Err(DomainError::new(
                    "INVALID_CHANGE_KIND",
                    "create changes must carry before_hash=null",
                ));
            }
            if context
                .document
                .objects
                .iter()
                .any(|existing| existing.object_id == object.object_id)
            {
                return Err(DomainError::new(
                    "DUPLICATE_OBJECT_ID",
                    "created object_id already exists in the document",
                ));
            }
            verify_created_origin(set, object)?;
            crate::validate_bbox(
                &object.geometry,
                context.document.coordinate_space.width,
                context.document.coordinate_space.height,
            )?;
            let label = find_label(context.ontology, &object.label_id)?;
            validate_attributes(label, &object.attributes, true)?;
        }
        Change::SetAttributes {
            object_id,
            values,
            before_hash,
            ..
        } => {
            let object = find_object(context.document, object_id)?;
            verify_before_hash(object, before_hash)?;
            let label = find_label(context.ontology, &object.label_id)?;
            validate_attributes(label, values, false)?;
        }
        Change::SetLabel {
            object_id,
            label_id,
            before_hash,
            ..
        } => {
            let object = find_object(context.document, object_id)?;
            verify_before_hash(object, before_hash)?;
            let label = find_label(context.ontology, label_id)?;
            // The relabeled object must satisfy the new label's definitions.
            validate_attributes(label, &object.attributes, true)?;
        }
    }
    Ok(())
}

/// Create actions are limited to detection runs by detector profiles or
/// profiles that explicitly enable bbox output; attribute audits may only
/// suggest attribute edits (contract C4).
fn enforce_run_gate(gate: RunGate<'_>, change: &Change) -> Result<(), DomainError> {
    match (gate.intent, change) {
        (RunIntent::Detect, Change::Create { .. }) => {
            if gate.capabilities.bbox_output || gate.provider_id == ProviderId::DetectorLocal {
                Ok(())
            } else {
                Err(DomainError::new(
                    "INVALID_CHANGE_KIND",
                    "create changes require a detector or a profile with bbox_output",
                ))
            }
        }
        (RunIntent::AuditAttributes, Change::SetAttributes { .. }) => {
            if gate.capabilities.attributes {
                Ok(())
            } else {
                Err(DomainError::new(
                    "INVALID_CHANGE_KIND",
                    "set_attributes changes require a profile with attribute output",
                ))
            }
        }
        (_, _) => Err(DomainError::new(
            "INVALID_CHANGE_KIND",
            "change kind is not permitted for this run intent",
        )),
    }
}

/// Accepted creations keep the provenance the server wrote when it recorded the
/// candidate; clients can never claim manual or imported origins for them.
fn verify_created_origin(
    set: &SuggestionSet,
    object: &AnnotationObject,
) -> Result<(), DomainError> {
    let origin = &object.origin;
    let verified = origin.kind == crate::OriginType::Prediction
        && origin.prediction_id.as_ref() == Some(&set.prediction_id)
        && origin.model_run_id.as_ref() == Some(&set.model_run_id)
        && origin.import_batch_id.is_none();
    if verified {
        Ok(())
    } else {
        Err(DomainError::new(
            "UNVERIFIED_PROVENANCE",
            "created objects must carry the prediction provenance of their suggestion set",
        ))
    }
}

fn verify_before_hash(object: &AnnotationObject, before_hash: &str) -> Result<(), DomainError> {
    if object_hash(object) == before_hash {
        Ok(())
    } else {
        Err(DomainError::new(
            "STALE_OBJECT",
            "object changed since the suggestion was produced",
        ))
    }
}

fn find_object<'a>(
    document: &'a AnnotationDocument,
    object_id: &Id,
) -> Result<&'a AnnotationObject, DomainError> {
    document
        .objects
        .iter()
        .find(|object| object.object_id == *object_id)
        .ok_or_else(|| {
            DomainError::new(
                "CONTEXT_OBJECT_UNKNOWN",
                "object is not part of the pinned document",
            )
        })
}

fn find_label<'a>(
    ontology: &'a OntologyVersion,
    label_id: &Id,
) -> Result<&'a LabelDef, DomainError> {
    ontology
        .labels
        .iter()
        .find(|label| label.label_id == *label_id)
        .ok_or_else(|| {
            DomainError::new(
                "UNKNOWN_LABEL",
                "label is not defined by the pinned ontology",
            )
        })
}

/// Validates attribute values against the pinned label definition with the
/// same rule vocabulary as the candidate funnel (T17 `validate_changes`).
fn validate_attributes(
    label: &LabelDef,
    values: &Attrs,
    require_complete: bool,
) -> Result<(), DomainError> {
    for (key, value) in values {
        let definition = label
            .attributes
            .iter()
            .find(|definition| definition.key == *key)
            .ok_or_else(|| {
                DomainError::new(
                    "UNKNOWN_ATTRIBUTE",
                    "attribute is not defined for the label",
                )
            })?;
        match (&definition.kind, value) {
            (_, Scalar::Null) => {}
            (crate::AttributeKind::Enum, Scalar::String(text)) => {
                if !definition.enum_values.iter().any(|entry| entry == text) {
                    return Err(DomainError::new(
                        "INVALID_ATTRIBUTE_VALUE",
                        "attribute must be one of the declared enum values",
                    ));
                }
            }
            (crate::AttributeKind::Boolean, Scalar::Boolean(_)) => {}
            (crate::AttributeKind::Number, Scalar::Number(number)) => {
                if !number.is_finite() {
                    return Err(DomainError::new(
                        "INVALID_ATTRIBUTE_VALUE",
                        "attribute must be finite",
                    ));
                }
                if definition.min.is_some_and(|min| *number < min)
                    || definition.max.is_some_and(|max| *number > max)
                {
                    return Err(DomainError::new(
                        "INVALID_ATTRIBUTE_VALUE",
                        "attribute is outside its declared range",
                    ));
                }
            }
            (crate::AttributeKind::Text, Scalar::String(text)) => {
                if text.chars().count() > 4096 {
                    return Err(DomainError::new(
                        "INVALID_ATTRIBUTE_VALUE",
                        "attribute exceeds 4096 characters",
                    ));
                }
            }
            _ => {
                return Err(DomainError::new(
                    "INVALID_ATTRIBUTE_VALUE",
                    "attribute does not match its declared kind",
                ))
            }
        }
    }
    if require_complete {
        for definition in &label.attributes {
            if definition.required && !values.contains_key(&definition.key) {
                return Err(DomainError::new(
                    "MISSING_ATTRIBUTE",
                    "required attribute is missing",
                ));
            }
        }
    }
    Ok(())
}

/// Identity of a change for selection and journal bookkeeping.
pub fn change_id(change: &Change) -> &Id {
    match change {
        Change::Create { change_id, .. }
        | Change::SetAttributes { change_id, .. }
        | Change::SetLabel { change_id, .. } => change_id,
    }
}

/// The object a change targets (created or modified).
pub fn change_object_id(change: &Change) -> &Id {
    match change {
        Change::Create { object, .. } => &object.object_id,
        Change::SetAttributes { object_id, .. } | Change::SetLabel { object_id, .. } => object_id,
    }
}

/// Attribute values a change writes (empty for other change kinds).
pub fn change_values(change: &Change) -> Option<&BTreeMap<String, Scalar>> {
    match change {
        Change::SetAttributes { values, .. } => Some(values),
        _ => None,
    }
}
