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

/// Bind a public execution configuration to the exact server-owned serde JSON value.
pub fn execution_configuration_hash(configuration: &serde_json::Value) -> Result<String, serde_json::Error> {
    Ok(hash_bytes(&serde_json::to_vec(configuration)?))
}

/// Hash the selected Host config without losing Rust JSON number categories in JavaScript.
pub fn host_execution_configuration_hash(host_json: &str, provider_id: &str, profile_id: &str) -> Result<String, crate::DomainError> {
    let invalid = || crate::DomainError::new("INVALID_HOST_CONFIGURATION", "Public Host configuration is invalid");
    let host: serde_json::Value = serde_json::from_str(host_json).map_err(|_| invalid())?;
    let providers = host.get("providers").and_then(serde_json::Value::as_array).ok_or_else(invalid)?;
    let api_profile = matches!(provider_id, "openai_api" | "anthropic_api" | "mimo_api");
    let mut matches = providers.iter().filter(|entry| {
        entry.get("provider").and_then(serde_json::Value::as_str) == Some(provider_id)
            && (!api_profile || entry.get("config").and_then(|config| config.get("profile_id")).and_then(serde_json::Value::as_str) == Some(profile_id))
    });
    let config = matches.next().and_then(|entry| entry.get("config")).filter(|config| config.is_object()).ok_or_else(invalid)?;
    if matches.next().is_some() { return Err(invalid()); }
    execution_configuration_hash(config).map_err(|_| invalid())
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
