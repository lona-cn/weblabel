use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    document::{AnnotationObject, Attrs},
    geometry::BBox,
};

#[derive(Serialize)]
struct CanonicalObject<'a> {
    label_id: &'a str,
    geometry: CanonicalBBox,
    attributes: &'a Attrs,
}

#[derive(Serialize)]
struct CanonicalBBox {
    r#type: &'static str,
    x_min: f64,
    y_min: f64,
    x_max: f64,
    y_max: f64,
}

impl From<&BBox> for CanonicalBBox {
    fn from(value: &BBox) -> Self {
        Self {
            r#type: "bbox_xyxy",
            x_min: value.x_min,
            y_min: value.y_min,
            x_max: value.x_max,
            y_max: value.y_max,
        }
    }
}

/// SHA-256 of the canonical object projection (label, bbox, sorted attributes).
/// Object IDs, origin and editor-only display flags are deliberately excluded.
pub fn object_hash(object: &AnnotationObject) -> String {
    let canonical = CanonicalObject {
        label_id: &object.label_id,
        geometry: CanonicalBBox::from(&object.geometry),
        attributes: &object.attributes,
    };
    let bytes = serde_json::to_vec(&canonical)
        .expect("canonical object contains only serializable finite scalar values");
    hash_bytes(&bytes)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SerializedDocument {
    pub json: String,
    pub content_hash: String,
}

/// Serialize a validated document once and compute the persisted revision hash over those exact bytes.
pub fn serialize_document(
    document: &crate::document::AnnotationDocument,
) -> Result<SerializedDocument, serde_json::Error> {
    let bytes = serde_json::to_vec(document)?;
    let content_hash = hash_bytes(&bytes);
    let json = String::from_utf8(bytes).expect("serde_json output is valid UTF-8");
    Ok(SerializedDocument { json, content_hash })
}

fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}
