use annotation_domain::{AnnotationDocument, AnnotationObject, Scalar, SuggestionDecisionIntent};

pub(crate) const HISTORY_LIMIT: usize = 128;
pub(crate) const HISTORY_MEMORY_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct HistoryEntry {
    documents: Option<(AnnotationDocument, AnnotationDocument)>,
    /// Suggestion decision intents produced by this logical operation. Undo
    /// flips them to `revert`, redo replays them as `accept`; the journal must
    /// keep the ordered accept/revert transitions without deduplication.
    pub suggestion_decisions: Vec<SuggestionDecisionIntent>,
    bytes: usize,
}

impl HistoryEntry {
    pub fn new(before: AnnotationDocument, after: AnnotationDocument) -> Self {
        let bytes =
            document_memory_estimate(&before).saturating_add(document_memory_estimate(&after));
        Self {
            documents: Some((before, after)),
            suggestion_decisions: Vec::new(),
            bytes,
        }
    }

    pub fn decision_only(suggestion_decisions: Vec<SuggestionDecisionIntent>) -> Self {
        Self {
            documents: None,
            suggestion_decisions: Vec::new(),
            bytes: std::mem::size_of::<Self>(),
        }
        .with_suggestion_decisions(suggestion_decisions)
    }

    pub fn with_suggestion_decisions(
        mut self,
        suggestion_decisions: Vec<SuggestionDecisionIntent>,
    ) -> Self {
        self.bytes = self
            .bytes
            .saturating_add(decision_memory_estimate(&suggestion_decisions));
        self.suggestion_decisions = suggestion_decisions;
        self
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

    pub fn undo_changes_document(&self) -> bool {
        self.undo
            .last()
            .is_some_and(|entry| entry.documents.is_some())
    }

    pub fn redo_changes_document(&self) -> bool {
        self.redo
            .last()
            .is_some_and(|entry| entry.documents.is_some())
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

    pub fn undo(
        &mut self,
        current: &AnnotationDocument,
    ) -> Option<(Option<AnnotationDocument>, Vec<SuggestionDecisionIntent>)> {
        let entry = self.undo.pop()?;
        let document = entry.documents.as_ref().map(|(before, after)| {
            debug_assert_eq!(after, current);
            before.clone()
        });
        let decisions = crate::suggestions::revert_intents(&entry.suggestion_decisions);
        self.redo.push(entry);
        Some((document, decisions))
    }

    pub fn redo(
        &mut self,
        current: &AnnotationDocument,
    ) -> Option<(Option<AnnotationDocument>, Vec<SuggestionDecisionIntent>)> {
        let entry = self.redo.pop()?;
        let document = entry.documents.as_ref().map(|(before, after)| {
            debug_assert_eq!(before, current);
            after.clone()
        });
        let decisions = entry.suggestion_decisions.clone();
        self.undo.push(entry);
        Some((document, decisions))
    }
}

fn decision_memory_estimate(decisions: &[SuggestionDecisionIntent]) -> usize {
    decisions.iter().fold(0usize, |bytes, decision| {
        bytes
            .saturating_add(std::mem::size_of::<SuggestionDecisionIntent>())
            .saturating_add(decision.suggestion_set_id.len())
            .saturating_add(
                decision
                    .change_ids
                    .len()
                    .saturating_mul(std::mem::size_of::<annotation_domain::Id>()),
            )
            .saturating_add(decision.change_ids.iter().map(|id| id.len()).sum::<usize>())
    })
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
