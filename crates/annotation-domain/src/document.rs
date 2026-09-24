use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{geometry::BBox, DomainError};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, ts_rs::TS)]
#[serde(transparent)]
#[ts(type = "string")]
pub struct Id(String);

impl schemars::JsonSchema for Id {
    fn schema_name() -> String {
        "Id".to_owned()
    }

    fn json_schema(_: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
        let mut schema = schemars::schema::SchemaObject::default();
        schema.instance_type = Some(schemars::schema::InstanceType::String.into());
        schema.string = Some(Box::new(schemars::schema::StringValidation {
            min_length: Some(1),
            max_length: Some(128),
            ..Default::default()
        }));
        schemars::schema::Schema::Object(schema)
    }
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        validate_id(&value).map_err(serde::de::Error::custom)?;
        Ok(Self(value))
    }
}

impl From<String> for Id {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for Id {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl std::ops::Deref for Id {
    type Target = str;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
pub type Attrs = BTreeMap<String, Scalar>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(untagged)]
pub enum Scalar {
    String(#[schemars(length(max = 4096))] String),
    Boolean(bool),
    Number(f64),
    Null,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum Completion {
    Unprocessed,
    InProgress,
    Complete,
    ConfirmedNegative,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CoordinateSpace {
    #[serde(rename = "type")]
    pub kind: CoordinateSpaceType,
    #[schemars(range(min = 1.0, max = 4294967295.0))]
    pub width: u32,
    #[schemars(range(min = 1.0, max = 4294967295.0))]
    pub height: u32,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum CoordinateSpaceType {
    CanonicalImagePixels,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct Origin {
    #[serde(rename = "type")]
    pub kind: OriginType,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<Id>")]
    pub prediction_id: Option<Id>,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<Id>")]
    pub model_run_id: Option<Id>,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<Id>")]
    pub import_batch_id: Option<Id>,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum OriginType {
    Manual,
    Import,
    Prediction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AnnotationObject {
    pub object_id: Id,
    pub label_id: Id,
    pub geometry: BBox,
    #[schemars(with = "crate::schema::AttributeMap")]
    pub attributes: Attrs,
    pub origin: Origin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AnnotationDocument {
    #[schemars(range(min = 1.0, max = 1.0))]
    #[ts(type = "1")]
    pub schema_version: u8,
    pub asset_revision_id: Id,
    pub ontology_version_id: Id,
    pub coordinate_space: CoordinateSpace,
    pub completion: Completion,
    pub objects: Vec<AnnotationObject>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct MediaRevision {
    pub asset_id: Id,
    pub asset_revision_id: Id,
    pub project_id: Id,
    pub original_name: String,
    pub original_sha256: String,
    pub canonical_sha256: String,
    #[schemars(range(min = 1.0, max = 4294967295.0))]
    pub canonical_width: u32,
    #[schemars(range(min = 1.0, max = 4294967295.0))]
    pub canonical_height: u32,
    #[schemars(range(min = 1.0, max = 8.0))]
    pub exif_orientation: u8,
    #[schemars(length(min = 9, max = 9))]
    pub original_to_canonical: Vec<f64>,
    pub source_group_id: Id,
}

impl MediaRevision {
    pub fn validate(&self) -> Result<(), DomainError> {
        for id in [
            &self.asset_id,
            &self.asset_revision_id,
            &self.project_id,
            &self.source_group_id,
        ] {
            validate_id(id)?;
        }
        if self.canonical_width == 0 || self.canonical_height == 0 {
            return Err(DomainError::new(
                "INVALID_DIMENSIONS",
                "canonical dimensions must be positive",
            ));
        }
        if !(1..=8).contains(&self.exif_orientation)
            || self.original_to_canonical.len() != 9
            || self
                .original_to_canonical
                .iter()
                .any(|value| !value.is_finite())
        {
            return Err(DomainError::new(
                "INVALID_MEDIA_TRANSFORM",
                "media transform must be a finite row-major 3x3 matrix and EXIF orientation 1..8",
            ));
        }
        Ok(())
    }
}

impl AnnotationDocument {
    pub fn validate_shape(&self) -> Result<(), DomainError> {
        if self.schema_version != 1 {
            return Err(DomainError::new(
                "UNSUPPORTED_SCHEMA_VERSION",
                "schema_version must be 1",
            ));
        }
        validate_id(&self.asset_revision_id)?;
        validate_id(&self.ontology_version_id)?;
        if self.coordinate_space.width == 0 || self.coordinate_space.height == 0 {
            return Err(DomainError::new(
                "INVALID_DIMENSIONS",
                "image dimensions must be positive",
            ));
        }
        if self.completion == Completion::ConfirmedNegative && !self.objects.is_empty() {
            return Err(DomainError::new(
                "INVALID_COMPLETION",
                "confirmed_negative requires an empty document",
            ));
        }
        let mut ids = std::collections::HashSet::with_capacity(self.objects.len());
        for object in &self.objects {
            validate_id(&object.object_id)?;
            validate_id(&object.label_id)?;
            if !ids.insert(&object.object_id) {
                return Err(DomainError::new(
                    "DUPLICATE_OBJECT_ID",
                    "object_id values must be unique",
                ));
            }
            let source_ids_valid = match object.origin.kind {
                OriginType::Manual => {
                    object.origin.prediction_id.is_none()
                        && object.origin.model_run_id.is_none()
                        && object.origin.import_batch_id.is_none()
                }
                OriginType::Prediction => {
                    object
                        .origin
                        .prediction_id
                        .as_ref()
                        .is_some_and(|id| validate_id(id).is_ok())
                        && object
                            .origin
                            .model_run_id
                            .as_ref()
                            .is_some_and(|id| validate_id(id).is_ok())
                        && object.origin.import_batch_id.is_none()
                }
                OriginType::Import => {
                    object
                        .origin
                        .import_batch_id
                        .as_ref()
                        .is_some_and(|id| validate_id(id).is_ok())
                        && object.origin.prediction_id.is_none()
                        && object.origin.model_run_id.is_none()
                }
            };
            if !source_ids_valid {
                return Err(DomainError::new(
                    "INVALID_ORIGIN",
                    "origin references must agree with the declared origin type",
                ));
            }
            crate::geometry::validate_bbox(
                &object.geometry,
                self.coordinate_space.width,
                self.coordinate_space.height,
            )?;
            for (key, value) in &object.attributes {
                if key.is_empty() || key.chars().count() > 128 {
                    return Err(DomainError::new(
                        "INVALID_ATTRIBUTE_KEY",
                        "attribute keys must contain 1 to 128 characters",
                    ));
                }
                match value {
                    Scalar::String(value) if value.chars().count() > 4096 => {
                        return Err(DomainError::new(
                            "ATTRIBUTE_TOO_LONG",
                            "string attributes are limited to 4096 characters",
                        ))
                    }
                    Scalar::Number(value) if !value.is_finite() => {
                        return Err(DomainError::new(
                            "NON_FINITE_NUMBER",
                            "numeric attributes must be finite",
                        ))
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }
}

pub fn validate_id(id: &str) -> Result<(), DomainError> {
    if id.is_empty() || id.chars().count() > 128 {
        return Err(DomainError::new(
            "INVALID_ID",
            "IDs must contain 1 to 128 characters",
        ));
    }
    Ok(())
}
