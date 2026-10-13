use std::{collections::HashMap, fmt::Write};

use annotation_domain::{
    geometry::BBox, ontology::LabelDef, AnnotationObject, Id, OntologyVersion, Origin, OriginType,
};

use crate::{
    deterministic_object_id, import_document, target_default_attributes, validate_context,
    validate_document, FormatError, ImportContext, ImportReport, LossReport,
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
        if box_width == 0.0 || box_height == 0.0 {
            return Err(FormatError::Unsupported(
                "YOLO normalized box dimensions underflow to zero".to_owned(),
            ));
        }
        writeln!(
            annotations,
            "{index} {center_x} {center_y} {box_width} {box_height}"
        )
        .expect("writing to a String cannot fail");
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
    let ontology_labels: HashMap<&Id, &LabelDef> = ontology
        .labels
        .iter()
        .map(|label| (&label.label_id, label))
        .collect();
    let mut seen_labels = HashMap::with_capacity(label_ids.len());
    let mut mapped_labels = Vec::with_capacity(label_ids.len());
    for label_id in label_ids {
        let label = match ontology_labels.get(label_id) {
            Some(label) if seen_labels.insert(label_id, ()).is_none() => *label,
            _ => {
                return Err(FormatError::Invalid(
                    "YOLO class mapping contains an unknown or duplicate label".to_owned(),
                ))
            }
        };
        mapped_labels.push(label);
    }

    let mut objects = Vec::new();
    let mut uses_attribute_defaults = false;
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
        let label = mapped_labels.get(class_index).ok_or_else(|| {
            FormatError::Invalid(
                "YOLO class index is outside the explicit class mapping".to_owned(),
            )
        })?;
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
        let attributes = target_default_attributes(label);
        uses_attribute_defaults |= !attributes.is_empty();
        objects.push(AnnotationObject {
            object_id: deterministic_object_id(context, "yolo", &format!("{line_index}:{line}")),
            label_id: label.label_id.clone(),
            geometry: bbox,
            attributes,
            origin: Origin {
                kind: OriginType::Import,
                prediction_id: None,
                model_run_id: None,
                import_batch_id: Some(context.import_batch_id.clone()),
            },
        });
    }
    let document = import_document(context, ontology, objects)?;
    let mut losses = LossReport::default();
    if uses_attribute_defaults {
        losses.add(
            "attribute_defaults",
            "Object attributes are initialized from the fixed target ontology defaults, not source annotations",
        );
    }
    Ok(ImportReport {
        document,
        loss_report: losses,
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
