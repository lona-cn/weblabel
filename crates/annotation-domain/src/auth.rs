//! Non-sensitive hints for the browser authentication entry point.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum BootstrapMode {
    Initial,
    Restore,
    Login,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct BootstrapStatus {
    pub mode: BootstrapMode,
    pub bootstrap_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum AdminRecoveryState {
    Disabled,
    Available,
    Expired,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AdminRecoveryStatus {
    pub state: AdminRecoveryState,
    pub request_id: Option<String>,
    pub username: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AdminRecoveryRequest {
    pub recovery_code: String,
    pub password: String,
}
