use std::collections::HashMap;

use annotation_domain::{geometry::BBox, DomainError};
use rstar::{primitives::Rectangle, Envelope, RTree, RTreeObject};

use crate::{hit_test_bbox, validate_bbox_geometry, Viewport};

#[derive(Debug, Clone, PartialEq)]
pub struct IndexedBBox {
    pub object_id: String,
    pub draw_sequence: u64,
    pub bbox: BBox,
}

#[derive(Debug, Clone)]
struct Entry {
    value: IndexedBBox,
    bounds: Rectangle<[f64; 2]>,
}

impl rstar::RTreeObject for Entry {
    type Envelope = rstar::AABB<[f64; 2]>;
    fn envelope(&self) -> Self::Envelope {
        self.bounds.envelope()
    }
}
struct SelectObject<'a> {
    object_id: &'a str,
    envelope: &'a rstar::AABB<[f64; 2]>,
}

impl rstar::SelectionFunction<Entry> for SelectObject<'_> {
    fn should_unpack_parent(&self, envelope: &rstar::AABB<[f64; 2]>) -> bool {
        envelope.contains_envelope(self.envelope)
    }

    fn should_unpack_leaf(&self, entry: &Entry) -> bool {
        entry.value.object_id == self.object_id
    }
}

/// CPU R-tree. Rectangles are continuous xyxy; rectangle queries use strict
/// positive-area intersection (touching edges alone do not overlap).
#[derive(Debug, Default)]
pub struct SpatialIndex {
    tree: RTree<Entry>,
    id_envelopes: HashMap<String, rstar::AABB<[f64; 2]>>,
}

impl SpatialIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.tree.size()
    }
    pub fn is_empty(&self) -> bool {
        self.tree.size() == 0
    }

    /// Replaces an existing ID atomically, or inserts it if absent.
    pub fn upsert(
        &mut self,
        object_id: impl Into<String>,
        draw_sequence: u64,
        bbox: BBox,
    ) -> Result<(), DomainError> {
        validate_bbox_geometry(&bbox)?;
        let object_id = object_id.into();
        if object_id.is_empty() {
            return Err(DomainError::new(
                "INVALID_ID",
                "object ID must not be empty",
            ));
        }
        let bounds = Rectangle::from_corners([bbox.x_min, bbox.y_min], [bbox.x_max, bbox.y_max]);
        let envelope = bounds.envelope();
        if let Some(existing_envelope) = self.id_envelopes.get(&object_id) {
            self.tree.remove_with_selection_function(SelectObject {
                object_id: &object_id,
                envelope: existing_envelope,
            });
        }
        self.tree.insert(Entry {
            value: IndexedBBox {
                object_id: object_id.clone(),
                draw_sequence,
                bbox,
            },
            bounds,
        });
        self.id_envelopes.insert(object_id, envelope);
        Ok(())
    }

    pub fn remove(&mut self, object_id: &str) -> bool {
        let Some(envelope) = self.id_envelopes.get(object_id) else {
            return false;
        };
        if self
            .tree
            .remove_with_selection_function(SelectObject {
                object_id,
                envelope,
            })
            .is_none()
        {
            return false;
        }
        self.id_envelopes.remove(object_id);
        true
    }

    /// Returns objects whose edges/corners are within a circular CSS-space tolerance.
    /// Sorted from earliest draw to latest, then by object ID for deterministic ties.
    pub fn query_point(
        &self,
        css_point: [f64; 2],
        view: Viewport,
        tolerance_css: f64,
    ) -> Result<Vec<IndexedBBox>, DomainError> {
        view.validate()?;
        if css_point.iter().any(|value| !value.is_finite())
            || !tolerance_css.is_finite()
            || tolerance_css < 0.0
        {
            return Err(DomainError::new(
                "INVALID_GEOMETRY",
                "point and hit tolerance must be finite; tolerance must be non-negative",
            ));
        }
        let point = crate::css_to_image(css_point, view);
        let radius = tolerance_css / view.scale;
        if point.iter().any(|value| !value.is_finite()) || !radius.is_finite() {
            return Err(DomainError::new(
                "INVALID_GEOMETRY",
                "derived image-space query is not finite",
            ));
        }
        let min = [point[0] - radius, point[1] - radius];
        let max = [point[0] + radius, point[1] + radius];
        if min.iter().chain(max.iter()).any(|value| !value.is_finite()) {
            return Err(DomainError::new(
                "INVALID_GEOMETRY",
                "derived query envelope is not finite",
            ));
        }
        let area = rstar::AABB::from_corners(min, max);
        let mut result = Vec::new();
        for entry in self.tree.locate_in_envelope_intersecting(area) {
            if hit_test_bbox(css_point, &entry.value.bbox, view, tolerance_css)? {
                result.push(entry.value.clone());
            }
        }
        sort_hits(&mut result);
        Ok(result)
    }

    /// Returns rectangles with strict positive-area intersection. Edge-only contact is excluded.
    /// Sorted from earliest draw to latest, then by object ID for deterministic ties.
    pub fn query_rect(&self, rect: &BBox) -> Result<Vec<IndexedBBox>, DomainError> {
        validate_bbox_geometry(rect)?;
        let area = rstar::AABB::from_corners([rect.x_min, rect.y_min], [rect.x_max, rect.y_max]);
        let mut result = self
            .tree
            .locate_in_envelope_intersecting(area)
            .filter(|entry| {
                entry.value.bbox.x_min < rect.x_max
                    && rect.x_min < entry.value.bbox.x_max
                    && entry.value.bbox.y_min < rect.y_max
                    && rect.y_min < entry.value.bbox.y_max
            })
            .map(|entry| entry.value.clone())
            .collect::<Vec<_>>();
        sort_hits(&mut result);
        Ok(result)
    }

    /// Returns visible boxes in deterministic draw order using the CSS viewport
    /// transformed to image coordinates; DPR is intentionally not involved.
    pub fn query_viewport(&self, view: Viewport) -> Result<Vec<IndexedBBox>, DomainError> {
        view.validate()?;
        if view.css_width == 0.0 || view.css_height == 0.0 {
            return Ok(Vec::new());
        }
        let min = crate::css_to_image([0.0, 0.0], view);
        let max = crate::css_to_image([view.css_width, view.css_height], view);
        if min.iter().chain(max.iter()).any(|value| !value.is_finite()) {
            return Err(DomainError::new(
                "INVALID_GEOMETRY",
                "derived viewport query is not finite",
            ));
        }
        self.query_rect(&BBox::new(
            min[0].min(max[0]),
            min[1].min(max[1]),
            min[0].max(max[0]),
            min[1].max(max[1]),
        ))
    }
}

fn sort_hits(values: &mut [IndexedBBox]) {
    values.sort_by(|a, b| {
        a.draw_sequence
            .cmp(&b.draw_sequence)
            .then_with(|| a.object_id.cmp(&b.object_id))
    });
}
