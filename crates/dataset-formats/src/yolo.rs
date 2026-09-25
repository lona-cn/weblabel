use std::collections::HashMap;

use annotation_domain::{
    geometry::BBox, AnnotationObject, Id, OntologyVersion, Origin, OriginType,
};

use crate::{
    deterministic_object_id, import_document, validate_context, validate_document, FormatError,
    ImportContext, ImportReport, LossReport,
};

const MAX_OBJECTS: usize = 50_000;

#[derive(Debug, Clone, PartialEq)]
pub struct YoloExport {
    pub annotations: String,
    /// Class index i always maps to label_ids[i], independent of label names or array positions.
    pub label_ids: Vec<Id>,
    pub loss_report: LossReport,
}

pub fn export_yolo(
    document: &annotation_domain::AnnotationDocument,
    ontology: &OntologyVersion,
) -> Result<YoloExport, FormatError> {
    validate_document(document, ontology)?;
    let label_ids: Vec<Id> = ontology
        .labels
        .iter()
        .map(|label| label.label_id.clone())
        .collect();
    let indices: HashMap<Id, usize> = label_ids
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, label_id)| (label_id, index))
        .collect();
    let width = f64::from(document.coordinate_space.width);
    let height = f64::from(document.coordinate_space.height);
    let mut annotations = String::new();
    let mut losses = LossReport::default();
    for object in &document.objects {
        let index = indices.get(&object.label_id).ok_or_else(|| {
            FormatError::Invalid("object label is not present in the ontology".to_owned())
        })?;
        let bbox = &object.geometry;
        let center_x = (bbox.x_min + bbox.x_max) / (2.0 * width);
        let center_y = (bbox.y_min + bbox.y_max) / (2.0 * height);
        let box_width = (bbox.x_max - bbox.x_min) / width;
        let box_height = (bbox.y_max - bbox.y_min) / height;
        annotations.push_str(&format!(
            "{index} {center_x:.17} {center_y:.17} {box_width:.17} {box_height:.17}\n"
        ));
        if !object.attributes.is_empty() {
            losses.add(
                "attributes",
                "YOLO detection labels do not encode object attributes",
            );
        }
        losses.add(
            "object_ids",
            "YOLO detection labels do not encode stable object IDs",
        );
        if object.origin.kind != OriginType::Manual {
            losses.add(
                "provenance",
                "YOLO detection labels do not encode object provenance",
            );
        }
    }
    if document.completion != annotation_domain::Completion::Unprocessed {
        losses.add(
            "completion",
            "YOLO detection labels do not encode completion or negative-state semantics",
        );
    }
    Ok(YoloExport {
        annotations,
        label_ids,
        loss_report: losses,
    })
}

pub fn import_yolo(
    annotations: &str,
    label_ids: &[Id],
    context: &ImportContext,
    ontology: &OntologyVersion,
) -> Result<ImportReport, FormatError> {
    validate_context(context, ontology)?;
    if annotations.len() > 32 * 1024 * 1024 {
        return Err(FormatError::Invalid(
            "YOLO file exceeds the size limit".to_owned(),
        ));
    }
    if label_ids.is_empty() && annotations.lines().any(|line| !line.trim().is_empty()) {
        return Err(FormatError::Invalid(
            "YOLO class mapping is empty".to_owned(),
        ));
    }
    let ontology_labels: HashMap<Id, ()> = ontology
        .labels
        .iter()
        .map(|label| (label.label_id.clone(), ()))
        .collect();
    let mut seen_labels = HashMap::with_capacity(label_ids.len());
    for label_id in label_ids {
        if !ontology_labels.contains_key(label_id)
            || seen_labels.insert(label_id.clone(), ()).is_some()
        {
            return Err(FormatError::Invalid(
                "YOLO class mapping contains an unknown or duplicate label".to_owned(),
            ));
        }
    }

    let mut objects = Vec::new();
    for (line_index, line) in annotations.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if objects.len() == MAX_OBJECTS {
            return Err(FormatError::Invalid(
                "YOLO file exceeds the object limit".to_owned(),
            ));
        }
        let values: Vec<&str> = line.split_ascii_whitespace().collect();
        if values.len() != 5 {
            return Err(FormatError::Invalid(
                "YOLO row must contain class, center_x, center_y, width, and height".to_owned(),
            ));
        }
        let class_index = values[0]
            .parse::<usize>()
            .map_err(|_| FormatError::Invalid("YOLO class index is invalid".to_owned()))?;
        let label_id = label_ids
            .get(class_index)
            .ok_or_else(|| {
                FormatError::Invalid(
                    "YOLO class index is outside the explicit class mapping".to_owned(),
                )
            })?
            .clone();
        let center_x = parse_finite(values[1])?;
        let center_y = parse_finite(values[2])?;
        let width = parse_finite(values[3])?;
        let height = parse_finite(values[4])?;
        if !(0.0..=1.0).contains(&center_x)
            || !(0.0..=1.0).contains(&center_y)
            || !(0.0..=1.0).contains(&width)
            || !(0.0..=1.0).contains(&height)
            || width <= 0.0
            || height <= 0.0
        {
            return Err(FormatError::Invalid(
                "YOLO normalized coordinates are outside the valid range".to_owned(),
            ));
        }
        let image_width = f64::from(context.width);
        let image_height = f64::from(context.height);
        let bbox = BBox::new(
            (center_x - width / 2.0) * image_width,
            (center_y - height / 2.0) * image_height,
            (center_x + width / 2.0) * image_width,
            (center_y + height / 2.0) * image_height,
        );
        objects.push(AnnotationObject {
            object_id: deterministic_object_id(context, "yolo", &format!("{line_index}:{line}")),
            label_id,
            geometry: bbox,
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
        loss_report: LossReport::default(),
    })
}

fn parse_finite(value: &str) -> Result<f64, FormatError> {
    let number = value
        .parse::<f64>()
        .map_err(|_| FormatError::Invalid("YOLO coordinate is not a number".to_owned()))?;
    if !number.is_finite() {
        return Err(FormatError::Invalid(
            "YOLO coordinate must be finite".to_owned(),
        ));
    }
    Ok(number)
}
