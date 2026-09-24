use serde::{Deserialize, Serialize};

use crate::DomainError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct BBox {
    #[serde(rename = "type")]
    pub kind: BBoxType,
    pub x_min: f64,
    pub y_min: f64,
    pub x_max: f64,
    pub y_max: f64,
}
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum BBoxType {
    BboxXyxy,
}

impl BBox {
    pub fn new(x_min: f64, y_min: f64, x_max: f64, y_max: f64) -> Self {
        Self {
            kind: BBoxType::BboxXyxy,
            x_min,
            y_min,
            x_max,
            y_max,
        }
    }
}

pub fn validate_bbox(bbox: &BBox, width: u32, height: u32) -> Result<(), DomainError> {
    let coordinates = [bbox.x_min, bbox.y_min, bbox.x_max, bbox.y_max];
    if coordinates.iter().any(|value| !value.is_finite()) {
        return Err(DomainError::new(
            "INVALID_GEOMETRY",
            "bbox coordinates must be finite",
        ));
    }
    if width == 0 || height == 0 {
        return Err(DomainError::new(
            "INVALID_DIMENSIONS",
            "image dimensions must be positive",
        ));
    }
    if bbox.x_min >= bbox.x_max || bbox.y_min >= bbox.y_max {
        return Err(DomainError::new(
            "INVALID_GEOMETRY",
            "bbox must have positive area",
        ));
    }
    if bbox.x_min < 0.0
        || bbox.y_min < 0.0
        || bbox.x_max > f64::from(width)
        || bbox.y_max > f64::from(height)
    {
        return Err(DomainError::new(
            "OUT_OF_BOUNDS",
            "bbox must be within the canonical image",
        ));
    }
    Ok(())
}
