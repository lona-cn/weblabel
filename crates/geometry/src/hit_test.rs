use annotation_domain::{geometry::BBox, DomainError};

use crate::{validate_bbox_geometry, Viewport};

/// Euclidean distance from an image-space point to a rectangle (zero inside).
pub fn point_to_bbox_distance(point: [f64; 2], bbox: &BBox) -> Result<f64, DomainError> {
    validate_bbox_geometry(bbox)?;
    if point.iter().any(|value| !value.is_finite()) {
        return Err(DomainError::new(
            "INVALID_GEOMETRY",
            "hit-test point must be finite",
        ));
    }
    let dx = if point[0] < bbox.x_min {
        bbox.x_min - point[0]
    } else if point[0] > bbox.x_max {
        point[0] - bbox.x_max
    } else {
        0.0
    };
    let dy = if point[1] < bbox.y_min {
        bbox.y_min - point[1]
    } else if point[1] > bbox.y_max {
        point[1] - bbox.y_max
    } else {
        0.0
    };
    Ok(dx.hypot(dy))
}

/// Tests a rectangle using a circular tolerance measured in CSS pixels.
pub fn hit_test_bbox(
    css_point: [f64; 2],
    bbox: &BBox,
    view: Viewport,
    tolerance_css: f64,
) -> Result<bool, DomainError> {
    view.validate()?;
    if !tolerance_css.is_finite() || tolerance_css < 0.0 {
        return Err(DomainError::new(
            "INVALID_GEOMETRY",
            "hit tolerance must be finite and non-negative",
        ));
    }
    let tolerance_image = tolerance_css / view.scale;
    if !tolerance_image.is_finite() {
        return Err(DomainError::new(
            "INVALID_GEOMETRY",
            "hit tolerance is not representable in image coordinates",
        ));
    }
    let image_point = crate::css_to_image(css_point, view);
    Ok(point_to_bbox_distance(image_point, bbox)? <= tolerance_image)
}
