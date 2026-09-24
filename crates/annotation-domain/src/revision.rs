use serde::{Deserialize, Serialize};

use crate::{
    document::{AnnotationDocument, Id},
    DomainError,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AnnotationRevision {
    pub annotation_revision_id: Id,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<Id>")]
    pub parent_revision_id: Option<Id>,
    #[serde(deserialize_with = "crate::safe_integer")]
    #[schemars(range(min = 0.0, max = 9007199254740991.0))]
    #[ts(type = "number")]
    pub revision_no: u64,
    pub document: AnnotationDocument,
    #[serde(deserialize_with = "crate::deserialize_utc_timestamp")]
    #[schemars(required, with = "crate::schema::UtcTimestamp")]
    #[ts(type = "string")]
    pub created_at: String,
    pub created_by: Id,
    pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct SuggestionDecisionIntent {
    pub suggestion_set_id: Id,
    pub change_ids: Vec<Id>,
    pub decision: SuggestionDecision,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionDecision {
    Accept,
    Revert,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct SaveLease {
    pub task_id: Id,
    #[serde(deserialize_with = "crate::safe_integer")]
    #[schemars(range(min = 0.0, max = 9007199254740991.0))]
    #[ts(type = "number")]
    pub fencing_token: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct SaveRequest {
    pub operation_id: Id,
    pub base_revision_id: Id,
    pub document: AnnotationDocument,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<SaveLease>")]
    pub lease: Option<SaveLease>,
    pub suggestion_decisions: Vec<SuggestionDecisionIntent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct SaveResponse {
    pub operation_id: Id,
    pub revision: AnnotationRevision,
    pub idempotent_replay: bool,
}

impl SaveRequest {
    pub fn validate(&self) -> Result<(), DomainError> {
        crate::document::validate_id(&self.operation_id)?;
        crate::document::validate_id(&self.base_revision_id)?;
        for intent in &self.suggestion_decisions {
            crate::document::validate_id(&intent.suggestion_set_id)?;
            let mut unique = std::collections::HashSet::with_capacity(intent.change_ids.len());
            for id in &intent.change_ids {
                crate::document::validate_id(id)?;
                if !unique.insert(id) {
                    return Err(DomainError::new(
                        "DUPLICATE_CHANGE_ID",
                        "change_ids must be unique within a decision",
                    ));
                }
            }
        }
        if let Some(lease) = &self.lease {
            crate::document::validate_id(&lease.task_id)?;
        }
        Ok(())
    }
}
