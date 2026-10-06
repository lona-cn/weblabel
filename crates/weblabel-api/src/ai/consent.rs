//! Immutable server-owned previews and run-scoped authorization (ADR 0002).
use super::{
    failure_response,
    runs::{self, RunFailure, RunRecord},
    AiState,
};
use crate::{auth::Principal, media::canonical::sha256_hex, projects::now_rfc3339};
use annotation_domain::{
    AiApprovedGrants, AiConsentRequest, AiConsentResponse, AiPreviewRequest, AiPreviewResponse,
    Availability, BBox, Id, ModelProfile, ProviderId, StartRunRequest,
};
use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection};
use uuid::Uuid;

struct Preview {
    id: String,
    actor: String,
    request: StartRunRequest,
    grants: AiApprovedGrants,
    configuration_hash: String,
    fingerprint: String,
    expires: String,
}
fn rejected(code: &'static str) -> RunFailure {
    RunFailure::new(
        StatusCode::FORBIDDEN,
        code,
        "The saved AI scope is no longer authorized",
    )
}
fn storage(_: impl std::fmt::Debug) -> RunFailure {
    RunFailure::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "AUTHORIZATION_STORAGE_FAILED",
        "Could not validate AI authorization",
    )
}
fn response(error: RunFailure) -> Response {
    failure_response(error.status, error.code, &error.message)
}
fn normalized(request: &StartRunRequest) -> StartRunRequest {
    let mut fixed = request.clone();
    fixed.operation_id = Id::from("fingerprint");
    fixed.consent_id = None;
    fixed.context.input_fingerprint.clear();
    fixed.context.selected_object_ids.sort();
    fixed
}
async fn configuration_hash(
    c: &mut SqliteConnection,
    profile: &ModelProfile,
    execution_hash: Option<&mut String>,
) -> Result<String, RunFailure> {
    let row = sqlx::query("SELECT config_json,secret_ref FROM model_profiles WHERE profile_id=?")
        .bind(&*profile.profile_id)
        .fetch_optional(&mut *c)
        .await
        .map_err(storage)?
        .ok_or_else(|| rejected("PROFILE_NOT_FOUND"))?;
    let configuration: Value =
        serde_json::from_str(&row.try_get::<String, _>("config_json").map_err(storage)?)
            .map_err(storage)?;
    let secret_ref: Option<String> = row.try_get("secret_ref").map_err(storage)?;
    if let Some(output) = execution_hash {
        *output = annotation_domain::hash::execution_configuration_hash(&configuration)
            .map_err(storage)?;
    }
    Ok(sha256_hex(
        serde_json::to_vec(
            &json!({"profile":profile,"configuration":configuration,"secret_ref":secret_ref}),
        )
        .map_err(storage)?
        .as_slice(),
    ))
}
async fn current(
    c: &mut SqliteConnection,
    actor: &str,
    request: &StartRunRequest,
    grants: &AiApprovedGrants,
    execution_hash: Option<&mut String>,
) -> Result<(ModelProfile, String, String), RunFailure> {
    runs::validate_context_on(c, actor, request).await?;
    let profile = runs::resolve_profile_on(c, &request.profile_id, true).await?;
    if profile.availability != Availability::Ready {
        return Err(rejected("PROFILE_UNAVAILABLE"));
    }
    if !matches!(
        profile.provider_id,
        ProviderId::DetectorLocal | ProviderId::Mock
    ) {
        let allowed: i64 =
            sqlx::query_scalar("SELECT allow_external_processing FROM projects WHERE project_id=?")
                .bind(&*request.context.project_id)
                .fetch_one(&mut *c)
                .await
                .map_err(storage)?;
        if allowed != 1 {
            return Err(rejected("EXTERNAL_PROCESSING_FORBIDDEN"));
        }
    }
    if grants.allow_image && !profile.capabilities.image_input {
        return Err(rejected("IMAGE_INPUT_UNSUPPORTED"));
    }
    let dimensions = sqlx::query(
        "SELECT canonical_width,canonical_height FROM media_metadata WHERE asset_revision_id=?",
    )
    .bind(&*request.context.asset_revision_id)
    .fetch_one(&mut *c)
    .await
    .map_err(storage)?;
    if let Some(crop) = &grants.preview_crop {
        let width: i64 = dimensions.try_get("canonical_width").map_err(storage)?;
        let height: i64 = dimensions.try_get("canonical_height").map_err(storage)?;
        if !grants.allow_image
            || annotation_domain::validate_bbox(crop, width as u32, height as u32).is_err()
            || [crop.x_min, crop.y_min, crop.x_max, crop.y_max]
                .iter()
                .any(|n| n.fract() != 0.0)
        {
            return Err(RunFailure::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_APPROVED_REGION",
                "Approved ROI must use actual integer pixel edges inside the canonical image",
            ));
        }
    }
    let head: Option<String> = sqlx::query_scalar("SELECT annotation_revision_id FROM annotation_heads WHERE project_id=? AND asset_revision_id=? AND ontology_version_id=?")
        .bind(&*request.context.project_id).bind(&*request.context.asset_revision_id).bind(&*request.context.ontology_version_id)
        .fetch_optional(&mut *c).await.map_err(storage)?;
    if head.as_deref() != Some(&*request.context.annotation_revision_id) {
        return Err(rejected("PREVIEW_INPUT_CHANGED"));
    }
    let revision = sqlx::query(
        "SELECT content_hash,body_json FROM annotation_revisions WHERE annotation_revision_id=?",
    )
    .bind(&*request.context.annotation_revision_id)
    .fetch_one(&mut *c)
    .await
    .map_err(storage)?;
    let document: annotation_domain::AnnotationDocument = serde_json::from_str(
        &revision
            .try_get::<String, _>("body_json")
            .map_err(storage)?,
    )
    .map_err(storage)?;
    // Every exposed object is frozen and hashed, including explicitly approved all-object scope.
    if grants.allow_object_context {
        let selected = &request.context.selected_object_ids;
        for object in document
            .objects
            .iter()
            .filter(|o| selected.is_empty() || selected.contains(&o.object_id))
        {
            if request.context.object_hashes.get(&object.object_id)
                != Some(&annotation_domain::object_hash(object))
            {
                return Err(rejected("CONTEXT_HASH_MISMATCH"));
            }
        }
    }
    let ontology: String = sqlx::query_scalar(
        "SELECT body_json FROM ontology_versions WHERE ontology_version_id=? AND project_id=?",
    )
    .bind(&*request.context.ontology_version_id)
    .bind(&*request.context.project_id)
    .fetch_one(&mut *c)
    .await
    .map_err(storage)?;
    let hash = configuration_hash(c, &profile, execution_hash).await?;
    let fingerprint=sha256_hex(&serde_json::to_vec(&json!({
        "request":normalized(request),"grants":grants,"profile_configuration_hash":hash,
        "annotation_content_hash":revision.try_get::<String,_>("content_hash").map_err(storage)?,
        "ontology":serde_json::from_str::<Value>(&ontology).map_err(storage)?,
        "canonical_dimensions":[dimensions.try_get::<i64,_>("canonical_width").map_err(storage)?,dimensions.try_get::<i64,_>("canonical_height").map_err(storage)?]
    })).map_err(storage)?);
    Ok((profile, hash, fingerprint))
}
async fn load_preview(
    c: &mut SqliteConnection,
    id: &str,
    actor: &str,
    check_expiry: bool,
) -> Result<Preview, RunFailure> {
    let row = sqlx::query("SELECT * FROM ai_run_previews WHERE preview_id=? AND actor_id=?")
        .bind(id)
        .bind(actor)
        .fetch_optional(&mut *c)
        .await
        .map_err(storage)?
        .ok_or_else(|| {
            RunFailure::new(
                StatusCode::NOT_FOUND,
                "PREVIEW_NOT_FOUND",
                "AI preview not found",
            )
        })?;
    let preview = Preview {
        id: id.to_owned(),
        actor: actor.to_owned(),
        request: serde_json::from_str(&row.try_get::<String, _>("request_json").map_err(storage)?)
            .map_err(storage)?,
        grants: serde_json::from_str(&row.try_get::<String, _>("grants_json").map_err(storage)?)
            .map_err(storage)?,
        configuration_hash: row.try_get("profile_configuration_hash").map_err(storage)?,
        fingerprint: row.try_get("input_fingerprint").map_err(storage)?,
        expires: row.try_get("expires_at").map_err(storage)?,
    };
    if check_expiry
        && chrono::DateTime::parse_from_rfc3339(&preview.expires).map_err(storage)?
            <= chrono::Utc::now()
    {
        return Err(rejected("PREVIEW_EXPIRED"));
    }
    let (_, hash, fingerprint) = current(c, actor, &preview.request, &preview.grants, None).await?;
    if hash != preview.configuration_hash || fingerprint != preview.fingerprint {
        return Err(rejected("PREVIEW_INPUT_CHANGED"));
    }
    Ok(preview)
}
pub(super) async fn preview(
    State(state): State<AiState>,
    Extension(actor): Extension<Principal>,
    request: Request<Body>,
) -> Response {
    let result=async {
        let bytes=to_bytes(request.into_body(),runs::MAX_RUN_REQUEST_BYTES).await.map_err(|_| RunFailure::new(StatusCode::PAYLOAD_TOO_LARGE,"PREVIEW_TOO_LARGE","AI preview exceeds its budget"))?;
        let mut input:AiPreviewRequest=serde_json::from_slice(&bytes).map_err(|_| RunFailure::new(StatusCode::BAD_REQUEST,"INVALID_PREVIEW","Request does not match the preview contract"))?;
        if input.request.prompt.chars().count()>runs::MAX_PROMPT_CHARS || input.request.context.object_hashes.len()>runs::MAX_OBJECT_HASHES { return Err(rejected("PREVIEW_TOO_LARGE")); }
        input.request.consent_id=None;
        input.request.context.selected_object_ids.sort();
        if input.request.context.selected_object_ids.windows(2).any(|w|w[0]==w[1]) { return Err(rejected("DUPLICATE_SELECTED_OBJECT")); }
        let mut tx=state.repository.begin_write().await.map_err(storage)?;
        let mut execution_configuration_hash = String::new();
        let (profile,hash,fingerprint)=current(tx.connection(),&actor.user_id,&input.request,&input.grants,Some(&mut execution_configuration_hash)).await?;
        if profile.provider_id==ProviderId::Mock && !state.allow_mock_runs { return Err(rejected("PROFILE_UNAVAILABLE")); }
        input.request.context.input_fingerprint=fingerprint.clone();
        let id=Uuid::new_v4().to_string();
        let expires=(chrono::Utc::now()+chrono::Duration::minutes(10)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
        sqlx::query("INSERT INTO ai_run_previews(preview_id,actor_id,project_id,profile_id,input_fingerprint,request_json,profile_configuration_hash,grants_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
            .bind(&id).bind(&actor.user_id).bind(&*input.request.context.project_id).bind(&*input.request.profile_id).bind(&fingerprint)
            .bind(serde_json::to_string(&input.request).map_err(storage)?).bind(hash).bind(serde_json::to_string(&input.grants).map_err(storage)?)
            .bind(now_rfc3339()).bind(&expires).execute(tx.connection()).await.map_err(storage)?;
        tx.commit().await.map_err(storage)?;
        Ok::<_,RunFailure>((StatusCode::CREATED,Json(AiPreviewResponse {preview_id:id.into(),input_fingerprint:fingerprint,execution_configuration_hash,request:input.request,profile,grants:input.grants,expires_at:expires})).into_response())
    }.await;
    result.unwrap_or_else(response)
}
pub(super) async fn create(
    State(state): State<AiState>,
    Extension(actor): Extension<Principal>,
    request: Request<Body>,
) -> Response {
    let result=async {
        let bytes=to_bytes(request.into_body(),4096).await.map_err(|_|rejected("CONSENT_TOO_LARGE"))?;
        let input:AiConsentRequest=serde_json::from_slice(&bytes).map_err(|_|RunFailure::new(StatusCode::BAD_REQUEST,"INVALID_CONSENT","Consent must name one server preview"))?;
        let mut tx=state.repository.begin_write().await.map_err(storage)?;
        let fixed=load_preview(tx.connection(),&input.preview_id,&actor.user_id,true).await?;
        let id=Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO consents(consent_id,actor_id,profile_id,input_fingerprint,approved_grants_json,created_at,expires_at,preview_id) VALUES(?,?,?,?,?,?,?,?)")
            .bind(&id).bind(&fixed.actor).bind(&*fixed.request.profile_id).bind(&fixed.fingerprint).bind(serde_json::to_string(&fixed.grants).map_err(storage)?)
            .bind(now_rfc3339()).bind(&fixed.expires).bind(&fixed.id).execute(tx.connection()).await.map_err(storage)?;
        tx.commit().await.map_err(storage)?;
        Ok::<_,RunFailure>((StatusCode::CREATED,Json(AiConsentResponse {consent_id:id.into(),preview_id:fixed.id.into(),input_fingerprint:fixed.fingerprint,expires_at:fixed.expires})).into_response())
    }.await;
    result.unwrap_or_else(response)
}
pub(crate) struct RunAuthorization {
    preview_id: String,
    grants_json: String,
    configuration_hash: String,
}
pub(crate) async fn authorize_request(
    c: &mut SqliteConnection,
    actor: &str,
    request: &StartRunRequest,
) -> Result<RunAuthorization, RunFailure> {
    let fixed = consent_preview(c, actor, request).await?;
    Ok(RunAuthorization {
        preview_id: fixed.id,
        grants_json: serde_json::to_string(&fixed.grants).map_err(storage)?,
        configuration_hash: fixed.configuration_hash,
    })
}
async fn consent_preview(
    c: &mut SqliteConnection,
    actor: &str,
    request: &StartRunRequest,
) -> Result<Preview, RunFailure> {
    let id = request
        .consent_id
        .as_deref()
        .ok_or_else(|| rejected("CONSENT_REQUIRED"))?;
    let row=sqlx::query("SELECT preview_id,input_fingerprint,profile_id,approved_grants_json FROM consents WHERE consent_id=? AND actor_id=?")
        .bind(id).bind(actor).fetch_optional(&mut *c).await.map_err(storage)?.ok_or_else(||rejected("CONSENT_INVALID"))?;
    let preview_id: Option<String> = row.try_get("preview_id").map_err(storage)?;
    let fixed = load_preview(
        c,
        &preview_id.ok_or_else(|| rejected("CONSENT_PREVIEW_REQUIRED"))?,
        actor,
        true,
    )
    .await?;
    if normalized(&fixed.request) != normalized(request)
        || request.context.input_fingerprint != fixed.fingerprint
        || row
            .try_get::<String, _>("input_fingerprint")
            .map_err(storage)?
            != fixed.fingerprint
        || row.try_get::<String, _>("profile_id").map_err(storage)? != *request.profile_id
        || serde_json::from_str::<AiApprovedGrants>(
            &row.try_get::<String, _>("approved_grants_json")
                .map_err(storage)?,
        )
        .map_err(storage)?
            != fixed.grants
    {
        return Err(rejected("CONSENT_INPUT_MISMATCH"));
    }
    Ok(fixed)
}
pub(crate) async fn record_authorization(
    c: &mut SqliteConnection,
    run_id: &str,
    authorization: &RunAuthorization,
) -> Result<(), RunFailure> {
    sqlx::query("INSERT INTO model_run_authorizations(run_id,preview_id,grants_json,profile_configuration_hash,capability_expires_at) VALUES(?,?,?,?,?)")
        .bind(run_id).bind(&authorization.preview_id).bind(&authorization.grants_json).bind(&authorization.configuration_hash)
        .bind((chrono::Utc::now()+chrono::Duration::minutes(10)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true))
        .execute(c).await.map_err(storage)?;
    Ok(())
}
/// Validate referenced objects and proposed regions against the same frozen scope
/// used by reads. Schema/domain validation still runs in the prediction funnel.
pub fn validate_candidate_scope(
    grants: &AiApprovedGrants,
    context: &annotation_domain::RunContext,
    raw: &Value,
) -> Result<(), RunFailure> {
    let approved_object = |id: &str| {
        grants.allow_object_context
            && context.object_hashes.keys().any(|key| &**key == id)
            && (context.selected_object_ids.is_empty()
                || context
                    .selected_object_ids
                    .iter()
                    .any(|selected| &**selected == id))
    };
    let approved_region = |value: &Value| -> Result<(), RunFailure> {
        if let Some(approved) = &grants.preview_crop {
            if let Ok(region) = serde_json::from_value::<BBox>(value.clone()) {
                if region.x_min < approved.x_min
                    || region.y_min < approved.y_min
                    || region.x_max > approved.x_max
                    || region.y_max > approved.y_max
                {
                    return Err(rejected("CANDIDATE_REGION_NOT_APPROVED"));
                }
            }
        }
        Ok(())
    };
    if let Some(changes) = raw.get("changes").and_then(Value::as_array) {
        for change in changes {
            if let Some(id) = change.get("object_id").and_then(Value::as_str) {
                if !approved_object(id) {
                    return Err(rejected("OBJECT_CONTEXT_NOT_APPROVED"));
                }
            }
            if let Some(geometry) = change
                .get("object")
                .and_then(|object| object.get("geometry"))
            {
                approved_region(geometry)?;
            }
        }
    }
    if let Some(issues) = raw.get("issues").and_then(Value::as_array) {
        for issue in issues {
            if let Some(id) = issue.get("object_id").and_then(Value::as_str) {
                if !approved_object(id) {
                    return Err(rejected("OBJECT_CONTEXT_NOT_APPROVED"));
                }
            }
            if let Some(region) = issue.get("region") {
                approved_region(region)?;
            }
        }
    }
    Ok(())
}

/// Revalidate before dispatch and each token-bound read/proposal. Preview expiry
/// limits creation, not already queued execution; cancellation remains authoritative.
pub async fn authorize_run(
    c: &mut SqliteConnection,
    record: &RunRecord,
) -> Result<AiApprovedGrants, RunFailure> {
    authorize_run_state(c, record, false).await
}

/// Late submissions are validated but the common funnel only quarantines them;
/// this never authorizes a terminal run to disclose data or dispatch a provider.
pub(crate) async fn authorize_submission(
    c: &mut SqliteConnection,
    record: &RunRecord,
) -> Result<AiApprovedGrants, RunFailure> {
    authorize_run_state(c, record, true).await
}

async fn authorize_run_state(
    c: &mut SqliteConnection,
    record: &RunRecord,
    allow_quarantine: bool,
) -> Result<AiApprovedGrants, RunFailure> {
    if record.cancel_requested
        || matches!(
            record.state,
            runs::RunState::Cancelled | runs::RunState::Interrupted
        )
        || (!allow_quarantine && record.state.is_terminal())
    {
        return Err(rejected("RUN_NOT_ACTIVE"));
    }
    let row=sqlx::query("SELECT preview_id,grants_json,profile_configuration_hash,capability_expires_at FROM model_run_authorizations WHERE run_id=?")
        .bind(&record.run_id).fetch_optional(&mut *c).await.map_err(storage)?.ok_or_else(||rejected("RUN_AUTHORIZATION_REQUIRED"))?;
    let deadline: Option<String> = row.try_get("capability_expires_at").map_err(storage)?;
    let deadline = deadline.ok_or_else(|| rejected("RUN_CAPABILITY_EXPIRED"))?;
    if chrono::DateTime::parse_from_rfc3339(&deadline).map_err(storage)? <= chrono::Utc::now() {
        return Err(rejected("RUN_CAPABILITY_EXPIRED"));
    }
    let fixed = load_preview(
        c,
        &row.try_get::<String, _>("preview_id").map_err(storage)?,
        &record.actor_id,
        false,
    )
    .await?;
    let context = record.context().map_err(storage)?;
    if context != fixed.request.context
        || record.profile_id != *fixed.request.profile_id
        || record.prompt != fixed.request.prompt
        || record.intent != runs::intent_str(fixed.request.intent)
        || row
            .try_get::<String, _>("profile_configuration_hash")
            .map_err(storage)?
            != fixed.configuration_hash
        || serde_json::from_str::<AiApprovedGrants>(
            &row.try_get::<String, _>("grants_json").map_err(storage)?,
        )
        .map_err(storage)?
            != fixed.grants
    {
        return Err(rejected("RUN_AUTHORIZATION_INVALID"));
    }
    Ok(fixed.grants)
}
