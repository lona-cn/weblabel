//! Shared, validated wire model for annotation documents and candidate runs.

pub mod ai_authorization;
pub mod document;
pub mod geometry;
pub mod hash;
pub mod ontology;
pub mod prediction;
pub mod revision;
mod schema;
pub mod suggestion_validation;

pub use ai_authorization::{
    AiApprovedGrants, AiConsentRequest, AiConsentResponse, AiPreviewRequest, AiPreviewResponse,
    ExternalProcessingPolicy,
};
pub use document::{
    AnnotationDocument, AnnotationObject, Attrs, Completion, CoordinateSpace, CoordinateSpaceType,
    Id, MediaRevision, Origin, OriginType, Scalar,
};
pub use geometry::{validate_bbox, BBox, BBoxType};
pub use hash::object_hash;
pub use ontology::{
    validate_document, AllowedGeometryType, AttributeDef, AttributeKind, LabelDef, OntologyVersion,
};
pub use prediction::{
    AuthKind, Availability, Change, ModelCapabilities, ModelProfile, ProviderId, QualityIssue,
    RunContext, RunEvent, RunEventType, RunIntent, StartRunRequest, SuggestionSet, SuggestionState,
    Verification,
};
pub use revision::{
    AnnotationRevision, SaveLease, SaveRequest, SaveResponse, SuggestionDecision,
    SuggestionDecisionIntent,
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub request_id: Id,
    #[serde(deserialize_with = "deserialize_optional_json_object")]
    #[schemars(
        required,
        with = "crate::schema::Nullable<std::collections::BTreeMap<String, serde_json::Value>>"
    )]
    #[ts(type = "Record<string, unknown> | null")]
    pub details: Option<std::collections::BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomainError {
    pub code: &'static str,
    pub message: &'static str,
}

impl DomainError {
    pub const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

impl std::fmt::Display for DomainError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for DomainError {}

/// Serde's default for a missing `Option` is `None`; wire `null` fields are required.
pub(crate) fn required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

pub(crate) fn deserialize_utc_timestamp<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    validate_utc_timestamp(&value).map_err(serde::de::Error::custom)?;
    Ok(value)
}

pub(crate) fn deserialize_optional_utc_timestamp<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    if let Some(value) = &value {
        validate_utc_timestamp(value).map_err(serde::de::Error::custom)?;
    }
    Ok(value)
}

fn validate_utc_timestamp(value: &str) -> Result<(), &'static str> {
    let timestamp =
        chrono::DateTime::parse_from_rfc3339(value).map_err(|_| "timestamp must be UTC RFC3339")?;
    if timestamp.offset().local_minus_utc() != 0 || value.ends_with("-00:00") {
        return Err("timestamp must use UTC offset");
    }
    Ok(())
}

pub(crate) fn deserialize_optional_json_object<'de, D>(
    deserializer: D,
) -> Result<Option<std::collections::BTreeMap<String, serde_json::Value>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value =
        Option::<std::collections::BTreeMap<String, serde_json::Value>>::deserialize(deserializer)?;
    if let Some(object) = &value {
        for value in object.values() {
            validate_json_depth(value, 2).map_err(serde::de::Error::custom)?;
        }
    }
    Ok(value)
}

fn validate_json_depth(value: &serde_json::Value, depth: usize) -> Result<(), &'static str> {
    if depth > 16 {
        return Err("JSON nesting depth must not exceed 16");
    }
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                validate_json_depth(value, depth + 1)?;
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values() {
                validate_json_depth(value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn safe_integer<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    if value > 9_007_199_254_740_991 {
        return Err(serde::de::Error::custom(
            "integer exceeds the safe JSON integer range",
        ));
    }
    Ok(value)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum EditorCommand {
    Create {
        object: AnnotationObject,
    },
    ReplaceGeometry {
        object_id: Id,
        geometry: BBox,
    },
    SetAttributes {
        object_ids: Vec<Id>,
        #[schemars(with = "crate::schema::AttributeMap")]
        values: Attrs,
    },
    SetLabel {
        object_ids: Vec<Id>,
        label_id: Id,
    },
    Delete {
        object_ids: Vec<Id>,
    },
    Duplicate {
        object_ids: Vec<Id>,
        new_ids: Vec<Id>,
    },
    SetCompletion {
        completion: Completion,
    },
    ApplySuggestions {
        set: SuggestionSet,
        change_ids: Vec<Id>,
        #[serde(deserialize_with = "safe_integer")]
        #[schemars(range(min = 0.0, max = 9007199254740991.0))]
        #[ts(type = "number")]
        expected_generation: u64,
    },
    Undo,
    Redo,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct EditorDelta {
    #[serde(deserialize_with = "safe_integer")]
    #[schemars(range(min = 0.0, max = 9007199254740991.0))]
    #[ts(type = "number")]
    pub generation: u64,
    pub changed_objects: Vec<AnnotationObject>,
    pub removed_object_ids: Vec<Id>,
    pub selected_object_ids: Vec<Id>,
    pub can_undo: bool,
    pub can_redo: bool,
    pub document_changed: bool,
    pub repaint: bool,
    pub suggestion_decisions: Vec<SuggestionDecisionIntent>,
    #[serde(deserialize_with = "required_option")]
    #[schemars(required, with = "crate::schema::Nullable<ApiError>")]
    pub error: Option<ApiError>,
}
