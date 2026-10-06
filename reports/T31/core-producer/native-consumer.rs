use annotation_domain::{AnnotationDocument, BBox, Change, EditorCommand, Id, OntologyVersion, SuggestionDecision, SuggestionSet};
use editor_core::Editor;
use wasm_bridge::EditorSession;

fn bits(document: &AnnotationDocument) -> [u64; 4] {
    let bbox = &document.objects[0].geometry;
    [bbox.x_min.to_bits(), bbox.y_min.to_bits(), bbox.x_max.to_bits(), bbox.y_max.to_bits()]
}

fn main() {
    let mut document: AnnotationDocument = serde_json::from_str(include_str!("../../../tests/fixtures/golden/document.json")).unwrap();
    let ontology: OntologyVersion = serde_json::from_str(include_str!("../../../tests/fixtures/golden/ontology.json")).unwrap();
    document.objects[0].geometry = BBox::new(44.891029759607644, 20.123456789012344, 110.98765432109876, 220.00000000000003);
    let original_bits = bits(&document);
    let original_wire = serde_json::to_vec(&document).unwrap();
    let native = Editor::from_snapshot(document.clone(), ontology.clone(), 11).unwrap();
    let mut detached = native.snapshot();
    detached.objects.clear();
    assert_eq!(serde_json::to_vec(native.document()).unwrap(), original_wire);
    assert_eq!(native.object_hashes()[&document.objects[0].object_id], annotation_domain::object_hash(&document.objects[0]));
    let mut session = EditorSession::from_snapshot(document.clone(), ontology, 11).unwrap();
    let mut detached = session.get_snapshot();
    detached.objects.clear();
    assert_eq!(serde_json::to_vec(&session.get_snapshot()).unwrap(), original_wire);
    session.prepare_frame().unwrap();
    let mut set: SuggestionSet = serde_json::from_str(include_str!("../../../tests/fixtures/golden/prediction.json")).unwrap();
    set.context.draft_generation = 11;
    let Change::SetAttributes { before_hash, .. } = &mut set.changes[0] else { panic!("attribute fixture") };
    *before_hash = annotation_domain::object_hash(&document.objects[0]);
    let accept = session.dispatch(EditorCommand::ApplySuggestions { set: set.clone(), change_ids: vec![Id::from("change_golden")], expected_generation: 11 });
    assert!(accept.error.is_none());
    assert!(accept.document_changed);
    assert_eq!(accept.generation, 12);
    assert_eq!(accept.suggestion_decisions[0].decision, SuggestionDecision::Accept);
    let accepted = session.get_snapshot();
    assert_eq!(bits(&accepted), original_bits);
    let undo = session.dispatch(EditorCommand::Undo);
    assert_eq!(undo.generation, 13);
    assert_eq!(undo.suggestion_decisions[0].decision, SuggestionDecision::Revert);
    assert_eq!(serde_json::to_vec(&session.get_snapshot()).unwrap(), original_wire);
    let redo = session.dispatch(EditorCommand::Redo);
    assert_eq!(redo.generation, 14);
    assert_eq!(redo.suggestion_decisions, accept.suggestion_decisions);
    assert_eq!(session.get_snapshot(), accepted);
    let no_op = session.dispatch(EditorCommand::ReplaceGeometry { object_id: document.objects[0].object_id.clone(), geometry: document.objects[0].geometry.clone() });
    assert!(!no_op.document_changed);
    assert_eq!(no_op.generation, 14);
    let invalid = session.dispatch(EditorCommand::ReplaceGeometry { object_id: document.objects[0].object_id.clone(), geometry: BBox::new(0.0, 0.0, 0.0, 0.0) });
    assert_eq!(invalid.error.unwrap().code, "INVALID_GEOMETRY");
    assert_eq!(session.get_snapshot(), accepted);
    assert_eq!(session.get_generation(), 14);
    set.context.draft_generation = 14;
    let Change::SetAttributes { before_hash, .. } = &mut set.changes[0] else { panic!("attribute fixture") };
    *before_hash = annotation_domain::object_hash(&accepted.objects[0]);
    let decision_only = session.dispatch(EditorCommand::ApplySuggestions { set, change_ids: vec![Id::from("change_golden")], expected_generation: 14 });
    assert!(decision_only.error.is_none());
    assert!(!decision_only.document_changed);
    assert_eq!(decision_only.generation, 14);
    assert_eq!(decision_only.suggestion_decisions, accept.suggestion_decisions);
    let undo = session.dispatch(EditorCommand::Undo);
    assert_eq!(undo.generation, 15);
    assert!(!undo.can_undo);
    assert!(undo.can_redo);
    assert_eq!(undo.suggestion_decisions[0].decision, SuggestionDecision::Revert);
    assert_eq!(session.get_snapshot(), document);
    assert_eq!(session.dispatch(EditorCommand::Redo).generation, 16);
    let deleted = session.dispatch(EditorCommand::Delete { object_ids: vec![document.objects[0].object_id.clone()] });
    assert_eq!(deleted.generation, 17);
    assert_eq!(deleted.removed_object_ids, vec![document.objects[0].object_id.clone()]);
    assert!(session.get_snapshot().objects.is_empty());
    assert_eq!(session.dispatch(EditorCommand::Undo).generation, 18);
    assert_eq!(session.get_snapshot(), accepted);
    let frame = session.prepare_frame().unwrap().projection.unwrap();
    assert_eq!(frame.0[0].bounds, [accepted.objects[0].geometry.x_min as f32, accepted.objects[0].geometry.y_min as f32, accepted.objects[0].geometry.x_max as f32, accepted.objects[0].geometry.y_max as f32]);
    assert_eq!(session.dispatch(EditorCommand::Redo).generation, 19);
    assert!(session.get_snapshot().objects.is_empty());
    println!("{}", serde_json::json!({"consumer":"actual compiled native Editor + EditorSession CLI", "original_coordinate_bits": original_bits, "initial_generation": 11, "final_generation": session.get_generation(), "journal":["accept","revert","accept","decision_only_accept","revert","accept"], "owned_snapshot_isolation":true, "invalid_edit_atomic":true, "no_op_preserves_history":true, "delete_undo_projection_verified":true}));
}
