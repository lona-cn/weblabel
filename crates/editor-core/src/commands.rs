use std::collections::HashSet;

use annotation_domain::{
    validate_document, AnnotationDocument, AnnotationObject, DomainError, EditorCommand, Id,
    OntologyVersion,
};

use crate::Selection;

pub(crate) fn apply(
    document: &mut AnnotationDocument,
    ontology: &OntologyVersion,
    selection: &Selection,
    command: &EditorCommand,
) -> Result<(), DomainError> {
    match command {
        EditorCommand::Create { object } => {
            if document
                .objects
                .iter()
                .any(|existing| existing.object_id == object.object_id)
            {
                return Err(DomainError::new(
                    "DUPLICATE_OBJECT_ID",
                    "object_id already exists",
                ));
            }
            document.objects.push(object.clone());
        }
        EditorCommand::ReplaceGeometry {
            object_id,
            geometry,
        } => {
            ensure_editable(selection, std::slice::from_ref(object_id))?;
            find_object_mut(document, object_id)?.geometry = geometry.clone();
        }
        EditorCommand::SetAttributes { object_ids, values } => {
            ensure_targets(document, object_ids)?;
            ensure_editable(selection, object_ids)?;
            for object_id in object_ids {
                let object = find_object_mut(document, object_id)?;
                for (key, value) in values {
                    object.attributes.insert(key.clone(), value.clone());
                }
            }
        }
        EditorCommand::SetLabel {
            object_ids,
            label_id,
        } => {
            ensure_targets(document, object_ids)?;
            ensure_editable(selection, object_ids)?;
            for object_id in object_ids {
                find_object_mut(document, object_id)?.label_id = label_id.clone();
            }
        }
        EditorCommand::Delete { object_ids } => {
            ensure_targets(document, object_ids)?;
            ensure_editable(selection, object_ids)?;
            let deleting: HashSet<Id> = object_ids.iter().cloned().collect();
            document
                .objects
                .retain(|object| !deleting.contains(&object.object_id));
        }
        EditorCommand::Duplicate {
            object_ids,
            new_ids,
        } => {
            ensure_targets(document, object_ids)?;
            ensure_editable(selection, object_ids)?;
            if object_ids.len() != new_ids.len() || object_ids.is_empty() {
                return Err(DomainError::new(
                    "INVALID_DUPLICATE_IDS",
                    "duplicate requires one new ID per object",
                ));
            }
            let mut unique = HashSet::with_capacity(new_ids.len());
            for id in new_ids {
                annotation_domain::document::validate_id(id)?;
                if !unique.insert(id)
                    || document
                        .objects
                        .iter()
                        .any(|object| object.object_id == *id)
                {
                    return Err(DomainError::new(
                        "DUPLICATE_OBJECT_ID",
                        "duplicate IDs must be unique and unused",
                    ));
                }
            }
            let copies: Vec<AnnotationObject> = object_ids
                .iter()
                .zip(new_ids)
                .map(|(old_id, new_id)| {
                    let mut object = find_object(document, old_id)
                        .expect("targets validated")
                        .clone();
                    object.object_id = new_id.clone();
                    object
                })
                .collect();
            document.objects.extend(copies);
        }
        EditorCommand::SetCompletion { completion } => document.completion = *completion,
        EditorCommand::ApplySuggestions { .. } => {
            return Err(DomainError::new(
                "INVALID_COMMAND_STATE",
                "suggestion application is handled by the editor",
            ));
        }
        EditorCommand::Undo | EditorCommand::Redo => {
            return Err(DomainError::new(
                "INVALID_HISTORY_COMMAND",
                "history commands are handled by the editor",
            ));
        }
    }
    validate_document(document, ontology)
}

fn ensure_targets(document: &AnnotationDocument, ids: &[Id]) -> Result<(), DomainError> {
    if ids.is_empty() {
        return Err(DomainError::new(
            "EMPTY_SELECTION",
            "command requires at least one object",
        ));
    }
    let mut seen = HashSet::with_capacity(ids.len());
    for id in ids {
        if !seen.insert(id) {
            return Err(DomainError::new(
                "DUPLICATE_OBJECT_ID",
                "target IDs must be unique",
            ));
        }
        find_object(document, id)?;
    }
    Ok(())
}

fn ensure_editable(selection: &Selection, ids: &[Id]) -> Result<(), DomainError> {
    if ids.iter().any(|id| selection.is_locked(id)) {
        return Err(DomainError::new(
            "OBJECT_LOCKED",
            "locked objects cannot be edited",
        ));
    }
    Ok(())
}

fn find_object<'a>(
    document: &'a AnnotationDocument,
    id: &Id,
) -> Result<&'a AnnotationObject, DomainError> {
    document
        .objects
        .iter()
        .find(|object| object.object_id == *id)
        .ok_or_else(|| DomainError::new("OBJECT_NOT_FOUND", "target object does not exist"))
}

fn find_object_mut<'a>(
    document: &'a mut AnnotationDocument,
    id: &Id,
) -> Result<&'a mut AnnotationObject, DomainError> {
    document
        .objects
        .iter_mut()
        .find(|object| object.object_id == *id)
        .ok_or_else(|| DomainError::new("OBJECT_NOT_FOUND", "target object does not exist"))
}
