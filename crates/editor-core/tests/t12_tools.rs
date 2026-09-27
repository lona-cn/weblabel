//! T12: rectangle editing, shortcuts, and dense selection end to end at the
//! Rust core. Real C3 PointerInput sequences drive the gesture state machine;
//! assertions cover preview-vs-committed `document_changed`, one undo entry per
//! pointerup, cancel equivalence with the before state, generation invariants,
//! predictable cycling across 100 overlapping boxes, atomic multi-selection
//! attribute edits, and locked/hidden document semantics.

use std::collections::BTreeMap;

use annotation_domain::{AnnotationDocument, EditorCommand, Id, OntologyVersion, Scalar};
use editor_core::{Editor, PointerInput, PointerPhase, Tool};

fn editor() -> Editor {
    let document: AnnotationDocument =
        serde_json::from_str(include_str!("../../../tests/fixtures/golden/document.json")).unwrap();
    let ontology: OntologyVersion =
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

fn pointer_shift(phase: PointerPhase, x_css: f64, y_css: f64) -> PointerInput {
    PointerInput {
        shift: true,
        ..pointer(phase, x_css, y_css)
    }
}

fn person() -> Id {
    Id::from("object_person_001")
}

fn added_object(editor: &Editor, id: &str, bbox: [f64; 4]) -> annotation_domain::AnnotationObject {
    let mut object = editor.snapshot().objects[0].clone();
    object.object_id = Id::from(id);
    object.geometry = annotation_domain::BBox::new(bbox[0], bbox[1], bbox[2], bbox[3]);
    object
}

fn geometry_of(editor: &Editor, id: &Id) -> [f64; 4] {
    let snapshot = editor.snapshot();
    let object = snapshot
        .objects
        .iter()
        .find(|object| object.object_id == *id)
        .expect("object exists");
    [
        object.geometry.x_min,
        object.geometry.y_min,
        object.geometry.x_max,
        object.geometry.y_max,
    ]
}

/// The card's core sequence: down(10,20), 100x move(110,220), up(110,220).
#[test]
fn draw_any_direction_commits_one_object_per_pointerup_and_one_undo_entry() {
    for (from, to) in [
        ((10.0, 20.0), (110.0, 220.0)),
        ((110.0, 220.0), (10.0, 20.0)),
        ((10.0, 220.0), (110.0, 20.0)),
        ((110.0, 20.0), (10.0, 220.0)),
    ] {
        let mut editor = editor();
        editor.set_tool(Tool::Box);
        editor
            .set_active_label(Id::from("label_person"))
            .expect("label exists");
        let down = editor
            .pointer(pointer(PointerPhase::Down, from.0, from.1))
            .unwrap();
        assert!(!down.document_changed);
        let mut preview_delta = down;
        for _ in 0..100 {
            preview_delta = editor
                .pointer(pointer(PointerPhase::Move, to.0, to.1))
                .unwrap();
        }
        assert_eq!(preview_delta.document_changed, false);
        assert_eq!(editor.snapshot().objects.len(), 1);
        assert_eq!(editor.generation(), 0);
        assert_eq!(editor.snapshot().objects[0].geometry.x_min, 10.0);
        let committed_delta = editor
            .pointer(pointer(PointerPhase::Up, to.0, to.1))
            .unwrap();
        assert_eq!(committed_delta.document_changed, true);
        assert_eq!(editor.snapshot().objects.len(), 2);
        assert_eq!(editor.generation(), 1);
        assert!(editor.can_undo());
        let created = &editor.snapshot().objects[1].geometry;
        assert_eq!(
            [created.x_min, created.y_min, created.x_max, created.y_max],
            [10.0, 20.0, 110.0, 220.0],
            "drag endpoints normalize to the same bbox from any direction"
        );
        let committed_generation = editor.generation();
        editor.dispatch(EditorCommand::Undo).unwrap();
        assert_eq!(editor.snapshot().objects.len(), 1);
        assert!(
            editor.generation() > committed_generation,
            "undo must move the generation strictly forward"
        );
    }
}

#[test]
fn pointer_cancel_equals_the_before_snapshot_and_never_bumps_generation() {
    let mut editor = editor();
    editor.set_tool(Tool::Box);
    editor
        .set_active_label(Id::from("label_person"))
        .expect("label exists");
    let before_snapshot = editor.snapshot();
    let before_generation = editor.generation();
    editor
        .pointer(pointer(PointerPhase::Down, 10.0, 20.0))
        .unwrap();
    for _ in 0..100 {
        editor
            .pointer(pointer(PointerPhase::Move, 110.0, 220.0))
            .unwrap();
    }
    assert!(editor.preview().is_some());
    let cancelled_delta = editor
        .pointer(pointer(PointerPhase::Cancel, 110.0, 220.0))
        .unwrap();
    let cancelled_snapshot = editor.snapshot();
    assert_eq!(cancelled_snapshot, before_snapshot);
    assert_eq!(cancelled_delta.document_changed, false);
    assert_eq!(editor.generation(), before_generation);
    assert!(editor.preview().is_none());
    assert!(!editor.can_undo());
}

#[test]
fn hundred_overlapping_boxes_cycle_selection_predictably() {
    let mut editor = editor();
    for index in 0..100 {
        let object = added_object(
            &editor,
            &format!("object_overlap_{index:03}"),
            [300.0, 300.0, 400.0, 400.0],
        );
        editor
            .dispatch(EditorCommand::Create { object })
            .expect("overlapping box is valid");
    }
    editor.set_tool(Tool::Select);
    let mut seen = Vec::new();
    for click in 0..101 {
        editor
            .pointer(pointer(PointerPhase::Down, 350.0, 350.0))
            .unwrap();
        let delta = editor
            .pointer(pointer(PointerPhase::Up, 350.0, 350.0))
            .unwrap();
        assert!(!delta.document_changed);
        assert_eq!(
            delta.selected_object_ids.len(),
            1,
            "click {click} picks one"
        );
        if click < 100 {
            seen.push(delta.selected_object_ids[0].clone());
        } else {
            assert_eq!(
                delta.selected_object_ids[0], seen[0],
                "the cycle wraps after exactly 100 clicks"
            );
        }
    }
    assert_eq!(seen[0], Id::from("object_overlap_099"), "topmost first");
    for step in 1..100 {
        assert_eq!(
            seen[step],
            Id::from(format!("object_overlap_{:03}", 99 - step)),
            "click {step} advances one step down the explicit draw order"
        );
    }
    assert_eq!(editor.generation(), 100, "cycling never edits the document");
}

/// Regression for the transient down-time selection flicker (review F-3):
/// dragging an unselected object stages its selection but must not publish it
/// on down/move deltas — exactly one selection change, in the commit delta.
#[test]
fn drag_of_an_unselected_object_publishes_selection_exactly_once_at_commit() {
    let mut editor = editor();
    editor.set_selection(vec![]).unwrap();
    editor.set_tool(Tool::Select);
    let down = editor
        .pointer(pointer(PointerPhase::Down, 60.0, 100.0))
        .unwrap();
    assert_eq!(
        down.selected_object_ids,
        Vec::<Id>::new(),
        "pointerdown must not publish a selection change"
    );
    assert!(!down.document_changed);
    let moved = editor
        .pointer(pointer(PointerPhase::Move, 80.0, 120.0))
        .unwrap();
    assert_eq!(
        moved.selected_object_ids,
        Vec::<Id>::new(),
        "pointermove must not publish a selection change"
    );
    assert!(!moved.document_changed);
    assert_eq!(editor.generation(), 0);
    let committed = editor
        .pointer(pointer(PointerPhase::Up, 80.0, 120.0))
        .unwrap();
    assert!(committed.document_changed);
    assert_eq!(
        committed.selected_object_ids,
        vec![person()],
        "exactly one selection change, in the commit delta"
    );
    assert_eq!(committed.generation, 1);
    // It really was a move-drag of the unselected object, not a click-select.
    assert_eq!(geometry_of(&editor, &person()), [30.0, 40.0, 130.0, 240.0]);
}

#[test]
fn multi_select_attribute_change_is_one_atomic_undo_entry() {
    let mut editor = editor();
    for id in ["object_person_002", "object_person_003"] {
        let object = added_object(&editor, id, [200.0, 20.0, 300.0, 120.0]);
        editor.dispatch(EditorCommand::Create { object }).unwrap();
    }
    let before = editor.snapshot();
    let mut values = BTreeMap::new();
    values.insert(
        "helmet_state".to_string(),
        Scalar::String("wearing".to_string()),
    );
    let delta = editor
        .dispatch(EditorCommand::SetAttributes {
            object_ids: vec![
                person(),
                Id::from("object_person_002"),
                Id::from("object_person_003"),
            ],
            values,
        })
        .unwrap();
    assert!(delta.document_changed);
    assert_eq!(delta.changed_objects.len(), 3);
    let changed_generation = editor.generation();
    for object in &editor.snapshot().objects {
        assert_eq!(
            object.attributes.get("helmet_state"),
            Some(&Scalar::String("wearing".to_string()))
        );
    }
    editor.dispatch(EditorCommand::Undo).unwrap();
    assert_eq!(
        editor.snapshot(),
        before,
        "one undo entry reverts the whole multi-object attribute change"
    );
    assert!(editor.generation() > changed_generation);
    // The next undo reverts one of the Arrange creates, proving the attribute
    // change consumed exactly one history entry.
    editor.dispatch(EditorCommand::Undo).unwrap();
    assert_eq!(editor.snapshot().objects.len(), 2);
}

#[test]
fn locked_objects_are_not_draggable_or_deletable_but_stay_selectable() {
    let mut editor = editor();
    editor
        .set_local_flags(&[person()], None, Some(true))
        .unwrap();
    editor.set_tool(Tool::Select);
    let before = editor.snapshot();

    // A drag starting on the locked object never mutates the document.
    editor
        .pointer(pointer(PointerPhase::Down, 60.0, 100.0))
        .unwrap();
    editor
        .pointer(pointer(PointerPhase::Move, 160.0, 200.0))
        .unwrap();
    let delta = editor
        .pointer(pointer(PointerPhase::Up, 160.0, 200.0))
        .unwrap();
    assert_eq!(editor.snapshot(), before);
    assert_eq!(editor.generation(), 0);
    assert!(!delta.document_changed);

    // A plain click still selects the locked object (it is not hidden).
    editor
        .pointer(pointer(PointerPhase::Down, 60.0, 100.0))
        .unwrap();
    let click = editor
        .pointer(pointer(PointerPhase::Up, 60.0, 100.0))
        .unwrap();
    assert_eq!(click.selected_object_ids, vec![person()]);

    // Delete is refused atomically by document semantics.
    let result = editor.dispatch(EditorCommand::Delete {
        object_ids: vec![person()],
    });
    assert_eq!(result.unwrap_err().code, "OBJECT_LOCKED");
    assert_eq!(editor.snapshot(), before);
    assert_eq!(editor.generation(), 0);

    // A mixed delete is refused as a whole: the unlocked sibling survives too.
    let unlocked = added_object(&editor, "object_person_002", [200.0, 20.0, 300.0, 120.0]);
    editor
        .dispatch(EditorCommand::Create { object: unlocked })
        .expect("create the unlocked sibling");
    let before_mixed = editor.snapshot();
    let mixed = editor.dispatch(EditorCommand::Delete {
        object_ids: vec![person(), Id::from("object_person_002")],
    });
    assert_eq!(mixed.unwrap_err().code, "OBJECT_LOCKED");
    assert_eq!(editor.snapshot(), before_mixed);
}

#[test]
fn hidden_objects_are_not_hit_testable_by_click_or_cycling() {
    let mut editor = editor();
    editor
        .set_local_flags(&[person()], Some(true), None)
        .unwrap();
    editor.set_tool(Tool::Select);
    editor
        .pointer(pointer(PointerPhase::Down, 60.0, 100.0))
        .unwrap();
    let delta = editor
        .pointer(pointer(PointerPhase::Up, 60.0, 100.0))
        .unwrap();
    assert!(
        delta.selected_object_ids.is_empty(),
        "clicking a hidden object clicks through to nothing"
    );
    assert!(!delta.document_changed);
    assert_eq!(editor.generation(), 0);

    // The pick stack of a later click must not include the hidden object either.
    editor.set_selection(vec![person()]).unwrap();
    editor
        .pointer(pointer(PointerPhase::Down, 60.0, 100.0))
        .unwrap();
    let cycled = editor
        .pointer(pointer(PointerPhase::Up, 60.0, 100.0))
        .unwrap();
    assert!(cycled.selected_object_ids.is_empty());
}

#[test]
fn move_drag_translates_the_selection_with_exactly_one_undo_entry() {
    let mut editor = editor();
    editor.set_selection(vec![person()]).unwrap();
    editor.set_tool(Tool::Select);
    let before = editor.snapshot();
    editor
        .pointer(pointer(PointerPhase::Down, 60.0, 100.0))
        .unwrap();
    let mut preview_delta = editor
        .pointer(pointer(PointerPhase::Move, 80.0, 120.0))
        .unwrap();
    assert_eq!(preview_delta.document_changed, false);
    assert_eq!(
        editor.preview().map(|preview| [
            preview.geometry.x_min,
            preview.geometry.y_min,
            preview.geometry.x_max,
            preview.geometry.y_max
        ]),
        Some([30.0, 40.0, 130.0, 240.0]),
        "the preview follows the drag without mutating the document"
    );
    assert_eq!(editor.snapshot(), before);
    for _ in 0..100 {
        preview_delta = editor
            .pointer(pointer(PointerPhase::Move, 160.0, 200.0))
            .unwrap();
    }
    assert_eq!(preview_delta.document_changed, false);
    assert_eq!(editor.generation(), 0);
    let committed = editor
        .pointer(pointer(PointerPhase::Up, 160.0, 200.0))
        .unwrap();
    assert_eq!(committed.document_changed, true);
    assert_eq!(
        geometry_of(&editor, &person()),
        [110.0, 120.0, 210.0, 320.0]
    );
    assert_eq!(editor.generation(), 1);
    editor.dispatch(EditorCommand::Undo).unwrap();
    assert_eq!(editor.snapshot(), before, "one pointerup = one undo entry");
    assert!(!editor.can_undo());
}

#[test]
fn multi_object_move_skips_locked_targets_and_commits_once() {
    let mut editor = editor();
    let second = added_object(&editor, "object_person_002", [200.0, 200.0, 300.0, 300.0]);
    editor
        .dispatch(EditorCommand::Create { object: second })
        .unwrap();
    editor
        .set_local_flags(&[person()], None, Some(true))
        .unwrap();
    editor
        .set_selection(vec![person(), Id::from("object_person_002")])
        .unwrap();
    editor.set_tool(Tool::Select);
    let before = editor.snapshot();
    editor
        .pointer(pointer(PointerPhase::Down, 250.0, 250.0))
        .unwrap();
    for _ in 0..10 {
        editor
            .pointer(pointer(PointerPhase::Move, 270.0, 270.0))
            .unwrap();
    }
    let committed = editor
        .pointer(pointer(PointerPhase::Up, 270.0, 270.0))
        .unwrap();
    assert_eq!(committed.document_changed, true);
    assert_eq!(
        geometry_of(&editor, &person()),
        [10.0, 20.0, 110.0, 220.0],
        "locked objects are never dragged"
    );
    assert_eq!(
        geometry_of(&editor, &Id::from("object_person_002")),
        [220.0, 220.0, 320.0, 320.0]
    );
    editor.dispatch(EditorCommand::Undo).unwrap();
    assert_eq!(
        editor.snapshot(),
        before,
        "the batch move is one undo entry"
    );
}

#[test]
fn resize_from_every_corner_and_edge_updates_exact_coordinates() {
    let cases: [([f64; 2], [f64; 2], [f64; 4]); 8] = [
        ([10.0, 20.0], [30.0, 40.0], [30.0, 40.0, 110.0, 220.0]),
        ([110.0, 20.0], [90.0, 40.0], [10.0, 40.0, 90.0, 220.0]),
        ([10.0, 220.0], [30.0, 200.0], [30.0, 20.0, 110.0, 200.0]),
        ([110.0, 220.0], [90.0, 200.0], [10.0, 20.0, 90.0, 200.0]),
        ([10.0, 120.0], [30.0, 130.0], [30.0, 20.0, 110.0, 220.0]),
        ([110.0, 120.0], [90.0, 130.0], [10.0, 20.0, 90.0, 220.0]),
        ([60.0, 20.0], [70.0, 40.0], [10.0, 40.0, 110.0, 220.0]),
        ([60.0, 220.0], [70.0, 200.0], [10.0, 20.0, 110.0, 200.0]),
    ];
    for (down_at, up_at, expected) in cases {
        let mut editor = editor();
        editor.set_selection(vec![person()]).unwrap();
        editor.set_tool(Tool::Select);
        let before = editor.snapshot();
        editor
            .pointer(pointer(PointerPhase::Down, down_at[0], down_at[1]))
            .unwrap();
        editor
            .pointer(pointer(PointerPhase::Move, up_at[0], up_at[1]))
            .unwrap();
        let committed = editor
            .pointer(pointer(PointerPhase::Up, up_at[0], up_at[1]))
            .unwrap();
        assert_eq!(committed.document_changed, true);
        assert_eq!(
            geometry_of(&editor, &person()),
            expected,
            "resize from {down_at:?} to {up_at:?}"
        );
        editor.dispatch(EditorCommand::Undo).unwrap();
        assert_eq!(
            editor.snapshot(),
            before,
            "each resize drag is one undo entry"
        );
        assert!(!editor.can_undo());
    }
}

#[test]
fn resize_never_inverts_the_box_and_clamps_to_the_canonical_image() {
    let mut editor = editor();
    editor.set_selection(vec![person()]).unwrap();
    editor.set_tool(Tool::Select);
    editor
        .pointer(pointer(PointerPhase::Down, 10.0, 20.0))
        .unwrap();
    editor
        .pointer(pointer(PointerPhase::Move, 200.0, 300.0))
        .unwrap();
    editor
        .pointer(pointer(PointerPhase::Up, 200.0, 300.0))
        .unwrap();
    assert_eq!(
        geometry_of(&editor, &person()),
        [108.0, 218.0, 110.0, 220.0],
        "dragging past the opposite sides floors at the 2 CSS px interactive minimum"
    );
    editor.dispatch(EditorCommand::Undo).unwrap();

    editor.set_selection(vec![person()]).unwrap();
    editor
        .pointer(pointer(PointerPhase::Down, 110.0, 120.0))
        .unwrap();
    editor
        .pointer(pointer(PointerPhase::Move, 1000.0, 120.0))
        .unwrap();
    editor
        .pointer(pointer(PointerPhase::Up, 1000.0, 120.0))
        .unwrap();
    assert_eq!(
        geometry_of(&editor, &person()),
        [10.0, 20.0, 640.0, 220.0],
        "commits clamp to the canonical image instead of failing"
    );
}

#[test]
fn tool_switch_and_viewport_switch_cancel_the_in_progress_gesture() {
    let mut editor = editor();
    editor.set_tool(Tool::Box);
    editor
        .set_active_label(Id::from("label_person"))
        .expect("label exists");
    let before = editor.snapshot();
    let generation = editor.generation();
    editor
        .pointer(pointer(PointerPhase::Down, 150.0, 150.0))
        .unwrap();
    editor
        .pointer(pointer(PointerPhase::Move, 250.0, 250.0))
        .unwrap();
    assert!(editor.preview().is_some());
    editor.set_tool(Tool::Select);
    assert!(
        editor.preview().is_none(),
        "tool switch cancels the preview"
    );
    assert_eq!(editor.snapshot(), before);
    assert_eq!(editor.generation(), generation);
    let up = editor
        .pointer(pointer(PointerPhase::Up, 250.0, 250.0))
        .unwrap();
    assert!(!up.document_changed);
    assert_eq!(
        editor.snapshot(),
        before,
        "the cancelled gesture never commits"
    );

    editor.set_tool(Tool::Box);
    editor
        .pointer(pointer(PointerPhase::Down, 150.0, 150.0))
        .unwrap();
    editor
        .pointer(pointer(PointerPhase::Move, 250.0, 250.0))
        .unwrap();
    assert!(editor.preview().is_some());
    editor
        .set_viewport(geometry::Viewport::try_new(2.0, 5.0, 6.0, 640.0, 480.0, 2.0).unwrap())
        .unwrap();
    assert!(
        editor.preview().is_none(),
        "a viewport switch (scroll zoom, canvas resize) cancels the gesture"
    );
    assert_eq!(editor.snapshot(), before);
    assert_eq!(editor.generation(), generation);
}

#[test]
fn duplicate_and_delete_round_trip_through_single_history_entries() {
    let mut editor = editor();
    let delta = editor
        .dispatch(EditorCommand::Duplicate {
            object_ids: vec![person()],
            new_ids: vec![Id::from("object_person_002")],
        })
        .unwrap();
    assert!(delta.document_changed);
    assert_eq!(editor.snapshot().objects.len(), 2);
    assert_eq!(
        geometry_of(&editor, &Id::from("object_person_002")),
        [10.0, 20.0, 110.0, 220.0]
    );
    editor.dispatch(EditorCommand::Undo).unwrap();
    assert_eq!(
        editor.snapshot().objects.len(),
        1,
        "duplicate is one undo entry"
    );

    editor
        .dispatch(EditorCommand::Duplicate {
            object_ids: vec![person()],
            new_ids: vec![Id::from("object_person_002")],
        })
        .unwrap();
    let deleted = editor
        .dispatch(EditorCommand::Delete {
            object_ids: vec![person(), Id::from("object_person_002")],
        })
        .unwrap();
    assert!(deleted.document_changed);
    assert_eq!(deleted.removed_object_ids.len(), 2);
    assert!(editor.snapshot().objects.is_empty());
    editor.dispatch(EditorCommand::Undo).unwrap();
    assert_eq!(
        editor.snapshot().objects.len(),
        2,
        "the batch delete is one undo entry"
    );
}

#[test]
fn click_semantics_clear_on_empty_and_extend_with_the_additive_modifier() {
    let mut editor = editor();
    editor.set_tool(Tool::Select);
    editor.set_selection(vec![person()]).unwrap();
    editor
        .pointer(pointer(PointerPhase::Down, 400.0, 400.0))
        .unwrap();
    let cleared = editor
        .pointer(pointer(PointerPhase::Up, 400.0, 400.0))
        .unwrap();
    assert!(cleared.selected_object_ids.is_empty());
    assert!(!cleared.document_changed);

    editor.set_selection(vec![person()]).unwrap();
    editor
        .pointer(pointer_shift(PointerPhase::Down, 400.0, 400.0))
        .unwrap();
    let kept = editor
        .pointer(pointer_shift(PointerPhase::Up, 400.0, 400.0))
        .unwrap();
    assert_eq!(kept.selected_object_ids, vec![person()]);

    let second = added_object(&editor, "object_person_002", [300.0, 300.0, 500.0, 400.0]);
    editor
        .dispatch(EditorCommand::Create { object: second })
        .unwrap();
    editor.set_selection(vec![person()]).unwrap();
    editor
        .pointer(pointer_shift(PointerPhase::Down, 400.0, 350.0))
        .unwrap();
    let added = editor
        .pointer(pointer_shift(PointerPhase::Up, 400.0, 350.0))
        .unwrap();
    assert_eq!(
        added.selected_object_ids,
        vec![person(), Id::from("object_person_002")],
        "additive click adds the topmost candidate to the selection"
    );
}

#[test]
fn draw_requires_an_active_label_and_sub_two_pixel_drags_never_commit() {
    let mut editor = editor();
    editor.set_tool(Tool::Box);
    let before = editor.snapshot();
    editor
        .pointer(pointer(PointerPhase::Down, 150.0, 150.0))
        .unwrap();
    editor
        .pointer(pointer(PointerPhase::Move, 250.0, 250.0))
        .unwrap();
    let result = editor.pointer(pointer(PointerPhase::Up, 250.0, 250.0));
    assert_eq!(result.unwrap_err().code, "ACTIVE_LABEL_REQUIRED");
    assert_eq!(editor.snapshot(), before);
    assert_eq!(editor.generation(), 0);
    assert!(!editor.can_undo());

    editor
        .set_active_label(Id::from("label_person"))
        .expect("label exists");
    editor
        .pointer(pointer(PointerPhase::Down, 150.0, 150.0))
        .unwrap();
    let undersized = editor
        .pointer(pointer(PointerPhase::Up, 152.0, 151.999))
        .unwrap();
    assert!(!undersized.document_changed);
    assert!(editor.preview().is_none());
    assert_eq!(editor.snapshot(), before);
    assert!(!editor.can_undo());
}
