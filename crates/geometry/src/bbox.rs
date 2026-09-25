use annotation_domain::{geometry::BBox, DomainError};

/// Normalizes drag endpoints into continuous xyxy image coordinates; it does not add a pixel.
pub fn normalize_bbox(first: [f64; 2], second: [f64; 2]) -> Result<BBox, DomainError> {
    if first
        .iter()
        .chain(second.iter())
        .any(|value| !value.is_finite())
    {
        return Err(DomainError::new(
            "INVALID_GEOMETRY",
            "bbox coordinates must be finite",
        ));
    }
    let bbox = BBox::new(
        first[0].min(second[0]),
        first[1].min(second[1]),
        first[0].max(second[0]),
        first[1].max(second[1]),
    );
    validate_bbox_geometry(&bbox)?;
    Ok(bbox)
}

/// Validates a positive-area, finite continuous rectangle without image bounds.
pub fn validate_bbox_geometry(bbox: &BBox) -> Result<(), DomainError> {
    if [bbox.x_min, bbox.y_min, bbox.x_max, bbox.y_max]
        .iter()
        .any(|value| !value.is_finite())
    {
        return Err(DomainError::new(
            "INVALID_GEOMETRY",
            "bbox coordinates must be finite",
        ));
    }
    if bbox.x_min >= bbox.x_max || bbox.y_min >= bbox.y_max {
        return Err(DomainError::new(
            "INVALID_GEOMETRY",
            "bbox must have positive area",
        ));
    }
    Ok(())
}

/// Applies the shared annotation-domain bounds rules.
pub fn validate_bbox(bbox: &BBox, width: u32, height: u32) -> Result<(), DomainError> {
    annotation_domain::geometry::validate_bbox(bbox, width, height)
}
