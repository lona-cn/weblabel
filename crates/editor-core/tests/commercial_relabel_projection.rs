use annotation_domain::{
    object_hash, project_relabel, AnnotationDocument, Id, OntologyVersion, Scalar,
};

#[test]
fn fixed_projection_reconciles_attributes_and_rejects_mismatched_inputs() {
    let before: AnnotationDocument =
        serde_json::from_str(include_str!("../../../tests/fixtures/golden/document.json")).unwrap();
    let mut ontology: OntologyVersion =
        serde_json::from_str(include_str!("../../../tests/fixtures/golden/ontology.json")).unwrap();
    let mut target = ontology.labels[0].clone();
    target.label_id = Id::from("target");
    target.attributes[0].key = "replacement".into();
    ontology.labels.push(target);

    let id = &before.objects[0].object_id;
    let hash = object_hash(&before.objects[0]);
    let projected = project_relabel(&before, &ontology, id, &hash, &Id::from("target")).unwrap();
    assert_eq!(projected.label_id, Id::from("target"));
    assert_eq!(
        projected.attributes,
        [("replacement".into(), Scalar::String("unknown".into()))]
            .into_iter()
            .collect()
    );
    assert_eq!(projected.geometry, before.objects[0].geometry);
    assert_eq!(projected.origin, before.objects[0].origin);

    assert_eq!(
        project_relabel(&before, &ontology, id, &hash, &before.objects[0].label_id).unwrap(),
        before.objects[0]
    );
    assert_eq!(
        project_relabel(&before, &ontology, id, "stale", &Id::from("target"))
            .unwrap_err()
            .code,
        "BEFORE_HASH_MISMATCH"
    );
    assert!(project_relabel(
        &before,
        &ontology,
        &Id::from("missing"),
        &hash,
        &Id::from("target")
    )
    .is_err());
    assert_eq!(
        project_relabel(&before, &ontology, id, &hash, &Id::from("missing"))
            .unwrap_err()
            .code,
        "UNKNOWN_LABEL"
    );
    ontology.ontology_version_id = Id::from("other-version");
    assert_eq!(
        project_relabel(&before, &ontology, id, &hash, &Id::from("target"))
            .unwrap_err()
            .code,
        "ONTOLOGY_VERSION_MISMATCH"
    );
}
