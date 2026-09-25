use std::io::{Cursor, Write};

use annotation_domain::{
    hash::serialize_document, AnnotationRevision, MediaRevision, OntologyVersion,
};
use serde::{Deserialize, Serialize};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

use crate::{
    archive::{extract_safe_zip, ArchiveLimits},
    sha256_hex, FormatError,
};

const MAX_MANIFEST_BYTES: usize = 32 * 1024 * 1024;

const MANIFEST: &str = "manifest.json";
const CANONICAL_IMAGE: &str = "canonical.png";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeBundle {
    pub media_revision: MediaRevision,
    pub ontology: OntologyVersion,
    pub revision: AnnotationRevision,
    pub canonical_image: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeManifest {
    schema_version: u8,
    media_revision: MediaRevision,
    ontology: OntologyVersion,
    revision: AnnotationRevision,
}

pub fn export_native(bundle: &NativeBundle) -> Result<Vec<u8>, FormatError> {
    validate_bundle(bundle)?;
    let manifest = NativeManifest {
        schema_version: 1,
        media_revision: bundle.media_revision.clone(),
        ontology: bundle.ontology.clone(),
        revision: bundle.revision.clone(),
    };
    let manifest_json = serde_json::to_vec(&manifest)?;
    let payload_size = manifest_json
        .len()
        .checked_add(bundle.canonical_image.len());
    if manifest_json.len() > MAX_MANIFEST_BYTES
        || payload_size
            .is_none_or(|size| size as u64 > ArchiveLimits::default().max_uncompressed_bytes)
    {
        return Err(FormatError::Invalid(
            "native bundle exceeds its size limit".to_owned(),
        ));
    }
    let cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    writer.start_file(MANIFEST, options)?;
    writer.write_all(&manifest_json)?;
    writer.start_file(CANONICAL_IMAGE, options)?;
    writer.write_all(&bundle.canonical_image)?;
    let bytes = writer.finish()?.into_inner();
    if bytes.len() as u64 > ArchiveLimits::default().max_uncompressed_bytes {
        return Err(FormatError::Invalid(
            "native bundle exceeds its size limit".to_owned(),
        ));
    }
    Ok(bytes)
}

pub fn import_native(bytes: &[u8], limits: &ArchiveLimits) -> Result<NativeBundle, FormatError> {
    let mut files = extract_safe_zip(bytes, limits)?;
    if files.len() != 2 || !files.contains_key(MANIFEST) || !files.contains_key(CANONICAL_IMAGE) {
        return Err(FormatError::Invalid(
            "native bundle must contain only manifest.json and canonical.png".to_owned(),
        ));
    }
    let manifest_bytes = files.get(MANIFEST).expect("manifest key checked above");
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err(FormatError::Invalid(
            "native manifest exceeds the size limit".to_owned(),
        ));
    }
    let manifest: NativeManifest = serde_json::from_slice(manifest_bytes)?;
    if manifest.schema_version != 1 {
        return Err(FormatError::Unsupported(
            "native schema_version is not supported".to_owned(),
        ));
    }
    let canonical_image = files
        .remove(CANONICAL_IMAGE)
        .expect("image key checked above");
    let bundle = NativeBundle {
        media_revision: manifest.media_revision,
        ontology: manifest.ontology,
        revision: manifest.revision,
        canonical_image,
    };
    validate_bundle(&bundle)?;
    Ok(bundle)
}

fn validate_bundle(bundle: &NativeBundle) -> Result<(), FormatError> {
    bundle
        .media_revision
        .validate()
        .map_err(|error| FormatError::Invalid(error.code.to_owned()))?;
    bundle
        .ontology
        .validate()
        .map_err(|error| FormatError::Invalid(error.code.to_owned()))?;
    crate::validate_document(&bundle.revision.document, &bundle.ontology)?;
    if bundle.media_revision.project_id != bundle.ontology.project_id
        || bundle.media_revision.asset_revision_id != bundle.revision.document.asset_revision_id
        || bundle.ontology.ontology_version_id != bundle.revision.document.ontology_version_id
        || bundle.media_revision.canonical_width != bundle.revision.document.coordinate_space.width
        || bundle.media_revision.canonical_height
            != bundle.revision.document.coordinate_space.height
    {
        return Err(FormatError::Invalid(
            "native bundle identities or dimensions do not agree".to_owned(),
        ));
    }
    if !is_safe_filename(&bundle.media_revision.original_name) {
        return Err(FormatError::Invalid(
            "native media name must not contain a path".to_owned(),
        ));
    }
    if sha256_hex(&bundle.canonical_image) != bundle.media_revision.canonical_sha256 {
        return Err(FormatError::Invalid(
            "canonical image hash does not match the manifest".to_owned(),
        ));
    }
    let serialized = serialize_document(&bundle.revision.document)
        .map_err(|_| FormatError::Invalid("annotation document cannot be serialized".to_owned()))?;
    if serialized.content_hash != bundle.revision.content_hash {
        return Err(FormatError::Invalid(
            "annotation content hash does not match the document".to_owned(),
        ));
    }
    Ok(())
}

fn is_safe_filename(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains(':')
        && !value.contains('\0')
}
