use serde::{Deserialize, Serialize};

use crate::{
    document::{validate_id, AnnotationDocument, Id, Scalar},
    DomainError,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AttributeDef {
    #[schemars(length(min = 1, max = 128))]
    pub key: String,
    pub kind: AttributeKind,
    pub required: bool,
    pub default_value: Scalar,
    pub enum_values: Vec<String>,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<f64>")]
    pub min: Option<f64>,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<f64>")]
    pub max: Option<f64>,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum AttributeKind {
    Enum,
    Boolean,
    Number,
    Text,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct LabelDef {
    pub label_id: Id,
    #[schemars(length(min = 1, max = 128))]
    pub name: String,
    pub color: String,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<String>")]
    pub shortcut: Option<String>,
    pub allowed_geometry_types: Vec<AllowedGeometryType>,
    pub attributes: Vec<AttributeDef>,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum AllowedGeometryType {
    BboxXyxy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct OntologyVersion {
    pub ontology_version_id: Id,
    pub project_id: Id,
    #[serde(deserialize_with = "crate::safe_integer")]
    #[schemars(range(min = 0.0, max = 9007199254740991.0))]
    #[ts(type = "number")]
    pub version_no: u64,
    pub labels: Vec<LabelDef>,
    pub guidelines_markdown: String,
    #[schemars(with = "crate::schema::False")]
    #[ts(type = "false")]
    pub allow_out_of_bounds: bool,
}

impl OntologyVersion {
    pub fn validate(&self) -> Result<(), DomainError> {
        validate_id(&self.ontology_version_id)?;
        validate_id(&self.project_id)?;
        let mut labels = std::collections::HashSet::with_capacity(self.labels.len());
        for label in &self.labels {
            validate_id(&label.label_id)?;
            if label.name.is_empty() || label.name.chars().count() > 128 {
                return Err(DomainError::new(
                    "INVALID_LABEL_NAME",
                    "label names must contain 1 to 128 characters",
                ));
            }
            if !labels.insert(&label.label_id) {
                return Err(DomainError::new(
                    "DUPLICATE_LABEL_ID",
                    "label_id values must be unique",
                ));
            }
            if label.allowed_geometry_types.is_empty()
                || label
                    .allowed_geometry_types
                    .iter()
                    .any(|kind| *kind != AllowedGeometryType::BboxXyxy)
            {
                return Err(DomainError::new(
                    "UNSUPPORTED_GEOMETRY",
                    "labels must allow bbox_xyxy geometry",
                ));
            }
            let mut attributes = std::collections::HashSet::with_capacity(label.attributes.len());
            for def in &label.attributes {
                if def.key.is_empty()
                    || def.key.chars().count() > 128
                    || !attributes.insert(&def.key)
                {
                    return Err(DomainError::new(
                        "INVALID_ATTRIBUTE_DEFINITION",
                        "attribute keys must be unique and contain 1 to 128 characters",
                    ));
                }
                if def.min.is_some_and(|value| !value.is_finite())
                    || def.max.is_some_and(|value| !value.is_finite())
                {
                    return Err(DomainError::new(
                        "NON_FINITE_NUMBER",
                        "attribute limits must be finite",
                    ));
                }
                if let (Some(min), Some(max)) = (def.min, def.max) {
                    if min > max {
                        return Err(DomainError::new(
                            "INVALID_ATTRIBUTE_RANGE",
                            "minimum must not exceed maximum",
                        ));
                    }
                }
                if def.kind == AttributeKind::Enum && def.enum_values.is_empty() {
                    return Err(DomainError::new(
                        "INVALID_ENUM",
                        "enum attributes require at least one value",
                    ));
                }
                let default_matches_kind = match (&def.default_value, def.kind) {
                    (Scalar::Null, _) => true,
                    (Scalar::String(_), AttributeKind::Enum | AttributeKind::Text) => true,
                    (Scalar::Boolean(_), AttributeKind::Boolean) => true,
                    (Scalar::Number(value), AttributeKind::Number) => value.is_finite(),
                    _ => false,
                };
                if !default_matches_kind {
                    return Err(DomainError::new(
                        "INVALID_ATTRIBUTE_DEFAULT",
                        "attribute default does not match its declared kind",
                    ));
                }
                if let Scalar::String(value) = &def.default_value {
                    if def.kind == AttributeKind::Enum && !def.enum_values.contains(value) {
                        return Err(DomainError::new(
                            "INVALID_ATTRIBUTE_DEFAULT",
                            "enum default is not an allowed value",
                        ));
                    }
                    if value.chars().count() > 4096 {
                        return Err(DomainError::new(
                            "ATTRIBUTE_TOO_LONG",
                            "string defaults are limited to 4096 characters",
                        ));
                    }
                }
                if let Scalar::Number(value) = &def.default_value {
                    if def.min.is_some_and(|min| *value < min)
                        || def.max.is_some_and(|max| *value > max)
                    {
                        return Err(DomainError::new(
                            "INVALID_ATTRIBUTE_DEFAULT",
                            "numeric default is outside its declared range",
                        ));
                    }
                }
            }
        }
        if self.allow_out_of_bounds {
            return Err(DomainError::new(
                "OUT_OF_BOUNDS_NOT_ALLOWED",
                "v1 ontologies must disallow out-of-bounds geometry",
            ));
        }
        Ok(())
    }
}

pub fn validate_document(
    document: &AnnotationDocument,
    ontology: &OntologyVersion,
) -> Result<(), DomainError> {
    document.validate_shape()?;
    ontology.validate()?;
    if document.ontology_version_id != ontology.ontology_version_id {
        return Err(DomainError::new(
            "ONTOLOGY_VERSION_MISMATCH",
            "document and ontology versions do not match",
        ));
    }
    for object in &document.objects {
        let label = ontology
            .labels
            .iter()
            .find(|label| label.label_id == object.label_id)
            .ok_or_else(|| {
                DomainError::new("UNKNOWN_LABEL", "object label_id is not in the ontology")
            })?;
        let definitions: std::collections::HashMap<_, _> = label
            .attributes
            .iter()
            .map(|def| (def.key.as_str(), def))
            .collect();
        for def in &label.attributes {
            if def.required && !object.attributes.contains_key(&def.key) {
                return Err(DomainError::new(
                    "MISSING_REQUIRED_ATTRIBUTE",
                    "required object attribute is missing",
                ));
            }
        }
        for (key, value) in &object.attributes {
            let def = definitions.get(key.as_str()).ok_or_else(|| {
                DomainError::new(
                    "UNKNOWN_ATTRIBUTE",
                    "object attribute is not defined by ontology",
                )
            })?;
            let valid_kind = match (def.kind, value) {
                (_, Scalar::Null) => true,
                (AttributeKind::Enum | AttributeKind::Text, Scalar::String(_)) => true,
                (AttributeKind::Boolean, Scalar::Boolean(_)) => true,
                (AttributeKind::Number, Scalar::Number(_)) => true,
                _ => false,
            };
            if !valid_kind {
                return Err(DomainError::new(
                    "ATTRIBUTE_TYPE_MISMATCH",
                    "attribute value does not match ontology kind",
                ));
            }
            if let Scalar::String(value) = value {
                if def.kind == AttributeKind::Enum && !def.enum_values.contains(value) {
                    return Err(DomainError::new(
                        "INVALID_ENUM_VALUE",
                        "attribute value is not an allowed enum value",
                    ));
                }
            }
            if let Scalar::Number(value) = value {
                if def.min.is_some_and(|min| *value < min)
                    || def.max.is_some_and(|max| *value > max)
                {
                    return Err(DomainError::new(
                        "ATTRIBUTE_OUT_OF_RANGE",
                        "numeric attribute is outside ontology limits",
                    ));
                }
            }
        }
    }
    Ok(())
}
