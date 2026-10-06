use crate::document::Id;
use serde::{Deserialize, Serialize};

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum ActivityKind {
    Task,
    Annotation,
    Correction,
    Review,
    Switch,
    ModelWait,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ActivityInterval {
    #[serde(deserialize_with = "crate::safe_integer")]
    #[schemars(range(min = 0.0, max = 9007199254740991.0))]
    #[ts(type = "number")]
    pub seq: u64,
    pub kind: ActivityKind,
    #[serde(deserialize_with = "crate::safe_integer")]
    #[schemars(range(min = 1.0, max = 86400000.0))]
    #[ts(type = "number")]
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ActivityCheckpoint {
    #[serde(deserialize_with = "crate::safe_integer")]
    #[schemars(range(min = 0.0, max = 9007199254740991.0))]
    #[ts(type = "number")]
    pub expected_version: u64,
    pub intervals: Vec<ActivityInterval>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ActivitySession {
    pub session_id: Id,
    #[serde(deserialize_with = "crate::safe_integer")]
    #[schemars(range(min = 0.0, max = 9007199254740991.0))]
    #[ts(type = "number")]
    pub version: u64,
    pub intervals: Vec<ActivityInterval>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ActivitySessionPage {
    pub items: Vec<ActivitySession>,
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<Id>")]
    pub next_cursor: Option<Id>,
}
