use std::collections::{HashMap, HashSet};

use annotation_domain::{
    validate_document, AnnotationDocument, AnnotationObject, DomainError, EditorCommand,
    EditorDelta, Id, OntologyVersion, Origin, OriginType,
};
use geometry::{css_to_image, normalize_bbox, Viewport};

use crate::{
    commands,
    history::{History, HistoryEntry},
    selection::{LocalFlags, Selection},
    tools::{PointerGesture, PointerInput, PointerPhase, Preview, Tool},
};

const MAX_GENERATION: u64 = 9_007_199_254_740_991;

pub struct Editor {
    document: AnnotationDocument,
    ontology: OntologyVersion,
    generation: u64,
    history: History,
    selection: Selection,
    tool: Tool,
    gesture: Option<PointerGesture>,
    preview: Option<Preview>,
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
            gesture: None,
            preview: None,
            active_label_id: None,
            viewport: Viewport::try_new(1.0, 0.0, 0.0, width, height, 1.0)?,
        })
    }

    pub fn dispatch(&mut self, command: EditorCommand) -> Result<EditorDelta, DomainError> {
        match command {
            EditorCommand::Undo => self.undo(),
            EditorCommand::Redo => self.redo(),
            other => {
                let before = self.document.clone();
                let mut after = before.clone();
                commands::apply(&mut after, &self.ontology, &self.selection, &other)?;
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
        }
    }

    pub fn snapshot(&self) -> AnnotationDocument {
        self.document.clone()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    pub fn set_tool(&mut self, tool: Tool) {
        self.cancel_gesture();
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
        self.cancel_gesture();
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
        self.preview.as_ref()
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
        match input.phase {
            PointerPhase::Down => {
                if self.gesture.is_some() || input.button != 0 {
                    return Ok(self.delta(false, false, Vec::new(), Vec::new()));
                }
                self.gesture = Some(PointerGesture {
                    pointer_id: input.pointer_id,
                    start: point,
                    current: point,
                    additive: input.shift || input.ctrl || input.meta,
                });
                self.refresh_preview();
                Ok(self.delta(false, true, Vec::new(), Vec::new()))
            }
            PointerPhase::Move => {
                let Some(gesture) = self
                    .gesture
                    .as_mut()
                    .filter(|g| g.pointer_id == input.pointer_id)
                else {
                    return Ok(self.delta(false, false, Vec::new(), Vec::new()));
                };
                gesture.current = point;
                self.refresh_preview();
                Ok(self.delta(false, true, Vec::new(), Vec::new()))
            }
            PointerPhase::Cancel => {
                if self
                    .gesture
                    .is_some_and(|gesture| gesture.pointer_id == input.pointer_id)
                {
                    self.cancel_gesture();
                    return Ok(self.delta(false, true, Vec::new(), Vec::new()));
                }
                Ok(self.delta(false, false, Vec::new(), Vec::new()))
            }
            PointerPhase::Up => self.finish_pointer(input.pointer_id, point),
        }
    }

    fn finish_pointer(
        &mut self,
        pointer_id: i32,
        point: [f64; 2],
    ) -> Result<EditorDelta, DomainError> {
        let Some(gesture) = self
            .gesture
            .filter(|gesture| gesture.pointer_id == pointer_id)
        else {
            return Ok(self.delta(false, false, Vec::new(), Vec::new()));
        };
        let gesture = PointerGesture {
            current: point,
            ..gesture
        };
        self.gesture = None;
        self.preview = None;
        match self.tool {
            Tool::Box => {
                let width_css = (gesture.current[0] - gesture.start[0]).abs() * self.viewport.scale;
                let height_css =
                    (gesture.current[1] - gesture.start[1]).abs() * self.viewport.scale;
                if width_css < 2.0 || height_css < 2.0 {
                    return Ok(self.delta(false, true, Vec::new(), Vec::new()));
                }
                let label_id = self.active_label_id.clone().ok_or_else(|| {
                    DomainError::new("ACTIVE_LABEL_REQUIRED", "box tool requires an active label")
                })?;
                let geometry = normalize_bbox(gesture.start, gesture.current)?;
                let attributes = self
                    .ontology
                    .labels
                    .iter()
                    .find(|label| label.label_id == label_id)
                    .expect("active label was validated")
                    .attributes
                    .iter()
                    .map(|attribute| (attribute.key.clone(), attribute.default_value.clone()))
                    .collect();
                let object = AnnotationObject {
                    object_id: Id::from(uuid::Uuid::new_v4().to_string()),
                    label_id,
                    geometry,
                    attributes,
                    origin: Origin {
                        kind: OriginType::Manual,
                        prediction_id: None,
                        model_run_id: None,
                        import_batch_id: None,
                    },
                };
                self.dispatch(EditorCommand::Create { object })
            }
            Tool::Select => {
                let min_x = gesture.start[0].min(gesture.current[0]);
                let min_y = gesture.start[1].min(gesture.current[1]);
                let max_x = gesture.start[0].max(gesture.current[0]);
                let max_y = gesture.start[1].max(gesture.current[1]);
                let mut ids = if gesture.additive {
                    self.selection
                        .ids()
                        .iter()
                        .filter(|id| !self.selection.flags(id).hidden)
                        .cloned()
                        .collect()
                } else {
                    Vec::new()
                };
                ids.extend(
                    self.document
                        .objects
                        .iter()
                        .filter(|object| {
                            !self.selection.flags(&object.object_id).hidden
                                && object.geometry.x_min <= max_x
                                && object.geometry.x_max >= min_x
                                && object.geometry.y_min <= max_y
                                && object.geometry.y_max >= min_y
                        })
                        .map(|object| object.object_id.clone()),
                );
                self.set_selection(ids)
            }
            Tool::Pan => {
                let tx = self.viewport.tx
                    + (gesture.current[0] - gesture.start[0]) * self.viewport.scale;
                let ty = self.viewport.ty
                    + (gesture.current[1] - gesture.start[1]) * self.viewport.scale;
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
        }
    }

    fn refresh_preview(&mut self) {
        self.preview = if self.tool == Tool::Box {
            self.gesture.and_then(|gesture| {
                normalize_bbox(gesture.start, gesture.current)
                    .ok()
                    .map(|geometry| Preview { geometry })
            })
        } else {
            None
        };
    }

    fn cancel_gesture(&mut self) {
        self.gesture = None;
        self.preview = None;
    }

    fn undo(&mut self) -> Result<EditorDelta, DomainError> {
        if !self.history.can_undo() {
            return Ok(self.delta(false, false, Vec::new(), Vec::new()));
        }
        self.bump_generation()?;
        let before = self.document.clone();
        let restored = self
            .history
            .undo(&before)
            .expect("undo availability was checked");
        self.document = restored;
        self.prune_transient_state();
        let after = self.document.clone();
        Ok(self.delta(
            true,
            true,
            changed_objects(&before, &after),
            removed_objects(&before, &after),
        ))
    }
    fn redo(&mut self) -> Result<EditorDelta, DomainError> {
        if !self.history.can_redo() {
            return Ok(self.delta(false, false, Vec::new(), Vec::new()));
        }
        self.bump_generation()?;
        let before = self.document.clone();
        let restored = self
            .history
            .redo(&before)
            .expect("redo availability was checked");
        self.document = restored;
        self.prune_transient_state();
        let after = self.document.clone();
        Ok(self.delta(
            true,
            true,
            changed_objects(&before, &after),
            removed_objects(&before, &after),
        ))
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
