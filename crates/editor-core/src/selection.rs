use std::collections::{HashMap, HashSet};

use annotation_domain::Id;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LocalFlags {
    pub hidden: bool,
    pub locked: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Selection {
    selected: Vec<Id>,
    flags: HashMap<Id, LocalFlags>,
}

impl Selection {
    pub fn ids(&self) -> &[Id] {
        &self.selected
    }

    pub fn set(&mut self, ids: Vec<Id>) {
        let mut seen = HashSet::with_capacity(ids.len());
        self.selected = ids
            .into_iter()
            .filter(|id| seen.insert(id.clone()))
            .collect();
    }

    pub fn flags(&self, id: &Id) -> LocalFlags {
        self.flags.get(id).copied().unwrap_or_default()
    }

    pub fn update_flags(&mut self, ids: &[Id], hidden: Option<bool>, locked: Option<bool>) {
        for id in ids {
            let flags = self.flags.entry(id.clone()).or_default();
            if let Some(value) = hidden {
                flags.hidden = value;
            }
            if let Some(value) = locked {
                flags.locked = value;
            }
        }
    }

    pub(crate) fn retain_document_ids(&mut self, ids: &HashSet<Id>) {
        self.selected.retain(|id| ids.contains(id));
        self.flags.retain(|id, _| ids.contains(id));
    }

    pub(crate) fn is_locked(&self, id: &Id) -> bool {
        self.flags(id).locked
    }
}
