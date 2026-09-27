//! Dense-selection candidate validation and predictable overlap cycling.
//!
//! Consumes the T03 hit-testing primitives (`geometry::SpatialIndex`,
//! `geometry::hit_test_bbox`) and adds the explicit ordering the architecture
//! requires for overlapping cyclic selection: strict containment hits rank
//! before near misses, each group ordered topmost (latest draw) first with the
//! object id as deterministic tie-break. Hidden objects are never hit-testable;
//! locked objects stay selectable but are filtered out by drag/resize callers.

use annotation_domain::{AnnotationDocument, DomainError, Id};
use geometry::{css_to_image, hit_test_bbox, SpatialIndex, Viewport};

use crate::selection::Selection;

/// Click stacking radius so small targets stay clickable (CSS pixels).
pub(crate) const PICK_TOLERANCE_CSS: f64 = 4.0;

/// Resize corner/edge grab band (CSS pixels).
pub(crate) const HANDLE_TOLERANCE_CSS: f64 = 6.0;

/// Resize corner anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

/// Resize edge anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

/// A resize handle: one of four corners or four edges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Handle {
    Corner(Corner),
    Edge(Edge),
}

/// Point-and-click candidate ordering for one canvas position.
pub(crate) struct HitIndex {
    index: SpatialIndex,
}

impl HitIndex {
    /// Builds the CPU spatial index in document draw order.
    pub(crate) fn build(document: &AnnotationDocument) -> Self {
        let mut index = SpatialIndex::new();
        for (draw_sequence, object) in document.objects.iter().enumerate() {
            // Document objects are validated at every editor boundary, so the
            // index accepts them without a second failure path.
            let _ = index.upsert(
                &*object.object_id,
                draw_sequence as u64,
                object.geometry.clone(),
            );
        }
        Self { index }
    }

    /// Candidates for click cycling at `point_css`: objects strictly
    /// containing the point first (so the clicked pixels always win), then
    /// near misses within `tolerance_css`; each group topmost-first. Hidden
    /// objects are excluded.
    pub(crate) fn stack(
        &self,
        selection: &Selection,
        viewport: Viewport,
        point_css: [f64; 2],
        tolerance_css: f64,
    ) -> Result<Vec<Id>, DomainError> {
        let hits = self.index.query_point(point_css, viewport, tolerance_css)?;
        let mut strict = Vec::new();
        let mut near = Vec::new();
        for hit in &hits {
            if selection.flags(&Id::from(hit.object_id.clone())).hidden {
                continue;
            }
            if hit_test_bbox(point_css, &hit.bbox, viewport, 0.0)? {
                strict.push(hit);
            } else {
                near.push(hit);
            }
        }
        // query_point sorts earliest-draw first; topmost (latest draw) first
        // is the reverse. Ties cannot occur (draw_sequence is unique).
        strict.reverse();
        near.reverse();
        Ok(strict
            .into_iter()
            .chain(near)
            .map(|hit| Id::from(hit.object_id.clone()))
            .collect())
    }
}

/// The next pick for a plain click: the candidate after the topmost currently
/// selected one, wrapping at the end of the stack; the topmost candidate when
/// nothing in the stack is selected. Empty stack yields `None`.
pub(crate) fn cycle_pick(stack: &[Id], selection_before: &[Id]) -> Option<Id> {
    if stack.is_empty() {
        return None;
    }
    let at = stack
        .iter()
        .position(|id| selection_before.contains(id))
        .map_or(0, |index| (index + 1) % stack.len());
    Some(stack[at].clone())
}

/// Marquee collection with the T04 semantics: strict positive-area overlap is
/// not required, edge contact counts; hidden objects are never picked and drop
/// out of the additive base.
pub(crate) fn marquee_ids(
    document: &AnnotationDocument,
    selection: &Selection,
    rect: &annotation_domain::BBox,
    additive: bool,
) -> Vec<Id> {
    let mut ids: Vec<Id> = if additive {
        selection
            .ids()
            .iter()
            .filter(|id| !selection.flags(id).hidden)
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    ids.extend(
        document
            .objects
            .iter()
            .filter(|object| {
                !selection.flags(&object.object_id).hidden
                    && object.geometry.x_min <= rect.x_max
                    && object.geometry.x_max >= rect.x_min
                    && object.geometry.y_min <= rect.y_max
                    && object.geometry.y_max >= rect.y_min
            })
            .map(|object| object.object_id.clone()),
    );
    ids
}

/// The resize handle under `point_css` for selected, visible, unlocked
/// objects. The topmost such object wins; a locked or hidden object never
/// exposes handles.
pub(crate) fn handle_hit(
    document: &AnnotationDocument,
    selection: &Selection,
    viewport: Viewport,
    point_css: [f64; 2],
) -> Option<(Id, Handle)> {
    if !viewport.scale.is_finite() || viewport.scale <= 0.0 {
        return None;
    }
    let tolerance_image = HANDLE_TOLERANCE_CSS / viewport.scale;
    if !tolerance_image.is_finite() {
        return None;
    }
    let point = css_to_image(point_css, viewport);
    if point.iter().any(|value| !value.is_finite()) {
        return None;
    }
    for object in document.objects.iter().rev() {
        if !selection.ids().contains(&object.object_id) {
            continue;
        }
        let flags = selection.flags(&object.object_id);
        if flags.hidden || flags.locked {
            continue;
        }
        if let Some(handle) = classify_handle(point, &object.geometry, tolerance_image) {
            return Some((object.object_id.clone(), handle));
        }
    }
    None
}

/// Classifies the resize handle at an image-space point: corner circles win
/// over edge bands; nearest corner/edge with a fixed tie-break order
/// (TopLeft, TopRight, BottomLeft, BottomRight; Left, Right, Top, Bottom).
pub(crate) fn classify_handle(
    point: [f64; 2],
    bbox: &annotation_domain::BBox,
    tolerance: f64,
) -> Option<Handle> {
    if tolerance < 0.0 || !tolerance.is_finite() {
        return None;
    }
    let corners = [
        (Corner::TopLeft, [bbox.x_min, bbox.y_min]),
        (Corner::TopRight, [bbox.x_max, bbox.y_min]),
        (Corner::BottomLeft, [bbox.x_min, bbox.y_max]),
        (Corner::BottomRight, [bbox.x_max, bbox.y_max]),
    ];
    let mut best: Option<(f64, Corner)> = None;
    for (corner, at) in corners {
        let distance = (point[0] - at[0]).hypot(point[1] - at[1]);
        if distance <= tolerance && best.map_or(true, |(closest, _)| distance < closest) {
            best = Some((distance, corner));
        }
    }
    if let Some((_, corner)) = best {
        return Some(Handle::Corner(corner));
    }
    let edges = [
        (
            Edge::Left,
            segment_distance(point, [bbox.x_min, bbox.y_min], [bbox.x_min, bbox.y_max]),
        ),
        (
            Edge::Right,
            segment_distance(point, [bbox.x_max, bbox.y_min], [bbox.x_max, bbox.y_max]),
        ),
        (
            Edge::Top,
            segment_distance(point, [bbox.x_min, bbox.y_min], [bbox.x_max, bbox.y_min]),
        ),
        (
            Edge::Bottom,
            segment_distance(point, [bbox.x_min, bbox.y_max], [bbox.x_max, bbox.y_max]),
        ),
    ];
    let mut best: Option<(f64, Edge)> = None;
    for (edge, distance) in edges {
        if distance <= tolerance && best.map_or(true, |(closest, _)| distance < closest) {
            best = Some((distance, edge));
        }
    }
    best.map(|(_, edge)| Handle::Edge(edge))
}

/// Euclidean distance from a point to an axis-aligned segment.
fn segment_distance(point: [f64; 2], from: [f64; 2], to: [f64; 2]) -> f64 {
    let clamped_x = point[0].clamp(from[0].min(to[0]), from[0].max(to[0]));
    let clamped_y = point[1].clamp(from[1].min(to[1]), from[1].max(to[1]));
    (point[0] - clamped_x).hypot(point[1] - clamped_y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_prefers_corners_then_edges_with_fixed_tie_breaks() {
        let bbox = annotation_domain::BBox::new(10.0, 20.0, 110.0, 220.0);
        assert_eq!(
            classify_handle([10.0, 20.0], &bbox, 6.0),
            Some(Handle::Corner(Corner::TopLeft))
        );
        assert_eq!(
            classify_handle([110.0, 120.0], &bbox, 6.0),
            Some(Handle::Edge(Edge::Right))
        );
        assert_eq!(classify_handle([60.0, 120.0], &bbox, 6.0), None);
    }

    #[test]
    fn cycle_pick_walks_the_stack_and_wraps() {
        let stack = vec![Id::from("a"), Id::from("b"), Id::from("c")];
        assert_eq!(cycle_pick(&stack, &[]), Some(Id::from("a")));
        assert_eq!(cycle_pick(&stack, &[Id::from("a")]), Some(Id::from("b")));
        assert_eq!(
            cycle_pick(&stack, &[Id::from("c"), Id::from("x")]),
            Some(Id::from("a"))
        );
        assert_eq!(cycle_pick(&[], &[]), None);
    }
}
