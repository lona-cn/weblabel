//! Native, YOLO, and COCO conversion with bounded archive handling.

pub mod archive;
pub mod coco;
pub mod native;
pub mod yolo;

use annotation_domain::{document::Id, AnnotationDocument};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum FormatError {
    #[error("invalid dataset: {0}")]
    Invalid(String),
    #[error("unsupported dataset: {0}")]
    Unsupported(String),
    #[error("dataset serialization failed")]
    Json(#[from] serde_json::Error),
    #[error("archive is invalid or exceeds its limits")]
    Archive(#[from] zip::result::ZipError),
    #[error("archive I/O failed")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LossItem {
    pub field: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LossReport {
    pub losses: Vec<LossItem>,
}

impl LossReport {
    pub fn requires_ack(&self) -> bool {
        !self.losses.is_empty()
    }

    pub fn contains(&self, field: &str) -> bool {
        self.losses.iter().any(|loss| loss.field == field)
    }

    pub(crate) fn add(&mut self, field: &str, reason: &str) {
        if !self.contains(field) {
            self.losses.push(LossItem {
                field: field.to_owned(),
                reason: reason.to_owned(),
            });
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportContext {
    pub asset_revision_id: Id,
    pub import_batch_id: Id,
    pub width: u32,
    pub height: u32,
    /// Multi-image imports must name a source image explicitly; no basename matching is implicit.
    pub source_image_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportReport {
    pub document: AnnotationDocument,
    pub loss_report: LossReport,
}

pub(crate) fn validate_context(
    context: &ImportContext,
    ontology: &annotation_domain::OntologyVersion,
) -> Result<(), FormatError> {
    annotation_domain::document::validate_id(&context.asset_revision_id)
        .and_then(|_| annotation_domain::document::validate_id(&context.import_batch_id))
        .map_err(|error| FormatError::Invalid(error.code.to_owned()))?;
    if context.width == 0 || context.height == 0 {
        return Err(FormatError::Invalid(
            "image dimensions must be positive".to_owned(),
        ));
    }
    ontology
        .validate()
        .map_err(|error| FormatError::Invalid(error.code.to_owned()))
}

pub(crate) fn validate_document(
    document: &AnnotationDocument,
    ontology: &annotation_domain::OntologyVersion,
) -> Result<(), FormatError> {
    if document.objects.len() > 50_000 {
        return Err(FormatError::Invalid(
            "annotation document exceeds the object limit".to_owned(),
        ));
    }
    annotation_domain::validate_document(document, ontology)
        .map_err(|error| FormatError::Invalid(error.code.to_owned()))
}

pub(crate) fn import_document(
    context: &ImportContext,
    ontology: &annotation_domain::OntologyVersion,
    objects: Vec<annotation_domain::AnnotationObject>,
) -> Result<AnnotationDocument, FormatError> {
    validate_context(context, ontology)?;
    let document = AnnotationDocument {
        schema_version: 1,
        asset_revision_id: context.asset_revision_id.clone(),
        ontology_version_id: ontology.ontology_version_id.clone(),
        coordinate_space: annotation_domain::CoordinateSpace {
            kind: annotation_domain::CoordinateSpaceType::CanonicalImagePixels,
            width: context.width,
            height: context.height,
        },
        completion: if objects.is_empty() {
            annotation_domain::Completion::Unprocessed
        } else {
            annotation_domain::Completion::InProgress
        },
        objects,
    };
    validate_document(&document, ontology)?;
    Ok(document)
}

pub(crate) fn deterministic_object_id(context: &ImportContext, format: &str, row_id: &str) -> Id {
    let name = format!(
        "{}:{}:{}:{}",
        &*context.asset_revision_id, &*context.import_batch_id, format, row_id
    );
    Id::from(uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, name.as_bytes()).to_string())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}
