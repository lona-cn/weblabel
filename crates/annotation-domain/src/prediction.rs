use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    document::{AnnotationObject, Attrs, Id},
    geometry::BBox,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ModelCapabilities {
    pub image_input: bool,
    pub tools: bool,
    pub structured_output: bool,
    pub bbox_output: bool,
    pub attributes: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ModelProfile {
    pub profile_id: Id,
    pub provider_id: ProviderId,
    pub model_id: String,
    pub auth_kind: AuthKind,
    pub capabilities: ModelCapabilities,
    pub availability: Availability,
    pub verification: Verification,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<String>")]
    pub runtime_version: Option<String>,
    #[serde(deserialize_with = "crate::deserialize_optional_utc_timestamp")]
    #[schemars(
        required,
        with = "crate::schema::Nullable<crate::schema::UtcTimestamp>"
    )]
    #[ts(type = "string | null")]
    pub verified_at: Option<String>,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId {
    CodexLocal,
    ClaudeLocal,
    OpenaiApi,
    AnthropicApi,
    MimoApi,
    DetectorLocal,
    Mock,
}
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    OfficialUserLogin,
    ApiKey,
    LocalWeights,
    None,
}
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Ready,
    NeedsLogin,
    NeedsConfiguration,
    Unsupported,
    Blocked,
}
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum Verification {
    NotRun,
    MockOnly,
    LivePassed,
    LiveFailed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct RunContext {
    pub project_id: Id,
    pub asset_revision_id: Id,
    pub annotation_revision_id: Id,
    pub ontology_version_id: Id,
    #[serde(deserialize_with = "crate::safe_integer")]
    #[schemars(range(min = 0.0, max = 9007199254740991.0))]
    #[ts(type = "number")]
    pub draft_generation: u64,
    pub canonical_sha256: String,
    pub selected_object_ids: Vec<Id>,
    pub object_hashes: BTreeMap<Id, String>,
    pub input_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct StartRunRequest {
    pub operation_id: Id,
    pub profile_id: Id,
    pub context: RunContext,
    pub intent: RunIntent,
    pub prompt: String,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<Id>")]
    pub consent_id: Option<Id>,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum RunIntent {
    Detect,
    AuditAttributes,
    FindIssues,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum Change {
    Create {
        change_id: Id,
        object: AnnotationObject,
        #[serde(deserialize_with = "crate::required_option")]
        #[schemars(required, with = "crate::schema::Nullable<String>")]
        before_hash: Option<String>,
        reason: String,
    },
    SetAttributes {
        change_id: Id,
        object_id: Id,
        #[schemars(with = "crate::schema::AttributeMap")]
        values: Attrs,
        before_hash: String,
        reason: String,
    },
    SetLabel {
        change_id: Id,
        object_id: Id,
        label_id: Id,
        before_hash: String,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct QualityIssue {
    pub issue_id: Id,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<Id>")]
    pub object_id: Option<Id>,
    pub code: String,
    pub message: String,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<BBox>")]
    pub region: Option<BBox>,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionState {
    Pending,
    Stale,
    Rejected,
    PartiallyAccepted,
    Accepted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct SuggestionSet {
    pub suggestion_set_id: Id,
    pub model_run_id: Id,
    pub prediction_id: Id,
    pub context: RunContext,
    pub changes: Vec<Change>,
    pub issues: Vec<QualityIssue>,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<f64>")]
    pub score: Option<f64>,
    pub state: SuggestionState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct RunEvent {
    pub run_id: Id,
    #[serde(deserialize_with = "crate::safe_integer")]
    #[schemars(range(min = 0.0, max = 9007199254740991.0))]
    #[ts(type = "number")]
    pub seq: u64,
    #[serde(rename = "type")]
    pub event_type: RunEventType,
    pub message: String,
    #[serde(deserialize_with = "crate::deserialize_optional_json_object")]
    #[schemars(
        required,
        with = "crate::schema::Nullable<std::collections::BTreeMap<String, serde_json::Value>>"
    )]
    #[ts(type = "Record<string, unknown> | null")]
    pub data: Option<std::collections::BTreeMap<String, serde_json::Value>>,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum RunEventType {
    Queued,
    Started,
    Progress,
    ToolCall,
    Candidate,
    Succeeded,
    Failed,
    Cancelled,
}
