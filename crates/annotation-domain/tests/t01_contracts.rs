use std::collections::BTreeMap;

use annotation_domain::{
    object_hash, validate_document, AnnotationDocument, BBox, MediaRevision, OntologyVersion,
    SaveRequest, Scalar,
};
use serde::de::DeserializeOwned;
use sha2::Digest;

const DOCUMENT: &str = include_str!("../../../tests/fixtures/golden/document.json");
const ONTOLOGY: &str = include_str!("../../../tests/fixtures/golden/ontology.json");

fn golden() -> (AnnotationDocument, OntologyVersion) {
    (
        serde_json::from_str(DOCUMENT).unwrap(),
        serde_json::from_str(ONTOLOGY).unwrap(),
    )
}

fn assert_missing_field_rejected<T: DeserializeOwned>(value: &serde_json::Value, field: &str) {
    let mut omitted = value.clone();
    omitted.as_object_mut().unwrap().remove(field);
    assert!(
        serde_json::from_value::<T>(omitted).is_err(),
        "missing {field} was accepted"
    );
}

#[test]
fn golden_document_validates_roundtrips_and_excludes_display_flags() {
    let (document, ontology) = golden();
    validate_document(&document, &ontology).unwrap();
    let encoded = serde_json::to_value(&document).unwrap();
    assert_eq!(encoded["coordinate_space"]["width"], 640);
    assert_eq!(encoded["objects"][0]["geometry"]["x_min"], 10.0);
    assert!(encoded.get("hidden").is_none());
    assert!(encoded.get("locked").is_none());
    let back: AnnotationDocument = serde_json::from_value(encoded.clone()).unwrap();
    assert_eq!(serde_json::to_value(back).unwrap(), encoded);
}

#[test]
fn ontology_required_attributes_unknown_labels_and_duplicate_ids_are_rejected() {
    let (mut document, ontology) = golden();
    document.objects[0].attributes.clear();
    assert_eq!(
        validate_document(&document, &ontology).unwrap_err().code,
        "MISSING_REQUIRED_ATTRIBUTE"
    );

    let (mut document, ontology) = golden();
    document.objects[0].label_id = "unknown_label".into();
    assert_eq!(
        validate_document(&document, &ontology).unwrap_err().code,
        "UNKNOWN_LABEL"
    );

    let (mut document, ontology) = golden();
    document.objects.push(document.objects[0].clone());
    assert_eq!(
        validate_document(&document, &ontology).unwrap_err().code,
        "DUPLICATE_OBJECT_ID"
    );
}

#[test]
fn invalid_numbers_dimensions_and_bbox_are_rejected() {
    let (mut document, ontology) = golden();
    document.objects[0].geometry.x_max = f64::INFINITY;
    assert_eq!(
        validate_document(&document, &ontology).unwrap_err().code,
        "INVALID_GEOMETRY"
    );

    let (mut document, ontology) = golden();
    document.coordinate_space.width = 0;
    assert_eq!(
        validate_document(&document, &ontology).unwrap_err().code,
        "INVALID_DIMENSIONS"
    );

    let mut media: MediaRevision =
        serde_json::from_str(include_str!("../../../tests/fixtures/golden/media.json")).unwrap();
    media.original_to_canonical[2] = f64::NAN;
    assert_eq!(
        media.validate().unwrap_err().code,
        "INVALID_MEDIA_TRANSFORM"
    );
}

#[test]
fn all_nullable_wire_fields_are_present_as_null_and_roundtrip_with_save_journal() {
    let save: SaveRequest =
        serde_json::from_str(include_str!("../../../tests/fixtures/golden/save.json")).unwrap();
    assert!(save.lease.is_none());
    assert!(save.suggestion_decisions.is_empty());
    let serialized = serde_json::to_value(&save).unwrap();
    assert!(serialized
        .get("lease")
        .is_some_and(serde_json::Value::is_null));
    assert_eq!(serialized["suggestion_decisions"], serde_json::json!([]));

    let mut omitted: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/golden/document.json")).unwrap();
    omitted["objects"][0]["origin"]
        .as_object_mut()
        .unwrap()
        .remove("prediction_id");
    assert!(serde_json::from_value::<AnnotationDocument>(omitted).is_err());
    let mut omitted_lease: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/golden/save.json")).unwrap();
    omitted_lease.as_object_mut().unwrap().remove("lease");
    assert!(serde_json::from_value::<SaveRequest>(omitted_lease).is_err());

    let revision = serde_json::json!({
        "annotation_revision_id": "revision_v1",
        "parent_revision_id": null,
        "revision_no": 1,
        "document": serde_json::from_str::<AnnotationDocument>(DOCUMENT).unwrap(),
        "created_at": "2026-09-25T12:00:00Z",
        "created_by": "user_v1",
        "content_hash": "abc"
    });
    assert!(
        serde_json::from_value::<annotation_domain::AnnotationRevision>(revision.clone()).is_ok()
    );
    let mut omitted_parent = revision;
    omitted_parent
        .as_object_mut()
        .unwrap()
        .remove("parent_revision_id");
    assert!(
        serde_json::from_value::<annotation_domain::AnnotationRevision>(omitted_parent).is_err()
    );
}

#[test]
fn provider_fixture_matches_c4_and_ids_timestamps_and_sequences_are_bounded() {
    let prediction = include_str!("../../../tests/fixtures/golden/prediction.json");
    let suggestion: annotation_domain::SuggestionSet = serde_json::from_str(prediction).unwrap();
    assert_eq!(
        serde_json::to_value(suggestion).unwrap(),
        serde_json::from_str::<serde_json::Value>(prediction).unwrap()
    );
    assert!(serde_json::from_str::<AnnotationDocument>(include_str!(
        "../../../tests/fixtures/schema-invalid/nonfinite_number.json"
    ))
    .is_err());

    let mut invalid_id: serde_json::Value = serde_json::from_str(DOCUMENT).unwrap();
    invalid_id["asset_revision_id"] = serde_json::Value::String(String::new());
    assert!(serde_json::from_value::<AnnotationDocument>(invalid_id).is_err());
    let mut long_id: serde_json::Value = serde_json::from_str(DOCUMENT).unwrap();
    long_id["asset_revision_id"] = serde_json::Value::String("x".repeat(129));
    assert!(serde_json::from_value::<AnnotationDocument>(long_id).is_err());

    let event = serde_json::json!({"run_id":"run_1","seq":9_007_199_254_740_991_u64,"type":"progress","message":"","data":null});
    assert!(serde_json::from_value::<annotation_domain::RunEvent>(event.clone()).is_ok());
    let mut unsafe_sequence = event;
    unsafe_sequence["seq"] = serde_json::json!(9_007_199_254_740_992_u64);
    assert!(serde_json::from_value::<annotation_domain::RunEvent>(unsafe_sequence).is_err());

    let mut invalid_timestamp = serde_json::json!({
        "annotation_revision_id":"revision_v1","parent_revision_id":null,"revision_no":1,
        "document":serde_json::from_str::<AnnotationDocument>(DOCUMENT).unwrap(),
        "created_at":"2026-09-25T12:00:00+01:00","created_by":"user_v1","content_hash":"abc"
    });
    assert!(
        serde_json::from_value::<annotation_domain::AnnotationRevision>(invalid_timestamp.clone())
            .is_err()
    );
    invalid_timestamp["created_at"] = serde_json::json!("2026-09-25T12:00:00-00:00");
    assert!(
        serde_json::from_value::<annotation_domain::AnnotationRevision>(invalid_timestamp.clone())
            .is_err()
    );
    invalid_timestamp["created_at"] = serde_json::json!("2026-09-25T12:00:00");
    assert!(
        serde_json::from_value::<annotation_domain::AnnotationRevision>(invalid_timestamp).is_err()
    );
}

#[test]
fn invalid_schema_fixtures_are_rejected_by_deserialization_or_domain_validation() {
    let unknown_geometry =
        include_str!("../../../tests/fixtures/schema-invalid/unknown_geometry.json");
    assert!(serde_json::from_str::<BBox>(unknown_geometry).is_err());

    let omitted_option =
        include_str!("../../../tests/fixtures/schema-invalid/omitted_optional.json");
    assert!(serde_json::from_str::<annotation_domain::Origin>(omitted_option).is_err());

    let confirmed_negative: AnnotationDocument = serde_json::from_str(include_str!(
        "../../../tests/fixtures/schema-invalid/confirmed_negative_objects.json"
    ))
    .unwrap();
    assert_eq!(
        validate_document(&confirmed_negative, &golden().1)
            .unwrap_err()
            .code,
        "INVALID_COMPLETION"
    );

    let zero_dimensions: AnnotationDocument = serde_json::from_str(include_str!(
        "../../../tests/fixtures/schema-invalid/zero_dimensions.json"
    ))
    .unwrap();
    assert_eq!(
        validate_document(&zero_dimensions, &golden().1)
            .unwrap_err()
            .code,
        "INVALID_DIMENSIONS"
    );
}

#[test]
fn editor_commands_and_prediction_changes_use_snake_case_tags() {
    let command = serde_json::json!({
        "kind": "set_completion",
        "completion": "complete",
    });
    let parsed: annotation_domain::EditorCommand = serde_json::from_value(command.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), command);
    assert!(
        serde_json::from_value::<annotation_domain::EditorCommand>(serde_json::json!({
            "kind": "SetCompletion",
            "completion": "complete",
        }))
        .is_err()
    );

    let change = serde_json::json!({
        "kind": "set_attributes",
        "change_id": "change_1",
        "object_id": "object_1",
        "values": {"helmet_state": "wearing"},
        "before_hash": "hash",
        "reason": "fixture",
    });
    let parsed: annotation_domain::Change = serde_json::from_value(change.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), change);
    let mut unknown_kind = change;
    unknown_kind["kind"] = serde_json::json!("SetAttributes");
    assert!(serde_json::from_value::<annotation_domain::Change>(unknown_kind).is_err());
}

#[test]
fn object_hash_uses_fixed_canonical_projection_and_is_attribute_order_independent() {
    let (document, _) = golden();
    let object = &document.objects[0];
    // Independently specified canonical serialization; the expected digest is fixed.
    let canonical = r#"{"label_id":"label_person","geometry":{"type":"bbox_xyxy","x_min":10.0,"y_min":20.0,"x_max":110.0,"y_max":220.0},"attributes":{"helmet_state":"unknown"}}"#;
    assert_eq!(
        object_hash(object),
        "cf8d9a1c30ef6ee1dee2cb316eaa15d5e7f3fdced7fd1b9900a0cbb42bad6026"
    );
    let independently_hashed = format!("{:x}", sha2::Sha256::digest(canonical.as_bytes()));
    assert_eq!(object_hash(object), independently_hashed);

    let mut reordered = object.clone();
    reordered.attributes = BTreeMap::from([
        ("z".into(), Scalar::Boolean(true)),
        ("a".into(), Scalar::String("x".into())),
    ]);
    let mut reversed = reordered.clone();
    reversed.attributes = BTreeMap::from([
        ("a".into(), Scalar::String("x".into())),
        ("z".into(), Scalar::Boolean(true)),
    ]);
    assert_eq!(object_hash(&reordered), object_hash(&reversed));
    let baseline = object_hash(object);
    let mut changed = object.clone();
    changed.geometry = BBox::new(10.0, 20.0, 111.0, 220.0);
    assert_ne!(baseline, object_hash(&changed));
    changed = object.clone();
    changed.label_id = "label_other".into();
    assert_ne!(baseline, object_hash(&changed));
    changed = object.clone();
    changed
        .attributes
        .insert("helmet_state".into(), Scalar::String("wearing".into()));
    assert_ne!(baseline, object_hash(&changed));
}

#[test]
fn wire_integers_are_limited_to_javascript_safe_range() {
    let mut ontology: serde_json::Value = serde_json::from_str(ONTOLOGY).unwrap();
    ontology["version_no"] = serde_json::json!(9_007_199_254_740_991_u64);
    assert!(serde_json::from_value::<OntologyVersion>(ontology.clone()).is_ok());
    ontology["version_no"] = serde_json::json!(9_007_199_254_740_992_u64);
    assert!(serde_json::from_value::<OntologyVersion>(ontology).is_err());
}

#[test]
fn every_nullable_wire_field_rejects_omission() {
    let document: serde_json::Value = serde_json::from_str(DOCUMENT).unwrap();
    let origin = &document["objects"][0]["origin"];
    for field in ["prediction_id", "model_run_id", "import_batch_id"] {
        assert_missing_field_rejected::<annotation_domain::Origin>(origin, field);
    }

    let ontology: serde_json::Value = serde_json::from_str(ONTOLOGY).unwrap();
    assert_missing_field_rejected::<annotation_domain::LabelDef>(
        &ontology["labels"][0],
        "shortcut",
    );
    for field in ["min", "max"] {
        assert_missing_field_rejected::<annotation_domain::AttributeDef>(
            &ontology["labels"][0]["attributes"][0],
            field,
        );
    }

    let profile = serde_json::json!({
        "profile_id":"profile_1","provider_id":"codex_local","model_id":"model",
        "auth_kind":"official_user_login",
        "capabilities":{"image_input":false,"tools":false,"structured_output":false,"bbox_output":false,"attributes":false},
        "availability":"blocked","verification":"not_run","runtime_version":null,"verified_at":null
    });
    assert_missing_field_rejected::<annotation_domain::ModelProfile>(&profile, "runtime_version");
    assert_missing_field_rejected::<annotation_domain::ModelProfile>(&profile, "verified_at");

    let context = serde_json::json!({
        "project_id":"project_1","asset_revision_id":"asset_1","annotation_revision_id":"revision_1",
        "ontology_version_id":"ontology_1","draft_generation":0,"canonical_sha256":"hash",
        "selected_object_ids":[],"object_hashes":{},"input_fingerprint":"fingerprint"
    });
    let start_run = serde_json::json!({
        "operation_id":"operation_1","profile_id":"profile_1","context":context,
        "intent":"audit_attributes","prompt":"","consent_id":null
    });
    assert_missing_field_rejected::<annotation_domain::StartRunRequest>(&start_run, "consent_id");

    let change = serde_json::json!({
        "kind":"create","change_id":"change_1","object":document["objects"][0],
        "before_hash":null,"reason":"fixture"
    });
    assert_missing_field_rejected::<annotation_domain::Change>(&change, "before_hash");

    let issue = serde_json::json!({
        "issue_id":"issue_1","object_id":null,"code":"quality","message":"issue","region":null
    });
    assert_missing_field_rejected::<annotation_domain::QualityIssue>(&issue, "object_id");
    assert_missing_field_rejected::<annotation_domain::QualityIssue>(&issue, "region");

    let prediction: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/golden/prediction.json"
    ))
    .unwrap();
    assert_missing_field_rejected::<annotation_domain::SuggestionSet>(&prediction, "score");

    let event =
        serde_json::json!({"run_id":"run_1","seq":0,"type":"progress","message":"","data":null});
    assert_missing_field_rejected::<annotation_domain::RunEvent>(&event, "data");

    let error = serde_json::json!({"code":"INVALID","message":"invalid","request_id":"request_1","details":null});
    assert_missing_field_rejected::<annotation_domain::ApiError>(&error, "details");

    let delta = serde_json::json!({
        "generation":0,"changed_objects":[],"removed_object_ids":[],"selected_object_ids":[],
        "can_undo":false,"can_redo":false,"document_changed":false,"repaint":false,
        "suggestion_decisions":[],"error":null
    });
    assert_missing_field_rejected::<annotation_domain::EditorDelta>(&delta, "error");

    let mut nested = serde_json::json!("end");
    for _ in 0..16 {
        nested = serde_json::json!({"next": nested});
    }
    let deeply_nested_error = serde_json::json!({
        "code":"INVALID","message":"invalid","request_id":"request_1","details":{"nested":nested}
    });
    assert!(serde_json::from_value::<annotation_domain::ApiError>(deeply_nested_error).is_err());
}
