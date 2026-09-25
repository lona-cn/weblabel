use std::collections::{BTreeMap, HashMap, HashSet};

use annotation_domain::{
    geometry::BBox, AnnotationObject, Id, OntologyVersion, Origin, OriginType,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    deterministic_object_id, import_document, validate_context, validate_document, FormatError,
    ImportContext, ImportReport, LossReport,
};

const MAX_OBJECTS: usize = 50_000;
const MAX_COCO_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct CocoExport {
    pub json: Vec<u8>,
    pub loss_report: LossReport,
}

#[derive(Debug, Serialize, Deserialize)]
struct CocoDocument {
    images: Vec<CocoImage>,
    categories: Vec<CocoCategory>,
    annotations: Vec<CocoAnnotation>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CocoImage {
    id: i64,
    file_name: String,
    width: u32,
    height: u32,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CocoCategory {
    id: i64,
    name: String,
    #[serde(default)]
    label_id: Option<Id>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CocoAnnotation {
    id: i64,
    image_id: i64,
    category_id: i64,
    bbox: Vec<f64>,
    #[serde(default, rename = "area")]
    _area: Option<f64>,
    #[serde(default)]
    iscrowd: u8,
    #[serde(default)]
    segmentation: Value,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize)]
struct ExportDocument {
    images: Vec<ExportImage>,
    categories: Vec<ExportCategory>,
    annotations: Vec<ExportAnnotation>,
}

#[derive(Debug, Serialize)]
struct ExportImage {
    id: i64,
    file_name: String,
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize)]
struct ExportCategory {
    id: i64,
    name: String,
    label_id: Id,
}

#[derive(Debug, Serialize)]
struct ExportAnnotation {
    id: i64,
    image_id: i64,
    category_id: i64,
    bbox: [f64; 4],
    area: f64,
    iscrowd: u8,
}

pub fn export_coco(
    document: &annotation_domain::AnnotationDocument,
    ontology: &OntologyVersion,
    file_name: &str,
) -> Result<CocoExport, FormatError> {
    validate_document(document, ontology)?;
    if !is_safe_file_name(file_name) {
        return Err(FormatError::Invalid(
            "COCO image file_name must be a safe basename".to_owned(),
        ));
    }
    let mut labels: Vec<_> = ontology.labels.iter().collect();
    labels.sort_by(|left, right| left.label_id.cmp(&right.label_id));
    let category_ids: HashMap<Id, i64> = labels
        .iter()
        .enumerate()
        .map(|(index, label)| (label.label_id.clone(), index as i64 + 1))
        .collect();
    let categories = labels
        .iter()
        .enumerate()
        .map(|(index, label)| ExportCategory {
            id: index as i64 + 1,
            name: label.name.clone(),
            label_id: label.label_id.clone(),
        })
        .collect();
    let mut losses = LossReport::default();
    let annotations = document
        .objects
        .iter()
        .enumerate()
        .map(|(index, object)| {
            let category_id = *category_ids.get(&object.label_id).ok_or_else(|| {
                FormatError::Invalid("object label is not present in the ontology".to_owned())
            })?;
            if !object.attributes.is_empty() {
                losses.add(
                    "attributes",
                    "COCO bbox annotations do not encode ontology attributes",
                );
            }
            losses.add(
                "object_ids",
                "COCO annotations do not encode stable WebLabel object IDs",
            );
            if object.origin.kind != OriginType::Manual {
                losses.add(
                    "provenance",
                    "COCO annotations do not encode object provenance",
                );
            }
            let width = object.geometry.x_max - object.geometry.x_min;
            let height = object.geometry.y_max - object.geometry.y_min;
            Ok(ExportAnnotation {
                id: index as i64 + 1,
                image_id: 1,
                category_id,
                bbox: [object.geometry.x_min, object.geometry.y_min, width, height],
                area: width * height,
                iscrowd: 0,
            })
        })
        .collect::<Result<Vec<_>, FormatError>>()?;
    if document.completion != annotation_domain::Completion::Unprocessed {
        losses.add(
            "completion",
            "COCO bbox annotations do not encode completion or negative-state semantics",
        );
    }
    let export = ExportDocument {
        images: vec![ExportImage {
            id: 1,
            file_name: file_name.to_owned(),
            width: document.coordinate_space.width,
            height: document.coordinate_space.height,
        }],
        categories,
        annotations,
    };
    Ok(CocoExport {
        json: serde_json::to_vec(&export)?,
        loss_report: losses,
    })
}

pub fn import_coco(
    bytes: &[u8],
    context: &ImportContext,
    ontology: &OntologyVersion,
) -> Result<ImportReport, FormatError> {
    validate_context(context, ontology)?;
    if bytes.len() > MAX_COCO_BYTES {
        return Err(FormatError::Invalid(
            "COCO document exceeds the size limit".to_owned(),
        ));
    }
    let source: CocoDocument = serde_json::from_slice(bytes)?;
    if source.images.len() > MAX_OBJECTS
        || source.categories.len() > MAX_OBJECTS
        || source.annotations.len() > MAX_OBJECTS
    {
        return Err(FormatError::Invalid(
            "COCO arrays exceed the item limit".to_owned(),
        ));
    }
    if source.images.is_empty() {
        return Err(FormatError::Invalid(
            "COCO dataset contains no images".to_owned(),
        ));
    }
    let mut image_ids = HashSet::with_capacity(source.images.len());
    if source
        .images
        .iter()
        .any(|image| !image_ids.insert(image.id))
    {
        return Err(FormatError::Invalid(
            "COCO image IDs must be unique".to_owned(),
        ));
    }
    let image_index = if let Some(source_image_id) = context.source_image_id {
        source
            .images
            .iter()
            .position(|image| image.id == source_image_id)
            .ok_or_else(|| {
                FormatError::Invalid("explicit COCO image ID was not found".to_owned())
            })?
    } else if source.images.len() == 1 {
        0
    } else {
        return Err(FormatError::Invalid(
            "multi-image COCO import requires an explicit source image ID".to_owned(),
        ));
    };
    let image = &source.images[image_index];
    if image.width != context.width || image.height != context.height {
        return Err(FormatError::Invalid(
            "selected COCO image dimensions do not match the target media".to_owned(),
        ));
    }

    let ontology_by_id: HashMap<Id, &str> = ontology
        .labels
        .iter()
        .map(|label| (label.label_id.clone(), label.name.as_str()))
        .collect();
    let mut category_map = HashMap::with_capacity(source.categories.len());
    let mut category_ids = HashSet::with_capacity(source.categories.len());
    for category in &source.categories {
        if !category_ids.insert(category.id) {
            return Err(FormatError::Invalid(
                "COCO category IDs must be unique".to_owned(),
            ));
        }
        let label_id = match &category.label_id {
            Some(label_id) if ontology_by_id.contains_key(label_id) => label_id.clone(),
            Some(_) => {
                return Err(FormatError::Invalid(
                    "COCO category label_id is not in the target ontology".to_owned(),
                ));
            }
            None => {
                return Err(FormatError::Invalid(
                    "COCO category requires an explicit target label_id".to_owned(),
                ));
            }
        };
        category_map.insert(category.id, label_id);
    }

    let mut losses = LossReport::default();
    if !source.extra.is_empty()
        || !image.extra.is_empty()
        || source
            .categories
            .iter()
            .any(|category| !category.extra.is_empty())
    {
        losses.add(
            "unsupported_fields",
            "COCO dataset, image, or category contains fields not represented by WebLabel",
        );
    }
    if source.images.len() > 1 {
        losses.add(
            "other_images",
            "only the explicitly selected COCO image is imported",
        );
    }
    let mut seen_annotation_ids = HashSet::with_capacity(source.annotations.len());
    let mut objects = Vec::new();
    for annotation in &source.annotations {
        if !image_ids.contains(&annotation.image_id) {
            return Err(FormatError::Invalid(
                "COCO annotation references an unknown image ID".to_owned(),
            ));
        }
        if annotation.image_id != image.id {
            continue;
        }
        if objects.len() == MAX_OBJECTS {
            return Err(FormatError::Invalid(
                "COCO image exceeds the object limit".to_owned(),
            ));
        }
        if !seen_annotation_ids.insert(annotation.id) {
            return Err(FormatError::Invalid(
                "COCO annotation IDs must be unique for the selected image".to_owned(),
            ));
        }
        if annotation.iscrowd > 1 {
            return Err(FormatError::Invalid(
                "COCO iscrowd must be 0 or 1".to_owned(),
            ));
        }
        let label_id = category_map
            .get(&annotation.category_id)
            .cloned()
            .ok_or_else(|| {
                FormatError::Invalid("COCO annotation references an unknown category ID".to_owned())
            })?;
        if annotation.bbox.len() != 4 || annotation.bbox.iter().any(|value| !value.is_finite()) {
            return Err(FormatError::Invalid(
                "COCO bbox must contain four finite numbers".to_owned(),
            ));
        }
        let [x, y, width, height] = [
            annotation.bbox[0],
            annotation.bbox[1],
            annotation.bbox[2],
            annotation.bbox[3],
        ];
        if width <= 0.0 || height <= 0.0 {
            return Err(FormatError::Invalid(
                "COCO bbox width and height must be positive".to_owned(),
            ));
        }
        if !annotation.segmentation.is_null()
            && annotation.segmentation != Value::Array(Vec::new())
            && annotation.segmentation != Value::Object(Default::default())
        {
            losses.add(
                "segmentation",
                "COCO segmentation is not imported; only bbox geometry is supported",
            );
        }
        if annotation.iscrowd == 1 {
            losses.add(
                "iscrowd",
                "COCO crowd annotations are imported as ordinary bbox objects",
            );
        }
        if !annotation.extra.is_empty() {
            losses.add(
                "unsupported_fields",
                "COCO annotation fields outside bbox/category are not represented",
            );
        }
        objects.push(AnnotationObject {
            object_id: deterministic_object_id(context, "coco", &annotation.id.to_string()),
            label_id,
            geometry: BBox::new(x, y, x + width, y + height),
            attributes: Default::default(),
            origin: Origin {
                kind: OriginType::Import,
                prediction_id: None,
                model_run_id: None,
                import_batch_id: Some(context.import_batch_id.clone()),
            },
        });
    }
    let document = import_document(context, ontology, objects)?;
    Ok(ImportReport {
        document,
        loss_report: losses,
    })
}

fn is_safe_file_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains(':')
        && !value.chars().any(char::is_control)
}
