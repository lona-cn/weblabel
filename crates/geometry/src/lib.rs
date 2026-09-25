//! CPU-only coordinate transforms, rectangle hit testing, and spatial indexing.

mod bbox;
mod hit_test;
mod spatial_index;
mod viewport;

pub use annotation_domain::{geometry::BBox, DomainError};
pub use bbox::{normalize_bbox, validate_bbox, validate_bbox_geometry};
pub use hit_test::{hit_test_bbox, point_to_bbox_distance};
pub use spatial_index::{IndexedBBox, SpatialIndex};
pub use viewport::{css_to_image, image_to_css, zoom_anchor, Viewport};
