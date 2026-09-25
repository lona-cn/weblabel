//! T19: candidate validation, atomic acceptance and reversible provenance.
//!
//! Every test drives the real editor kernel or the shared domain validator:
//! untrusted candidate output must be validated against the pinned ontology,
//! object hashes and capability gates before anything touches the document,
//! an acceptance is one atomic undo unit, and accept/undo/redo keep the source
//! prediction and emit ordered accept/revert decision intents.

use annotation_domain::{
    object_hash,
    suggestion_validation::{validate_suggestions, AcceptanceContext, RunGate},
    AnnotationDocument, AnnotationObject, Attrs, BBox, Change, EditorCommand, Id,
    ModelCapabilities, OntologyVersion, Origin, OriginType, ProviderId, RunIntent, Scalar,
    SuggestionDecision, SuggestionDecisionIntent, SuggestionSet,
};
use editor_core::{suggestions, Editor, Selection};
use serde_json::{json, Value};

fn document() -> AnnotationDocument {
    serde_json::from_str(include_str!("../../../tests/fixtures/golden/document.json")).unwrap()
}

fn ontology() -> OntologyVersion {
    serde_json::from_str(include_str!("../../../tests/fixtures/golden/ontology.json")).unwrap()
}

fn golden_set() -> SuggestionSet {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/golden/prediction.json"
    ))
    .unwrap()
}

fn editor() -> Editor {
    Editor::new(document(), ontology()).unwrap()
}

fn person() -> Id {
    Id::from("object_person_001")
}

fn value(document: &AnnotationDocument) -> Value {
    serde_json::to_value(document).unwrap()
}

fn origin(prediction_id: &str, model_run_id: &str) -> Origin {
    Origin {
        kind: OriginType::Prediction,
        prediction_id: Some(Id::from(prediction_id)),
        model_run_id: Some(Id::from(model_run_id)),
        import_batch_id: None,
    }
}

/// Builds a suggestion set over the golden asset whose context matches the
/// golden document; `changes` is the wire `changes` array.
fn set_with_changes(changes: Value) -> SuggestionSet {
    set_with_context(
        changes,
        "revision_golden",
        "asset_revision_golden",
        "ontology_v1",
    )
}

fn set_with_context(
    changes: Value,
    annotation_revision_id: &str,
    asset_revision_id: &str,
    ontology_version_id: &str,
) -> SuggestionSet {
    serde_json::from_value(json!({
        "suggestion_set_id": "suggestion_test",
        "model_run_id": "run_test",
        "prediction_id": "prediction_test",
        "context": {
            "project_id": "project_golden",
            "asset_revision_id": asset_revision_id,
            "annotation_revision_id": annotation_revision_id,
            "ontology_version_id": ontology_version_id,
            "draft_generation": 0,
            "canonical_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "selected_object_ids": ["object_person_001"],
            "object_hashes": {},
            "input_fingerprint": "fingerprint_test"
        },
        "changes": changes,
        "issues": [],
        "score": null,
        "state": "pending"
    }))
    .unwrap()
}

fn set_attributes_change(change_id: &str, before_hash: &str) -> Value {
    json!({
        "kind": "set_attributes",
        "change_id": change_id,
        "object_id": "object_person_001",
        "values": {"helmet_state": "wearing"},
        "before_hash": before_hash,
        "reason": "helmet audit"
    })
}

fn create_change(change_id: &str, object_id: &str) -> Value {
    json!({
        "kind": "create",
        "change_id": change_id,
        "object": {
            "object_id": object_id,
            "label_id": "label_person",
            "geometry": {"type": "bbox_xyxy", "x_min": 120.0, "y_min": 20.0, "x_max": 180.0, "y_max": 80.0},
            "attributes": {"helmet_state": "unknown"},
            "origin": {"type": "prediction", "prediction_id": "prediction_test", "model_run_id": "run_test", "import_batch_id": null}
        },
        "before_hash": null,
        "reason": "detector candidate"
    })
}

/// The hash of `object_person_001` in its pre-edit state: the "old" suggestion
/// sets in these tests are computed against this hash.
fn original_hash() -> String {
    object_hash(&document().objects[0])
}

fn ids(list: &[&str]) -> Vec<Id> {
    list.iter().map(|id| Id::from(*id)).collect()
}

fn capabilities(bbox_output: bool, attributes: bool) -> ModelCapabilities {
    ModelCapabilities {
        image_input: true,
        tools: false,
        structured_output: true,
        bbox_output,
        attributes,
    }
}

fn numeric_ontology() -> OntologyVersion {
    serde_json::from_value(json!({
        "ontology_version_id": "ontology_v1",
        "project_id": "project_golden",
        "version_no": 1,
        "labels": [{
            "label_id": "label_person",
            "name": "person",
            "color": "#3366ff",
            "shortcut": null,
            "allowed_geometry_types": ["bbox_xyxy"],
            "attributes": [
                {"key": "helmet_state", "kind": "enum", "required": true, "default_value": "unknown",
                 "enum_values": ["wearing", "not_wearing", "unknown"], "min": null, "max": null},
                {"key": "confidence", "kind": "number", "required": false, "default_value": null,
                 "enum_values": [], "min": 0.0, "max": 1.0}
            ]
        }],
        "guidelines_markdown": "numeric attribute fixture",
        "allow_out_of_bounds": false
    }))
    .unwrap()
}

fn typed_set(changes: Vec<Change>) -> SuggestionSet {
    SuggestionSet {
        suggestion_set_id: Id::from("suggestion_test"),
        model_run_id: Id::from("run_test"),
        prediction_id: Id::from("prediction_test"),
        context: serde_json::from_value(json!({
            "project_id": "project_golden",
            "asset_revision_id": "asset_revision_golden",
            "annotation_revision_id": "revision_golden",
            "ontology_version_id": "ontology_v1",
            "draft_generation": 0,
            "canonical_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "selected_object_ids": ["object_person_001"],
            "object_hashes": {},
            "input_fingerprint": "fingerprint_test"
        }))
        .unwrap(),
        changes,
        issues: Vec::new(),
        score: None,
        state: annotation_domain::SuggestionState::Pending,
    }
}

fn typed_attrs(pairs: Vec<(&str, Scalar)>) -> Attrs {
    pairs
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

// 1. Stale detection: any mismatch leaves the document untouched.

#[test]
fn stale_object_hash_rejects_old_set_without_touching_document_or_history() {
    let mut editor = editor();
    let before_all = value(&editor.snapshot());
    let old_hash = original_hash();
    // Arrange: edit object_person_001 so its object_hash changes.
    editor
        .dispatch(EditorCommand::SetAttributes {
            object_ids: vec![person()],
            values: typed_attrs(vec![(
                "helmet_state",
                Scalar::String("not_wearing".to_owned()),
            )]),
        })
        .unwrap();
    assert_eq!(editor.generation(), 1);

    // The old suggestion set was computed against the pre-edit object hash.
    let set = set_with_changes(json!([set_attributes_change("change_old", &old_hash)]));
    let before = value(&editor.snapshot());
    let result = editor.dispatch(EditorCommand::ApplySuggestions {
        set,
        change_ids: ids(&["change_old"]),
        expected_generation: editor.generation(),
    });
    let error = result.err().expect("stale set must be rejected");
    assert_eq!(error.code, "STALE_OBJECT", "{error}");
    assert_eq!(serde_json::to_value(editor.snapshot()).unwrap(), before);
    assert_eq!(
        editor.generation(),
        1,
        "rejected input must not advance generation"
    );

    // history length did not grow: exactly the one edit entry remains.
    editor.dispatch(EditorCommand::Undo).unwrap();
    assert_eq!(serde_json::to_value(editor.snapshot()).unwrap(), before_all);
    assert!(!editor.can_undo());
}

#[test]
fn stale_generation_rejects_without_touching_document() {
    let mut editor = editor();
    let set = set_with_changes(json!([set_attributes_change(
        "change_gen",
        &original_hash()
    )]));
    let before = value(&editor.snapshot());
    let result = editor.dispatch(EditorCommand::ApplySuggestions {
        set,
        change_ids: ids(&["change_gen"]),
        expected_generation: editor.generation() + 1,
    });
    let error = result.err().expect("wrong generation must be rejected");
    assert_eq!(error.code, "STALE_GENERATION", "{error}");
    assert_eq!(serde_json::to_value(editor.snapshot()).unwrap(), before);
    assert_eq!(editor.generation(), 0);
    assert!(!editor.can_undo());
}

#[test]
fn stale_asset_and_ontology_pins_reject_without_touching_document() {
    let mut editor = editor();
    let before = value(&editor.snapshot());

    let set = set_with_context(
        json!([set_attributes_change("change_asset", &original_hash())]),
        "revision_golden",
        "asset_revision_other",
        "ontology_v1",
    );
    let error = editor
        .dispatch(EditorCommand::ApplySuggestions {
            set,
            change_ids: ids(&["change_asset"]),
            expected_generation: 0,
        })
        .err()
        .expect("foreign asset must be rejected");
    assert_eq!(error.code, "STALE_ASSET", "{error}");

    let set = set_with_context(
        json!([set_attributes_change("change_ontology", &original_hash())]),
        "revision_golden",
        "asset_revision_golden",
        "ontology_other",
    );
    let error = editor
        .dispatch(EditorCommand::ApplySuggestions {
            set,
            change_ids: ids(&["change_ontology"]),
            expected_generation: 0,
        })
        .err()
        .expect("foreign ontology must be rejected");
    assert_eq!(error.code, "STALE_ONTOLOGY", "{error}");

    assert_eq!(serde_json::to_value(editor.snapshot()).unwrap(), before);
    assert_eq!(editor.generation(), 0);
    assert!(!editor.can_undo());
}

#[test]
fn stale_base_revision_and_canonical_hash_reject_via_apply() {
    let mut doc = document();
    let before = value(&doc);
    let ontology = ontology();
    let set = set_with_context(
        json!([set_attributes_change("change_base", &original_hash())]),
        "revision_other",
        "asset_revision_golden",
        "ontology_v1",
    );
    let error = suggestions::apply(
        &mut doc,
        &ontology,
        &Selection::default(),
        &suggestions::AcceptancePins {
            generation: 0,
            expected_generation: 0,
            base_revision_id: Some(&Id::from("revision_golden")),
            canonical_sha256: Some(
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ),
            run: None,
        },
        &set,
        &ids(&["change_base"]),
    )
    .err()
    .expect("set pinned to another base revision must be rejected");
    assert_eq!(error.code, "STALE_BASE_REVISION", "{error}");
    assert_eq!(serde_json::to_value(&doc).unwrap(), before);

    let set = set_with_changes(json!([set_attributes_change(
        "change_sha",
        &original_hash()
    )]));
    let error = suggestions::apply(
        &mut doc,
        &ontology,
        &Selection::default(),
        &suggestions::AcceptancePins {
            generation: 0,
            expected_generation: 0,
            base_revision_id: Some(&Id::from("revision_golden")),
            canonical_sha256: Some(
                "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            ),
            run: None,
        },
        &set,
        &ids(&["change_sha"]),
    )
    .err()
    .expect("changed media hash must be rejected");
    assert_eq!(error.code, "STALE_CANONICAL_HASH", "{error}");
    assert_eq!(serde_json::to_value(&doc).unwrap(), before);
}

// 2. Caps, labels, attributes, geometry and duplicate ids are rejected.

#[test]
fn change_cap_and_unknown_change_ids_are_rejected() {
    let mut editor = editor();
    let before = value(&editor.snapshot());
    let mut changes = Vec::new();
    for index in 0..1001 {
        changes.push(set_attributes_change(
            &format!("change_{index:04}"),
            &original_hash(),
        ));
    }
    let set = set_with_changes(Value::Array(changes));
    let error = editor
        .dispatch(EditorCommand::ApplySuggestions {
            set: set.clone(),
            change_ids: ids(&["change_0000"]),
            expected_generation: 0,
        })
        .err()
        .expect("oversized suggestion sets must be rejected");
    assert_eq!(error.code, "TOO_MANY_CHANGES", "{error}");

    let small = set_with_changes(json!([set_attributes_change(
        "change_known",
        &original_hash()
    )]));
    let error = editor
        .dispatch(EditorCommand::ApplySuggestions {
            set: small,
            change_ids: ids(&["change_unknown"]),
            expected_generation: 0,
        })
        .err()
        .expect("unknown change ids must be rejected");
    assert_eq!(error.code, "CHANGE_NOT_FOUND", "{error}");

    assert_eq!(serde_json::to_value(editor.snapshot()).unwrap(), before);
    assert!(!editor.can_undo());
}

#[test]
fn invalid_labels_attributes_and_geometry_are_rejected() {
    let mut doc = document();
    let before = value(&doc);
    let ontology = ontology();

    let bad_label = json!([{
        "kind": "create",
        "change_id": "change_label",
        "object": {
            "object_id": "object_person_002",
            "label_id": "label_unknown",
            "geometry": {"type": "bbox_xyxy", "x_min": 120.0, "y_min": 20.0, "x_max": 180.0, "y_max": 80.0},
            "attributes": {"helmet_state": "unknown"},
            "origin": {"type": "prediction", "prediction_id": "prediction_test", "model_run_id": "run_test", "import_batch_id": null}
        },
        "before_hash": null,
        "reason": "untrusted"
    }]);
    let error = suggestions::apply(
        &mut doc,
        &ontology,
        &Selection::default(),
        &pins(0, 0),
        &set_with_changes(bad_label),
        &ids(&["change_label"]),
    )
    .err()
    .expect("unknown labels must be rejected");
    assert_eq!(error.code, "UNKNOWN_LABEL", "{error}");
    assert_eq!(serde_json::to_value(&doc).unwrap(), before);

    let bad_attribute = json!([{
        "kind": "create",
        "change_id": "change_attr",
        "object": {
            "object_id": "object_person_002",
            "label_id": "label_person",
            "geometry": {"type": "bbox_xyxy", "x_min": 120.0, "y_min": 20.0, "x_max": 180.0, "y_max": 80.0},
            "attributes": {"helmet_state": "bogus"},
            "origin": {"type": "prediction", "prediction_id": "prediction_test", "model_run_id": "run_test", "import_batch_id": null}
        },
        "before_hash": null,
        "reason": "untrusted"
    }]);
    let error = suggestions::apply(
        &mut doc,
        &ontology,
        &Selection::default(),
        &pins(0, 0),
        &set_with_changes(bad_attribute),
        &ids(&["change_attr"]),
    )
    .err()
    .expect("invalid attribute values must be rejected");
    assert_eq!(error.code, "INVALID_ATTRIBUTE_VALUE", "{error}");
    assert_eq!(serde_json::to_value(&doc).unwrap(), before);

    let missing_attribute = json!([{
        "kind": "create",
        "change_id": "change_missing",
        "object": {
            "object_id": "object_person_002",
            "label_id": "label_person",
            "geometry": {"type": "bbox_xyxy", "x_min": 120.0, "y_min": 20.0, "x_max": 180.0, "y_max": 80.0},
            "attributes": {},
            "origin": {"type": "prediction", "prediction_id": "prediction_test", "model_run_id": "run_test", "import_batch_id": null}
        },
        "before_hash": null,
        "reason": "untrusted"
    }]);
    let error = suggestions::apply(
        &mut doc,
        &ontology,
        &Selection::default(),
        &pins(0, 0),
        &set_with_changes(missing_attribute),
        &ids(&["change_missing"]),
    )
    .err()
    .expect("missing required attributes must be rejected");
    assert_eq!(error.code, "MISSING_ATTRIBUTE", "{error}");
    assert_eq!(serde_json::to_value(&doc).unwrap(), before);

    let unknown_attribute = json!([{
        "kind": "create",
        "change_id": "change_unknown_attr",
        "object": {
            "object_id": "object_person_002",
            "label_id": "label_person",
            "geometry": {"type": "bbox_xyxy", "x_min": 120.0, "y_min": 20.0, "x_max": 180.0, "y_max": 80.0},
            "attributes": {"helmet_state": "unknown", "paint_color": "red"},
            "origin": {"type": "prediction", "prediction_id": "prediction_test", "model_run_id": "run_test", "import_batch_id": null}
        },
        "before_hash": null,
        "reason": "untrusted"
    }]);
    let error = suggestions::apply(
        &mut doc,
        &ontology,
        &Selection::default(),
        &pins(0, 0),
        &set_with_changes(unknown_attribute),
        &ids(&["change_unknown_attr"]),
    )
    .err()
    .expect("attributes not declared for the label must be rejected");
    assert_eq!(error.code, "UNKNOWN_ATTRIBUTE", "{error}");
    assert_eq!(serde_json::to_value(&doc).unwrap(), before);

    let out_of_bounds = json!([{
        "kind": "create",
        "change_id": "change_bounds",
        "object": {
            "object_id": "object_person_002",
            "label_id": "label_person",
            "geometry": {"type": "bbox_xyxy", "x_min": 120.0, "y_min": 20.0, "x_max": 700.0, "y_max": 80.0},
            "attributes": {"helmet_state": "unknown"},
            "origin": {"type": "prediction", "prediction_id": "prediction_test", "model_run_id": "run_test", "import_batch_id": null}
        },
        "before_hash": null,
        "reason": "untrusted"
    }]);
    let error = suggestions::apply(
        &mut doc,
        &ontology,
        &Selection::default(),
        &pins(0, 0),
        &set_with_changes(out_of_bounds),
        &ids(&["change_bounds"]),
    )
    .err()
    .expect("out of bounds boxes must be rejected");
    assert_eq!(error.code, "OUT_OF_BOUNDS", "{error}");
    assert_eq!(serde_json::to_value(&doc).unwrap(), before);
}

#[test]
fn non_finite_numbers_are_rejected() {
    let mut doc = document();
    let before = value(&doc);
    let ontology = numeric_ontology();
    let original_hash = original_hash();

    let nan_attribute = Change::SetAttributes {
        change_id: Id::from("change_nan"),
        object_id: person(),
        values: typed_attrs(vec![("confidence", Scalar::Number(f64::NAN))]),
        before_hash: original_hash.clone(),
        reason: "untrusted".to_owned(),
    };
    let error = suggestions::apply(
        &mut doc,
        &ontology,
        &Selection::default(),
        &pins(0, 0),
        &typed_set(vec![nan_attribute]),
        &ids(&["change_nan"]),
    )
    .err()
    .expect("non-finite attribute numbers must be rejected");
    assert_eq!(error.code, "INVALID_ATTRIBUTE_VALUE", "{error}");
    assert_eq!(serde_json::to_value(&doc).unwrap(), before);

    let out_of_range = Change::SetAttributes {
        change_id: Id::from("change_range"),
        object_id: person(),
        values: typed_attrs(vec![("confidence", Scalar::Number(12.0))]),
        before_hash: original_hash.clone(),
        reason: "untrusted".to_owned(),
    };
    let error = suggestions::apply(
        &mut doc,
        &ontology,
        &Selection::default(),
        &pins(0, 0),
        &typed_set(vec![out_of_range]),
        &ids(&["change_range"]),
    )
    .err()
    .expect("out of range attribute numbers must be rejected");
    assert_eq!(error.code, "INVALID_ATTRIBUTE_VALUE", "{error}");

    let nan_box = Change::Create {
        change_id: Id::from("change_nan_box"),
        object: AnnotationObject {
            object_id: Id::from("object_person_002"),
            label_id: Id::from("label_person"),
            geometry: BBox::new(f64::NAN, 20.0, 180.0, 80.0),
            attributes: typed_attrs(vec![("helmet_state", Scalar::String("unknown".to_owned()))]),
            origin: origin("prediction_test", "run_test"),
        },
        before_hash: None,
        reason: "untrusted".to_owned(),
    };
    let error = suggestions::apply(
        &mut doc,
        &ontology,
        &Selection::default(),
        &pins(0, 0),
        &typed_set(vec![nan_box]),
        &ids(&["change_nan_box"]),
    )
    .err()
    .expect("non-finite geometry must be rejected");
    assert_eq!(error.code, "INVALID_GEOMETRY", "{error}");
    assert_eq!(serde_json::to_value(&doc).unwrap(), before);
}

#[test]
fn duplicate_ids_and_targets_are_rejected() {
    let mut doc = document();
    let before = value(&doc);
    let ontology = ontology();
    let original_hash = original_hash();

    let set = set_with_changes(json!([
        set_attributes_change("change_dup", &original_hash),
        create_change("change_create", "object_person_002")
    ]));
    let error = suggestions::apply(
        &mut doc,
        &ontology,
        &Selection::default(),
        &pins(0, 0),
        &set,
        &ids(&["change_dup", "change_dup"]),
    )
    .err()
    .expect("duplicate change ids must be rejected");
    assert_eq!(error.code, "DUPLICATE_CHANGE_ID", "{error}");

    let conflicting = set_with_changes(json!([
        set_attributes_change("change_a", &original_hash),
        set_attributes_change("change_b", &original_hash)
    ]));
    let error = suggestions::apply(
        &mut doc,
        &ontology,
        &Selection::default(),
        &pins(0, 0),
        &conflicting,
        &ids(&["change_a", "change_b"]),
    )
    .err()
    .expect("two changes on one object must be rejected");
    assert_eq!(error.code, "DUPLICATE_OBJECT_ID", "{error}");

    let duplicate_create =
        set_with_changes(json!([create_change("change_exists", "object_person_001")]));
    let error = suggestions::apply(
        &mut doc,
        &ontology,
        &Selection::default(),
        &pins(0, 0),
        &duplicate_create,
        &ids(&["change_exists"]),
    )
    .err()
    .expect("creating an existing object id must be rejected");
    assert_eq!(error.code, "DUPLICATE_OBJECT_ID", "{error}");

    assert_eq!(serde_json::to_value(&doc).unwrap(), before);
}

// 3. Intent and capability gates.

#[test]
fn audit_runs_reject_create_and_label_changes() {
    let doc = document();
    let ontology = ontology();
    let caps = capabilities(true, true);
    let gate = RunGate {
        intent: RunIntent::AuditAttributes,
        provider_id: ProviderId::Mock,
        capabilities: &caps,
    };

    let create = set_with_changes(json!([create_change("change_create", "object_person_002")]));
    let error = validate_suggestions(
        &context(&doc, &ontology, Some(gate)),
        &create,
        &ids(&["change_create"]),
    )
    .err()
    .expect("audit runs must not create objects");
    assert_eq!(error.code, "INVALID_CHANGE_KIND", "{error}");

    let label = set_with_changes(json!([{
        "kind": "set_label",
        "change_id": "change_label",
        "object_id": "object_person_001",
        "label_id": "label_person",
        "before_hash": original_hash(),
        "reason": "untrusted"
    }]));
    let error = validate_suggestions(
        &context(&doc, &ontology, Some(gate)),
        &label,
        &ids(&["change_label"]),
    )
    .err()
    .expect("audit runs must not relabel objects");
    assert_eq!(error.code, "INVALID_CHANGE_KIND", "{error}");

    // geometry/delete style actions cannot even be represented by the frozen
    // Change schema: untrusted payloads with those kinds are rejected at parse.
    for kind in ["delete", "replace_geometry", "geometry"] {
        let raw = json!({
            "kind": kind,
            "change_id": "change_raw",
            "object_ids": ["object_person_001"],
            "reason": "untrusted"
        });
        assert!(
            serde_json::from_value::<Change>(raw).is_err(),
            "change kind {kind} must be rejected by the schema"
        );
    }
}

#[test]
fn create_changes_require_detector_or_bbox_capability() {
    let doc = document();
    let ontology = ontology();
    let create = set_with_changes(json!([create_change("change_create", "object_person_002")]));
    let weak = capabilities(false, true);

    let error = validate_suggestions(
        &context(
            &doc,
            &ontology,
            Some(RunGate {
                intent: RunIntent::Detect,
                provider_id: ProviderId::OpenaiApi,
                capabilities: &weak,
            }),
        ),
        &create,
        &ids(&["change_create"]),
    )
    .err()
    .expect("create without bbox capability must be rejected");
    assert_eq!(error.code, "INVALID_CHANGE_KIND", "{error}");

    let strong = capabilities(true, true);
    validate_suggestions(
        &context(
            &doc,
            &ontology,
            Some(RunGate {
                intent: RunIntent::Detect,
                provider_id: ProviderId::OpenaiApi,
                capabilities: &strong,
            }),
        ),
        &create,
        &ids(&["change_create"]),
    )
    .expect("explicit bbox capability may create objects");

    let detector = capabilities(false, true);
    validate_suggestions(
        &context(
            &doc,
            &ontology,
            Some(RunGate {
                intent: RunIntent::Detect,
                provider_id: ProviderId::DetectorLocal,
                capabilities: &detector,
            }),
        ),
        &create,
        &ids(&["change_create"]),
    )
    .expect("the local detector may create objects");
}

#[test]
fn attribute_changes_require_attribute_capability_and_matching_intent() {
    let doc = document();
    let ontology = ontology();
    let change = set_with_changes(json!([set_attributes_change(
        "change_attrs",
        &original_hash()
    )]));

    let no_attributes = capabilities(true, false);
    let error = validate_suggestions(
        &context(
            &doc,
            &ontology,
            Some(RunGate {
                intent: RunIntent::AuditAttributes,
                provider_id: ProviderId::Mock,
                capabilities: &no_attributes,
            }),
        ),
        &change,
        &ids(&["change_attrs"]),
    )
    .err()
    .expect("profiles without attribute output must be rejected");
    assert_eq!(error.code, "INVALID_CHANGE_KIND", "{error}");

    let detect = capabilities(true, true);
    let error = validate_suggestions(
        &context(
            &doc,
            &ontology,
            Some(RunGate {
                intent: RunIntent::Detect,
                provider_id: ProviderId::DetectorLocal,
                capabilities: &detect,
            }),
        ),
        &change,
        &ids(&["change_attrs"]),
    )
    .err()
    .expect("detect runs must not carry attribute edits");
    assert_eq!(error.code, "INVALID_CHANGE_KIND", "{error}");

    let audit = capabilities(true, true);
    validate_suggestions(
        &context(
            &doc,
            &ontology,
            Some(RunGate {
                intent: RunIntent::AuditAttributes,
                provider_id: ProviderId::Mock,
                capabilities: &audit,
            }),
        ),
        &change,
        &ids(&["change_attrs"]),
    )
    .expect("attribute audits may suggest attribute edits");

    let find_issues = capabilities(true, true);
    let error = validate_suggestions(
        &context(
            &doc,
            &ontology,
            Some(RunGate {
                intent: RunIntent::FindIssues,
                provider_id: ProviderId::Mock,
                capabilities: &find_issues,
            }),
        ),
        &change,
        &ids(&["change_attrs"]),
    )
    .err()
    .expect("find_issues runs must not carry changes");
    assert_eq!(error.code, "INVALID_CHANGE_KIND", "{error}");
}

// 4. Batch atomicity, explicit subsets and repeat acceptance.

#[test]
fn one_bad_change_rejects_the_whole_batch_and_explicit_subsets_apply() {
    let mut editor = editor();
    let original_hash = original_hash();
    let bad_create = json!({
        "kind": "create",
        "change_id": "change_bad",
        "object": {
            "object_id": "object_person_002",
            "label_id": "label_person",
            "geometry": {"type": "bbox_xyxy", "x_min": 120.0, "y_min": 20.0, "x_max": 180.0, "y_max": 80.0},
            "attributes": {"helmet_state": "bogus"},
            "origin": {"type": "prediction", "prediction_id": "prediction_test", "model_run_id": "run_test", "import_batch_id": null}
        },
        "before_hash": null,
        "reason": "untrusted"
    });
    let set = set_with_changes(json!([
        set_attributes_change("change_good", &original_hash),
        bad_create
    ]));
    let before = value(&editor.snapshot());

    let error = editor
        .dispatch(EditorCommand::ApplySuggestions {
            set: set.clone(),
            change_ids: ids(&["change_good", "change_bad"]),
            expected_generation: 0,
        })
        .err()
        .expect("one bad change must reject the whole batch");
    assert_eq!(error.code, "INVALID_ATTRIBUTE_VALUE", "{error}");
    assert_eq!(serde_json::to_value(editor.snapshot()).unwrap(), before);
    assert_eq!(editor.generation(), 0);
    assert!(!editor.can_undo());

    // The explicitly selected subset is its own atomic command.
    let delta = editor
        .dispatch(EditorCommand::ApplySuggestions {
            set: set.clone(),
            change_ids: ids(&["change_good"]),
            expected_generation: 0,
        })
        .unwrap();
    assert!(delta.document_changed);
    assert_eq!(
        delta.suggestion_decisions,
        vec![SuggestionDecisionIntent {
            suggestion_set_id: Id::from("suggestion_test"),
            change_ids: ids(&["change_good"]),
            decision: SuggestionDecision::Accept,
        }]
    );
    let snapshot = editor.snapshot();
    assert_eq!(
        snapshot.objects[0].attributes["helmet_state"],
        Scalar::String("wearing".to_owned())
    );
    assert_eq!(editor.generation(), 1);
    assert!(editor.can_undo());
}

#[test]
fn repeated_accept_never_duplicates_objects() {
    let mut editor = editor();
    let create = set_with_changes(json!([create_change("change_create", "object_person_002")]));
    editor
        .dispatch(EditorCommand::ApplySuggestions {
            set: create.clone(),
            change_ids: ids(&["change_create"]),
            expected_generation: 0,
        })
        .unwrap();
    assert_eq!(editor.snapshot().objects.len(), 2);

    let before = value(&editor.snapshot());
    let error = editor
        .dispatch(EditorCommand::ApplySuggestions {
            set: create,
            change_ids: ids(&["change_create"]),
            expected_generation: editor.generation(),
        })
        .err()
        .expect("repeated accept must not create a second object");
    assert_eq!(error.code, "DUPLICATE_OBJECT_ID", "{error}");
    assert_eq!(serde_json::to_value(editor.snapshot()).unwrap(), before);
    assert_eq!(editor.snapshot().objects.len(), 2);
}

#[test]
fn repeated_accept_of_applied_changes_is_stale() {
    let mut editor = editor();
    let original_hash = original_hash();
    let attributes = set_with_changes(json!([set_attributes_change(
        "change_attrs",
        &original_hash
    )]));
    editor
        .dispatch(EditorCommand::ApplySuggestions {
            set: attributes.clone(),
            change_ids: ids(&["change_attrs"]),
            expected_generation: 0,
        })
        .unwrap();
    let before = value(&editor.snapshot());
    let error = editor
        .dispatch(EditorCommand::ApplySuggestions {
            set: attributes,
            change_ids: ids(&["change_attrs"]),
            expected_generation: editor.generation(),
        })
        .err()
        .expect("repeated accept of an applied change must be rejected");
    assert_eq!(error.code, "STALE_OBJECT", "{error}");
    assert_eq!(serde_json::to_value(editor.snapshot()).unwrap(), before);
}

// 5. accept -> undo -> redo keeps the prediction and the ordered intents.

#[test]
fn accept_undo_redo_keeps_prediction_and_emits_ordered_intents() {
    let mut editor = editor();
    let original_hash = original_hash();
    let set = set_with_changes(json!([
        set_attributes_change("change_attrs", &original_hash),
        create_change("change_create", "object_person_002")
    ]));
    let prediction_before = serde_json::to_value(&set).unwrap();
    let initial = value(&editor.snapshot());

    let accepted = editor
        .dispatch(EditorCommand::ApplySuggestions {
            set: set.clone(),
            change_ids: ids(&["change_attrs", "change_create"]),
            expected_generation: 0,
        })
        .unwrap();
    assert_eq!(
        accepted.suggestion_decisions,
        vec![SuggestionDecisionIntent {
            suggestion_set_id: Id::from("suggestion_test"),
            change_ids: ids(&["change_attrs", "change_create"]),
            decision: SuggestionDecision::Accept,
        }]
    );
    let accepted_doc = value(&editor.snapshot());
    assert_eq!(editor.snapshot().objects.len(), 2);

    let undone = editor.dispatch(EditorCommand::Undo).unwrap();
    assert_eq!(
        undone.suggestion_decisions,
        vec![SuggestionDecisionIntent {
            suggestion_set_id: Id::from("suggestion_test"),
            change_ids: ids(&["change_attrs", "change_create"]),
            decision: SuggestionDecision::Revert,
        }]
    );
    assert_eq!(serde_json::to_value(editor.snapshot()).unwrap(), initial);

    let redone = editor.dispatch(EditorCommand::Redo).unwrap();
    assert_eq!(
        redone.suggestion_decisions,
        vec![SuggestionDecisionIntent {
            suggestion_set_id: Id::from("suggestion_test"),
            change_ids: ids(&["change_attrs", "change_create"]),
            decision: SuggestionDecision::Accept,
        }]
    );
    assert_eq!(
        serde_json::to_value(editor.snapshot()).unwrap(),
        accepted_doc
    );

    // The source prediction set is immutable and history survives the roundtrip.
    assert_eq!(serde_json::to_value(&set).unwrap(), prediction_before);
    assert!(editor.can_undo());
    assert!(!editor.can_redo());
    editor.dispatch(EditorCommand::Undo).unwrap();
    assert_eq!(serde_json::to_value(editor.snapshot()).unwrap(), initial);
}

#[test]
fn multiple_logical_operations_keep_ordered_intents_without_dedup() {
    let mut editor = editor();
    let original_hash = original_hash();
    let set = set_with_changes(json!([
        set_attributes_change("change_attrs", &original_hash),
        create_change("change_create", "object_person_002")
    ]));
    let mut journal: Vec<SuggestionDecisionIntent> = Vec::new();

    let first = editor
        .dispatch(EditorCommand::ApplySuggestions {
            set: set.clone(),
            change_ids: ids(&["change_attrs"]),
            expected_generation: 0,
        })
        .unwrap();
    journal.extend(first.suggestion_decisions);

    let second = editor
        .dispatch(EditorCommand::ApplySuggestions {
            set: set.clone(),
            change_ids: ids(&["change_create"]),
            expected_generation: editor.generation(),
        })
        .unwrap();
    journal.extend(second.suggestion_decisions);

    let undone = editor.dispatch(EditorCommand::Undo).unwrap();
    journal.extend(undone.suggestion_decisions);

    // The save queue must keep the ordered journal without collapsing
    // accept -> revert of the same change.
    assert_eq!(
        journal,
        vec![
            SuggestionDecisionIntent {
                suggestion_set_id: Id::from("suggestion_test"),
                change_ids: ids(&["change_attrs"]),
                decision: SuggestionDecision::Accept,
            },
            SuggestionDecisionIntent {
                suggestion_set_id: Id::from("suggestion_test"),
                change_ids: ids(&["change_create"]),
                decision: SuggestionDecision::Accept,
            },
            SuggestionDecisionIntent {
                suggestion_set_id: Id::from("suggestion_test"),
                change_ids: ids(&["change_create"]),
                decision: SuggestionDecision::Revert,
            },
        ]
    );
    // Generation only ever advances and history stays usable.
    assert!(editor.generation() >= 3);
    assert!(editor.can_undo());
}

#[test]
fn golden_fixture_set_is_stale_and_leaves_the_document_untouched() {
    let mut editor = editor();
    let before = value(&editor.snapshot());
    let set = golden_set();
    let error = editor
        .dispatch(EditorCommand::ApplySuggestions {
            set,
            change_ids: ids(&["change_golden"]),
            expected_generation: 0,
        })
        .err()
        .expect("the placeholder before_hash of the golden fixture cannot match");
    assert_eq!(error.code, "STALE_OBJECT", "{error}");
    assert_eq!(serde_json::to_value(editor.snapshot()).unwrap(), before);
}

fn pins<'a>(generation: u64, expected_generation: u64) -> suggestions::AcceptancePins<'a> {
    suggestions::AcceptancePins {
        generation,
        expected_generation,
        base_revision_id: None,
        canonical_sha256: None,
        run: None,
    }
}

fn context<'a>(
    document: &'a AnnotationDocument,
    ontology: &'a OntologyVersion,
    run: Option<RunGate<'a>>,
) -> AcceptanceContext<'a> {
    AcceptanceContext {
        document,
        ontology,
        expected_generation: None,
        current_generation: None,
        base_revision_id: None,
        canonical_sha256: None,
        run,
    }
}
