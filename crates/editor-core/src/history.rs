use annotation_domain::{AnnotationDocument, AnnotationObject, Scalar};

pub(crate) const HISTORY_LIMIT: usize = 128;
pub(crate) const HISTORY_MEMORY_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct HistoryEntry {
    pub before: AnnotationDocument,
    pub after: AnnotationDocument,
    bytes: usize,
}

impl HistoryEntry {
    pub fn new(before: AnnotationDocument, after: AnnotationDocument) -> Self {
        let bytes =
            document_memory_estimate(&before).saturating_add(document_memory_estimate(&after));
        Self {
            before,
            after,
            bytes,
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct History {
    undo: Vec<HistoryEntry>,
    redo: Vec<HistoryEntry>,
    retained_bytes: usize,
}

impl History {
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn push(&mut self, entry: HistoryEntry) {
        self.retained_bytes = self
            .retained_bytes
            .saturating_sub(self.redo.iter().map(|entry| entry.bytes).sum());
        self.redo.clear();

        if entry.bytes > HISTORY_MEMORY_LIMIT {
            self.undo.clear();
            self.retained_bytes = 0;
            return;
        }
        while self.undo.len() == HISTORY_LIMIT
            || self.retained_bytes.saturating_add(entry.bytes) > HISTORY_MEMORY_LIMIT
        {
            let oldest = self.undo.remove(0);
            self.retained_bytes = self.retained_bytes.saturating_sub(oldest.bytes);
        }
        self.retained_bytes = self.retained_bytes.saturating_add(entry.bytes);
        self.undo.push(entry);
    }

    pub fn undo(&mut self, current: &AnnotationDocument) -> Option<AnnotationDocument> {
        let entry = self.undo.pop()?;
        debug_assert_eq!(&entry.after, current);
        let document = entry.before.clone();
        self.redo.push(entry);
        Some(document)
    }

    pub fn redo(&mut self, current: &AnnotationDocument) -> Option<AnnotationDocument> {
        let entry = self.redo.pop()?;
        debug_assert_eq!(&entry.before, current);
        let document = entry.after.clone();
        self.undo.push(entry);
        Some(document)
    }
}

fn document_memory_estimate(document: &AnnotationDocument) -> usize {
    let mut bytes = 256usize
        .saturating_add(document.asset_revision_id.len())
        .saturating_add(document.ontology_version_id.len())
        .saturating_add(document.objects.len().saturating_mul(256));
    for object in &document.objects {
        bytes = bytes.saturating_add(object_memory_estimate(object));
    }
    bytes
}

fn object_memory_estimate(object: &AnnotationObject) -> usize {
    let mut bytes = object
        .object_id
        .len()
        .saturating_add(object.label_id.len())
        .saturating_add(128)
        .saturating_add(object.attributes.len().saturating_mul(128));
    for (key, value) in &object.attributes {
        bytes = bytes
            .saturating_add(key.len())
            .saturating_add(scalar_memory_estimate(value));
    }
    bytes
}

fn scalar_memory_estimate(value: &Scalar) -> usize {
    match value {
        Scalar::String(value) => value.len(),
        Scalar::Number(_) | Scalar::Boolean(_) | Scalar::Null => 16,
    }
}
