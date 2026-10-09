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
