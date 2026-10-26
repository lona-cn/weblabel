//! Safe public model metadata and exact service-owned legacy/native presets.
use annotation_domain::ModelProfile;
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use sqlx::{sqlite::SqliteRow, Row};

use super::{failure_response, AiState};

fn decode(row: SqliteRow) -> Result<ModelProfile, Box<dyn std::error::Error>> {
    let capabilities: String = row.try_get("capabilities_json")?;
    // The domain DTO validates capability fields, enums and optional timestamps.
    // Only these selected public columns are ever passed to serialization.
    Ok(serde_json::from_value(json!({
        "profile_id": row.try_get::<String, _>("profile_id")?,
        "provider_id": row.try_get::<String, _>("provider_id")?,
        "model_id": row.try_get::<String, _>("model_id")?,
        "auth_kind": row.try_get::<String, _>("auth_kind")?,
        "capabilities": serde_json::from_str::<annotation_domain::ModelCapabilities>(&capabilities)?,
        "availability": row.try_get::<String, _>("availability")?,
        "verification": row.try_get::<String, _>("verification")?,
        "runtime_version": row.try_get::<Option<String>, _>("runtime_version")?,
        "verified_at": row.try_get::<Option<String>, _>("verified_at")?,
    }))?)
}

pub(super) async fn list(State(state): State<AiState>) -> Response {
    let mut tx = match state.repository.begin_write().await {
        Ok(tx) => tx,
        Err(_) => return failed(),
    };
    let native_http = matches!(&state.profile_configuration,
        crate::runtime::config::ProfileConfiguration::Native(Ok(Some(_))));
    let rows = match sqlx::query(
        "SELECT profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at, \
         CASE WHEN ? AND provider_id IN ('openai_api','anthropic_api','mimo_api') THEN config_json ELSE NULL END AS native_config_json \
         FROM model_profiles WHERE provider_id != 'codex_local' ORDER BY profile_id",
    ).bind(native_http).fetch_all(tx.connection()).await {
        Ok(rows) => rows,
        Err(_) => return failed(),
    };
    if tx.commit().await.is_err() {
        return failed();
    }
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let stored_hash = match row.try_get::<Option<&str>, _>("native_config_json") {
            Ok(Some(raw)) => {
                let Ok(config) = serde_json::from_str::<Value>(raw) else { return failed(); };
                match annotation_domain::hash::execution_configuration_hash(&config) {
                    Ok(hash) => Some(hash),
                    Err(_) => return failed(),
                }
            }
            Ok(None) => None,
            Err(_) => return failed(),
        };
        match decode(row) {
            Ok(mut profile) => {
                native_availability(&state, &mut profile, stored_hash.as_deref());
                items.push(profile);
            }
            Err(_) => return failed(),
        }
    }
    (
        StatusCode::OK,
        Json(json!({"items": items, "next_cursor": null})),
    )
        .into_response()
}

fn failed() -> Response {
    failure_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "PROFILE_LIST_FAILED",
        "Could not read model profiles",
    )
}

use crate::auth::Principal;
use axum::{
    extract::{Path, Query},
    Extension,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
pub(super) struct PresetQuery {
    after: Option<String>,
    limit: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProvisionRequest {
    configuration_hash: String,
}
#[derive(Serialize)]
pub struct ModelProfilePreset {
    pub preset_id: String,
    pub profile_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub auth_kind: String,
    pub capabilities: annotation_domain::ModelCapabilities,
    pub configuration_hash: String,
    pub configured: bool,
    pub availability: String,
    pub availability_reason: String,
}
struct Preset {
    public: ModelProfilePreset,
    config: Value,
}
fn denied() -> Response {
    failure_response(
        StatusCode::FORBIDDEN,
        "PLATFORM_ADMIN_REQUIRED",
        "Platform administrator required",
    )
}
fn config_error() -> Response {
    failure_response(StatusCode::UNPROCESSABLE_ENTITY,"HOST_CONFIGURATION_UNAVAILABLE","Host presets are missing, invalid or ambiguous. A local operator must prepare the private Host configuration; manual annotation remains available.")
}
fn clean_private(v: &Value) -> bool {
    match v {
        Value::Object(map) => map.iter().all(|(k, v)| {
            let lower = k.to_lowercase();
            (lower == "secret_ref"
                || (lower == "max_output_tokens" && v.is_number())
                || ![
                    "secret",
                    "token",
                    "password",
                    "authorization",
                    "api_key",
                    "apikey",
                ]
                .iter()
                .any(|part| lower.contains(part)))
                && ![
                    "secret_env",
                    "source_env",
                    "transport",
                    "fetch_impl",
                    "imagesource",
                    "runtoken",
                    "headers",
                    "env",
                ]
                .contains(&lower.as_str())
                && (lower != "secret_ref" || v.as_str().is_some_and(valid_ref))
                && clean_private(v)
        }),
        Value::Array(items) => items.iter().all(clean_private),
        Value::String(s) => {
            super::redact_text(s) == *s
                && !s.contains("Bearer ")
                && !s.contains("--api-key")
                && !s.contains("--token")
        }
        _ => true,
    }
}
fn valid_ref(s: &str) -> bool {
    let Some(name) = s.strip_prefix("env:") else {
        return false;
    };
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
fn allowed_keys(v: &Value, allowed: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|m| m.keys().all(|k| allowed.contains(&k.as_str())))
}
fn safe_id(s: &str) -> bool {
    annotation_domain::document::validate_id(s).is_ok() && super::redact_text(s) == s
}

fn valid_command(value: &Value, no_flags: bool) -> bool {
    allowed_keys(value, &["executable", "argv"])
        && value
            .get("executable")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty() && !s.contains(['\0', '\n', '\r']))
        && value
            .get("argv")
            .and_then(Value::as_array)
            .is_some_and(|a| {
                a.iter().all(|v| {
                    v.as_str().is_some_and(|s| {
                        !s.contains(['\0', '\n', '\r']) && (!no_flags || !s.starts_with('-'))
                    })
                })
            })
}
fn valid_string_array(value: Option<&Value>) -> bool {
    value.and_then(Value::as_array).is_some_and(|a| {
        a.iter()
            .all(|v| v.as_str().is_some_and(|s| !s.contains(['\0', '\n', '\r'])))
    })
}
fn valid_local_config(provider: &str, config: &Value) -> bool {
    if provider == "claude_local" {
        let Some(p) = config.get("permissions") else {
            return false;
        };
        allowed_keys(
            config,
            &[
                "permissions",
                "schemaArtifactPath",
                "pricing",
                "probeTimeoutMs",
                "runTimeoutMs",
                "budgets",
            ],
        ) && allowed_keys(
            p,
            &[
                "command",
                "mcpCommand",
                "runRoot",
                "forbiddenCwdRoots",
                "envAllowlist",
                "apiBase",
                "model",
                "sessionId",
                "toolPolicy",
            ],
        ) && ["command", "mcpCommand"]
            .iter()
            .all(|key| p.get(*key).is_some_and(|v| valid_command(v, true)))
            && p.get("runRoot")
                .and_then(Value::as_str)
                .is_some_and(|s| std::path::Path::new(s).is_absolute())
            && valid_string_array(p.get("forbiddenCwdRoots"))
            && valid_string_array(p.get("envAllowlist"))
    } else {
        let Some(policy) = config.get("spawnPolicy") else {
            return false;
        };
        allowed_keys(
            config,
            &[
                "spawnPolicy",
                "workerCommand",
                "workerCwd",
                "lockPath",
                "labelMapPath",
                "probeTimeoutMs",
                "runTimeoutMs",
            ],
        ) && allowed_keys(
            policy,
            &["trusted_executable_roots", "allowed_env", "cwd_root"],
        ) && valid_string_array(policy.get("trusted_executable_roots"))
            && valid_string_array(policy.get("allowed_env"))
            && policy
                .get("cwd_root")
                .and_then(Value::as_str)
                .is_some_and(|s| std::path::Path::new(s).is_absolute())
            && config
                .get("workerCommand")
                .is_some_and(|v| valid_command(v, false))
            && ["workerCwd", "lockPath", "labelMapPath"].iter().all(|key| {
                config
                    .get(*key)
                    .and_then(Value::as_str)
                    .is_some_and(|s| std::path::Path::new(s).is_absolute())
            })
    }
}

fn valid_optional_settings(config: &Value, api: bool) -> bool {
    let budgets = if api {
        &[
            "max_tool_turns",
            "max_total_bytes",
            "max_run_ms",
            "max_output_tokens",
            "max_image_bytes",
            "max_pixels",
            "max_crops",
        ][..]
    } else {
        &["max_tool_turns", "max_tool_result_bytes"][..]
    };
    if let Some(value) = config.get("budgets") {
        if !allowed_keys(value, budgets)
            || !value.as_object().is_some_and(|map| {
                map.values().all(|v| {
                    v.as_f64().is_some_and(|n| {
                        n.is_finite()
                            && n >= 0.0
                            && n.fract() == 0.0
                            && n <= 9_007_199_254_740_991.0
                    })
                })
            })
        {
            return false;
        }
    }
    if let Some(value) = config.get("pricing").filter(|v| !v.is_null()) {
        if !allowed_keys(value, &["input_per_million_usd", "output_per_million_usd"])
            || !value.as_object().is_some_and(|m| {
                m.values()
                    .all(|v| v.is_null() || v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
            })
        {
            return false;
        }
    }
    for field in [
        "timeout_ms",
        "max_response_bytes",
        "max_stream_bytes",
        "probeTimeoutMs",
        "runTimeoutMs",
    ] {
        if let Some(v) = config.get(field).filter(|v| !v.is_null()) {
            if !v.as_f64().is_some_and(|n| {
                n.is_finite() && n > 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0
            }) {
                return false;
            }
        }
    }
    true
}

pub(crate) fn http_base_approval(config: &Value) -> bool {
    let approval = &config["base_approval"];
    approval["approved"] == true
        && approval["approved_by"].as_str().is_some_and(|admin| {
            config["local_admins"].as_array().is_some_and(|admins| {
                admins.iter().any(|value| value.as_str() == Some(admin))
            })
        })
        && approval["approved_at"].as_str().is_some_and(|value| {
            chrono::DateTime::parse_from_rfc3339(value).is_ok()
        })
}

/// Shared HTTP configuration validation; does not resolve secrets or probe a provider.
pub(crate) fn http_metadata<'a>(
    provider: &str,
    config: &'a Value,
    secret_available: impl Fn(&str) -> bool,
    native_executor: bool,
) -> Result<(&'a str, &'a str, &'static str, Value, &'static str, &'static str), Response> {
    if !clean_private(config) || !valid_optional_settings(config, true) {
        return Err(config_error());
    }
    Ok({
            if !allowed_keys(
                config,
                &[
                    "profile_id",
                    "model_id",
                    "credential",
                    "api_base",
                    "base_approval",
                    "local_admins",
                    "capabilities",
                    "account_model_verified",
                    "budgets",
                    "pricing",
                    "timeout_ms",
                    "max_response_bytes",
                    "max_stream_bytes",
                ],
            ) {
                return Err(config_error());
            }
            let profile = config
                .get("profile_id")
                .and_then(Value::as_str)
                .filter(|s| safe_id(s))
                .ok_or_else(config_error)?;
            let model = config
                .get("model_id")
                .and_then(Value::as_str)
                .filter(|s| safe_id(s))
                .ok_or_else(config_error)?;
            let credential = config
                .get("credential")
                .filter(|v| allowed_keys(v, &["secret_ref"]))
                .ok_or_else(config_error)?;
            let reference = credential
                .get("secret_ref")
                .and_then(Value::as_str)
                .filter(|s| valid_ref(s))
                .ok_or_else(config_error)?;
            if config
                .get("account_model_verified")
                .is_some_and(|v| !v.is_boolean())
                || config
                    .get("local_admins")
                    .is_some_and(|v| !valid_string_array(Some(v)))
            {
                return Err(config_error());
            }
            if let Some(approval) = config.get("base_approval") {
                if !allowed_keys(
                    approval,
                    &[
                        "approved",
                        "approved_by",
                        "approved_at",
                        "allow_private_network",
                        "allow_insecure_http",
                    ],
                ) || approval.get("approved") != Some(&Value::Bool(true))
                    || !approval
                        .get("approved_by")
                        .and_then(Value::as_str)
                        .is_some_and(safe_id)
                    || approval
                        .get("approved_at")
                        .and_then(Value::as_str)
                        .is_none()
                {
                    return Err(config_error());
                }
            }
            if let Some(base) = config.get("api_base") {
                let raw = base.as_str().ok_or_else(config_error)?;
                let uri: axum::http::Uri = raw.parse().map_err(|_| config_error())?;
                let insecure_approved = uri.scheme_str() == Some("http")
                    && http_base_approval(config)
                    && config["base_approval"]["allow_insecure_http"] == true;
                if (uri.scheme_str() != Some("https") && !insecure_approved)
                    || uri.authority().is_none_or(|a| a.as_str().contains('@'))
                    || raw.contains('?')
                    || raw.contains('#')
                {
                    return Err(config_error());
                }
            }
            let caps = config.get("capabilities").cloned().unwrap_or_else(||json!({"image_input":false,"tools":false,"structured_output":false,"bbox_output":false,"attributes":false}));
            annotation_domain::ModelCapabilities::deserialize(&caps).map_err(|_| config_error())?;
            let reference_available = secret_available(&reference[4..]);
            let evidence = config.get("account_model_verified") == Some(&Value::Bool(true))
                && config.get("capabilities").is_some();
            // Native dispatch enforces DNS/private-network policy; metadata grants
            // configuration eligibility only, never a live-verification result.
            let official = match provider {
                "openai_api" => "https://api.openai.com/v1",
                "anthropic_api" => "https://api.anthropic.com",
                _ => "https://api.xiaomimimo.com/v1",
            };
            let custom_base = config
                .get("api_base")
                .and_then(Value::as_str)
                .is_some_and(|s| s.trim_end_matches('/') != official);
            let (available, reason) = if !reference_available {
                ("needs_configuration","Allowlisted secret reference is absent; prepare it locally, never submit a token to the browser")
            } else if !evidence {
                (
                    "blocked",
                    "Explicit account model and capability evidence is missing",
                )
            } else if native_executor && caps["tools"] != true {
                ("blocked","Native HTTP execution requires tool-call capability")
            } else if custom_base && !(native_executor && http_base_approval(config)) {
                ("blocked","Custom endpoint runtime approval has not been checked; no network probe was performed")
            } else if native_executor {
                ("ready","Native HTTP configuration permits an attempt; live verification has not run and DNS/scope authorization are enforced at dispatch")
            } else {
                ("ready","Host configuration and explicit account capability evidence are present; live verification has not run")
            };
            (profile, model, "api_key", caps, available, reason)
    })
}

fn parse_presets(
    raw: &str,
    allowed_env: &str,
    has_secret: impl Fn(&str) -> bool,
) -> Result<Vec<Preset>, Response> {
    let host: Value = serde_json::from_str(raw).map_err(|_| config_error())?;
    let base: axum::http::Uri = host
        .get("apiBase")
        .and_then(Value::as_str)
        .ok_or_else(config_error)?
        .parse()
        .map_err(|_| config_error())?;
    if base.scheme_str() != Some("http")
        || !matches!(base.host(), Some("127.0.0.1" | "localhost" | "[::1]"))
        || base.port_u16().is_none_or(|p| p == 0)
        || base.authority().is_some_and(|a| a.as_str().contains('@'))
        || base.query().is_some()
        || !host
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .is_some_and(|n| n > 0)
    {
        return Err(config_error());
    }
    let providers = host
        .get("providers")
        .and_then(Value::as_array)
        .filter(|a| a.len() <= 500)
        .ok_or_else(config_error)?;
    let mut result = Vec::with_capacity(providers.len());
    for entry in providers {
        let provider = entry
            .get("provider")
            .and_then(Value::as_str)
            .ok_or_else(config_error)?;
        let config = entry
            .get("config")
            .filter(|c| c.is_object() && clean_private(c))
            .ok_or_else(config_error)?;
        let api = matches!(provider, "openai_api" | "anthropic_api" | "mimo_api");
        if !valid_optional_settings(config, api) {
            return Err(config_error());
        }
        let (profile, model, auth, caps, availability, reason) = if api {
            http_metadata(provider, config,
                |name| allowed_env.split(',').any(|allowed| allowed == name) && has_secret(name), false)?
        } else if provider == "claude_local" {
            if !valid_local_config(provider, config) {
                return Err(config_error());
            }
            ("claude_local","unknown","official_user_login",json!({"image_input":true,"tools":true,"structured_output":true,"bbox_output":false,"attributes":true}),"needs_login","Official runtime and personal login have not been checked. A local operator must prepare them; this check does not log in or invoke the runtime")
        } else if provider == "detector_local" {
            if !valid_local_config(provider, config) {
                return Err(config_error());
            }
            ("detector_local","unknown","local_weights",json!({"image_input":true,"tools":false,"structured_output":true,"bbox_output":true,"attributes":false}),"needs_configuration","Worker identity, pinned local weights and mapping have not been checked. No weights are downloaded or model executed")
        } else {
            return Err(config_error());
        };
        if result
            .iter()
            .any(|p: &Preset| p.public.profile_id == profile)
        {
            return Err(config_error());
        }
        let hash =
            annotation_domain::hash::host_execution_configuration_hash(raw, provider, profile)
                .map_err(|_| config_error())?;
        if annotation_domain::hash::execution_configuration_hash(config)
            .map_err(|_| config_error())?
            != hash
        {
            return Err(config_error());
        }
        result.push(Preset {
            public: ModelProfilePreset {
                preset_id: hash.clone(),
                profile_id: profile.to_owned(),
                provider_id: provider.to_owned(),
                model_id: model.to_owned(),
                auth_kind: auth.to_owned(),
                capabilities: serde_json::from_value(caps).map_err(|_| config_error())?,
                configuration_hash: hash,
                configured: false,
                availability: availability.to_owned(),
                availability_reason: reason.to_owned(),
            },
            config: config.clone(),
        });
    }
    result.sort_by(|a, b| a.public.profile_id.cmp(&b.public.profile_id));
    Ok(result)
}
fn read_metadata(path: &str) -> Result<String, Response> {
    use std::io::Read;
    if !std::path::Path::new(path).is_absolute() {
        return Err(config_error());
    }
    let file = std::fs::File::open(path).map_err(|_| config_error())?;
    let mut raw = String::new();
    file.take(1024 * 1024 + 1)
        .read_to_string(&mut raw)
        .map_err(|_| config_error())?;
    if raw.len() > 1024 * 1024 {
        return Err(config_error());
    }
    Ok(raw)
}
fn host_presets() -> Result<Vec<Preset>, Response> {
    // An absent or explicitly empty setting means AI has not been configured.
    // A configured but unreadable/invalid path must still fail closed.
    let path = match std::env::var("WEBLABEL_HOST_CONFIG") {
        Err(std::env::VarError::NotPresent) => return Ok(Vec::new()),
        Ok(path) if path.is_empty() => return Ok(Vec::new()),
        Ok(path) => path,
        Err(std::env::VarError::NotUnicode(_)) => return Err(config_error()),
    };
    let raw = read_metadata(&path)?;
    let mut presets = parse_presets(
        &raw,
        &std::env::var("WEBLABEL_HOST_ALLOWED_ENV").unwrap_or_default(),
        |key| std::env::var(key).is_ok_and(|s| !s.is_empty()),
    )?;
    for preset in &mut presets {
        if preset.public.provider_id == "detector_local" {
            let lock = preset
                .config
                .get("lockPath")
                .and_then(Value::as_str)
                .and_then(|path| read_metadata(path).ok())
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
            if let Some(model) = lock
                .as_ref()
                .and_then(|v| v.get("model_id"))
                .and_then(Value::as_str)
                .filter(|s| safe_id(s))
            {
                preset.public.model_id = model.to_owned();
            } else {
                preset.public.availability_reason="Pinned detector model identity is unavailable. Prepare the local model lock and weights; no profile can be provisioned until its actual identity is known".to_owned();
            }
        }
    }
    Ok(presets)
}

fn native_config_error() -> Response {
    failure_response(StatusCode::UNPROCESSABLE_ENTITY, "RUNTIME_CONFIGURATION_UNAVAILABLE",
        "Native runtime presets are invalid or unavailable. A local operator must prepare the private configuration; manual annotation remains available.")
}

fn native_availability(state: &AiState, profile: &mut ModelProfile, stored_hash: Option<&str>) {
    use annotation_domain::{AuthKind, Availability, ModelCapabilities, ProviderId};
    let crate::runtime::config::ProfileConfiguration::Native(configuration) = &state.profile_configuration else { return; };
    if profile.provider_id == ProviderId::Mock { return; }
    let current = (|| {
        let runtime = configuration.as_ref().ok()?.as_ref()?;
        let provider = match profile.provider_id {
            ProviderId::OpenaiApi => "openai_api",
            ProviderId::AnthropicApi => "anthropic_api",
            ProviderId::MimoApi => "mimo_api",
            _ => return None,
        };
        let private = runtime.selected(provider, &profile.profile_id).ok()?;
        let hash = runtime.configuration_hash(provider, &profile.profile_id).ok()?;
        if stored_hash != Some(hash.as_str()) { return None; }
        let (_, model, auth, caps, available, _) = native_http_metadata(runtime, provider, private).ok()?;
        if model != &*profile.model_id || auth != "api_key" || profile.auth_kind != AuthKind::ApiKey
            || serde_json::from_value::<ModelCapabilities>(caps).ok()? != profile.capabilities {
            return None;
        }
        Some(match available {
            "ready" => Availability::Ready,
            "blocked" => Availability::Blocked,
            _ => Availability::NeedsConfiguration,
        })
    })();
    // Do not promote a historical operator-blocked profile through a GET.
    // Explicit provisioning persists fresh eligibility; verification stays separate.
    if current != Some(Availability::Ready) {
        profile.availability = current.unwrap_or(Availability::NeedsConfiguration);
    }
}

fn native_http_metadata<'a>(
    runtime: &crate::runtime::config::RuntimeConfig,
    provider: &str,
    config: &'a Value,
) -> Result<(&'a str, &'a str, &'static str, Value, &'static str, &'static str), Response> {
    http_metadata(provider, config, |name| {
        runtime.allowed_secret_env().iter().any(|allowed| allowed == name)
            && std::env::var(name).is_ok_and(|value| !value.is_empty() && !value.contains(['\r', '\n', '\0']))
    }, true)
}

fn native_presets(config: &crate::runtime::config::RuntimeConfig) -> Result<Vec<Preset>, Response> {
    let mut result = Vec::with_capacity(config.providers().len());
    for entry in config.providers() {
        let profile = entry.config["profile_id"].as_str().ok_or_else(native_config_error)?;
        let (model, auth, caps, availability, reason) = match entry.provider.as_str() {
            "openai_api" | "anthropic_api" | "mimo_api" => {
                let (_, model, auth, caps, availability, reason) =
                    native_http_metadata(config, &entry.provider, &entry.config).map_err(|_| native_config_error())?;
                (model.to_owned(), auth, caps, availability, reason)
            }
            "claude_local" => (
                entry.config["model_id"].as_str().ok_or_else(native_config_error)?.to_owned(),
                "official_user_login",
                json!({"image_input":true,"tools":true,"structured_output":true,"bbox_output":false,"attributes":true}),
                "needs_configuration",
                "Native official runtime, personal login and isolation have not been checked; no process was started",
            ),
            "detector_local" => {
                // Read only the explicitly configured public model lock metadata, never weights.
                let model = entry.config["lock_path"].as_str()
                    .and_then(|path| read_metadata(path).ok())
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                    .and_then(|lock| lock.get("model_id").and_then(Value::as_str)
                        .filter(|id| safe_id(id)).map(str::to_owned))
                    .unwrap_or_else(|| "unknown".to_owned());
                (model, "local_weights",
                    json!({"image_input":true,"tools":false,"structured_output":true,"bbox_output":true,"attributes":false}),
                    "needs_configuration",
                    "Native detector identity, derived model and runtime have not been verified; no weights were loaded or downloaded")
            }
            _ => return Err(native_config_error()),
        };
        let hash = config.configuration_hash(&entry.provider, profile).map_err(|_| native_config_error())?;
        result.push(Preset {
            public: ModelProfilePreset {
                preset_id: hash.clone(),
                profile_id: profile.to_owned(),
                provider_id: entry.provider.clone(),
                model_id: model,
                auth_kind: auth.to_owned(),
                capabilities: serde_json::from_value(caps).map_err(|_| native_config_error())?,
                configuration_hash: hash,
                configured: false,
                availability: availability.to_owned(),
                availability_reason: reason.to_owned(),
            },
            config: entry.config.clone(),
        });
    }
    result.sort_by(|a, b| a.public.profile_id.cmp(&b.public.profile_id));
    Ok(result)
}

fn active_presets(configuration: &crate::runtime::config::ProfileConfiguration) -> Result<Vec<Preset>, Response> {
    use crate::runtime::config::ProfileConfiguration;
    match configuration {
        ProfileConfiguration::LegacyHost => host_presets(),
        ProfileConfiguration::Native(Ok(Some(config))) => native_presets(config),
        ProfileConfiguration::Native(Ok(None)) => Ok(Vec::new()),
        ProfileConfiguration::Native(Err(_)) => Err(native_config_error()),
    }
}

pub(super) async fn presets(
    State(state): State<AiState>,
    Extension(actor): Extension<Principal>,
    Query(query): Query<PresetQuery>,
) -> Response {
    if !actor.platform_admin {
        return denied();
    }
    let result = async {
        let limit = query.limit.unwrap_or(50);
        if limit==0 || limit>100 || query.after.as_ref().is_some_and(|s|!safe_id(s)) { return Err(failure_response(StatusCode::BAD_REQUEST,"INVALID_PAGE","Invalid preset page")); }
        let mut presets = active_presets(&state.profile_configuration)?;
        let mut tx = state.repository.begin_write().await.map_err(|_|failed())?;
        for preset in &mut presets {
            let stored=sqlx::query("SELECT config_json,provider_id,model_id,auth_kind,capabilities_json FROM model_profiles WHERE profile_id=?").bind(&preset.public.profile_id).fetch_optional(tx.connection()).await.map_err(|_|failed())?;
            if let Some(row)=stored {
                let config: Value=serde_json::from_str(row.get::<&str,_>("config_json")).map_err(|_|failed())?;
                let capabilities: Value=serde_json::from_str(row.get::<&str,_>("capabilities_json")).map_err(|_|failed())?;
                preset.public.configured=annotation_domain::hash::execution_configuration_hash(&config).map_err(|_|failed())?==preset.public.configuration_hash && row.get::<&str,_>("provider_id")==preset.public.provider_id && row.get::<&str,_>("model_id")==preset.public.model_id && row.get::<&str,_>("auth_kind")==preset.public.auth_kind && capabilities==serde_json::to_value(&preset.public.capabilities).map_err(|_|failed())?;
            }
        }
        tx.commit().await.map_err(|_|failed())?;
        let mut items: Vec<ModelProfilePreset> = presets.into_iter().map(|p|p.public).filter(|p|query.after.as_ref().is_none_or(|after|p.profile_id>*after)).take(limit+1).collect();
        let next = if items.len()>limit { items.pop(); items.last().map(|p|p.profile_id.clone()) } else { None };
        Ok(Json(json!({"items":items,"next_cursor":next})).into_response())
    }.await;
    result.unwrap_or_else(|e| e)
}

pub(super) async fn get(
    State(state): State<AiState>,
    Path(id): Path<String>,
    Extension(actor): Extension<Principal>,
) -> Response {
    if !actor.platform_admin {
        return denied();
    }
    let result = async {
        let mut tx = state.repository.begin_write().await.map_err(|_|failed())?;
        let row=sqlx::query("SELECT profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json FROM model_profiles WHERE profile_id=? AND provider_id NOT IN ('codex_local','mock')").bind(&id).fetch_optional(tx.connection()).await.map_err(|_|failed())?.ok_or_else(||failure_response(StatusCode::NOT_FOUND,"PROFILE_NOT_FOUND","Model profile not found"))?;
        let config: Value=serde_json::from_str(&row.try_get::<String,_>("config_json").map_err(|_|failed())?).map_err(|_|failed())?;
        let hash=annotation_domain::hash::execution_configuration_hash(&config).map_err(|_|failed())?;
        let mut profile=decode(row).map_err(|_|failed())?;
        native_availability(&state, &mut profile, Some(&hash));
        tx.commit().await.map_err(|_|failed())?;
        Ok(Json(json!({"profile":profile,"configuration_hash":hash})).into_response())
    }.await;
    result.unwrap_or_else(|e| e)
}

pub(super) async fn provision(
    State(state): State<AiState>,
    Path(id): Path<String>,
    Extension(actor): Extension<Principal>,
    Json(input): Json<ProvisionRequest>,
) -> Response {
    if !actor.platform_admin {
        return denied();
    }
    let result = async {
        let preset = active_presets(&state.profile_configuration)?.into_iter().find(|p|p.public.profile_id==id && p.public.configuration_hash==input.configuration_hash).ok_or_else(||failure_response(StatusCode::NOT_FOUND,"PRESET_NOT_FOUND","No unique service-owned preset matches this profile and configuration hash"))?;
        if preset.public.provider_id=="detector_local" && preset.public.model_id=="unknown" {return Err(failure_response(StatusCode::UNPROCESSABLE_ENTITY,"DETECTOR_IDENTITY_UNAVAILABLE","Prepare the local pinned model lock before provisioning; no model or weight download is performed"));}
        let mut tx=state.repository.begin_write().await.map_err(|_|failed())?;
        let previous=sqlx::query("SELECT config_json,provider_id,model_id,auth_kind,capabilities_json FROM model_profiles WHERE profile_id=?").bind(&id).fetch_optional(tx.connection()).await.map_err(|_|failed())?;
        if let Some(previous)=previous {
            let config: Value=serde_json::from_str(&previous.get::<String,_>("config_json")).map_err(|_|failed())?;
            let capabilities: Value=serde_json::from_str(&previous.get::<String,_>("capabilities_json")).map_err(|_|failed())?;
            if annotation_domain::hash::execution_configuration_hash(&config).map_err(|_|failed())? != input.configuration_hash || previous.get::<String,_>("provider_id")!=preset.public.provider_id || previous.get::<String,_>("model_id")!=preset.public.model_id || previous.get::<String,_>("auth_kind")!=preset.public.auth_kind || capabilities!=serde_json::to_value(&preset.public.capabilities).map_err(|_|failed())? {return Err(failure_response(StatusCode::CONFLICT,"PROFILE_CONFIGURATION_CONFLICT","Existing profile identity or configuration differs; historical profiles cannot be overwritten"));}
            if matches!(&state.profile_configuration, crate::runtime::config::ProfileConfiguration::Native(_))
                && matches!(preset.public.provider_id.as_str(), "openai_api" | "anthropic_api" | "mimo_api") {
                sqlx::query("UPDATE model_profiles SET availability=? WHERE profile_id=?")
                    .bind(&preset.public.availability).bind(&id).execute(tx.connection()).await.map_err(|_|failed())?;
            }
        } else {
            let p=&preset.public;
            sqlx::query("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES(?,?,?,?,?,?,'not_run',NULL,NULL,?,NULL,?)").bind(&id).bind(&p.provider_id).bind(&p.model_id).bind(&p.auth_kind).bind(serde_json::to_string(&p.capabilities).map_err(|_|failed())?).bind(&p.availability).bind(serde_json::to_string(&preset.config).map_err(|_|failed())?).bind(crate::projects::now_rfc3339()).execute(tx.connection()).await.map_err(|_|failed())?;
        }
        let row=sqlx::query("SELECT profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at FROM model_profiles WHERE profile_id=?").bind(&id).fetch_one(tx.connection()).await.map_err(|_|failed())?;
        let mut profile=decode(row).map_err(|_|failed())?;
        native_availability(&state, &mut profile, Some(&input.configuration_hash));
        tx.commit().await.map_err(|_|failed())?;
        Ok(Json(profile).into_response())
    }.await;
    result.unwrap_or_else(|e| e)
}

#[cfg(test)]
mod native_tests {
    use super::*;
    use crate::runtime::config::{ProfileConfiguration, RuntimeConfig, RuntimeConfigurationError};

    #[test]
    fn native_absence_and_invalid_config_are_distinct_without_legacy_fallback() {
        assert!(active_presets(&ProfileConfiguration::Native(Ok(None))).unwrap().is_empty());
        let response = active_presets(&ProfileConfiguration::Native(Err(RuntimeConfigurationError))).err().unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn native_local_presets_use_exact_profile_ids_and_hashes_without_readiness_claims() {
        let entries: Vec<Value> = ["local-first", "local-second"].into_iter().map(|profile| json!({
            "provider":"claude_local","config":{
                "profile_id":profile,"model_id":"claude-sonnet-synthetic",
                "executable":std::env::current_exe().unwrap(),"timeout_ms":1000,
                "max_tool_turns":5,"max_tool_result_bytes":4096
            }
        })).collect();
        let raw = json!({"schema_version":1,"timeout_ms":1000,"providers":entries}).to_string();
        let config = RuntimeConfig::parse(&raw, &[]).unwrap();
        let presets = native_presets(&config).unwrap();
        assert_eq!(presets.len(), 2);
        for (preset, expected) in presets.iter().zip(["local-first", "local-second"]) {
            assert_eq!(preset.public.profile_id, expected);
            assert_eq!(preset.public.configuration_hash, config.configuration_hash("claude_local", expected).unwrap());
            assert_eq!(preset.public.model_id, "claude-sonnet-synthetic");
            assert_eq!(preset.public.availability, "needs_configuration");
            assert!(!preset.public.configured);
        }
    }
}

#[cfg(test)]
pub(crate) mod ux_tests {
    use super::*;
    use crate::{
        auth::{AuthConfig, AuthState},
        storage::Repository,
    };
    use axum::{
        body::{to_bytes, Body},
        http::Request,
        middleware,
        routing::get,
        Router,
    };
    use tower::ServiceExt;
    pub(crate) async fn auth_router(
        routes: Router<AiState>,
        repository: Repository,
        database: &str,
    ) -> Router {
        let pool = sqlx::SqlitePool::connect(database).await.unwrap();
        let auth = AuthState::new(pool, AuthConfig {
            bind: "127.0.0.1:48100".parse().unwrap(),
            cookie_secure: false,
            allowed_origins: vec!["http://localhost".into()],
            allowed_hosts: vec!["localhost".into()],
            launch_code: String::new(),
            launch_code_expires_at: 0,
        }, std::time::Duration::from_secs(2))
        .unwrap();
        routes
            .route_layer(middleware::from_fn_with_state(
                auth.clone(),
                crate::auth::authenticate,
            ))
            .route_layer(middleware::from_fn_with_state(
                auth,
                crate::auth::csrf_and_origin,
            ))
            .with_state(AiState {
                repository,
                allow_mock_runs: false,
                run_tokens: Default::default(),
                profile_configuration: crate::runtime::config::ProfileConfiguration::LegacyHost,
            })
    }
    pub(crate) async fn seed_session(repository: &Repository, user: &str, token: &str) {
        let mut tx = repository.begin_write().await.unwrap();
        sqlx::query("INSERT INTO sessions(session_id,user_id,expires_at,created_at,csrf_hash) VALUES(?,?,'9999999999','0',?)").bind(crate::media::canonical::sha256_hex(token.as_bytes())).bind(user).bind(crate::media::canonical::sha256_hex(b"ux-csrf")).execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
    }
    pub(crate) async fn call(
        app: &Router,
        method: &str,
        path: &str,
        token: Option<&str>,
        csrf: bool,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "localhost")
            .header("origin", "http://localhost")
            .header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header("cookie", format!("weblabel_session={token}"));
        }
        if csrf {
            builder = builder.header("x-csrf-token", "ux-csrf");
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    pub(crate) async fn loopback_smoke(
        app: Router,
        method: &str,
        path: &str,
        token: &str,
        body: Value,
    ) -> String {
        loopback_response(app, method, path, token, body, StatusCode::OK).await
    }

    async fn loopback_response(
        app: Router,
        method: &str,
        path: &str,
        token: &str,
        body: Value,
        expected: StatusCode,
    ) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let request=format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost\r\nCookie: weblabel_session={token}\r\nx-csrf-token: ux-csrf\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.to_string().len(),body);
        let reply = tokio::task::spawn_blocking(move || {
            use std::io::{Read, Write};
            let mut socket = std::net::TcpStream::connect(address).unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            socket.write_all(request.as_bytes()).unwrap();
            let mut response = String::new();
            socket
                .take(1024 * 1024)
                .read_to_string(&mut response)
                .unwrap();
            response
        })
        .await
        .unwrap();
        server.abort();
        let _ = server.await;
        assert!(
            reply.starts_with(&format!("HTTP/1.1 {}", expected.as_u16())),
            "unexpected loopback HTTP response: {reply}"
        );
        reply
    }

    fn api_host() -> Value {
        json!({"apiBase":"http://127.0.0.1:48100","timeoutMs":1000,"providers":[{"provider":"openai_api","config":{"profile_id":"ux-api","model_id":"exact-model","credential":{"secret_ref":"env:UX_SYNTHETIC_KEY"},"account_model_verified":true,"capabilities":{"image_input":true,"tools":true,"structured_output":true,"bbox_output":false,"attributes":true}}}]})
    }
    #[test]
    fn ux_presets_hash_exact_host_and_hide_private_values() {
        let host = api_host();
        let raw = host.to_string();
        let presets = parse_presets(&raw, "UX_SYNTHETIC_KEY", |_| true).unwrap();
        assert_eq!(
            presets[0].public.configuration_hash,
            annotation_domain::hash::execution_configuration_hash(&host["providers"][0]["config"])
                .unwrap()
        );
        let public = serde_json::to_string(&presets[0].public).unwrap();
        for field in [
            "secret_ref",
            "UX_SYNTHETIC_KEY",
            "config_json",
            "endpoint",
            "apiBase",
        ] {
            assert!(!public.contains(field));
        }
        assert_eq!(presets[0].public.availability, "ready");
        assert_eq!(
            parse_presets(&raw, "", |_| true).unwrap()[0]
                .public
                .availability,
            "needs_configuration"
        );
        let mut unverified = host.clone();
        unverified["providers"][0]["config"]["account_model_verified"] = json!(false);
        let mut budgeted = host.clone();
        budgeted["providers"][0]["config"]["budgets"] = json!({"max_output_tokens":512});
        assert!(parse_presets(&budgeted.to_string(), "", |_| false).is_ok());
        budgeted["providers"][0]["config"]["budgets"]["max_output_tokens"] =
            json!("synthetic-token-value");
        assert!(parse_presets(&budgeted.to_string(), "", |_| false).is_err());
        assert_eq!(
            parse_presets(&unverified.to_string(), "UX_SYNTHETIC_KEY", |_| true).unwrap()[0]
                .public
                .availability,
            "blocked"
        );
    }
    #[test]
    fn ux_presets_reject_private_unknown_and_ambiguous_entries() {
        for field in [
            "secret_env",
            "source_env",
            "fetch_impl",
            "transport",
            "imageSource",
            "api_key",
            "unknown",
        ] {
            let mut host = api_host();
            host["providers"][0]["config"][field] = json!("synthetic-private-value");
            assert!(
                parse_presets(&host.to_string(), "", |_| false).is_err(),
                "{field}"
            );
        }
        let mut host = api_host();
        let duplicate = host["providers"][0].clone();
        host["providers"].as_array_mut().unwrap().push(duplicate);
        assert!(parse_presets(&host.to_string(), "", |_| false).is_err());
        for provider in ["mock", "codex_local", "unknown"] {
            let mut host = api_host();
            host["providers"][0]["provider"] = json!(provider);
            assert!(parse_presets(&host.to_string(), "", |_| false).is_err());
        }
        let mut host = api_host();
        host["providers"][0]["config"]["credential"] =
            json!({"secret_ref":"inline-synthetic-secret"});
        assert!(parse_presets(&host.to_string(), "", |_| false).is_err());
        let mut host = api_host();
        host["providers"][0]["config"]["capabilities"]["apiKey"] =
            json!("raw-synthetic-credential");
        assert!(parse_presets(&host.to_string(), "", |_| false).is_err());
    }
    #[test]
    fn ux_empty_host_presets_are_distinct_from_broken_configuration() {
        const CHILD: &str = "WEBLABEL_UX_EMPTY_PRESETS_CHILD";
        if std::env::var(CHILD).as_deref() != Ok("1") {
            // Changes are confined to this exact child test, never visible to
            // parallel tests or the user's private Host configuration.
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "ai::profiles::ux_tests::ux_empty_host_presets_are_distinct_from_broken_configuration", "--nocapture"])
                .env(CHILD, "1")
                .env_remove("WEBLABEL_HOST_CONFIG")
                .env_remove("WEBLABEL_HOST_ALLOWED_ENV")
                .output().unwrap();
            print!("{}", String::from_utf8_lossy(&output.stdout));
            assert!(output.status.success(), "isolated child failed: {}", String::from_utf8_lossy(&output.stderr));
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let target = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target");
            std::fs::create_dir_all(&target).unwrap();
            let directory = tempfile::tempdir_in(target).unwrap();
            let db = format!("sqlite:{}", directory.path().join("empty-presets.sqlite").display());
            let repository = Repository::open(&db, directory.path().join("objects"), std::time::Duration::from_secs(5)).await.unwrap();
            let mut tx = repository.begin_write().await.unwrap();
            sqlx::query("INSERT INTO users(user_id,username,password_hash,created_at,platform_admin) VALUES('ux-admin','ux-admin','hash','0',1),('ux-reader','ux-reader','hash','0',0)").execute(tx.connection()).await.unwrap();
            tx.commit().await.unwrap();
            seed_session(&repository, "ux-admin", "admin-session").await;
            seed_session(&repository, "ux-reader", "reader-session").await;
            let app = auth_router(Router::new().route("/api/model-profile-presets", get(presets)).route("/api/model-profiles/{id}", get(super::get).put(provision)), repository.clone(), &db).await;
            for setting in [None, Some("")] {
                unsafe {
                    match setting {
                        None => std::env::remove_var("WEBLABEL_HOST_CONFIG"),
                        Some(value) => std::env::set_var("WEBLABEL_HOST_CONFIG", value),
                    }
                }
                let reply = loopback_response(app.clone(), "GET", "/api/model-profile-presets?limit=100", "admin-session", json!({}), StatusCode::OK).await;
                let page: Value = serde_json::from_str(reply.split_once("\r\n\r\n").unwrap().1).unwrap();
                assert_eq!(page, json!({"items":[], "next_cursor":null}));
                println!("loopback host_setting={setting:?} status=200 body={page}");
                assert_eq!(call(&app, "GET", "/api/model-profile-presets", None, false, json!({})).await.0, StatusCode::UNAUTHORIZED);
                assert_eq!(call(&app, "GET", "/api/model-profile-presets", Some("reader-session"), false, json!({})).await.0, StatusCode::FORBIDDEN);
                let (status, body) = call(&app, "PUT", "/api/model-profiles/unknown", Some("admin-session"), true, json!({"configuration_hash":"a".repeat(64)})).await;
                assert_eq!(status, StatusCode::NOT_FOUND);
                assert_eq!(body["code"], "PRESET_NOT_FOUND");
            }
            let path = directory.path().join("synthetic-host.json");
            let mut ambiguous = api_host();
            let duplicate = ambiguous["providers"][0].clone();
            ambiguous["providers"].as_array_mut().unwrap().push(duplicate);
            for (label, raw) in [("malformed", "{broken".to_owned()), ("invalid", "{}".to_owned()), ("ambiguous", ambiguous.to_string())] {
                std::fs::write(&path, raw).unwrap();
                unsafe { std::env::set_var("WEBLABEL_HOST_CONFIG", &path); }
                let reply = loopback_response(app.clone(), "GET", "/api/model-profile-presets?limit=100", "admin-session", json!({}), StatusCode::UNPROCESSABLE_ENTITY).await;
                let body: Value = serde_json::from_str(reply.split_once("\r\n\r\n").unwrap().1).unwrap();
                assert_eq!(body["code"], "HOST_CONFIGURATION_UNAVAILABLE");
                println!("loopback host_setting={label} status=422 code={}", body["code"]);
            }
            for path in [directory.path().join("missing.json"), std::path::PathBuf::from("relative.json"), std::path::PathBuf::from(" ")] {
                unsafe { std::env::set_var("WEBLABEL_HOST_CONFIG", path); }
                let (status, body) = call(&app, "GET", "/api/model-profile-presets", Some("admin-session"), false, json!({})).await;
                assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
                assert_eq!(body["code"], "HOST_CONFIGURATION_UNAVAILABLE");
            }
            let mut tx = repository.begin_write().await.unwrap();
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM model_profiles").fetch_one(tx.connection()).await.unwrap();
            assert_eq!(count, 0);
        });
    }

    struct HostEnv {
        old: Option<std::ffi::OsString>,
    }
    impl Drop for HostEnv {
        fn drop(&mut self) {
            unsafe {
                if let Some(old) = &self.old {
                    std::env::set_var("WEBLABEL_HOST_CONFIG", old);
                } else {
                    std::env::remove_var("WEBLABEL_HOST_CONFIG");
                }
            }
        }
    }
    #[tokio::test]
    async fn ux_profile_http_provisions_real_storage_idempotently_without_exposing_secrets() {
        // This test is the only environment writer in this module. Its Host file is synthetic and owned under target.
        let target = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target");
        std::fs::create_dir_all(&target).unwrap();
        let directory = tempfile::tempdir_in(target).unwrap();
        let db = format!(
            "sqlite:{}",
            directory.path().join("profiles.sqlite").display()
        );
        let repository = Repository::open(
            &db,
            directory.path().join("objects"),
            std::time::Duration::from_secs(5),
        )
        .await
        .unwrap();
        let mut tx = repository.begin_write().await.unwrap();
        sqlx::query("INSERT INTO users(user_id,username,password_hash,created_at,platform_admin) VALUES('ux-admin','ux-admin','hash','0',1),('ux-reader','ux-reader','hash','0',0)").execute(tx.connection()).await.unwrap();
        tx.commit().await.unwrap();
        seed_session(&repository, "ux-admin", "admin-session").await;
        seed_session(&repository, "ux-reader", "reader-session").await;
        let path = directory.path().join("host.json");
        let host = api_host();
        std::fs::write(&path, host.to_string()).unwrap();
        let _restore = HostEnv {
            old: std::env::var_os("WEBLABEL_HOST_CONFIG"),
        };
        unsafe {
            std::env::set_var("WEBLABEL_HOST_CONFIG", &path);
        }
        let app = auth_router(
            Router::new()
                .route("/api/model-profile-presets", get(presets))
                .route("/api/model-profiles/{id}", get(super::get).put(provision))
                .route("/api/model-profiles", get(list)),
            repository.clone(),
            &db,
        )
        .await;
        assert_eq!(
            call(
                &app,
                "GET",
                "/api/model-profile-presets",
                None,
                false,
                json!({})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &app,
                "GET",
                "/api/model-profile-presets",
                Some("reader-session"),
                false,
                json!({})
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &app,
                "GET",
                "/api/model-profile-presets?limit=101",
                Some("admin-session"),
                false,
                json!({})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        let (status, page) = call(
            &app,
            "GET",
            "/api/model-profile-presets?limit=1",
            Some("admin-session"),
            false,
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let reply = loopback_smoke(
            app.clone(),
            "GET",
            "/api/model-profile-presets",
            "admin-session",
            json!({}),
        )
        .await;
        assert!(reply.contains("ux-api"));
        assert!(!reply.contains("secret_ref"));
        let hash = page["items"][0]["configuration_hash"].as_str().unwrap();
        let payload = json!({"configuration_hash":hash});
        assert_eq!(
            call(
                &app,
                "PUT",
                "/api/model-profiles/ux-api",
                Some("admin-session"),
                false,
                payload.clone()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &app,
                "PUT",
                "/api/model-profiles/ux-api",
                Some("reader-session"),
                true,
                payload.clone()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &app,
                "PUT",
                "/api/model-profiles/ux-api",
                Some("admin-session"),
                true,
                json!({"configuration_hash":hash,"secret":"synthetic"})
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let (status, profile) = call(
            &app,
            "PUT",
            "/api/model-profiles/ux-api",
            Some("admin-session"),
            true,
            payload.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(profile["verification"], "not_run");
        assert_eq!(profile["verified_at"], Value::Null);
        assert_eq!(
            call(
                &app,
                "PUT",
                "/api/model-profiles/ux-api",
                Some("admin-session"),
                true,
                payload
            )
            .await,
            (StatusCode::OK, profile.clone())
        );
        let (status, stored) = call(
            &app,
            "GET",
            "/api/model-profiles/ux-api",
            Some("admin-session"),
            false,
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(stored["configuration_hash"], hash);
        let (_, public) = call(
            &app,
            "GET",
            "/api/model-profiles",
            Some("reader-session"),
            false,
            json!({}),
        )
        .await;
        for projection in [&page, &profile, &stored, &public] {
            let text = projection.to_string();
            assert!(!text.contains("UX_SYNTHETIC_KEY"));
            assert!(!text.contains("secret_ref"));
            assert!(!text.contains("host.json"));
        }
        let mut tx = repository.begin_write().await.unwrap();
        let row: String =
            sqlx::query_scalar("SELECT config_json FROM model_profiles WHERE profile_id='ux-api'")
                .fetch_one(tx.connection())
                .await
                .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&row).unwrap(),
            host["providers"][0]["config"]
        );
        tx.commit().await.unwrap();
        let mut changed = host.clone();
        changed["providers"][0]["config"]["model_id"] = json!("other-model");
        std::fs::write(&path, changed.to_string()).unwrap();
        let changed_hash = annotation_domain::hash::execution_configuration_hash(
            &changed["providers"][0]["config"],
        )
        .unwrap();
        assert_eq!(
            call(
                &app,
                "PUT",
                "/api/model-profiles/ux-api",
                Some("admin-session"),
                true,
                json!({"configuration_hash":changed_hash})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            call(
                &app,
                "PUT",
                "/api/model-profiles/missing",
                Some("admin-session"),
                true,
                json!({"configuration_hash":hash})
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );

        std::fs::write(&path, host.to_string()).unwrap();
        let mut tx = repository.begin_write().await.unwrap();
        sqlx::query(
            "UPDATE model_profiles SET model_id='mismatched-history' WHERE profile_id='ux-api'",
        )
        .execute(tx.connection())
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            call(
                &app,
                "PUT",
                "/api/model-profiles/ux-api",
                Some("admin-session"),
                true,
                json!({"configuration_hash":hash})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let lock_path = directory.path().join("detector-lock.json");
        let detector = json!({"apiBase":"http://127.0.0.1:48100","timeoutMs":1000,"providers":[{"provider":"detector_local","config":{"spawnPolicy":{"trusted_executable_roots":[directory.path()],"allowed_env":[],"cwd_root":directory.path()},"workerCommand":{"executable":directory.path().join("worker.exe"),"argv":[]},"workerCwd":directory.path(),"lockPath":lock_path,"labelMapPath":directory.path().join("mapping.json")}}]});
        std::fs::write(&path, detector.to_string()).unwrap();
        let detector_hash = annotation_domain::hash::execution_configuration_hash(
            &detector["providers"][0]["config"],
        )
        .unwrap();
        let detector_payload = json!({"configuration_hash":detector_hash});
        assert_eq!(
            call(
                &app,
                "PUT",
                "/api/model-profiles/detector_local",
                Some("admin-session"),
                true,
                detector_payload.clone()
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        std::fs::write(
            &lock_path,
            json!({"model_id":"ux-detector-pinned"}).to_string(),
        )
        .unwrap();
        let (status, detector_profile) = call(
            &app,
            "PUT",
            "/api/model-profiles/detector_local",
            Some("admin-session"),
            true,
            detector_payload.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(detector_profile["model_id"], "ux-detector-pinned");
        assert_eq!(detector_profile["availability"], "needs_configuration");
        assert_eq!(detector_profile["verification"], "not_run");
        std::fs::write(
            &lock_path,
            json!({"model_id":"different-pinned-identity"}).to_string(),
        )
        .unwrap();
        assert_eq!(
            call(
                &app,
                "PUT",
                "/api/model-profiles/detector_local",
                Some("admin-session"),
                true,
                detector_payload
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        std::fs::remove_file(&path).unwrap();
        let (status, missing_host) = call(
            &app,
            "GET",
            "/api/model-profile-presets",
            Some("admin-session"),
            false,
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(!missing_host.to_string().contains("host.json"));
    }
}
