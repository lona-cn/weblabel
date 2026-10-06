//! Public server-owned preview, consent, and external-processing wire contracts.
use serde::{Deserialize, Serialize};

use crate::{BBox, Id, ModelProfile, StartRunRequest};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AiApprovedGrants {
    pub allow_image: bool,
    pub allow_object_context: bool,
    /// Explicit null approves the full image; omission must never broaden scope.
    #[serde(deserialize_with = "crate::required_option")]
    #[schemars(required, with = "crate::schema::Nullable<BBox>")]
    pub preview_crop: Option<BBox>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AiPreviewRequest {
    pub request: StartRunRequest,
    pub grants: AiApprovedGrants,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AiPreviewResponse {
    pub preview_id: Id,
    pub input_fingerprint: String,
    /// SHA-256 over the selected execution config, already sealed by input_fingerprint.
    pub execution_configuration_hash: String,
    pub request: StartRunRequest,
    pub profile: ModelProfile,
    pub grants: AiApprovedGrants,
    #[serde(deserialize_with = "crate::deserialize_utc_timestamp")]
    #[schemars(required, with = "crate::schema::UtcTimestamp")]
    #[ts(type = "string")]
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AiConsentRequest {
    pub preview_id: Id,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct AiConsentResponse {
    pub consent_id: Id,
    pub preview_id: Id,
    pub input_fingerprint: String,
    #[serde(deserialize_with = "crate::deserialize_utc_timestamp")]
    #[schemars(required, with = "crate::schema::UtcTimestamp")]
    #[ts(type = "string")]
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ExternalProcessingPolicy {
    pub allow_external_processing: bool,
}
