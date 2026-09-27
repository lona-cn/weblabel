//! T12 gesture state machine: draw / move / resize / marquee / pan.
//!
//! One pointerdown starts exactly one gesture; pointermove only refreshes the
//! interaction preview (`document_changed` stays false and no history entry is
//! produced); one pointerup commits exactly one undoable edit; pointer cancel
//! (Esc, blur, tool switch, viewport switch, asset switch in the web layer)
//! discards the gesture without touching the document or the generation.
//!
//! All geometry truth stays in Rust: drag endpoints are normalized into
//! canonical continuous xyxy image pixels, interactive boxes keep a 2 CSS px
//! minimum side, and commits clamp to the canonical image so the document can
//! never leave valid state.

use annotation_domain::{
    AnnotationDocument, AnnotationObject, BBox, DomainError, Id, OntologyVersion, Origin,
    OriginType,
};
use geometry::{normalize_bbox, Viewport};

use super::dense::{self, HitIndex};
use super::{PointerInput, PointerPhase, Preview, Tool};
use crate::selection::Selection;

/// Minimum interactive box side in CSS pixels (docs/architecture.md).
pub(crate) const MIN_SIDE_CSS: f64 = 2.0;

/// A pointer gesture that moved less than this per axis is a click.
const CLICK_THRESHOLD_CSS: f64 = 2.0;

/// The atomic document edit a committed gesture produces.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Commit {
    Create(AnnotationObject),
    ReplaceGeometries(Vec<(Id, BBox)>),
}

/// What one pointer event asks the editor to do.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Action {
    None,
    SetSelection(Vec<Id>),
    /// Commits one atomic edit. `selection` applies in the same delta when the
    /// drag staged a selection change at pointerdown, so one interaction is at
    /// most one selection change and exactly one committed edit.
    Commit {
        selection: Option<Vec<Id>>,
        edit: Commit,
    },
    Pan([f64; 2]),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct EventOutcome {
    pub repaint: bool,
    pub action: Action,
}

/// Read-only editor state a gesture event may consult.
pub(crate) struct GestureContext<'a> {
    pub document: &'a AnnotationDocument,
    pub selection: &'a Selection,
    pub viewport: Viewport,
    pub tool: Tool,
    pub active_label_id: Option<&'a Id>,
    pub ontology: &'a OntologyVersion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GestureKind {
    Draw,
    Move,
    Resize(dense::Handle),
    Pan,
    /// Down landed on empty space or a locked object: a click may still resolve.
    PendingClick,
}

#[derive(Debug, Clone, PartialEq)]
struct ActiveGesture {
    pointer_id: i32,
    kind: GestureKind,
    /// Image-space drag anchor.
    start: [f64; 2],
    /// Image-space current point.
    current: [f64; 2],
    additive: bool,
    /// Original geometry per move/resize target, captured at pointerdown; the
    /// dragged object comes first so the preview shows the drag target.
    targets: Vec<(Id, BBox)>,
    /// Click stack captured at pointerdown for predictable dense cycling.
    click_stack: Vec<Id>,
    /// Selection as it was before the pointer went down; click cycling walks
    /// the stack relative to this, not to the transient down-time selection.
    selection_before: Vec<Id>,
    /// A selection change staged at pointerdown (dragging an unselected object
    /// selects the drag target set) and applied only when the gesture commits,
    /// so clicks never flicker through transient selections.
    staged_selection: Option<Vec<Id>>,
}

pub(crate) struct GestureMachine {
    active: Option<ActiveGesture>,
    preview: Option<Preview>,
}

impl GestureMachine {
    pub(crate) fn new() -> Self {
        Self {
            active: None,
            preview: None,
        }
    }

    pub(crate) fn preview(&self) -> Option<&Preview> {
        self.preview.as_ref()
    }

    pub(crate) fn cancel(&mut self) {
        self.active = None;
        self.preview = None;
    }

    pub(crate) fn handle(
        &mut self,
        ctx: &GestureContext<'_>,
        input: &PointerInput,
        point: [f64; 2],
    ) -> Result<EventOutcome, DomainError> {
        match input.phase {
            PointerPhase::Down => self.down(ctx, input, point),
            PointerPhase::Move => self.move_to(ctx, input, point),
            PointerPhase::Up => self.up(ctx, input, point),
            PointerPhase::Cancel => Ok(self.cancel_event(input.pointer_id)),
        }
    }

    fn down(
        &mut self,
        ctx: &GestureContext<'_>,
        input: &PointerInput,
        point: [f64; 2],
    ) -> Result<EventOutcome, DomainError> {
        if self.active.is_some() || input.button != 0 {
            return Ok(EventOutcome {
                repaint: false,
                action: Action::None,
            });
        }
        let additive = input.shift || input.ctrl || input.meta;
        let selection_before = ctx.selection.ids().to_vec();
        let current_css = [input.x_css, input.y_css];
        match ctx.tool {
            Tool::Box => {
                self.active = Some(ActiveGesture {
                    pointer_id: input.pointer_id,
                    kind: GestureKind::Draw,
                    start: point,
                    current: point,
                    additive,
                    targets: Vec::new(),
                    click_stack: Vec::new(),
                    selection_before,
                    staged_selection: None,
                });
                self.preview = None;
                Ok(EventOutcome {
                    repaint: true,
                    action: Action::None,
                })
            }
            Tool::Pan => {
                self.active = Some(ActiveGesture {
                    pointer_id: input.pointer_id,
                    kind: GestureKind::Pan,
                    start: point,
                    current: point,
                    additive,
                    targets: Vec::new(),
                    click_stack: Vec::new(),
                    selection_before,
                    staged_selection: None,
                });
                self.preview = None;
                Ok(EventOutcome {
                    repaint: true,
                    action: Action::None,
                })
            }
            Tool::Select => {
                // 1. Resize handles of selected, visible, unlocked objects win.
                if let Some((id, handle)) =
                    dense::handle_hit(ctx.document, ctx.selection, ctx.viewport, current_css)
                {
                    if let Some(geometry) = find_geometry(ctx.document, &id) {
                        self.active = Some(ActiveGesture {
                            pointer_id: input.pointer_id,
                            kind: GestureKind::Resize(handle),
                            start: point,
                            current: point,
                            additive,
                            targets: vec![(id, geometry)],
                            click_stack: Vec::new(),
                            selection_before,
                            staged_selection: None,
                        });
                        self.preview = None;
                        return Ok(EventOutcome {
                            repaint: true,
                            action: Action::None,
                        });
                    }
                }
                let index = HitIndex::build(ctx.document);
                let click_stack = index.stack(
                    ctx.selection,
                    ctx.viewport,
                    current_css,
                    dense::PICK_TOLERANCE_CSS,
                )?;
                let strict = index.stack(ctx.selection, ctx.viewport, current_css, 0.0)?;
                // 2. Dragging the topmost object that contains the point moves
                //    it (with its selection); a locked topmost object is never
                //    draggable and falls through to click/marquee handling.
                if let Some(hit_id) = strict.first().cloned() {
                    if !ctx.selection.flags(&hit_id).locked {
                        let new_selection = if additive {
                            let mut ids: Vec<Id> = ctx
                                .selection
                                .ids()
                                .iter()
                                .filter(|id| !ctx.selection.flags(id).hidden)
                                .cloned()
                                .collect();
                            if !ids.contains(&hit_id) {
                                ids.push(hit_id.clone());
                            }
                            ids
                        } else if ctx.selection.ids().contains(&hit_id) {
                            selection_before.clone()
                        } else {
                            vec![hit_id.clone()]
                        };
                        let mut targets: Vec<(Id, BBox)> = Vec::new();
                        // The drag target comes first so the preview shows it.
                        if let Some(geometry) = find_geometry(ctx.document, &hit_id) {
                            targets.push((hit_id.clone(), geometry));
                        }
                        for id in &new_selection {
                            if *id == hit_id || ctx.selection.flags(id).locked {
                                continue;
                            }
                            if let Some(geometry) = find_geometry(ctx.document, id) {
                                targets.push((id.clone(), geometry));
                            }
                        }
                        let selection_changed = new_selection != selection_before;
                        self.active = Some(ActiveGesture {
                            pointer_id: input.pointer_id,
                            kind: GestureKind::Move,
                            start: point,
                            current: point,
                            additive,
                            targets,
                            click_stack,
                            selection_before,
                            staged_selection: if selection_changed {
                                Some(new_selection)
                            } else {
                                None
                            },
                        });
                        self.preview = None;
                        return Ok(EventOutcome {
                            repaint: true,
                            action: Action::None,
                        });
                    }
                }
                // 3. Empty space (or a locked object): a click may still cycle
                //    the dense stack, a drag becomes a marquee.
                self.active = Some(ActiveGesture {
                    pointer_id: input.pointer_id,
                    kind: GestureKind::PendingClick,
                    start: point,
                    current: point,
                    additive,
                    targets: Vec::new(),
                    click_stack,
                    selection_before,
                    staged_selection: None,
                });
                self.preview = None;
                Ok(EventOutcome {
                    repaint: true,
                    action: Action::None,
                })
            }
        }
    }

    fn move_to(
        &mut self,
        ctx: &GestureContext<'_>,
        input: &PointerInput,
        point: [f64; 2],
    ) -> Result<EventOutcome, DomainError> {
        if !self
            .active
            .as_ref()
            .is_some_and(|gesture| gesture.pointer_id == input.pointer_id)
        {
            return Ok(EventOutcome {
                repaint: false,
                action: Action::None,
            });
        }
        self.active.as_mut().expect("checked").current = point;
        self.refresh_preview(ctx);
        Ok(EventOutcome {
            repaint: true,
            action: Action::None,
        })
    }

    fn up(
        &mut self,
        ctx: &GestureContext<'_>,
        input: &PointerInput,
        point: [f64; 2],
    ) -> Result<EventOutcome, DomainError> {
        if !self
            .active
            .as_ref()
            .is_some_and(|gesture| gesture.pointer_id == input.pointer_id)
        {
            return Ok(EventOutcome {
                repaint: false,
                action: Action::None,
            });
        }
        let mut gesture = self.active.take().expect("checked");
        gesture.current = point;
        self.preview = None;
        let scale = ctx.viewport.scale;
        let width = f64::from(ctx.document.coordinate_space.width);
        let height = f64::from(ctx.document.coordinate_space.height);
        let dx_css = (gesture.current[0] - gesture.start[0]) * scale;
        let dy_css = (gesture.current[1] - gesture.start[1]) * scale;
        let click = dx_css.abs() < CLICK_THRESHOLD_CSS && dy_css.abs() < CLICK_THRESHOLD_CSS;
        match gesture.kind {
            GestureKind::Draw => {
                if click {
                    return Ok(EventOutcome {
                        repaint: true,
                        action: Action::None,
                    });
                }
                let Some(geometry) =
                    draw_rect(gesture.start, gesture.current, scale, width, height)
                else {
                    return Ok(EventOutcome {
                        repaint: true,
                        action: Action::None,
                    });
                };
                let object = build_object(ctx, geometry)?;
                Ok(EventOutcome {
                    repaint: true,
                    action: Action::Commit {
                        selection: None,
                        edit: Commit::Create(object),
                    },
                })
            }
            GestureKind::Move => {
                if click {
                    return Ok(click_outcome(ctx, &gesture));
                }
                let delta = clamp_translate(
                    &gesture.targets,
                    gesture.current[0] - gesture.start[0],
                    gesture.current[1] - gesture.start[1],
                    width,
                    height,
                );
                let edits: Vec<(Id, BBox)> = gesture
                    .targets
                    .iter()
                    .map(|(id, bbox)| (id.clone(), translate_bbox(bbox, delta[0], delta[1])))
                    .collect();
                let unchanged = edits
                    .iter()
                    .zip(&gesture.targets)
                    .all(|((_, moved), (_, original))| moved == original);
                if unchanged {
                    return Ok(EventOutcome {
                        repaint: true,
                        action: Action::None,
                    });
                }
                Ok(EventOutcome {
                    repaint: true,
                    action: Action::Commit {
                        selection: gesture.staged_selection.take(),
                        edit: Commit::ReplaceGeometries(edits),
                    },
                })
            }
            GestureKind::Resize(handle) => {
                if click {
                    // Clicking a handle of the current selection keeps it.
                    return Ok(EventOutcome {
                        repaint: true,
                        action: Action::None,
                    });
                }
                let Some((id, original)) = gesture.targets.first().cloned() else {
                    return Ok(EventOutcome {
                        repaint: true,
                        action: Action::None,
                    });
                };
                let resized = resize_bbox(
                    &original,
                    handle,
                    gesture.current,
                    MIN_SIDE_CSS / scale,
                    width,
                    height,
                );
                if resized == original {
                    return Ok(EventOutcome {
                        repaint: true,
                        action: Action::None,
                    });
                }
                Ok(EventOutcome {
                    repaint: true,
                    action: Action::Commit {
                        selection: None,
                        edit: Commit::ReplaceGeometries(vec![(id, resized)]),
                    },
                })
            }
            GestureKind::Pan => Ok(EventOutcome {
                repaint: true,
                action: Action::Pan([dx_css, dy_css]),
            }),
            GestureKind::PendingClick => {
                if click {
                    return Ok(click_outcome(ctx, &gesture));
                }
                let rect = BBox::new(
                    gesture.start[0].min(gesture.current[0]),
                    gesture.start[1].min(gesture.current[1]),
                    gesture.start[0].max(gesture.current[0]),
                    gesture.start[1].max(gesture.current[1]),
                );
                let ids = dense::marquee_ids(ctx.document, ctx.selection, &rect, gesture.additive);
                Ok(EventOutcome {
                    repaint: true,
                    action: Action::SetSelection(ids),
                })
            }
        }
    }

    fn cancel_event(&mut self, pointer_id: i32) -> EventOutcome {
        if self
            .active
            .as_ref()
            .is_some_and(|gesture| gesture.pointer_id == pointer_id)
        {
            self.cancel();
            EventOutcome {
                repaint: true,
                action: Action::None,
            }
        } else {
            EventOutcome {
                repaint: false,
                action: Action::None,
            }
        }
    }

    fn refresh_preview(&mut self, ctx: &GestureContext<'_>) {
        let Some(gesture) = self.active.as_ref() else {
            self.preview = None;
            return;
        };
        let width = f64::from(ctx.document.coordinate_space.width);
        let height = f64::from(ctx.document.coordinate_space.height);
        let scale = ctx.viewport.scale;
        self.preview = match gesture.kind {
            GestureKind::Draw => draw_rect(gesture.start, gesture.current, scale, width, height)
                .map(|geometry| Preview { geometry }),
            GestureKind::Move => {
                let delta = clamp_translate(
                    &gesture.targets,
                    gesture.current[0] - gesture.start[0],
                    gesture.current[1] - gesture.start[1],
                    width,
                    height,
                );
                gesture.targets.first().map(|(_, bbox)| Preview {
                    geometry: translate_bbox(bbox, delta[0], delta[1]),
                })
            }
            GestureKind::Resize(handle) => gesture.targets.first().map(|(_, bbox)| Preview {
                geometry: resize_bbox(
                    bbox,
                    handle,
                    gesture.current,
                    MIN_SIDE_CSS / scale,
                    width,
                    height,
                ),
            }),
            GestureKind::Pan | GestureKind::PendingClick => None,
        };
    }
}

/// Click resolution: a plain click cycles the dense stack from the selection as
/// it was before the pointer went down; an additive click adds the topmost
/// candidate to that selection. A click that resolves to the selection the
/// pointerdown already staged publishes nothing: one click is one selection
/// change at most.
fn click_outcome(ctx: &GestureContext<'_>, gesture: &ActiveGesture) -> EventOutcome {
    let ids: Vec<Id> = if gesture.additive {
        let Some(topmost) = gesture.click_stack.first() else {
            return EventOutcome {
                repaint: false,
                action: Action::None,
            };
        };
        let mut ids: Vec<Id> = gesture
            .selection_before
            .iter()
            .filter(|id| !ctx.selection.flags(id).hidden)
            .cloned()
            .collect();
        if !ids.contains(topmost) {
            ids.push(topmost.clone());
        }
        ids
    } else {
        dense::cycle_pick(&gesture.click_stack, &gesture.selection_before)
            .into_iter()
            .collect()
    };
    if ids.as_slice() == ctx.selection.ids() {
        return EventOutcome {
            repaint: false,
            action: Action::None,
        };
    }
    EventOutcome {
        repaint: true,
        action: Action::SetSelection(ids),
    }
}

/// Applies gesture geometry replacements atomically: locked targets make the
/// whole commit fail (`OBJECT_LOCKED`, matching `commands::ensure_editable`),
/// a vanished target fails with `OBJECT_NOT_FOUND`, and the editor commits the
/// batch as one history entry.
pub(crate) fn apply_replacements(
    document: &mut AnnotationDocument,
    selection: &Selection,
    edits: &[(Id, BBox)],
) -> Result<(), DomainError> {
    for (object_id, geometry) in edits {
        if selection.is_locked(object_id) {
            return Err(DomainError::new(
                "OBJECT_LOCKED",
                "locked objects cannot be edited",
            ));
        }
        let object = document
            .objects
            .iter_mut()
            .find(|object| object.object_id == *object_id)
            .ok_or_else(|| {
                DomainError::new("OBJECT_NOT_FOUND", "gesture target no longer exists")
            })?;
        object.geometry = geometry.clone();
    }
    Ok(())
}

/// Translates a drag delta so every target stays inside the canonical image.
pub(crate) fn clamp_translate(
    targets: &[(Id, BBox)],
    dx: f64,
    dy: f64,
    width: f64,
    height: f64,
) -> [f64; 2] {
    let mut dx = dx;
    let mut dy = dy;
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for (_, bbox) in targets {
        min_x = min_x.min(bbox.x_min);
        min_y = min_y.min(bbox.y_min);
        max_x = max_x.max(bbox.x_max);
        max_y = max_y.max(bbox.y_max);
    }
    if !min_x.is_finite() || !min_y.is_finite() || !max_x.is_finite() || !max_y.is_finite() {
        return [0.0, 0.0];
    }
    if min_x + dx < 0.0 {
        dx = -min_x;
    }
    if min_y + dy < 0.0 {
        dy = -min_y;
    }
    if max_x + dx > width {
        dx = width - max_x;
    }
    if max_y + dy > height {
        dy = height - max_y;
    }
    if !dx.is_finite() || !dy.is_finite() {
        return [0.0, 0.0];
    }
    [dx, dy]
}

pub(crate) fn translate_bbox(bbox: &BBox, dx: f64, dy: f64) -> BBox {
    BBox::new(
        bbox.x_min + dx,
        bbox.y_min + dy,
        bbox.x_max + dx,
        bbox.y_max + dy,
    )
}

/// Resizes one bbox from a corner or edge handle; the moving sides clamp to
/// the canonical image and never cross the anchored opposite sides closer than
/// the 2 CSS px interactive minimum.
pub(crate) fn resize_bbox(
    original: &BBox,
    handle: dense::Handle,
    to: [f64; 2],
    min_side_image: f64,
    width: f64,
    height: f64,
) -> BBox {
    use dense::{Corner, Edge, Handle};
    let mut x_min = original.x_min;
    let mut y_min = original.y_min;
    let mut x_max = original.x_max;
    let mut y_max = original.y_max;
    match handle {
        Handle::Corner(Corner::TopLeft) => {
            x_min = to[0].clamp(0.0, (x_max - min_side_image).max(0.0));
            y_min = to[1].clamp(0.0, (y_max - min_side_image).max(0.0));
        }
        Handle::Corner(Corner::TopRight) => {
            x_max = to[0].clamp((x_min + min_side_image).min(width), width);
            y_min = to[1].clamp(0.0, (y_max - min_side_image).max(0.0));
        }
        Handle::Corner(Corner::BottomLeft) => {
            x_min = to[0].clamp(0.0, (x_max - min_side_image).max(0.0));
            y_max = to[1].clamp((y_min + min_side_image).min(height), height);
        }
        Handle::Corner(Corner::BottomRight) => {
            x_max = to[0].clamp((x_min + min_side_image).min(width), width);
            y_max = to[1].clamp((y_min + min_side_image).min(height), height);
        }
        Handle::Edge(Edge::Left) => {
            x_min = to[0].clamp(0.0, (x_max - min_side_image).max(0.0));
        }
        Handle::Edge(Edge::Right) => {
            x_max = to[0].clamp((x_min + min_side_image).min(width), width);
        }
        Handle::Edge(Edge::Top) => {
            y_min = to[1].clamp(0.0, (y_max - min_side_image).max(0.0));
        }
        Handle::Edge(Edge::Bottom) => {
            y_max = to[1].clamp((y_min + min_side_image).min(height), height);
        }
    }
    BBox::new(x_min, y_min, x_max, y_max)
}

/// The committed drag rect: normalized from any drag direction, at least the
/// 2 CSS px interactive minimum per side, clamped to the canonical image with
/// strictly positive image-space area.
pub(crate) fn draw_rect(
    start: [f64; 2],
    current: [f64; 2],
    scale: f64,
    width: f64,
    height: f64,
) -> Option<BBox> {
    let width_css = (current[0] - start[0]).abs() * scale;
    let height_css = (current[1] - start[1]).abs() * scale;
    if width_css < MIN_SIDE_CSS || height_css < MIN_SIDE_CSS {
        return None;
    }
    let rect = normalize_bbox(start, current).ok()?;
    let x_min = rect.x_min.max(0.0);
    let y_min = rect.y_min.max(0.0);
    let x_max = rect.x_max.min(width);
    let y_max = rect.y_max.min(height);
    if x_max <= x_min || y_max <= y_min {
        return None;
    }
    if (x_max - x_min) * scale < MIN_SIDE_CSS || (y_max - y_min) * scale < MIN_SIDE_CSS {
        return None;
    }
    Some(BBox::new(x_min, y_min, x_max, y_max))
}

/// Builds the created object for a committed draw, mirroring the T04 command
/// path (UUID id, ontology attribute defaults, manual origin).
pub(crate) fn build_object(
    ctx: &GestureContext<'_>,
    geometry: BBox,
) -> Result<AnnotationObject, DomainError> {
    let label_id = ctx.active_label_id.cloned().ok_or_else(|| {
        DomainError::new("ACTIVE_LABEL_REQUIRED", "box tool requires an active label")
    })?;
    let attributes = ctx
        .ontology
        .labels
        .iter()
        .find(|label| label.label_id == label_id)
        .expect("active label was validated")
        .attributes
        .iter()
        .map(|attribute| (attribute.key.clone(), attribute.default_value.clone()))
        .collect();
    Ok(AnnotationObject {
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
    })
}

/// Small helper shared by the machine internals.
pub(crate) fn find_geometry(document: &AnnotationDocument, id: &Id) -> Option<BBox> {
    document
        .objects
        .iter()
        .find(|object| object.object_id == *id)
        .map(|object| object.geometry.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draw_rect_normalizes_every_direction_and_enforces_minimums() {
        let forward = draw_rect([10.0, 20.0], [110.0, 220.0], 1.0, 640.0, 480.0).unwrap();
        assert_eq!(forward, BBox::new(10.0, 20.0, 110.0, 220.0));
        let backward = draw_rect([110.0, 220.0], [10.0, 20.0], 1.0, 640.0, 480.0).unwrap();
        assert_eq!(backward, forward);
        assert!(draw_rect([150.0, 150.0], [152.0, 151.999], 1.0, 640.0, 480.0).is_none());
        assert!(draw_rect([639.0, 30.0], [659.0, 40.0], 1.0, 640.0, 480.0).is_none());
        let clipped = draw_rect([630.0, 30.0], [660.0, 50.0], 1.0, 640.0, 480.0).unwrap();
        assert_eq!(clipped, BBox::new(630.0, 30.0, 640.0, 50.0));
    }

    #[test]
    fn resize_clamps_to_bounds_and_minimum_side() {
        let bbox = BBox::new(10.0, 20.0, 110.0, 220.0);
        let shrunk = resize_bbox(
            &bbox,
            dense::Handle::Corner(dense::Corner::TopLeft),
            [200.0, 300.0],
            2.0,
            640.0,
            480.0,
        );
        assert_eq!(shrunk, BBox::new(108.0, 218.0, 110.0, 220.0));
        let grown = resize_bbox(
            &bbox,
            dense::Handle::Edge(dense::Edge::Right),
            [1000.0, 100.0],
            2.0,
            640.0,
            480.0,
        );
        assert_eq!(grown, BBox::new(10.0, 20.0, 640.0, 220.0));
    }

    #[test]
    fn clamp_translate_keeps_every_target_inside_the_image() {
        let targets = vec![
            (Id::from("a"), BBox::new(10.0, 20.0, 50.0, 60.0)),
            (Id::from("b"), BBox::new(100.0, 100.0, 140.0, 140.0)),
        ];
        assert_eq!(
            clamp_translate(&targets, -80.0, -80.0, 640.0, 480.0),
            [-10.0, -20.0]
        );
        assert_eq!(
            clamp_translate(&targets, 600.0, 600.0, 640.0, 480.0),
            [500.0, 340.0]
        );
    }
}
