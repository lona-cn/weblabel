use crate::{Completion, Id, MediaRevision, SaveLease};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AnnotationHeadSummary {
    pub ontology_version_id: Id,
    pub annotation_revision_id: Id,
    #[serde(deserialize_with = "crate::safe_integer")]
    #[schemars(range(min = 0.0, max = 9007199254740991.0))]
    #[ts(type = "number")]
    pub revision_no: u64,
    pub content_hash: String,
    pub completion: Completion,
    #[serde(deserialize_with = "crate::safe_integer")]
    #[schemars(range(min = 0.0, max = 9007199254740991.0))]
    #[ts(type = "number")]
    pub object_count: u64,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<Id>")]
    pub approved_review_id: Option<Id>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AnnotationHeadPage {
    pub items: Vec<AnnotationHeadSummary>,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<String>")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AssetAnnotationHead {
    pub media: MediaRevision,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<AnnotationHeadSummary>")]
    pub head: Option<AnnotationHeadSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AssetAnnotationHeadPage {
    pub items: Vec<AssetAnnotationHead>,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<String>")]
    pub next_cursor: Option<String>,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum ProjectMemberRole {
    Admin,
    Annotator,
    Reviewer,
    Viewer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectMember {
    pub user_id: Id,
    pub username: String,
    pub role: ProjectMemberRole,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectMemberPage {
    pub items: Vec<ProjectMember>,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<String>")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AnnotationImportCommitRequest {
    pub loss_ack: bool,
    pub operation_id: Id,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<SaveLease>")]
    pub lease: Option<SaveLease>,
}
