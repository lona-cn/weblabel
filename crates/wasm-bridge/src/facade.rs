//! C3 editor facade: editor-core owns the geometry truth, this module projects
//! it into renderer scenes and maps every domain error to a structured
//! `ApiError`. `EditorSession` is target-independent and fully unit tested;
//! the wasm32 `EditorFacade` adds JsValue wrapping and wgpu submission.

use std::collections::HashMap;

use annotation_domain::{
    AnnotationDocument, ApiError, DomainError, EditorCommand, EditorDelta, Id, OntologyVersion,
    SuggestionSet,
};
use editor_core::{Editor, PointerInput, Tool};
use geometry::Viewport;
use renderer_wgpu::scene::{Overlay, RenderObject, Viewport as SceneViewport};

use crate::input::LocalFlagsArgs;

/// Fill color for labels whose ontology color string cannot be parsed; every
/// validated ontology parses, so this only guards malformed input.
const UNPAINTED_LABEL_COLOR: [f32; 4] = [0.85, 0.85, 0.85, 1.0];
const PREVIEW_COLOR: [f32; 4] = [0.2, 0.55, 1.0, 0.45];

/// Structured error with a fresh request id (production ids are UUIDs).
pub fn api_error(code: &str, message: &str) -> ApiError {
    ApiError {
        code: code.to_owned(),
        message: message.to_owned(),
        request_id: Id::from(format!("wasm-{}", uuid::Uuid::new_v4())),
        details: None,
    }
}

pub fn api_error_from_domain(error: &DomainError) -> ApiError {
    api_error(error.code, error.message)
}

/// The binary RGBA contract of `create_editor`: exactly width*height*4 bytes of
/// canonical pixels (already EXIF-oriented; no header, no padding).
pub fn validate_canonical_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<(), ApiError> {
    if width == 0 || height == 0 {
        return Err(api_error(
            "CANONICAL_FRAME_SIZE",
            "canonical image must have non-zero dimensions",
        ));
    }
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4));
    match expected {
        Some(expected) if expected == rgba.len() => Ok(()),
        Some(expected) => Err(api_error(
            "CANONICAL_FRAME_SIZE",
            &format!(
                "canonical RGBA is {} bytes; expected {} for {}x{}",
                rgba.len(),
                expected,
                width,
                height
            ),
        )),
        None => Err(api_error(
            "CANONICAL_FRAME_SIZE",
            "canonical image dimensions overflow the RGBA byte count",
        )),
    }
}

fn label_color(color: &str) -> [f32; 4] {
    let hex = color.strip_prefix('#').unwrap_or(color);
    if hex.len() != 6 {
        return UNPAINTED_LABEL_COLOR;
    }
    let channel = |range: std::ops::Range<usize>| {
        u8::from_str_radix(&hex[range], 16).map(|value| f32::from(value) / 255.0)
    };
    match (channel(0..2), channel(2..4), channel(4..6)) {
        (Ok(red), Ok(green), Ok(blue)) => [red, green, blue, 1.0],
        _ => UNPAINTED_LABEL_COLOR,
    }
}

fn scene_viewport(view: Viewport) -> SceneViewport {
    SceneViewport {
        scale: view.scale as f32,
        tx: view.tx as f32,
        ty: view.ty as f32,
        css_width: view.css_width as f32,
        css_height: view.css_height as f32,
        dpr: view.dpr as f32,
    }
}

fn bounds_of(object: &annotation_domain::AnnotationObject) -> [f32; 4] {
    bounds_of_bbox(&object.geometry)
}

fn bounds_of_bbox(geometry: &annotation_domain::BBox) -> [f32; 4] {
    [
        geometry.x_min as f32,
        geometry.y_min as f32,
        geometry.x_max as f32,
        geometry.y_max as f32,
    ]
}

#[derive(Debug, Clone, PartialEq)]
struct ProjectionEntry {
    object_id: Id,
    bounds: [f32; 4],
    color: [f32; 4],
    selected: bool,
    hidden: bool,
    locked: bool,
}

/// Incremental delta projection: editor deltas update the renderer object list
/// in document order without rebuilding from snapshots (C3 delta projection).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ProjectionCache {
    entries: Vec<ProjectionEntry>,
}

impl ProjectionCache {
    /// Applies `changed_objects`/`removed_object_ids` of one delta.
    pub fn apply_delta(
        &mut self,
        changed: &[annotation_domain::AnnotationObject],
        removed: &[Id],
        color_of: impl Fn(&Id) -> [f32; 4],
    ) -> bool {
        let mut touched = false;
        for id in removed {
            let previous_len = self.entries.len();
            self.entries.retain(|entry| entry.object_id != *id);
            touched |= self.entries.len() != previous_len;
        }
        for object in changed {
            let bounds = bounds_of(object);
            let color = color_of(&object.label_id);
            match self
                .entries
                .iter_mut()
                .find(|entry| entry.object_id == object.object_id)
            {
                Some(entry) => {
                    if entry.bounds != bounds || entry.color != color {
                        entry.bounds = bounds;
                        entry.color = color;
                        touched = true;
                    }
                }
                None => {
                    self.entries.push(ProjectionEntry {
                        object_id: object.object_id.clone(),
                        bounds,
                        color,
                        selected: false,
                        hidden: false,
                        locked: false,
                    });
                    touched = true;
                }
            }
        }
        touched
    }

    pub fn set_selection(&mut self, selected: &[Id]) -> bool {
        let mut touched = false;
        for entry in &mut self.entries {
            let is_selected = selected.contains(&entry.object_id);
            if entry.selected != is_selected {
                entry.selected = is_selected;
                touched = true;
            }
        }
        touched
    }

    pub fn set_flags(&mut self, id: &Id, hidden: bool, locked: bool) -> bool {
        let Some(entry) = self.entries.iter_mut().find(|entry| entry.object_id == *id) else {
            return false;
        };
        if entry.hidden == hidden && entry.locked == locked {
            return false;
        }
        entry.hidden = hidden;
        entry.locked = locked;
        true
    }

    /// Visible objects as renderer instances, in document order.
    pub fn render_objects(&self) -> Vec<RenderObject> {
        self.entries
            .iter()
            .filter(|entry| !entry.hidden)
            .map(|entry| RenderObject {
                bounds: entry.bounds,
                color: entry.color,
                selected: entry.selected,
                locked: entry.locked,
            })
            .collect()
    }
}

/// Everything one `render()` needs to push to the GPU. `None` members were not
/// touched since the previous frame (incremental renderer updates).
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedFrame {
    pub viewport: Option<SceneViewport>,
    pub projection: Option<(Vec<RenderObject>, Vec<Overlay>)>,
}

/// Platform-independent C3 editor session (docs/contracts.md C3).
pub struct EditorSession {
    editor: Editor,
    colors: HashMap<Id, [f32; 4]>,
    projection: ProjectionCache,
    preview_overlay: Option<Overlay>,
    predictions: Vec<SuggestionSet>,
    view: Viewport,
    image_width: u32,
    image_height: u32,
    viewport_dirty: bool,
    projection_dirty: bool,
    disposed: bool,
}

impl EditorSession {
    pub fn new(document: AnnotationDocument, ontology: OntologyVersion) -> Result<Self, ApiError> {
        let image_width = document.coordinate_space.width;
        let image_height = document.coordinate_space.height;
        let mut colors = HashMap::with_capacity(ontology.labels.len());
        for label in &ontology.labels {
            colors.insert(label.label_id.clone(), label_color(&label.color));
        }
        let editor =
            Editor::new(document, ontology).map_err(|error| api_error_from_domain(&error))?;
        let view = Viewport::try_new(
            1.0,
            0.0,
            0.0,
            f64::from(image_width),
            f64::from(image_height),
            1.0,
        )
        .map_err(|error| api_error_from_domain(&error))?;
        let mut projection = ProjectionCache::default();
        for object in editor.snapshot().objects {
            let color = colors
                .get(&object.label_id)
                .copied()
                .unwrap_or(UNPAINTED_LABEL_COLOR);
            projection.apply_delta(&[object], &[], |_| color);
        }
        Ok(Self {
            editor,
            colors,
            projection,
            preview_overlay: None,
            predictions: Vec::new(),
            view,
            image_width,
            image_height,
            viewport_dirty: true,
            projection_dirty: true,
            disposed: false,
        })
    }

    pub fn dispatch(&mut self, command: EditorCommand) -> EditorDelta {
        if self.disposed {
            return self.error_delta(api_error("EDITOR_DISPOSED", "editor session is disposed"));
        }
        match self.editor.dispatch(command) {
            Ok(delta) => self.absorb(delta),
            Err(error) => self.error_delta(api_error_from_domain(&error)),
        }
    }

    pub fn pointer(&mut self, input: PointerInput) -> EditorDelta {
        if self.disposed {
            return self.error_delta(api_error("EDITOR_DISPOSED", "editor session is disposed"));
        }
        match self.editor.pointer(input) {
            Ok(delta) => self.absorb(delta),
            Err(error) => self.error_delta(api_error_from_domain(&error)),
        }
    }

    pub fn set_tool(&mut self, tool: Tool) -> Result<(), ApiError> {
        self.ensure_live()?;
        self.editor.set_tool(tool);
        Ok(())
    }

    pub fn set_active_label(&mut self, label_id: Id) -> Result<(), ApiError> {
        self.ensure_live()?;
        self.editor
            .set_active_label(label_id)
            .map_err(|error| api_error_from_domain(&error))
    }

    pub fn set_viewport(&mut self, view: Viewport) -> Result<(), ApiError> {
        self.ensure_live()?;
        self.editor
            .set_viewport(view)
            .map_err(|error| api_error_from_domain(&error))?;
        self.view = view;
        self.viewport_dirty = true;
        Ok(())
    }

    /// Zooms while keeping the image point under `css` fixed (geometry truth).
    pub fn zoom_at(&mut self, css: [f64; 2], factor: f64) -> Result<(), ApiError> {
        self.ensure_live()?;
        let next = geometry::zoom_anchor(self.view, css, factor)
            .map_err(|error| api_error_from_domain(&error))?;
        self.set_viewport(next)
    }

    pub fn fit_image(&mut self) -> Result<(), ApiError> {
        self.ensure_live()?;
        if self.view.css_width <= 0.0 || self.view.css_height <= 0.0 {
            // Paused 0x0 canvas: there is nothing to fit; keep the view as-is.
            return Ok(());
        }
        let width = f64::from(self.image_width);
        let height = f64::from(self.image_height);
        let scale = (self.view.css_width / width).min(self.view.css_height / height);
        let tx = (self.view.css_width - width * scale) / 2.0;
        let ty = (self.view.css_height - height * scale) / 2.0;
        let next = Viewport::try_new(
            scale,
            tx,
            ty,
            self.view.css_width,
            self.view.css_height,
            self.view.dpr,
        )
        .map_err(|error| api_error_from_domain(&error))?;
        self.set_viewport(next)
    }

    pub fn set_selection(&mut self, ids: Vec<Id>) -> EditorDelta {
        if self.disposed {
            return self.error_delta(api_error("EDITOR_DISPOSED", "editor session is disposed"));
        }
        match self.editor.set_selection(ids) {
            Ok(delta) => self.absorb(delta),
            Err(error) => self.error_delta(api_error_from_domain(&error)),
        }
    }

    pub fn set_local_flags(&mut self, ids: &[Id], flags: LocalFlagsArgs) -> EditorDelta {
        if self.disposed {
            return self.error_delta(api_error("EDITOR_DISPOSED", "editor session is disposed"));
        }
        match self.editor.set_local_flags(ids, flags.hidden, flags.locked) {
            Ok(delta) => {
                let mut touched = false;
                for id in ids {
                    let local = self.editor.local_flags(id);
                    touched |= self.projection.set_flags(id, local.hidden, local.locked);
                }
                if touched {
                    self.projection_dirty = true;
                }
                self.absorb(delta)
            }
            Err(error) => self.error_delta(api_error_from_domain(&error)),
        }
    }

    pub fn set_predictions(&mut self, sets: Vec<SuggestionSet>) -> Result<(), ApiError> {
        self.ensure_live()?;
        for set in &sets {
            if set.suggestion_set_id.is_empty() {
                return Err(api_error(
                    "INVALID_SUGGESTION_SET",
                    "suggestion_set_id must not be empty",
                ));
            }
        }
        self.predictions = sets;
        Ok(())
    }

    pub fn get_snapshot(&self) -> AnnotationDocument {
        self.editor.snapshot()
    }

    pub fn get_generation(&self) -> u64 {
        self.editor.generation()
    }

    /// Additive C3 extension (reports/T09/review.md): the Rust-owned view so
    /// callers can resize without duplicating zoom/pan math in the browser.
    pub fn get_viewport(&self) -> Viewport {
        self.view
    }

    pub fn is_disposed(&self) -> bool {
        self.disposed
    }

    /// Drains the dirty flags into one frame. A clean session yields `None`, so
    /// idle callers submit no GPU work at all.
    pub fn prepare_frame(&mut self) -> Option<PreparedFrame> {
        if self.disposed || (!self.viewport_dirty && !self.projection_dirty) {
            return None;
        }
        let frame = PreparedFrame {
            viewport: self.viewport_dirty.then(|| scene_viewport(self.view)),
            projection: self.projection_dirty.then(|| {
                (
                    self.projection.render_objects(),
                    self.preview_overlay.iter().copied().collect(),
                )
            }),
        };
        self.viewport_dirty = false;
        self.projection_dirty = false;
        Some(frame)
    }

    /// Re-marks both frame parts dirty (used after a failed GPU submission so
    /// the next frame retries).
    pub fn invalidate_frame(&mut self) {
        self.viewport_dirty = true;
        self.projection_dirty = true;
    }

    /// Idempotent teardown of session-owned state; the CPU document survives.
    pub fn dispose(&mut self) {
        if self.disposed {
            return;
        }
        self.disposed = true;
        self.projection = ProjectionCache::default();
        self.preview_overlay = None;
        self.predictions.clear();
    }

    fn ensure_live(&self) -> Result<(), ApiError> {
        if self.disposed {
            Err(api_error("EDITOR_DISPOSED", "editor session is disposed"))
        } else {
            Ok(())
        }
    }

    /// Label paint used by the projection (and projection-equivalence tests).
    pub fn color_of(&self, label_id: &Id) -> [f32; 4] {
        self.colors
            .get(label_id)
            .copied()
            .unwrap_or(UNPAINTED_LABEL_COLOR)
    }

    fn absorb(&mut self, delta: EditorDelta) -> EditorDelta {
        let colors = &self.colors;
        let mut touched = self.projection.apply_delta(
            &delta.changed_objects,
            &delta.removed_object_ids,
            |label_id| {
                colors
                    .get(label_id)
                    .copied()
                    .unwrap_or(UNPAINTED_LABEL_COLOR)
            },
        );
        touched |= self.projection.set_selection(&delta.selected_object_ids);
        if delta.repaint {
            touched |= self.refresh_preview();
        }
        if touched {
            self.projection_dirty = true;
        }
        delta
    }

    fn refresh_preview(&mut self) -> bool {
        let next = self.editor.preview().map(|preview| {
            let bounds = bounds_of_bbox(&preview.geometry);
            Overlay {
                bounds,
                color: PREVIEW_COLOR,
            }
        });
        if next == self.preview_overlay {
            return false;
        }
        self.preview_overlay = next;
        true
    }

    /// Error delta at the current generation: every failure path surfaces here
    /// instead of panicking or throwing opaque values.
    pub fn error_delta(&self, error: ApiError) -> EditorDelta {
        EditorDelta {
            generation: self.editor.generation(),
            changed_objects: Vec::new(),
            removed_object_ids: Vec::new(),
            selected_object_ids: Vec::new(),
            can_undo: self.editor.can_undo(),
            can_redo: self.editor.can_redo(),
            document_changed: false,
            repaint: false,
            suggestion_decisions: Vec::new(),
            error: Some(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use annotation_domain::{BBox, EditorCommand};

    fn fixtures() -> (AnnotationDocument, OntologyVersion) {
        (
            serde_json::from_str(include_str!("../../../tests/fixtures/golden/document.json"))
                .expect("golden document"),
            serde_json::from_str(include_str!("../../../tests/fixtures/golden/ontology.json"))
                .expect("golden ontology"),
        )
    }

    fn session() -> EditorSession {
        let (document, ontology) = fixtures();
        EditorSession::new(document, ontology).expect("valid golden fixture")
    }

    fn person() -> Id {
        Id::from("object_person_001")
    }

    fn pointer(phase: editor_core::PointerPhase, x_css: f64, y_css: f64) -> PointerInput {
        PointerInput {
            phase,
            pointer_id: 7,
            x_css,
            y_css,
            button: 0,
            buttons: 1,
            shift: false,
            ctrl: false,
            alt: false,
            meta: false,
        }
    }

    #[test]
    fn structured_api_error_carries_code_message_and_generated_request_id() {
        let error = api_error_from_domain(&DomainError::new("OBJECT_NOT_FOUND", "missing"));
        assert_eq!(error.code, "OBJECT_NOT_FOUND");
        assert_eq!(error.message, "missing");
        assert!(!error.request_id.is_empty());
        assert!(error.request_id.len() <= 128);
        assert!(
            serde_json::to_value(&error).is_ok(),
            "ApiError stays wire-valid"
        );
        assert!(error.details.is_none());
    }

    #[test]
    fn domain_failures_become_error_deltas_without_panics_or_generation_bumps() {
        let mut session = session();
        let delta = session.dispatch(EditorCommand::Delete {
            object_ids: vec![Id::from("object_missing")],
        });
        let error = delta.error.expect("structured error");
        assert_eq!(error.code, "OBJECT_NOT_FOUND");
        assert_eq!(delta.generation, 0);
        assert!(!delta.document_changed);
        assert!(delta.changed_objects.is_empty());
        assert_eq!(session.get_generation(), 0);
    }

    #[test]
    fn pointer_move_never_bumps_generation_and_box_creation_bumps_it_once() {
        let mut session = session();
        session.set_tool(Tool::Box).expect("tool");
        session
            .set_active_label(Id::from("label_person"))
            .expect("label");
        let down = session.pointer(pointer(editor_core::PointerPhase::Down, 20.0, 30.0));
        assert!(down.repaint);
        assert_eq!(down.generation, 0);
        assert!(!down.document_changed);
        let moved = session.pointer(pointer(editor_core::PointerPhase::Move, 120.0, 130.0));
        assert!(moved.repaint);
        assert_eq!(moved.generation, 0);
        assert!(session.get_snapshot().objects.len() == 1);
        let up = session.pointer(pointer(editor_core::PointerPhase::Up, 120.0, 130.0));
        assert_eq!(up.generation, 1);
        assert!(up.document_changed);
        assert_eq!(up.changed_objects.len(), 1);
        assert_eq!(session.get_snapshot().objects.len(), 2);
    }

    #[test]
    fn incremental_projection_matches_a_full_rebuild() {
        let mut session = session();
        let selection = session.set_selection(vec![person()]);
        assert!(selection.error.is_none(), "selection applies without error");
        let flags_delta = session.set_local_flags(
            &[person()],
            LocalFlagsArgs {
                hidden: Some(true),
                locked: Some(true),
            },
        );
        assert!(flags_delta.error.is_none(), "flags apply without error");
        let mut created = session.get_snapshot().objects[0].clone();
        created.object_id = Id::from("object_person_002");
        created.geometry = BBox::new(120.0, 20.0, 180.0, 80.0);
        session.dispatch(EditorCommand::Create { object: created });
        session.dispatch(EditorCommand::Delete {
            object_ids: vec![Id::from("object_person_002")],
        });

        let snapshot = session.get_snapshot();
        let mut rebuilt = ProjectionCache::default();
        rebuilt.apply_delta(&snapshot.objects, &[], |label_id| {
            session.color_of(label_id)
        });
        rebuilt.set_selection(&[person()]);
        rebuilt.set_flags(&person(), true, true);
        assert_eq!(session.projection, rebuilt);
        assert_eq!(
            session.projection.render_objects(),
            rebuilt.render_objects()
        );
    }

    #[test]
    fn prepare_frame_drains_dirty_state_and_idle_submits_nothing() {
        let mut session = session();
        let initial = session.prepare_frame().expect("initial frame");
        assert!(initial.viewport.is_some());
        assert!(initial.projection.is_some());
        assert!(session.prepare_frame().is_none(), "idle session is quiet");

        session
            .set_viewport(Viewport::try_new(2.0, 5.0, 6.0, 640.0, 480.0, 2.0).expect("viewport"))
            .expect("set viewport");
        let frame = session.prepare_frame().expect("viewport frame");
        let viewport = frame.viewport.expect("viewport part");
        assert_eq!(viewport.scale, 2.0);
        assert_eq!(viewport.dpr, 2.0);
        assert!(frame.projection.is_none(), "projection untouched");
        assert!(session.prepare_frame().is_none(), "idle again");

        let selection = session.set_selection(vec![person()]);
        assert!(selection.error.is_none(), "selection applies without error");
        let frame = session.prepare_frame().expect("selection frame");
        assert!(frame.viewport.is_none());
        let (objects, overlays) = frame.projection.expect("projection part");
        assert!(objects[0].selected);
        assert!(overlays.is_empty());
        assert!(session.prepare_frame().is_none());
    }

    #[test]
    fn dispose_is_idempotent_and_later_mutation_is_a_structured_error() {
        let mut session = session();
        session.dispose();
        session.dispose();
        assert!(session.is_disposed());
        assert!(session.prepare_frame().is_none());
        let delta = session.dispatch(EditorCommand::Undo);
        assert_eq!(delta.error.expect("disposed error").code, "EDITOR_DISPOSED");
        assert_eq!(
            session.set_tool(Tool::Pan).err().expect("disposed").code,
            "EDITOR_DISPOSED"
        );
    }

    #[test]
    fn zoom_at_keeps_the_image_point_under_the_cursor_fixed() {
        let mut session = session();
        session
            .set_viewport(Viewport::try_new(2.0, 10.0, -4.0, 640.0, 480.0, 1.0).expect("viewport"))
            .expect("set");
        let css = [123.0, 45.0];
        let before = geometry::css_to_image(css, session.get_viewport());
        session.zoom_at(css, 0.5).expect("zoom");
        let after = geometry::css_to_image(css, session.get_viewport());
        assert!((before[0] - after[0]).abs() < 1e-9);
        assert!((before[1] - after[1]).abs() < 1e-9);
        assert_eq!(session.get_viewport().scale, 1.0);
    }

    #[test]
    fn fit_image_centers_the_image_within_the_css_box() {
        let mut session = session();
        session
            .set_viewport(Viewport::try_new(1.0, 0.0, 0.0, 1000.0, 500.0, 2.0).expect("viewport"))
            .expect("set");
        session.fit_image().expect("fit");
        let view = session.get_viewport();
        let expected_scale = (1000.0 / 640.0f64).min(500.0 / 480.0);
        assert!((view.scale - expected_scale).abs() < 1e-9);
        let top_left = geometry::image_to_css([0.0, 0.0], view);
        let bottom_right = geometry::image_to_css([640.0, 480.0], view);
        assert!((top_left[0] - (1000.0 - 640.0 * view.scale) / 2.0).abs() < 1e-9);
        assert!((top_left[1] - (500.0 - 480.0 * view.scale) / 2.0).abs() < 1e-9);
        assert!((bottom_right[0] - 1000.0 + top_left[0]).abs() < 1e-9);
        assert!((bottom_right[1] - 500.0 + top_left[1]).abs() < 1e-9);
    }

    #[test]
    fn canonical_rgba_validation_measures_the_binary_interface() {
        assert!(validate_canonical_rgba(2, 2, &[0u8; 16]).is_ok());
        let error = validate_canonical_rgba(2, 2, &[0u8; 15]).expect_err("short buffer");
        assert_eq!(error.code, "CANONICAL_FRAME_SIZE");
        assert!(error.message.contains("expected 16"));
        assert!(validate_canonical_rgba(0, 4, &[]).is_err());
        assert!(validate_canonical_rgba(u32::MAX, u32::MAX, &[]).is_err());
    }

    #[test]
    fn label_colors_parse_and_invalid_colors_never_panic() {
        assert_eq!(
            label_color("#2878d0"),
            [40.0 / 255.0, 120.0 / 255.0, 208.0 / 255.0, 1.0]
        );
        assert_eq!(label_color("zzz"), UNPAINTED_LABEL_COLOR);
        assert_eq!(label_color("#12345"), UNPAINTED_LABEL_COLOR);
    }
}

// ---------------------------------------------------------------------------
// wasm32 bindings: JsValue wrapping over EditorSession and renderer submission.
// Malformed payloads and domain failures are structured ApiError values; the
// only throwers are the C3 void setters, and they throw that same structure.
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
pub mod wasm {
    use wasm_bindgen::prelude::*;

    use super::*;
    use annotation_domain::MediaRevision;

    #[derive(serde::Serialize)]
    struct ProjectionUpdate {
        objects: Vec<RenderObject>,
        overlays: Vec<Overlay>,
    }

    fn to_js<T: serde::Serialize>(value: &T) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(value).map_err(|error| JsValue::from_str(&error.to_string()))
    }

    fn to_js_error(error: ApiError) -> JsValue {
        serde_wasm_bindgen::to_value(&error).unwrap_or_else(|_| JsValue::from_str(&error.code))
    }

    fn from_js<T: serde::de::DeserializeOwned>(value: JsValue, code: &str) -> Result<T, ApiError> {
        serde_wasm_bindgen::from_value(value).map_err(|error| api_error(code, &error.to_string()))
    }

    #[wasm_bindgen]
    pub struct EditorFacade {
        session: EditorSession,
        renderer: renderer_wgpu::Renderer,
        canvas: web_sys::HtmlCanvasElement,
    }

    #[wasm_bindgen]
    impl EditorFacade {
        /// C3 `dispatch`. Never throws: parse and domain failures come back as
        /// `EditorDelta.error` at the current generation.
        pub fn dispatch(&mut self, command: JsValue) -> Result<JsValue, JsValue> {
            let delta = match from_js::<EditorCommand>(command, "INVALID_COMMAND") {
                Ok(command) => self.session.dispatch(command),
                Err(error) => self.session.error_delta(error),
            };
            to_js(&delta)
        }

        /// C3 `pointer`. One call per DOM event; the payload is the small
        /// C3 `PointerInput`, the result the incremental `EditorDelta`.
        pub fn pointer(&mut self, input: JsValue) -> Result<JsValue, JsValue> {
            let delta = match from_js::<crate::input::PointerInputArgs>(input, "INVALID_POINTER") {
                Ok(args) => match crate::input::pointer_input(args) {
                    Ok(input) => self.session.pointer(input),
                    Err(error) => self.session.error_delta(error),
                },
                Err(error) => self.session.error_delta(error),
            };
            to_js(&delta)
        }

        pub fn set_tool(&mut self, tool: String) -> Result<(), JsValue> {
            let tool = crate::input::tool(&tool).map_err(to_js_error)?;
            self.session.set_tool(tool).map_err(to_js_error)
        }

        pub fn set_active_label(&mut self, label_id: String) -> Result<(), JsValue> {
            self.session
                .set_active_label(Id::from(label_id))
                .map_err(to_js_error)
        }

        pub fn set_viewport(&mut self, view: JsValue) -> Result<(), JsValue> {
            let args = from_js::<crate::input::ViewportArgs>(view, "INVALID_VIEWPORT")
                .map_err(to_js_error)?;
            let view = crate::input::viewport(args).map_err(to_js_error)?;
            self.session.set_viewport(view).map_err(to_js_error)?;
            if view.css_width == 0.0 || view.css_height == 0.0 {
                // A paused 0x0 canvas keeps no backing store: drop the buffer
                // immediately (the host does not render while paused, so the
                // renderer would otherwise retain the old allocation).
                self.canvas.set_width(0);
                self.canvas.set_height(0);
            }
            Ok(())
        }

        pub fn zoom_at(&mut self, x_css: f64, y_css: f64, factor: f64) -> Result<(), JsValue> {
            self.session
                .zoom_at([x_css, y_css], factor)
                .map_err(to_js_error)
        }

        pub fn fit_image(&mut self) -> Result<(), JsValue> {
            self.session.fit_image().map_err(to_js_error)
        }

        pub fn set_selection(&mut self, ids: Vec<String>) -> Result<JsValue, JsValue> {
            let ids = ids.into_iter().map(Id::from).collect();
            to_js(&self.session.set_selection(ids))
        }

        pub fn set_local_flags(
            &mut self,
            ids: Vec<String>,
            flags: JsValue,
        ) -> Result<JsValue, JsValue> {
            let flags =
                from_js::<crate::input::LocalFlagsArgs>(flags, "INVALID_FLAGS").unwrap_or_default();
            let ids: Vec<Id> = ids.into_iter().map(Id::from).collect();
            to_js(&self.session.set_local_flags(&ids, flags))
        }

        pub fn get_snapshot(&self) -> Result<JsValue, JsValue> {
            to_js(&self.session.get_snapshot())
        }

        /// Generation is bounded by 2^53-1 in editor-core; it crosses the
        /// boundary as a plain JS number (a u64 return would become a BigInt
        /// and break the C3 `get_generation(): number` contract).
        pub fn get_generation(&self) -> f64 {
            self.session.get_generation() as f64
        }

        /// Additive C3 extension (reports/T09/review.md): Rust-owned view state
        /// so resize preserves zoom/pan without duplicating geometry in TS.
        pub fn get_viewport(&self) -> Result<JsValue, JsValue> {
            let view = self.session.get_viewport();
            to_js(&crate::input::ViewportArgs {
                scale: view.scale,
                tx: view.tx,
                ty: view.ty,
                css_width: view.css_width,
                css_height: view.css_height,
                dpr: view.dpr,
            })
        }

        pub fn set_predictions(&mut self, sets: JsValue) -> Result<(), JsValue> {
            let sets = from_js::<Vec<SuggestionSet>>(sets, "INVALID_SUGGESTION_SET")
                .map_err(to_js_error)?;
            self.session.set_predictions(sets).map_err(to_js_error)
        }

        /// One submission path for the dirty-flag scheduler: a clean session
        /// performs no renderer call at all (idle GPU quiet). A renderer update
        /// submits exactly one frame; when both view and projection changed the
        /// two narrow updates each submit (renderer API renders per update).
        pub fn render(&mut self, timestamp_ms: f64) -> Result<(), JsValue> {
            let _ = timestamp_ms;
            let Some(frame) = self.session.prepare_frame() else {
                return Ok(());
            };
            if let Some(viewport) = frame.viewport {
                if let Err(error) = self.renderer.update_viewport(to_js(&viewport)?) {
                    self.session.invalidate_frame();
                    return Err(error);
                }
            }
            if let Some((objects, overlays)) = frame.projection {
                let update = ProjectionUpdate { objects, overlays };
                if let Err(error) = self.renderer.update_objects(to_js(&update)?) {
                    self.session.invalidate_frame();
                    return Err(error);
                }
            }
            Ok(())
        }

        /// Idempotent teardown of listeners-free WASM state: drops the CPU
        /// projection and destroys the GPU device exactly once.
        pub fn dispose(&mut self) {
            if self.session.is_disposed() {
                return;
            }
            self.session.dispose();
            self.renderer.dispose();
        }
    }

    /// C3 `create_editor`: asynchronous GPU device creation. Every failure is a
    /// structured ApiError rejection — never a panic — so the host can show it.
    #[wasm_bindgen]
    pub async fn create_editor(
        canvas: web_sys::HtmlCanvasElement,
        media: JsValue,
        ontology: JsValue,
        document: JsValue,
        canonical_rgba: Vec<u8>,
    ) -> Result<EditorFacade, JsValue> {
        let media = from_js::<MediaRevision>(media, "INVALID_MEDIA").map_err(to_js_error)?;
        let ontology =
            from_js::<OntologyVersion>(ontology, "INVALID_ONTOLOGY").map_err(to_js_error)?;
        let document =
            from_js::<AnnotationDocument>(document, "INVALID_DOCUMENT").map_err(to_js_error)?;
        media
            .validate()
            .map_err(|error| to_js_error(api_error_from_domain(&error)))?;
        let width = media.canonical_width;
        let height = media.canonical_height;
        if document.coordinate_space.width != width || document.coordinate_space.height != height {
            return Err(to_js_error(api_error(
                "MEDIA_DOCUMENT_MISMATCH",
                "document coordinate space must equal the canonical media dimensions",
            )));
        }
        validate_canonical_rgba(width, height, &canonical_rgba).map_err(to_js_error)?;
        let session = EditorSession::new(document, ontology).map_err(to_js_error)?;
        let renderer = renderer_wgpu::Renderer::new(canvas.clone(), width, height, canonical_rgba)
            .await
            .map_err(|error| {
                let message = error
                    .as_string()
                    .unwrap_or_else(|| String::from("renderer init failed"));
                let code = if message.contains("Unsupported") {
                    "WEBGPU_UNAVAILABLE"
                } else {
                    "RENDERER_INIT_FAILED"
                };
                to_js_error(api_error(code, &message))
            })?;
        Ok(EditorFacade {
            session,
            renderer,
            canvas,
        })
    }
}
