use annotation_domain::{AnnotationDocument, EditorCommand, Id, Scalar};
use editor_core::{Editor, PointerInput, PointerPhase, Tool};

fn editor() -> Editor {
    let document: AnnotationDocument =
        serde_json::from_str(include_str!("../../../tests/fixtures/golden/document.json")).unwrap();
    let ontology =
        serde_json::from_str(include_str!("../../../tests/fixtures/golden/ontology.json")).unwrap();
    Editor::new(document, ontology).unwrap()
}

fn pointer(phase: PointerPhase, x_css: f64, y_css: f64) -> PointerInput {
    PointerInput {
        phase,
        pointer_id: 7,
        x_css,
        y_css,
        button: 0,
        buttons: 1,
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
    }
}

fn person() -> Id {
    Id::from("object_person_001")
}

#[test]
fn empty_undo_preserves_document_and_generation() {
    let mut editor = editor();
    let before = editor.snapshot();
    let delta = editor.dispatch(EditorCommand::Undo).unwrap();
    assert!(!delta.document_changed);
    assert_eq!(delta.generation, 0);
    assert_eq!(editor.snapshot(), before);
}

#[test]
fn create_undo_redo_restores_document_and_generation_never_rewinds() {
    let mut editor = editor();
    let object = editor.snapshot().objects[0].clone();
    let mut new_object = object.clone();
    new_object.object_id = Id::from("object_created_002");
    new_object.geometry = annotation_domain::BBox::new(120.0, 20.0, 180.0, 80.0);
    let initial = editor.snapshot();
    assert!(
        editor
            .dispatch(EditorCommand::Create { object: new_object })
            .unwrap()
            .document_changed
    );
    let created = editor.snapshot();
    assert_eq!(editor.generation(), 1);
    editor.dispatch(EditorCommand::Undo).unwrap();
    assert_eq!(editor.snapshot(), initial);
    assert_eq!(editor.generation(), 2);
    editor.dispatch(EditorCommand::Redo).unwrap();
    assert_eq!(editor.snapshot(), created);
    assert_eq!(editor.generation(), 3);
}

#[test]
fn no_op_command_does_not_create_history_or_advance_generation() {
    let mut editor = editor();
    let completion = editor.snapshot().completion;
    let delta = editor
        .dispatch(EditorCommand::SetCompletion { completion })
        .unwrap();
    assert!(!delta.document_changed);
    assert_eq!(editor.generation(), 0);
    assert!(!editor.can_undo());
    let redo = editor.dispatch(EditorCommand::Redo).unwrap();
    assert!(!redo.document_changed);
    assert_eq!(redo.generation, 0);
    assert!(!editor.can_redo());
}

#[test]
fn bounded_history_drops_oldest_operations_without_losing_document() {
    let mut editor = editor();
    for index in 0..=128 {
        let completion = if index % 2 == 0 {
            annotation_domain::Completion::Complete
        } else {
            annotation_domain::Completion::InProgress
        };
        editor
            .dispatch(EditorCommand::SetCompletion { completion })
            .unwrap();
    }
    let after_all = editor.snapshot();
    assert_eq!(editor.generation(), 129);
    for _ in 0..128 {
        editor.dispatch(EditorCommand::Undo).unwrap();
    }
    assert_eq!(
        editor.snapshot().completion,
        annotation_domain::Completion::Complete
    );
    assert!(!editor.can_undo());
    let empty_undo = editor.dispatch(EditorCommand::Undo).unwrap();
    assert!(!empty_undo.document_changed);
    assert_eq!(editor.generation(), 257);
    for _ in 0..128 {
        editor.dispatch(EditorCommand::Redo).unwrap();
    }
    assert_eq!(editor.snapshot(), after_all);
}

#[test]
fn select_tool_region_selects_intersections_without_document_mutation() {
    let mut editor = editor();
    editor.set_tool(Tool::Select);
    editor
        .pointer(pointer(PointerPhase::Down, 0.0, 0.0))
        .unwrap();
    editor
        .pointer(pointer(PointerPhase::Move, 120.0, 30.0))
        .unwrap();
    let delta = editor
        .pointer(pointer(PointerPhase::Up, 120.0, 30.0))
        .unwrap();
    assert_eq!(delta.selected_object_ids, vec![person()]);
    assert!(!delta.document_changed);
    assert_eq!(editor.snapshot().objects.len(), 1);
    assert_eq!(editor.generation(), 0);
}

#[test]
fn box_tool_rejects_sub_two_css_pixel_edges_and_accepts_boundary() {
    let mut undersized = editor();
    undersized.set_tool(Tool::Box);
    undersized
        .set_active_label(Id::from("label_person"))
        .unwrap();
    let before = undersized.snapshot();
    undersized
        .pointer(pointer(PointerPhase::Down, 150.0, 150.0))
        .unwrap();
    undersized
        .pointer(pointer(PointerPhase::Move, 152.0, 151.999))
        .unwrap();
    let delta = undersized
        .pointer(pointer(PointerPhase::Up, 152.0, 151.999))
        .unwrap();
    assert!(!delta.document_changed);
    assert!(undersized.preview().is_none());
    assert_eq!(undersized.snapshot(), before);
    assert_eq!(undersized.generation(), 0);
    assert!(!undersized.can_undo());

    let mut boundary = editor();
    boundary.set_tool(Tool::Box);
    boundary.set_active_label(Id::from("label_person")).unwrap();
    boundary
        .pointer(pointer(PointerPhase::Down, 150.0, 150.0))
        .unwrap();
    let delta = boundary
        .pointer(pointer(PointerPhase::Up, 152.0, 152.0))
        .unwrap();
    assert!(delta.document_changed);
    assert_eq!(boundary.snapshot().objects.len(), 2);
    assert_eq!(boundary.generation(), 1);
}

#[test]
fn hidden_objects_are_excluded_from_canvas_region_selection() {
    let mut editor = editor();
    editor
        .set_local_flags(&[person()], Some(true), None)
        .unwrap();
    editor.set_tool(Tool::Select);
    editor
        .pointer(pointer(PointerPhase::Down, 0.0, 0.0))
        .unwrap();
    let delta = editor
        .pointer(pointer(PointerPhase::Up, 120.0, 30.0))
        .unwrap();
    assert!(delta.selected_object_ids.is_empty());
    assert_eq!(editor.snapshot().objects.len(), 1);
    assert_eq!(editor.generation(), 0);
}

#[test]
fn additive_region_selection_drops_previously_selected_hidden_objects() {
    let mut editor = editor();
    editor.set_selection(vec![person()]).unwrap();
    editor
        .set_local_flags(&[person()], Some(true), None)
        .unwrap();
    editor.set_tool(Tool::Select);
    let mut down = pointer(PointerPhase::Down, 400.0, 400.0);
    down.shift = true;
    editor.pointer(down).unwrap();
    let delta = editor
        .pointer(pointer(PointerPhase::Up, 450.0, 450.0))
        .unwrap();
    assert!(delta.selected_object_ids.is_empty());
    assert_eq!(editor.snapshot().objects.len(), 1);
    assert_eq!(editor.generation(), 0);
}

#[test]
fn one_hundred_pointer_moves_commit_exactly_one_create() {
    let mut editor = editor();
    editor.set_tool(Tool::Box);
    editor.set_active_label(Id::from("label_person")).unwrap();
    editor
        .pointer(pointer(PointerPhase::Down, 150.0, 150.0))
        .unwrap();
    for step in 1..=100 {
        editor
            .pointer(pointer(
                PointerPhase::Move,
                150.0 + f64::from(step),
                150.0 + f64::from(step),
            ))
            .unwrap();
    }
    assert_eq!(editor.generation(), 0);
    assert_eq!(editor.snapshot().objects.len(), 1);
    let delta = editor
        .pointer(pointer(PointerPhase::Up, 260.0, 260.0))
        .unwrap();
    assert!(delta.document_changed);
    assert_eq!(editor.snapshot().objects.len(), 2);
    assert_eq!(editor.generation(), 1);
    assert!(editor.can_undo());
    editor.dispatch(EditorCommand::Undo).unwrap();
    assert_eq!(editor.snapshot().objects.len(), 1);
}

#[test]
fn pointer_cancel_discards_preview_without_formal_object() {
    let mut editor = editor();
    editor.set_tool(Tool::Box);
    editor.set_active_label(Id::from("label_person")).unwrap();
    let initial = editor.snapshot();
    editor
        .pointer(pointer(PointerPhase::Down, 150.0, 150.0))
        .unwrap();
    editor
        .pointer(pointer(PointerPhase::Move, 200.0, 200.0))
        .unwrap();
    assert!(editor.preview().is_some());
    let delta = editor
        .pointer(pointer(PointerPhase::Cancel, 200.0, 200.0))
        .unwrap();
    assert!(!delta.document_changed);
    assert!(editor.preview().is_none());
    assert_eq!(editor.snapshot(), initial);
    assert_eq!(editor.generation(), 0);
    assert!(!editor.can_undo());
}

#[test]
fn invalid_member_rejects_entire_multi_object_attribute_change() {
    let mut editor = editor();
    let mut second = editor.snapshot().objects[0].clone();
    second.object_id = Id::from("object_person_002");
    second.geometry = annotation_domain::BBox::new(200.0, 20.0, 300.0, 220.0);
    editor
        .dispatch(EditorCommand::Create { object: second })
        .unwrap();
    let before = editor.snapshot();
    let mut values = std::collections::BTreeMap::new();
    values.insert(
        "helmet_state".to_string(),
        Scalar::String("wearing".to_string()),
    );
    values.insert("not_in_ontology".to_string(), Scalar::Boolean(true));
    let result = editor.dispatch(EditorCommand::SetAttributes {
        object_ids: vec![person(), Id::from("object_person_002")],
        values,
    });
    assert_eq!(result.unwrap_err().code, "UNKNOWN_ATTRIBUTE");
    assert_eq!(editor.snapshot(), before);
    assert_eq!(editor.generation(), 1);
}

#[test]
fn hidden_locked_and_selection_state_never_enters_snapshot() {
    let mut editor = editor();
    editor.set_selection(vec![person()]).unwrap();
    editor
        .set_local_flags(&[person()], Some(true), Some(true))
        .unwrap();
    assert!(editor.local_flags(&person()).hidden);
    assert!(editor.local_flags(&person()).locked);
    assert_eq!(editor.snapshot().objects[0].object_id, person());
    assert_eq!(editor.snapshot().objects.len(), 1);
    let serialized = serde_json::to_value(editor.snapshot()).unwrap();
    assert!(serialized.get("selection").is_none());
    assert!(serialized["objects"][0].get("hidden").is_none());
    assert!(serialized["objects"][0].get("locked").is_none());
    assert_eq!(editor.generation(), 0);
}

#[test]
fn locked_objects_reject_mutation_without_changing_document() {
    let mut editor = editor();
    editor
        .set_local_flags(&[person()], None, Some(true))
        .unwrap();
    let before = editor.snapshot();
    let geometry = annotation_domain::BBox::new(11.0, 20.0, 111.0, 220.0);
    let result = editor.dispatch(EditorCommand::ReplaceGeometry {
        object_id: person(),
        geometry,
    });
    assert_eq!(result.unwrap_err().code, "OBJECT_LOCKED");
    assert_eq!(editor.snapshot(), before);
    assert_eq!(editor.generation(), 0);
}

#[test]
fn apply_suggestions_reports_not_ready_without_mutating_document() {
    let mut editor = editor();
    let before = editor.snapshot();
    let result = editor.dispatch(EditorCommand::ApplySuggestions {
        set: serde_json::from_str(include_str!(
            "../../../tests/fixtures/golden/prediction.json"
        ))
        .unwrap(),
        change_ids: vec![],
        expected_generation: 0,
    });
    assert_eq!(result.unwrap_err().code, "NOT_READY");
    assert_eq!(editor.snapshot(), before);
    assert_eq!(editor.generation(), 0);
}

#[test]
fn duplicate_requires_distinct_unused_ids_and_is_atomic() {
    let mut editor = editor();
    let before = editor.snapshot();
    let result = editor.dispatch(EditorCommand::Duplicate {
        object_ids: vec![person()],
        new_ids: vec![person()],
    });
    assert_eq!(result.unwrap_err().code, "DUPLICATE_OBJECT_ID");
    assert_eq!(editor.snapshot(), before);
    assert_eq!(editor.generation(), 0);
}
