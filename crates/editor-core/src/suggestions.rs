//! Editor-side suggestion acceptance: atomic accept with reversible history.
//!
//! An acceptance is planned through the shared `annotation-domain` validation
//! and then applied as an aggregate of ordinary editor commands, so the regular
//! command rules (locks, document validation) stay in force and history keeps
//! the pre-change document as the inverse. Undo of an accept emits a `revert`
//! decision intent and redo emits `accept` again; the source prediction is
//! never modified.

use annotation_domain::{
    suggestion_validation::{validate_suggestions, AcceptanceContext, RunGate},
    AnnotationDocument, Change, DomainError, EditorCommand, Id, OntologyVersion,
    SuggestionDecisionIntent, SuggestionSet,
};

use crate::{commands, Selection};

/// Pins the caller knows at acceptance time; unknown pins are `None`.
#[derive(Debug, Clone, Copy)]
pub struct AcceptancePins<'a> {
    /// Generation of the editor kernel right now.
    pub generation: u64,
    /// Generation the client observed when it issued the command.
    pub expected_generation: u64,
    /// Annotation revision the open document was loaded from, when known.
    pub base_revision_id: Option<&'a Id>,
    /// Canonical image hash of the open asset, when known.
    pub canonical_sha256: Option<&'a str>,
    /// Capability gate of the originating run, when known.
    pub run: Option<RunGate<'a>>,
}

/// Validates the selected `change_ids` and applies them to `document` as one
/// atomic command aggregate.
///
/// On any validation or application error the document is left byte-identical.
/// On success the returned intent must be journaled in the same transaction as
/// the resulting revision.
pub fn apply(
    document: &mut AnnotationDocument,
    ontology: &OntologyVersion,
    selection: &Selection,
    pins: &AcceptancePins<'_>,
    set: &SuggestionSet,
    change_ids: &[Id],
) -> Result<SuggestionDecisionIntent, DomainError> {
    let context = AcceptanceContext {
        document,
        ontology,
        expected_generation: Some(pins.expected_generation),
        current_generation: Some(pins.generation),
        base_revision_id: pins.base_revision_id,
        canonical_sha256: pins.canonical_sha256,
        run: pins.run,
    };
    let batch = validate_suggestions(&context, set, change_ids)?;

    // Ordinary command aggregate applied to a scratch copy: one bad command
    // rolls the whole batch back and the caller's document never changes.
    let mut working = document.clone();
    for change in batch.changes.iter().copied() {
        commands::apply(&mut working, ontology, selection, &command_for(change))?;
    }
    *document = working;
    Ok(batch.decision)
}

/// The ordinary editor command one validated change expands to.
fn command_for(change: &Change) -> EditorCommand {
    match change {
        Change::Create { object, .. } => EditorCommand::Create {
            object: object.clone(),
        },
        Change::SetAttributes {
            object_id, values, ..
        } => EditorCommand::SetAttributes {
            object_ids: vec![object_id.clone()],
            values: values.clone(),
        },
        Change::SetLabel {
            object_id,
            label_id,
            ..
        } => EditorCommand::SetLabel {
            object_ids: vec![object_id.clone()],
            label_id: label_id.clone(),
        },
    }
}

/// Flips accept/revert for the intents recorded by a history entry that is
/// being undone (redo re-emits the original intents).
pub(crate) fn revert_intents(
    decisions: &[SuggestionDecisionIntent],
) -> Vec<SuggestionDecisionIntent> {
    use annotation_domain::SuggestionDecision;
    decisions
        .iter()
        .map(|intent| SuggestionDecisionIntent {
            suggestion_set_id: intent.suggestion_set_id.clone(),
            change_ids: intent.change_ids.clone(),
            decision: match intent.decision {
                SuggestionDecision::Accept => SuggestionDecision::Revert,
                SuggestionDecision::Revert => SuggestionDecision::Accept,
            },
        })
        .collect()
}
