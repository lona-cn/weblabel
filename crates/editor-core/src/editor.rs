use std::collections::{HashMap, HashSet};

use annotation_domain::{
    validate_document, AnnotationDocument, AnnotationObject, DomainError, EditorCommand,
    EditorDelta, Id, OntologyVersion,
};
use geometry::{css_to_image, Viewport};

use crate::{
    commands,
    history::{History, HistoryEntry},
    selection::{LocalFlags, Selection},
    tools::gesture::{self, Action, Commit, EventOutcome, GestureContext, GestureMachine},
    tools::{PointerInput, Preview, Tool},
};

const MAX_GENERATION: u64 = 9_007_199_254_740_991;

pub struct Editor {
    document: AnnotationDocument,
    ontology: OntologyVersion,
    generation: u64,
    history: History,
    selection: Selection,
    tool: Tool,
    gesture: GestureMachine,
    active_label_id: Option<Id>,
    viewport: Viewport,
}

impl Editor {
    pub fn new(
        document: AnnotationDocument,
        ontology: OntologyVersion,
    ) -> Result<Self, DomainError> {
        validate_document(&document, &ontology)?;
        let width = f64::from(document.coordinate_space.width);
        let height = f64::from(document.coordinate_space.height);
        Ok(Self {
            document,
            ontology,
            generation: 0,
            history: History::default(),
            selection: Selection::default(),
            tool: Tool::Select,
            gesture: GestureMachine::new(),
            active_label_id: None,
            viewport: Viewport::try_new(1.0, 0.0, 0.0, width, height, 1.0)?,
        })
    }

    pub fn dispatch(&mut self, command: EditorCommand) -> Result<EditorDelta, DomainError> {
        // A document mutation invalidates any in-flight gesture; committing a
        // gesture reaches this path only after the machine has already cleared
        // its state, so this is a no-op for gesture commits.
        self.gesture.cancel();
        match command {
            EditorCommand::Undo => self.undo(),
            EditorCommand::Redo => self.redo(),
            other => {
                let before = self.document.clone();
                let mut after = before.clone();
                let suggestion_decisions = match &other {
                    EditorCommand::ApplySuggestions {
                        set,
                        change_ids,
                        expected_generation,
                    } => {
                        vec![crate::suggestions::apply(
                            &mut after,
                            &self.ontology,
                            &self.selection,
                            &crate::suggestions::AcceptancePins {
                                generation: self.generation,
                                expected_generation: *expected_generation,
                                base_revision_id: None,
                                canonical_sha256: None,
                                run: None,
                            },
                            set,
                            change_ids,
                        )?]
                    }
                    _ => {
                        commands::apply(&mut after, &self.ontology, &self.selection, &other)?;
                        Vec::new()
                    }
                };
                if after == before {
                    // A value-equal accept is still a decision: surface the
                    // computed intents so the save transaction journals them
                    // even though the document itself did not change.
                    let mut delta = self.delta(false, false, Vec::new(), Vec::new());
                    delta.suggestion_decisions = suggestion_decisions;
                    return Ok(delta);
                }
                self.bump_generation()?;
                self.document = after.clone();
                self.history.push(
                    HistoryEntry::new(before.clone(), after.clone())
                        .with_suggestion_decisions(suggestion_decisions.clone()),
                );
                self.prune_transient_state();
                let mut delta = self.delta(
                    true,
                    true,
                    changed_objects(&before, &after),
                    removed_objects(&before, &after),
                );
                delta.suggestion_decisions = suggestion_decisions;
                Ok(delta)
            }
        }
    }

    pub fn snapshot(&self) -> AnnotationDocument {
        self.document.clone()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Read-only view state so boundary layers can mirror view changes the
    /// gesture path makes (the pan tool) without duplicating view math.
    pub fn viewport(&self) -> Viewport {
        self.viewport
    }

    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    pub fn set_tool(&mut self, tool: Tool) {
        self.gesture.cancel();
        self.tool = tool;
    }

    pub fn set_active_label(&mut self, label_id: Id) -> Result<(), DomainError> {
        if !self
            .ontology
            .labels
            .iter()
            .any(|label| label.label_id == label_id)
        {
            return Err(DomainError::new(
                "UNKNOWN_LABEL",
                "active label is not in the ontology",
            ));
        }
        self.active_label_id = Some(label_id);
        Ok(())
    }

    pub fn set_viewport(&mut self, viewport: Viewport) -> Result<(), DomainError> {
        viewport.validate()?;
        self.viewport = viewport;
        self.gesture.cancel();
        Ok(())
    }

    pub fn set_selection(&mut self, ids: Vec<Id>) -> Result<EditorDelta, DomainError> {
        let existing: HashSet<_> = self
            .document
            .objects
            .iter()
            .map(|object| object.object_id.clone())
            .collect();
        if ids.iter().any(|id| !existing.contains(id)) {
            return Err(DomainError::new(
                "OBJECT_NOT_FOUND",
                "selection contains an unknown object",
            ));
        }
        let previous = self.selection.ids().to_vec();
        self.selection.set(ids);
        Ok(self.delta(
            false,
            previous != self.selection.ids(),
            Vec::new(),
            Vec::new(),
        ))
    }

    pub fn set_local_flags(
        &mut self,
        ids: &[Id],
        hidden: Option<bool>,
        locked: Option<bool>,
    ) -> Result<EditorDelta, DomainError> {
        let existing: HashSet<_> = self
            .document
            .objects
            .iter()
            .map(|object| object.object_id.clone())
            .collect();
        if ids.iter().any(|id| !existing.contains(id)) {
            return Err(DomainError::new(
                "OBJECT_NOT_FOUND",
                "flags contain an unknown object",
            ));
        }
        let before: Vec<_> = ids.iter().map(|id| self.selection.flags(id)).collect();
        self.selection.update_flags(ids, hidden, locked);
        let changed = before
            .iter()
            .zip(ids)
            .any(|(old, id)| *old != self.selection.flags(id));
        Ok(self.delta(false, changed, Vec::new(), Vec::new()))
    }

    pub fn local_flags(&self, id: &Id) -> LocalFlags {
        self.selection.flags(id)
    }

    pub fn preview(&self) -> Option<&Preview> {
        self.gesture.preview()
    }

    pub fn pointer(&mut self, input: PointerInput) -> Result<EditorDelta, DomainError> {
        if !input.x_css.is_finite() || !input.y_css.is_finite() {
            return Err(DomainError::new(
                "INVALID_POINTER",
                "pointer coordinates must be finite",
            ));
        }
        let point = css_to_image([input.x_css, input.y_css], self.viewport);
        if !point[0].is_finite() || !point[1].is_finite() {
            return Err(DomainError::new(
                "INVALID_POINTER",
                "transformed pointer coordinates must be finite",
            ));
        }
        let context = GestureContext {
            document: &self.document,
            selection: &self.selection,
            viewport: self.viewport,
            tool: self.tool,
            active_label_id: self.active_label_id.as_ref(),
            ontology: &self.ontology,
        };
        let outcome = self.gesture.handle(&context, &input, point)?;
        self.apply_outcome(outcome)
    }

    fn apply_outcome(&mut self, outcome: EventOutcome) -> Result<EditorDelta, DomainError> {
        match outcome.action {
            Action::None => Ok(self.delta(false, outcome.repaint, Vec::new(), Vec::new())),
            Action::SetSelection(ids) => self.set_selection(ids),
            Action::Pan(delta_css) => {
                let tx = self.viewport.tx + delta_css[0];
                let ty = self.viewport.ty + delta_css[1];
                if !tx.is_finite() || !ty.is_finite() {
                    return Err(DomainError::new(
                        "INVALID_VIEWPORT",
                        "pan would produce non-finite translation",
                    ));
                }
                self.viewport.tx = tx;
                self.viewport.ty = ty;
                Ok(self.delta(false, true, Vec::new(), Vec::new()))
            }
            Action::Commit { selection, edit } => {
                // The staged selection lands in the same delta as the edit.
                let mut selection_changed = false;
                if let Some(ids) = selection {
                    selection_changed = ids.as_slice() != self.selection.ids();
                    self.selection.set(ids);
                }
                let mut delta = match edit {
                    Commit::Create(object) => self.dispatch(EditorCommand::Create { object })?,
                    Commit::ReplaceGeometries(edits) => {
                        self.commit_document_edit(|document, selection| {
                            gesture::apply_replacements(document, selection, &edits)
                        })?
                    }
                };
                if selection_changed {
                    delta.repaint = true;
                }
                Ok(delta)
            }
        }
    }

    /// Commits one atomic document edit as exactly one history entry.
    fn commit_document_edit(
        &mut self,
        apply: impl FnOnce(&mut AnnotationDocument, &Selection) -> Result<(), DomainError>,
    ) -> Result<EditorDelta, DomainError> {
        let before = self.document.clone();
        let mut after = before.clone();
        apply(&mut after, &self.selection)?;
        validate_document(&after, &self.ontology)?;
        if after == before {
            return Ok(self.delta(false, false, Vec::new(), Vec::new()));
        }
        self.bump_generation()?;
        self.document = after.clone();
        self.history
            .push(HistoryEntry::new(before.clone(), after.clone()));
        self.prune_transient_state();
        Ok(self.delta(
            true,
            true,
            changed_objects(&before, &after),
            removed_objects(&before, &after),
        ))
    }

    fn undo(&mut self) -> Result<EditorDelta, DomainError> {
        if !self.history.can_undo() {
            return Ok(self.delta(false, false, Vec::new(), Vec::new()));
        }
        self.bump_generation()?;
        let before = self.document.clone();
        let (restored, suggestion_decisions) = self
            .history
            .undo(&before)
            .expect("undo availability was checked");
        self.document = restored;
        self.prune_transient_state();
        let after = self.document.clone();
        let mut delta = self.delta(
            true,
            true,
            changed_objects(&before, &after),
            removed_objects(&before, &after),
        );
        delta.suggestion_decisions = suggestion_decisions;
        Ok(delta)
    }
    fn redo(&mut self) -> Result<EditorDelta, DomainError> {
        if !self.history.can_redo() {
            return Ok(self.delta(false, false, Vec::new(), Vec::new()));
        }
        self.bump_generation()?;
        let before = self.document.clone();
        let (restored, suggestion_decisions) = self
            .history
            .redo(&before)
            .expect("redo availability was checked");
        self.document = restored;
        self.prune_transient_state();
        let after = self.document.clone();
        let mut delta = self.delta(
            true,
            true,
            changed_objects(&before, &after),
            removed_objects(&before, &after),
        );
        delta.suggestion_decisions = suggestion_decisions;
        Ok(delta)
    }

    fn bump_generation(&mut self) -> Result<(), DomainError> {
        if self.generation == MAX_GENERATION {
            return Err(DomainError::new(
                "GENERATION_EXHAUSTED",
                "editor generation reached the safe integer limit",
            ));
        }
        self.generation += 1;
        Ok(())
    }

    fn delta(
        &self,
        document_changed: bool,
        repaint: bool,
        changed_objects: Vec<AnnotationObject>,
        removed_object_ids: Vec<Id>,
    ) -> EditorDelta {
        EditorDelta {
            generation: self.generation,
            changed_objects,
            removed_object_ids,
            selected_object_ids: self.selection.ids().to_vec(),
            can_undo: self.history.can_undo(),
            can_redo: self.history.can_redo(),
            document_changed,
            repaint,
            suggestion_decisions: Vec::new(),
            error: None,
        }
    }

    fn prune_transient_state(&mut self) {
        let ids: HashSet<_> = self
            .document
            .objects
            .iter()
            .map(|object| object.object_id.clone())
            .collect();
        self.selection.retain_document_ids(&ids);
    }
}

fn changed_objects(
    before: &AnnotationDocument,
    after: &AnnotationDocument,
) -> Vec<AnnotationObject> {
    let old: HashMap<Id, &AnnotationObject> = before
        .objects
        .iter()
        .map(|object| (object.object_id.clone(), object))
        .collect();
    after
        .objects
        .iter()
        .filter(|object| {
            old.get(&object.object_id)
                .map_or(true, |previous| **previous != **object)
        })
        .cloned()
        .collect()
}

fn removed_objects(before: &AnnotationDocument, after: &AnnotationDocument) -> Vec<Id> {
    let after_ids: HashSet<Id> = after
        .objects
        .iter()
        .map(|object| object.object_id.clone())
        .collect();
    before
        .objects
        .iter()
        .filter(|object| !after_ids.contains(&object.object_id))
        .map(|object| object.object_id.clone())
        .collect()
}
