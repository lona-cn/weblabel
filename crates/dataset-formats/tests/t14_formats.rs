use std::io::{Cursor, Write};

use annotation_domain::{
    AnnotationDocument, AnnotationRevision, Id, MediaRevision, OntologyVersion,
};
use dataset_formats::{
    archive::{extract_safe_zip, ArchiveLimits},
    coco::{export_coco, import_coco},
    native::{export_native, import_native, NativeBundle},
    yolo::{export_yolo, import_yolo},
    ImportContext,
};
use serde_json::{json, Value};
use sha2::Digest;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn ontology() -> OntologyVersion {
    serde_json::from_value(json!({
        "ontology_version_id":"ontology-1",
        "project_id":"project-1",
        "version_no":1,
        "labels":[
            {"label_id":"car","name":"Car","color":"#f00","shortcut":null,"allowed_geometry_types":["bbox_xyxy"],"attributes":[{"key":"paint","kind":"text","required":false,"default_value":null,"enum_values":[],"min":null,"max":null}]},
            {"label_id":"truck","name":"Truck","color":"#0f0","shortcut":null,"allowed_geometry_types":["bbox_xyxy"],"attributes":[]}
        ],
        "guidelines_markdown":"",
        "allow_out_of_bounds":false
    })).unwrap()
}

fn document() -> AnnotationDocument {
    serde_json::from_value(json!({
        "schema_version":1,
        "asset_revision_id":"asset-revision-1",
        "ontology_version_id":"ontology-1",
        "coordinate_space":{"type":"canonical_image_pixels","width":640,"height":480},
        "completion":"complete",
        "objects":[{
            "object_id":"object-1",
            "label_id":"car",
            "geometry":{"type":"bbox_xyxy","x_min":10.0,"y_min":20.0,"x_max":110.0,"y_max":220.0},
            "attributes":{"paint":"red"},
            "origin":{"type":"manual","prediction_id":null,"model_run_id":null,"import_batch_id":null}
        }]
    })).unwrap()
}

fn import_context(batch: &str) -> ImportContext {
    ImportContext {
        asset_revision_id: Id::from("asset-revision-1"),
        import_batch_id: Id::from(batch),
        width: 640,
        height: 480,
        source_image_id: None,
    }
}

fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    for (name, bytes) in entries {
        writer
            .start_file(
                *name,
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[test]
fn yolo_export_import_uses_continuous_pixel_coordinates_and_reports_losses() {
    let ontology = ontology();
    let document = document();
    let exported = export_yolo(&document, &ontology).unwrap();
    let values = exported
        .annotations
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .map(|value| value.parse::<f64>().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(values[0], 0.0);
    assert!((values[1] - 0.09375).abs() < 1e-15);
    assert!((values[2] - 0.25).abs() < 1e-15);
    assert!((values[3] - 0.15625).abs() < 1e-15);
    assert!((values[4] - 0.4166666666666667).abs() < 1e-15);
    assert!(exported.loss_report.requires_ack());
    assert!(exported.loss_report.contains("attributes"));

    let imported = import_yolo(
        &exported.annotations,
        &exported.label_ids,
        &import_context("batch-yolo"),
        &ontology,
    )
    .unwrap();
    let bbox = &imported.document.objects[0].geometry;
    assert!((bbox.x_min - 10.0).abs() <= 1e-6);
    assert!((bbox.y_min - 20.0).abs() <= 1e-6);
    assert!((bbox.x_max - 110.0).abs() <= 1e-6);
    assert!((bbox.y_max - 220.0).abs() <= 1e-6);
    assert_eq!(imported.document.objects[0].label_id, Id::from("car"));
    assert_eq!(
        imported.document.objects[0].origin.import_batch_id,
        Some(Id::from("batch-yolo"))
    );
}

#[test]
fn yolo_tiny_boxes_preserve_normalized_f64_and_positive_roundtrip_sizes() {
    let ontology = ontology();
    for size in [1e-16, 1e-300, 1e-306] {
        let mut document = document();
        let geometry = &mut document.objects[0].geometry;
        geometry.x_min = 0.0;
        geometry.y_min = 0.0;
        geometry.x_max = size;
        geometry.y_max = size;
        let exported = export_yolo(&document, &ontology).unwrap();
        let values: Vec<f64> = exported
            .annotations
            .split_whitespace()
            .skip(1)
            .map(|token| token.parse().unwrap())
            .collect();
        assert_eq!(
            values,
            [
                size / (2.0 * 640.0),
                size / (2.0 * 480.0),
                size / 640.0,
                size / 480.0
            ]
        );
        assert!(values[2] > 0.0 && values[3] > 0.0);
        if size == 1e-306 {
            assert!(values.iter().all(|value| value.is_subnormal()));
        }
        let imported = import_yolo(
            &exported.annotations,
            &exported.label_ids,
            &import_context("tiny-roundtrip"),
            &ontology,
        )
        .unwrap();
        let bbox = &imported.document.objects[0].geometry;
        for recovered_size in [bbox.x_max - bbox.x_min, bbox.y_max - bbox.y_min] {
            assert!(recovered_size > 0.0);
            assert!(((recovered_size - size) / size).abs() <= 1e-14);
        }
    }
}

#[test]
fn empty_yolo_import_remains_unprocessed_and_export_zip_names_are_portable() {
    let ontology = ontology();
    let imported = import_yolo(
        "",
        &[Id::from("car")],
        &import_context("batch-empty"),
        &ontology,
    )
    .unwrap();
    assert!(imported.document.objects.is_empty());
    assert_eq!(
        imported.document.completion,
        annotation_domain::Completion::Unprocessed
    );

    let archive = dataset_formats::archive::create_safe_zip(
        &[
            ("labels.txt".to_owned(), b"0 0.5 0.5 0.5 0.5\n".to_vec()),
            ("label_ids.json".to_owned(), br#"["car"]"#.to_vec()),
        ],
        &ArchiveLimits::default(),
    )
    .unwrap();
    let files = extract_safe_zip(&archive, &ArchiveLimits::default()).unwrap();
    assert_eq!(files["label_ids.json"], br#"["car"]"#);
    assert_eq!(files["labels.txt"], b"0 0.5 0.5 0.5 0.5\n");
}

#[test]
fn coco_import_maps_sparse_category_ids_by_id_not_array_position() {
    let ontology = ontology();
    let input = json!({
        "images":[{"id":17,"file_name":"unmatched.png","width":640,"height":480}],
        "categories":[
            {"id":90,"name":"Car","label_id":"car","attributes":{"paint":"red"}},
            {"id":7,"name":"Truck","label_id":"truck"}
        ],
        "annotations":[
            {"id":1,"image_id":17,"category_id":7,"bbox":[10.0,20.0,100.0,200.0],"iscrowd":0,"segmentation":[[10.0,20.0,110.0,20.0,110.0,220.0,10.0,220.0]]},
            {"id":2,"image_id":17,"category_id":90,"bbox":[1.0,2.0,3.0,4.0],"iscrowd":0}
        ]
    });
    let imported = import_coco(
        &serde_json::to_vec(&input).unwrap(),
        &import_context("batch-coco"),
        &ontology,
    )
    .unwrap();
    assert_eq!(imported.document.objects[0].label_id, Id::from("truck"));
    assert_eq!(imported.document.objects[1].label_id, Id::from("car"));
    assert_eq!(
        imported.document.completion,
        annotation_domain::Completion::InProgress
    );
    assert!(imported.loss_report.requires_ack());
    assert!(imported.loss_report.contains("unsupported_fields"));
}
#[test]
fn coco_requires_explicit_category_mapping_even_for_unique_names() {
    let input = json!({
        "images":[{"id":1,"file_name":"same-name.png","width":640,"height":480}],
        "categories":[{"id":700,"name":"Car"}],
        "annotations":[]
    });
    assert!(import_coco(
        &serde_json::to_vec(&input).unwrap(),
        &import_context("batch-coco-unmapped"),
        &ontology()
    )
    .is_err());
}
#[test]
fn coco_requires_explicit_image_id_for_same_named_multiple_images() {
    let ontology = ontology();
    let input = json!({
        "images":[
            {"id":4,"file_name":"same.png","width":640,"height":480},
            {"id":19,"file_name":"same.png","width":640,"height":480}
        ],
        "categories":[{"id":400,"name":"Car","label_id":"car"}],
        "annotations":[
            {"id":1,"image_id":4,"category_id":400,"bbox":[1.0,2.0,3.0,4.0]},
            {"id":2,"image_id":19,"category_id":400,"bbox":[10.0,20.0,30.0,40.0]}
        ]
    });
    let bytes = serde_json::to_vec(&input).unwrap();
    assert!(import_coco(&bytes, &import_context("batch-coco-ambiguous"), &ontology).is_err());

    let mut context = import_context("batch-coco-explicit");
    context.source_image_id = Some(19);
    let imported = import_coco(&bytes, &context, &ontology).unwrap();
    assert_eq!(imported.document.objects.len(), 1);
    assert_eq!(imported.document.objects[0].geometry.x_min, 10.0);
    assert!(imported.loss_report.contains("other_images"));
}

#[test]
fn native_export_roundtrips_provenance_and_binds_canonical_image_hash() {
    let document = document();
    let ontology = ontology();
    let canonical_image = b"canonical png test bytes".to_vec();
    let media_revision: MediaRevision = serde_json::from_value(json!({
        "asset_id":"asset-1",
        "asset_revision_id":"asset-revision-1",
        "project_id":"project-1",
        "original_name":"sample.png",
        "original_sha256":"a".repeat(64),
        "canonical_sha256":format!("{:x}", sha2::Sha256::digest(&canonical_image)),
        "canonical_width":640,
        "canonical_height":480,
        "exif_orientation":1,
        "original_to_canonical":[1.0,0.0,0.0,0.0,1.0,0.0,0.0,0.0,1.0],
        "source_group_id":"source-group"
    }))
    .unwrap();
    let content_hash = annotation_domain::hash::serialize_document(&document)
        .unwrap()
        .content_hash;
    let revision: AnnotationRevision = serde_json::from_value(json!({
        "annotation_revision_id":"revision-1",
        "parent_revision_id":null,
        "revision_no":1,
        "document":document.clone(),
        "created_at":"2026-01-01T00:00:00Z",
        "created_by":"user-1",
        "content_hash":content_hash
    }))
    .unwrap();
    let bundle = NativeBundle {
        media_revision,
        ontology,
        revision,
        canonical_image: canonical_image.clone(),
    };
    let archive = export_native(&bundle).unwrap();
    let imported = import_native(&archive, &ArchiveLimits::default()).unwrap();
    assert_eq!(imported.revision, bundle.revision);
    assert_eq!(imported.ontology, bundle.ontology);
    assert_eq!(imported.canonical_image, canonical_image);
    assert!(!serde_json::to_string(&imported).unwrap().contains("C:\\"));

    // A native snapshot owns its existing values and omissions, not target defaults.
    let mut historical = bundle.clone();
    historical.ontology.labels[0].attributes[0].default_value =
        annotation_domain::Scalar::String("blue".to_owned());
    let preserved = import_native(
        &export_native(&historical).unwrap(),
        &ArchiveLimits::default(),
    )
    .unwrap();
    assert_eq!(
        preserved.revision.document.objects[0].attributes,
        historical.revision.document.objects[0].attributes
    );
    historical.revision.document.objects[0].attributes.clear();
    historical.revision.content_hash =
        annotation_domain::hash::serialize_document(&historical.revision.document)
            .unwrap()
            .content_hash;
    let optional_archive = export_native(&historical).unwrap();
    assert!(import_native(&optional_archive, &ArchiveLimits::default())
        .unwrap()
        .revision
        .document
        .objects[0]
        .attributes
        .is_empty());
    let files = extract_safe_zip(&optional_archive, &ArchiveLimits::default()).unwrap();
    let mut manifest: Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
    manifest["ontology"]["labels"][0]["attributes"][0]["required"] = json!(true);
    let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
    let invalid_archive = make_zip(&[
        ("manifest.json", &manifest_bytes),
        ("canonical.png", &files["canonical.png"]),
    ]);
    assert!(matches!(
        import_native(&invalid_archive, &ArchiveLimits::default()),
        Err(dataset_formats::FormatError::Invalid(_))
    ));
}

#[test]
fn zip_reader_rejects_traversal_drive_paths_casefold_duplicates_symlinks_and_bombs() {
    let limits = ArchiveLimits {
        max_entries: 8,
        max_uncompressed_bytes: 8,
    };
    for name in [
        "../escape.txt",
        "/absolute.txt",
        "C:/drive.txt",
        "folder\\escape.txt",
    ] {
        let archive = make_zip(&[(name, b"x")]);
        assert!(
            extract_safe_zip(&archive, &limits).is_err(),
            "accepted {name}"
        );
    }
    let duplicate = make_zip(&[("Labels/Car.txt", b"1"), ("labels/car.TXT", b"2")]);
    assert!(extract_safe_zip(&duplicate, &limits).is_err());
    let unicode_casefold_collision = make_zip(&[("straße.txt", b"1"), ("strasse.txt", b"2")]);
    assert!(extract_safe_zip(&unicode_casefold_collision, &limits).is_err());
    let too_many = make_zip(&[("a", b"1"), ("b", b"2"), ("c", b"3")]);
    let tight = ArchiveLimits {
        max_entries: 2,
        max_uncompressed_bytes: 8,
    };
    assert!(extract_safe_zip(&too_many, &tight).is_err());
    let oversized = make_zip(&[("large", b"123456789")]);
    assert!(extract_safe_zip(&oversized, &limits).is_err());

    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .add_symlink("link.txt", "target.txt", SimpleFileOptions::default())
        .unwrap();
    let symlink = writer.finish().unwrap().into_inner();
    assert!(extract_safe_zip(&symlink, &limits).is_err());
}

#[test]
fn coco_export_reports_information_loss_and_uses_bbox_area_semantics() {
    let ontology = ontology();
    let exported = export_coco(&document(), &ontology, "canonical.png").unwrap();
    let value: Value = serde_json::from_slice(&exported.json).unwrap();
    assert_eq!(
        value["annotations"][0]["bbox"],
        json!([10.0, 20.0, 100.0, 200.0])
    );
    assert_eq!(value["annotations"][0]["area"], json!(20_000.0));
    assert_eq!(value["annotations"][0]["iscrowd"], json!(0));
    assert!(exported.loss_report.requires_ack());
    assert!(exported.loss_report.contains("attributes"));
}

fn external_default_ontology() -> OntologyVersion {
    let mut value = serde_json::to_value(ontology()).unwrap();
    let mut attrs = vec![
        json!({"key":"category","kind":"enum","required":true,"default_value":"ready","enum_values":["ready","other"],"min":null,"max":null}),
        json!({"key":"verified","kind":"boolean","required":false,"default_value":false,"enum_values":[],"min":null,"max":null}),
        json!({"key":"confidence","kind":"number","required":true,"default_value":2.5,"enum_values":[],"min":0,"max":3}),
        json!({"key":"note","kind":"text","required":false,"default_value":"target only","enum_values":[],"min":null,"max":null}),
    ];
    for kind in ["enum", "boolean", "number", "text"] {
        attrs.push(json!({"key":format!("null_{kind}"),"kind":kind,"required":true,"default_value":null,"enum_values":if kind == "enum" { vec!["ready"] } else { vec![] },"min":null,"max":null}));
    }
    value["labels"][0]["attributes"] = json!(attrs);
    value["labels"][1]["attributes"] = json!([
        {"key":"note","kind":"text","required":true,"default_value":"truck default","enum_values":[],"min":null,"max":null}
    ]);
    value["labels"].as_array_mut().unwrap().push(json!({"label_id":"bare","name":"Bare","color":"#00f","shortcut":null,"allowed_geometry_types":["bbox_xyxy"],"attributes":[]}));
    value["labels"].as_array_mut().unwrap().swap(0, 1);
    serde_json::from_value(value).unwrap()
}

fn expected_car_defaults() -> Value {
    json!({"category":"ready","verified":false,"confidence":2.5,"note":"target only","null_enum":null,"null_boolean":null,"null_number":null,"null_text":null})
}

#[test]
fn external_coco_initializes_target_defaults_and_preserves_selected_source_identity() {
    let ontology = external_default_ontology();
    let input = json!({
        "images":[{"id":4,"file_name":"same.png","width":640,"height":480},{"id":19,"file_name":"same.png","width":640,"height":480}],
        "categories":[{"id":900,"name":"Truck","label_id":"truck"},{"id":7,"name":"Car","label_id":"car"},{"id":80,"name":"Bare","label_id":"bare"}],
        "annotations":[
            {"id":1,"image_id":4,"category_id":7,"bbox":[1,2,3,4]},
            {"id":61,"image_id":19,"category_id":7,"bbox":[10.5,20.25,100,200]},
            {"id":62,"image_id":19,"category_id":900,"bbox":[30,40,20,10]},
            {"id":63,"image_id":19,"category_id":80,"bbox":[50,60,10,10]}
        ]
    });
    let bytes = serde_json::to_vec(&input).unwrap();
    let mut context = import_context("batch-defaults");
    context.source_image_id = Some(19);
    let report = import_coco(&bytes, &context, &ontology).unwrap();
    assert_eq!(report.document.objects.len(), 3);
    assert_eq!(report.document.asset_revision_id, context.asset_revision_id);
    assert_eq!(
        report.document.ontology_version_id,
        ontology.ontology_version_id
    );
    let objects = &report.document.objects;
    assert_eq!(
        serde_json::to_value(&objects[0].attributes).unwrap(),
        expected_car_defaults()
    );
    assert_eq!(
        serde_json::to_value(&objects[1].attributes).unwrap(),
        json!({"note":"truck default"})
    );
    assert!(objects[2].attributes.is_empty());
    assert_eq!(
        objects
            .iter()
            .map(|object| &*object.label_id)
            .collect::<Vec<_>>(),
        vec!["car", "truck", "bare"]
    );
    assert_eq!(
        objects[0].geometry,
        annotation_domain::BBox::new(10.5, 20.25, 110.5, 220.25)
    );
    for (object, source_id) in objects.iter().zip([61, 62, 63]) {
        let identity = format!("asset-revision-1:batch-defaults:coco:{source_id}");
        assert_eq!(
            object.object_id,
            Id::from(
                uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, identity.as_bytes()).to_string()
            )
        );
        assert_eq!(object.origin.kind, annotation_domain::OriginType::Import);
        assert_eq!(
            object.origin.import_batch_id,
            Some(context.import_batch_id.clone())
        );
        assert_eq!(object.origin.model_run_id, None);
        assert_eq!(object.origin.prediction_id, None);
    }
    assert!(report.loss_report.requires_ack());
    assert!(report.loss_report.contains("attribute_defaults"));
    assert!(report.loss_report.contains("other_images"));
}

#[test]
fn external_yolo_initializes_only_mapped_target_defaults_and_preserves_rows() {
    let ontology = external_default_ontology();
    let annotations =
        "0 0.09375 0.25 0.15625 0.4166666666666667\n1 0.5 0.5 0.125 0.25\n2 0.5 0.5 0.125 0.25\n";
    let context = import_context("batch-yolo-defaults");
    let report = import_yolo(
        annotations,
        &[Id::from("car"), Id::from("truck"), Id::from("bare")],
        &context,
        &ontology,
    )
    .unwrap();
    let objects = &report.document.objects;
    assert_eq!(objects.len(), 3);
    assert_eq!(
        serde_json::to_value(&objects[0].attributes).unwrap(),
        expected_car_defaults()
    );
    assert_eq!(
        serde_json::to_value(&objects[1].attributes).unwrap(),
        json!({"note":"truck default"})
    );
    assert!(objects[2].attributes.is_empty());
    assert_eq!(
        objects
            .iter()
            .map(|object| &*object.label_id)
            .collect::<Vec<_>>(),
        vec!["car", "truck", "bare"]
    );
    let bbox = &objects[0].geometry;
    for (actual, expected) in [
        (bbox.x_min, 10.0),
        (bbox.y_min, 20.0),
        (bbox.x_max, 110.0),
        (bbox.y_max, 220.0),
    ] {
        assert!((actual - expected).abs() <= 1e-6);
    }
    for (line_index, (object, line)) in objects.iter().zip(annotations.lines()).enumerate() {
        let identity = format!("asset-revision-1:batch-yolo-defaults:yolo:{line_index}:{line}");
        assert_eq!(
            object.object_id,
            Id::from(
                uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, identity.as_bytes()).to_string()
            )
        );
        assert_eq!(
            object.origin.import_batch_id,
            Some(context.import_batch_id.clone())
        );
        assert_eq!(object.origin.kind, annotation_domain::OriginType::Import);
    }
    assert!(report.loss_report.requires_ack());
    assert!(report.loss_report.contains("attribute_defaults"));
}

#[test]
fn external_import_without_used_target_attributes_does_not_invent_default_loss() {
    let ontology = external_default_ontology();
    let context = import_context("batch-bare");
    let coco = json!({"images":[{"id":1,"file_name":"bare.png","width":640,"height":480}],"categories":[{"id":80,"name":"Bare","label_id":"bare"}],"annotations":[{"id":1,"image_id":1,"category_id":80,"bbox":[10,20,30,40]}]});
    let coco_report =
        import_coco(&serde_json::to_vec(&coco).unwrap(), &context, &ontology).unwrap();
    let yolo_report = import_yolo(
        "0 0.5 0.5 0.125 0.25",
        &[Id::from("bare")],
        &context,
        &ontology,
    )
    .unwrap();
    for report in [coco_report, yolo_report] {
        assert!(report.document.objects[0].attributes.is_empty());
        assert!(!report.loss_report.requires_ack());
    }
    let empty = import_yolo("", &[Id::from("car")], &context, &ontology).unwrap();
    assert_eq!(
        empty.document.completion,
        annotation_domain::Completion::Unprocessed
    );
    assert!(!empty.loss_report.requires_ack());
}

#[test]
fn external_defaults_do_not_relax_ontology_defaults_or_geometry_validation() {
    let valid = external_default_ontology();
    let context = import_context("batch-invalid-defaults");
    let coco = |bbox: Value| {
        serde_json::to_vec(&json!({"images":[{"id":1,"file_name":"test.png","width":640,"height":480}],"categories":[{"id":7,"name":"Car","label_id":"car"}],"annotations":[{"id":1,"image_id":1,"category_id":7,"bbox":bbox}]})).unwrap()
    };
    for (key, value) in [
        (
            "category",
            annotation_domain::Scalar::String("not-allowed".to_owned()),
        ),
        ("confidence", annotation_domain::Scalar::Number(4.0)),
    ] {
        let mut invalid = valid.clone();
        let label = invalid
            .labels
            .iter_mut()
            .find(|label| &*label.label_id == "car")
            .unwrap();
        label
            .attributes
            .iter_mut()
            .find(|attr| attr.key == key)
            .unwrap()
            .default_value = value;
        assert!(matches!(
            import_coco(&coco(json!([10, 20, 30, 40])), &context, &invalid),
            Err(dataset_formats::FormatError::Invalid(_))
        ));
        assert!(matches!(
            import_yolo(
                "0 0.5 0.5 0.125 0.25",
                &[Id::from("car")],
                &context,
                &invalid
            ),
            Err(dataset_formats::FormatError::Invalid(_))
        ));
    }
    assert!(import_coco(&coco(json!([630, 20, 30, 40])), &context, &valid).is_err());
    assert!(import_yolo("0 1.0 0.5 0.125 0.25", &[Id::from("car")], &context, &valid).is_err());
}

#[test]
fn unselected_coco_objects_do_not_trigger_target_default_loss() {
    let ontology = external_default_ontology();
    let input = json!({
        "images":[{"id":4,"file_name":"same.png","width":640,"height":480},{"id":19,"file_name":"same.png","width":640,"height":480}],
        "categories":[{"id":7,"name":"Car","label_id":"car"},{"id":80,"name":"Bare","label_id":"bare"}],
        "annotations":[{"id":1,"image_id":4,"category_id":7,"bbox":[1,2,3,4]},{"id":2,"image_id":19,"category_id":80,"bbox":[10,20,30,40]}]
    });
    let mut context = import_context("batch-unselected-defaults");
    context.source_image_id = Some(19);
    let report = import_coco(&serde_json::to_vec(&input).unwrap(), &context, &ontology).unwrap();
    assert_eq!(report.document.objects.len(), 1);
    assert_eq!(report.document.objects[0].label_id, Id::from("bare"));
    assert!(report.document.objects[0].attributes.is_empty());
    assert!(!report.loss_report.contains("attribute_defaults"));
    assert!(report.loss_report.contains("other_images"));
}

#[test]
fn yolo_rejects_positive_boxes_whose_normalized_extent_underflows() {
    for (x_max, y_max) in [(f64::from_bits(1), 1.0), (1.0, f64::from_bits(1))] {
        let mut document = document();
        let bbox = &mut document.objects[0].geometry;
        bbox.x_min = 0.0;
        bbox.y_min = 0.0;
        bbox.x_max = x_max;
        bbox.y_max = y_max;
        assert!(matches!(
            export_yolo(&document, &ontology()),
            Err(dataset_formats::FormatError::Unsupported(_))
        ));
    }
}

#[test]
fn yolo_ordinary_and_edge_boxes_preserve_all_normalized_values() {
    let ontology = ontology();
    for coordinates in [
        [10.0, 20.0, 110.0, 220.0],
        [0.0, 0.0, 640.0, 480.0],
        [639.25, 479.5, 640.0, 480.0],
    ] {
        let [x_min, y_min, x_max, y_max] = coordinates;
        let mut document = document();
        let bbox = &mut document.objects[0].geometry;
        bbox.x_min = x_min;
        bbox.y_min = y_min;
        bbox.x_max = x_max;
        bbox.y_max = y_max;
        let exported = export_yolo(&document, &ontology).unwrap();
        let values: Vec<f64> = exported
            .annotations
            .split_whitespace()
            .skip(1)
            .map(|token| token.parse().unwrap())
            .collect();
        assert_eq!(
            values,
            [
                (x_min + x_max) / (2.0 * 640.0),
                (y_min + y_max) / (2.0 * 480.0),
                (x_max - x_min) / 640.0,
                (y_max - y_min) / 480.0
            ]
        );
        let imported = import_yolo(
            &exported.annotations,
            &exported.label_ids,
            &import_context("edge-roundtrip"),
            &ontology,
        )
        .unwrap();
        let recovered = &imported.document.objects[0].geometry;
        for (actual, expected) in [
            recovered.x_min,
            recovered.y_min,
            recovered.x_max,
            recovered.y_max,
        ]
        .into_iter()
        .zip(coordinates)
        {
            assert!((actual - expected).abs() <= 1e-6);
        }
    }
}
