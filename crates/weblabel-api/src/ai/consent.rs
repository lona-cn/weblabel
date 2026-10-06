//! Persisted, actor/profile/fingerprint-bound consent intent. Creation records
//! explicit requested grants, not verified project/image/object scope or outbound
//! authorization. Run-time revalidation belongs to the orchestrator boundary.
use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    ai::{failure_response, AiState},
    auth::Principal,
    projects::now_rfc3339,
};

const BODY_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovedGrants {
    pub image: bool,
    pub selected_objects: bool,
    pub crop: Option<Crop>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Crop {
    pub x_min: f64,
    pub y_min: f64,
    pub x_max: f64,
    pub y_max: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateConsent {
    profile_id: String,
    input_fingerprint: String,
    approved_grants: ApprovedGrants,
}

#[derive(Debug, Clone)]
pub(crate) struct ConsentRecord {
    pub(crate) consent_id: String,
    pub(crate) grants: ApprovedGrants,
}

pub(super) async fn create(
    State(state): State<AiState>,
    Extension(principal): Extension<Principal>,
    request: Request<Body>,
) -> Response {
    let body = match to_bytes(request.into_body(), BODY_LIMIT).await {
        Ok(body) => body,
        Err(_) => {
            return failure_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "CONSENT_TOO_LARGE",
                "Consent request exceeds its size limit",
            )
        }
    };
    let body: CreateConsent = match serde_json::from_slice(&body) {
        Ok(body) => body,
        Err(_) => {
            return failure_response(
                StatusCode::BAD_REQUEST,
                "INVALID_CONSENT",
                "Request body does not match the consent contract",
            )
        }
    };
    if body.input_fingerprint.is_empty() || body.input_fingerprint.len() > 128 {
        return failure_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INPUT_FINGERPRINT_INVALID",
            "input_fingerprint must contain 1 to 128 bytes",
        );
    }
    if let Some(crop) = body.approved_grants.crop {
        if ![crop.x_min, crop.y_min, crop.x_max, crop.y_max]
            .into_iter()
            .all(f64::is_finite)
            || crop.x_min < 0.0
            || crop.y_min < 0.0
            || crop.x_min >= crop.x_max
            || crop.y_min >= crop.y_max
        {
            return failure_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_GRANT",
                "crop must be a finite, positive-area image region",
            );
        }
        if !body.approved_grants.image {
            return failure_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_GRANT",
                "a crop grant requires image access",
            );
        }
    }
    let mut tx = match state.repository.begin_write().await {
        Ok(tx) => tx,
        Err(_) => {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "CONSENT_FAILED",
                "Could not start consent transaction",
            )
        }
    };
    let profile =
        sqlx::query("SELECT provider_id, availability FROM model_profiles WHERE profile_id=?")
            .bind(&body.profile_id)
            .fetch_optional(tx.connection())
            .await;
    let profile = match profile {
        Ok(Some(profile)) => profile,
        Ok(None) => {
            return failure_response(
                StatusCode::NOT_FOUND,
                "PROFILE_NOT_FOUND",
                "Model profile was not found",
            )
        }
        Err(_) => {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "CONSENT_FAILED",
                "Could not verify model profile",
            )
        }
    };
    let provider: String = match profile.try_get("provider_id") {
        Ok(provider) => provider,
        Err(_) => {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "CONSENT_FAILED",
                "Could not verify model profile",
            )
        }
    };
    let availability: String = match profile.try_get("availability") {
        Ok(availability) => availability,
        Err(_) => {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "CONSENT_FAILED",
                "Could not verify model profile",
            )
        }
    };
    if availability != "ready" {
        return failure_response(
            StatusCode::FORBIDDEN,
            "PROFILE_UNAVAILABLE",
            "Model profile is no longer available",
        );
    }
    // This request has no project context and cannot verify outbound policy or
    // actual image/object scope. API providers fail closed. Codex/Claude local
    // runtimes may also send data externally: recording their intent below is
    // NOT permission to dispatch or transfer data through those runtimes.
    if matches!(
        provider.as_str(),
        "openai_api" | "anthropic_api" | "mimo_api"
    ) {
        return failure_response(
            StatusCode::FORBIDDEN,
            "OUTBOUND_POLICY_UNAVAILABLE",
            "Project outbound policy and actual grants are unavailable",
        );
    }
    let consent_id = Uuid::new_v4().to_string();
    let grants = match serde_json::to_string(&body.approved_grants) {
        Ok(grants) => grants,
        Err(_) => {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "CONSENT_FAILED",
                "Could not encode consent grants",
            )
        }
    };
    let inserted = sqlx::query("INSERT INTO consents(consent_id,actor_id,profile_id,input_fingerprint,approved_grants_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)")
        .bind(&consent_id).bind(&principal.user_id).bind(&body.profile_id).bind(&body.input_fingerprint).bind(grants).bind(now_rfc3339()).bind::<Option<String>>(None)
        .execute(tx.connection()).await;
    if inserted.is_err() || tx.commit().await.is_err() {
        return failure_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "CONSENT_FAILED",
            "Could not persist consent",
        );
    }
    (StatusCode::CREATED, Json(json!({"consent_id": consent_id}))).into_response()
}

pub(crate) async fn revalidate(
    connection: &mut sqlx::SqliteConnection,
    actor_id: &str,
    profile_id: &str,
    project_id: &str,
    input_fingerprint: &str,
    consent_id: Option<&str>,
    requires_image: bool,
) -> Result<Option<ConsentRecord>, Response> {
    let profile =
        sqlx::query("SELECT provider_id, availability FROM model_profiles WHERE profile_id=?")
            .bind(profile_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|_| {
                failure_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "CONSENT_CHECK_FAILED",
                    "Could not revalidate model profile",
                )
            })?;
    let Some(profile) = profile else {
        return Err(failure_response(
            StatusCode::NOT_FOUND,
            "PROFILE_NOT_FOUND",
            "Model profile was not found",
        ));
    };
    let provider: String = profile.try_get("provider_id").map_err(|_| {
        failure_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "CONSENT_CHECK_FAILED",
            "Could not revalidate model profile",
        )
    })?;
    let availability: String = profile.try_get("availability").map_err(|_| {
        failure_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "CONSENT_CHECK_FAILED",
            "Could not revalidate model profile",
        )
    })?;
    let member: Option<String> =
        sqlx::query_scalar("SELECT role FROM memberships WHERE project_id=? AND user_id=?")
            .bind(project_id)
            .bind(actor_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|_| {
                failure_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "CONSENT_CHECK_FAILED",
                    "Could not revalidate project membership",
                )
            })?;
    if member.is_none() {
        return Err(failure_response(
            StatusCode::NOT_FOUND,
            "PROJECT_NOT_FOUND",
            "Project is unavailable",
        ));
    }
    if availability != "ready" {
        return Err(failure_response(
            StatusCode::FORBIDDEN,
            "PROFILE_UNAVAILABLE",
            "Model profile is no longer available",
        ));
    }
    let outbound = matches!(
        provider.as_str(),
        "openai_api" | "anthropic_api" | "mimo_api"
    );
    if !outbound {
        return Ok(None);
    }
    let Some(consent_id) = consent_id else {
        return Err(failure_response(
            StatusCode::FORBIDDEN,
            "CONSENT_REQUIRED",
            "Network-backed model runs require matching consent",
        ));
    };
    let row = sqlx::query("SELECT consent_id, approved_grants_json FROM consents WHERE consent_id=? AND actor_id=? AND profile_id=? AND input_fingerprint=? AND (expires_at IS NULL OR expires_at > ?)")
        .bind(consent_id).bind(actor_id).bind(profile_id).bind(input_fingerprint).bind(now_rfc3339())
        .fetch_optional(&mut *connection).await
        .map_err(|_| failure_response(StatusCode::INTERNAL_SERVER_ERROR, "CONSENT_CHECK_FAILED", "Could not verify consent"))?;
    let Some(row) = row else {
        return Err(failure_response(
            StatusCode::FORBIDDEN,
            "CONSENT_INVALID",
            "Consent is expired or does not match this run",
        ));
    };
    let encoded: String = row.try_get("approved_grants_json").map_err(|_| {
        failure_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "CONSENT_CHECK_FAILED",
            "Could not read consent grants",
        )
    })?;
    let value: Value = serde_json::from_str(&encoded).map_err(|_| {
        failure_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "CONSENT_CORRUPT",
            "Stored consent grants are invalid",
        )
    })?;
    let grants: ApprovedGrants = serde_json::from_value(value).map_err(|_| {
        failure_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "CONSENT_CORRUPT",
            "Stored consent grants are invalid",
        )
    })?;
    // Until the project outbound-policy field and grant verifier are integrated,
    // image transfer stays denied even if a client forged a consent row.
    if requires_image || grants.image || grants.selected_objects {
        return Err(failure_response(
            StatusCode::FORBIDDEN,
            "OUTBOUND_POLICY_UNAVAILABLE",
            "Project outbound policy and actual image grants are not available; no image was sent",
        ));
    }
    Ok(Some(ConsentRecord {
        consent_id: consent_id.to_owned(),
        grants,
    }))
}
