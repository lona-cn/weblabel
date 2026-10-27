//! Private native runtime configuration. Parsing never resolves a secret, starts a
//! process, loads a model, or consults the legacy Host configuration.
use std::{
    collections::BTreeSet,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use serde::Deserialize;
use serde_json::Value;

const MAX_CONFIG_BYTES: usize = 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Native runtime configuration is missing, invalid or ambiguous")]
pub struct RuntimeConfigurationError;

impl RuntimeConfigurationError {
    pub fn code(self) -> &'static str {
        "RUNTIME_CONFIGURATION_UNAVAILABLE"
    }
}

/// Native absence and invalid metadata remain distinct; no alternate loader exists.
pub type ProfileConfiguration = Result<Option<Arc<RuntimeConfig>>, RuntimeConfigurationError>;

pub(crate) struct ConfigurationLocation {
    pub path: PathBuf,
    pub allowed_secret_env: Vec<String>,
}

/// Read only the two explicit native settings; configuration bytes are loaded
/// once by their owner, never through the legacy Host environment.
pub(crate) fn configuration_location_from_environment(
) -> Result<Option<ConfigurationLocation>, RuntimeConfigurationError> {
    let allowed_secret_env = match std::env::var("WEBLABEL_RUNTIME_ALLOWED_ENV") {
        Ok(raw) => parse_allowed_env(&raw)?,
        Err(std::env::VarError::NotPresent) => Vec::new(),
        Err(_) => return Err(RuntimeConfigurationError),
    };
    let path = match std::env::var("WEBLABEL_RUNTIME_CONFIG") {
        Ok(path) if path.is_empty() => return Ok(None),
        Ok(path) => PathBuf::from(path),
        Err(std::env::VarError::NotPresent) => return Ok(None),
        Err(_) => return Err(RuntimeConfigurationError),
    };
    Ok(Some(ConfigurationLocation {
        path,
        allowed_secret_env,
    }))
}

pub fn profile_configuration_from_environment() -> ProfileConfiguration {
    let Some(location) = configuration_location_from_environment()? else {
        return Ok(None);
    };
    RuntimeConfig::load(&location.path, &location.allowed_secret_env)
        .map(|config| Some(Arc::new(config)))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeProvider {
    pub provider: String,
    pub config: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    schema_version: u64,
    timeout_ms: u64,
    providers: Vec<RuntimeProvider>,
}

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub timeout_ms: u64,
    providers: Vec<RuntimeProvider>,
    allowed_secret_env: Vec<String>,
}

impl RuntimeConfig {
    pub fn parse(
        raw: &str,
        allowed_secret_env: &[String],
    ) -> Result<Self, RuntimeConfigurationError> {
        if raw.len() > MAX_CONFIG_BYTES {
            return Err(RuntimeConfigurationError);
        }
        validate_allowed_env(allowed_secret_env)?;
        let envelope: Envelope =
            serde_json::from_str(raw).map_err(|_| RuntimeConfigurationError)?;
        if envelope.schema_version != 1
            || envelope.timeout_ms == 0
            || envelope.timeout_ms > MAX_SAFE_INTEGER
            || envelope.providers.len() > 500
        {
            return Err(RuntimeConfigurationError);
        }
        let mut ids = BTreeSet::new();
        for entry in &envelope.providers {
            let config = &entry.config;
            let profile = config
                .get("profile_id")
                .and_then(Value::as_str)
                .filter(|id| safe_id(id))
                .ok_or(RuntimeConfigurationError)?;
            if !ids.insert(profile) {
                return Err(RuntimeConfigurationError);
            }
            match entry.provider.as_str() {
                "openai_api" | "anthropic_api" | "mimo_api" => {
                    crate::ai::profiles::http_metadata(&entry.provider, config, |_| false)
                        .map_err(|_| RuntimeConfigurationError)?;
                }
                "claude_local" => {
                    exact_keys(
                        config,
                        &[
                            "profile_id",
                            "model_id",
                            "executable",
                            "timeout_ms",
                            "max_tool_turns",
                            "max_tool_result_bytes",
                        ],
                    )?;
                    if !config
                        .get("model_id")
                        .and_then(Value::as_str)
                        .is_some_and(safe_id)
                    {
                        return Err(RuntimeConfigurationError);
                    }
                    valid_path(config.get("executable"))?;
                    for key in ["timeout_ms", "max_tool_turns", "max_tool_result_bytes"] {
                        positive_integer(config.get(key))?;
                    }
                }
                "detector_local" => {
                    exact_keys(
                        config,
                        &[
                            "profile_id",
                            "lock_path",
                            "model_dir",
                            "label_map_path",
                            "onnxruntime_library",
                            "timeout_ms",
                        ],
                    )?;
                    for key in [
                        "lock_path",
                        "model_dir",
                        "label_map_path",
                        "onnxruntime_library",
                    ] {
                        valid_path(config.get(key))?;
                    }
                    positive_integer(config.get("timeout_ms"))?;
                }
                _ => return Err(RuntimeConfigurationError),
            }
        }
        Ok(Self {
            timeout_ms: envelope.timeout_ms,
            providers: envelope.providers,
            allowed_secret_env: allowed_secret_env.to_vec(),
        })
    }

    pub fn load(
        path: &Path,
        allowed_secret_env: &[String],
    ) -> Result<Self, RuntimeConfigurationError> {
        if !safe_path(path) {
            return Err(RuntimeConfigurationError);
        }
        let file = std::fs::File::open(path).map_err(|_| RuntimeConfigurationError)?;
        if !file
            .metadata()
            .map_err(|_| RuntimeConfigurationError)?
            .is_file()
        {
            return Err(RuntimeConfigurationError);
        }
        let mut raw = String::new();
        file.take((MAX_CONFIG_BYTES + 1) as u64)
            .read_to_string(&mut raw)
            .map_err(|_| RuntimeConfigurationError)?;
        Self::parse(&raw, allowed_secret_env)
    }

    pub fn providers(&self) -> &[RuntimeProvider] {
        &self.providers
    }
    pub fn allowed_secret_env(&self) -> &[String] {
        &self.allowed_secret_env
    }

    pub fn selected(
        &self,
        provider_id: &str,
        profile_id: &str,
    ) -> Result<&Value, RuntimeConfigurationError> {
        let mut entries = self.providers.iter().filter(|entry| {
            entry.provider == provider_id
                && entry.config.get("profile_id").and_then(Value::as_str) == Some(profile_id)
        });
        let config = &entries.next().ok_or(RuntimeConfigurationError)?.config;
        if entries.next().is_some() {
            return Err(RuntimeConfigurationError);
        }
        Ok(config)
    }

    pub fn configuration_hash(
        &self,
        provider_id: &str,
        profile_id: &str,
    ) -> Result<String, RuntimeConfigurationError> {
        annotation_domain::hash::execution_configuration_hash(
            self.selected(provider_id, profile_id)?,
        )
        .map_err(|_| RuntimeConfigurationError)
    }
}

/// Select by the exact pair for every provider, including both local providers.
/// The serde Value is hashed directly: integer and floating categories survive.
pub fn runtime_execution_configuration_hash(
    raw: &str,
    provider_id: &str,
    profile_id: &str,
) -> Result<String, RuntimeConfigurationError> {
    RuntimeConfig::parse(raw, &[])?.configuration_hash(provider_id, profile_id)
}

fn safe_id(id: &str) -> bool {
    annotation_domain::document::validate_id(id).is_ok() && crate::ai::redact_text(id) == id
}

fn exact_keys(value: &Value, keys: &[&str]) -> Result<(), RuntimeConfigurationError> {
    if !value
        .as_object()
        .is_some_and(|map| map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key)))
    {
        return Err(RuntimeConfigurationError);
    }
    Ok(())
}

fn positive_integer(value: Option<&Value>) -> Result<(), RuntimeConfigurationError> {
    if value
        .and_then(Value::as_u64)
        .is_some_and(|n| n > 0 && n <= MAX_SAFE_INTEGER)
    {
        Ok(())
    } else {
        Err(RuntimeConfigurationError)
    }
}

fn safe_path(path: &Path) -> bool {
    path.is_absolute()
        && path
            .to_str()
            .is_some_and(|s| !s.contains(['\0', '\n', '\r']))
        && !path.components().any(|c| matches!(c, Component::ParentDir))
}

fn valid_path(value: Option<&Value>) -> Result<(), RuntimeConfigurationError> {
    if value
        .and_then(Value::as_str)
        .is_some_and(|s| safe_path(Path::new(s)))
    {
        Ok(())
    } else {
        Err(RuntimeConfigurationError)
    }
}

pub fn parse_allowed_env(raw: &str) -> Result<Vec<String>, RuntimeConfigurationError> {
    let names = if raw.is_empty() {
        Vec::new()
    } else {
        raw.split(',').map(|name| name.trim().to_owned()).collect()
    };
    validate_allowed_env(&names)?;
    Ok(names)
}

fn validate_allowed_env(names: &[String]) -> Result<(), RuntimeConfigurationError> {
    let mut seen = BTreeSet::new();
    for name in names {
        let upper = name.to_ascii_uppercase();
        let mut bytes = name.bytes();
        if !bytes
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
            || !bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
            || !seen.insert(upper.clone())
            || upper.starts_with("WEBLABEL_")
            || upper.starts_with("LD_")
            || upper.starts_with("DYLD_")
            || [
                "PATH",
                "PATHEXT",
                "COMSPEC",
                "NODE_OPTIONS",
                "NODE_PATH",
                "PYTHONPATH",
                "PYTHONHOME",
            ]
            .contains(&upper.as_str())
        {
            return Err(RuntimeConfigurationError);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn local(profile: &str) -> Value {
        json!({"provider":"claude_local","config":{"profile_id":profile,"model_id":"claude-sonnet-fixture",
            "executable": std::env::current_exe().unwrap(), "timeout_ms":1000,
            "max_tool_turns":10,"max_tool_result_bytes":4096}})
    }
    fn envelope(providers: Vec<Value>) -> Value {
        json!({"schema_version":1,"timeout_ms":1000,"providers":providers})
    }

    #[test]
    fn exact_local_pair_selects_two_profiles_and_rejects_missing() {
        let raw = envelope(vec![local("first"), local("second")]).to_string();
        let config = RuntimeConfig::parse(&raw, &[]).unwrap();
        for profile in ["first", "second"] {
            assert_eq!(
                runtime_execution_configuration_hash(&raw, "claude_local", profile).unwrap(),
                annotation_domain::hash::execution_configuration_hash(
                    config.selected("claude_local", profile).unwrap()
                )
                .unwrap()
            );
        }
        assert!(config.selected("claude_local", "missing").is_err());
        assert!(config.selected("detector_local", "first").is_err());
        assert_ne!(
            config.configuration_hash("claude_local", "first").unwrap(),
            config.configuration_hash("claude_local", "second").unwrap()
        );
    }

    #[test]
    fn duplicate_global_identity_and_unknown_fields_fail_closed() {
        let mut other = local("same");
        other["provider"] = json!("detector_local");
        assert!(
            RuntimeConfig::parse(&envelope(vec![local("same"), other]).to_string(), &[]).is_err()
        );
        let mut config = envelope(vec![local("first")]);
        config["apiBase"] = json!("http://127.0.0.1:48100");
        assert!(RuntimeConfig::parse(&config.to_string(), &[]).is_err());
        let mut entry = local("first");
        entry["config"]["argv"] = json!([]);
        assert!(RuntimeConfig::parse(&envelope(vec![entry]).to_string(), &[]).is_err());
    }

    #[test]
    fn invalid_paths_budgets_and_environment_are_rejected() {
        for (key, value) in [
            ("executable", json!("relative.exe")),
            ("timeout_ms", json!(0)),
            ("max_tool_turns", json!(1.5)),
            ("max_tool_result_bytes", json!(-1)),
        ] {
            let mut entry = local("first");
            entry["config"][key] = value;
            assert!(RuntimeConfig::parse(&envelope(vec![entry]).to_string(), &[]).is_err());
        }
        for env in [
            "BAD-NAME",
            "PATH",
            "NODE_OPTIONS",
            "WEBLABEL_RUN_TOKEN",
            "KEY,key",
            "KEY,,OTHER",
        ] {
            assert!(parse_allowed_env(env).is_err());
        }
        assert_eq!(
            parse_allowed_env("FIXTURE_API_KEY, SECOND_KEY").unwrap(),
            ["FIXTURE_API_KEY", "SECOND_KEY"]
        );
    }

    #[test]
    fn http_hash_preserves_integer_and_float_number_categories() {
        let entry = json!({"provider":"openai_api","config":{"profile_id":"first","model_id":"fixture-model",
            "credential":{"secret_ref":"env:FIXTURE_API_KEY"},"pricing":{"input_per_million_usd":1.0}}});
        let float = envelope(vec![entry]);
        let mut integer = float.clone();
        integer["providers"][0]["config"]["pricing"]["input_per_million_usd"] = json!(1);
        assert_ne!(
            runtime_execution_configuration_hash(&float.to_string(), "openai_api", "first")
                .unwrap(),
            runtime_execution_configuration_hash(&integer.to_string(), "openai_api", "first")
                .unwrap()
        );
        assert_eq!(
            runtime_execution_configuration_hash(&float.to_string(), "openai_api", "first")
                .unwrap(),
            annotation_domain::hash::execution_configuration_hash(&float["providers"][0]["config"])
                .unwrap()
        );
    }

    #[test]
    fn all_five_providers_select_exact_identity_and_reject_ambiguity() {
        let mut entries = vec![local("claude-one"), local("claude-two")];
        for provider in ["openai_api", "anthropic_api", "mimo_api"] {
            for suffix in ["one", "two"] {
                entries.push(json!({"provider":provider,"config":{
                    "profile_id":format!("{provider}-{suffix}"),"model_id":"synthetic-model",
                    "credential":{"secret_ref":"env:SYNTHETIC_KEY"}
                }}));
            }
        }
        let fixture = std::env::current_exe().unwrap();
        for suffix in ["one", "two"] {
            entries.push(json!({"provider":"detector_local","config":{
                "profile_id":format!("detector-{suffix}"),"lock_path":fixture,
                "model_dir":fixture.parent().unwrap(),"label_map_path":fixture,
                "onnxruntime_library":fixture,"timeout_ms":1000
            }}));
        }
        let raw = envelope(entries.clone()).to_string();
        let config = RuntimeConfig::parse(&raw, &[]).unwrap();
        for entry in &entries {
            let provider = entry["provider"].as_str().unwrap();
            let profile = entry["config"]["profile_id"].as_str().unwrap();
            assert_eq!(
                config.configuration_hash(provider, profile).unwrap(),
                annotation_domain::hash::execution_configuration_hash(&entry["config"]).unwrap()
            );
            assert!(config.selected(provider, "nonexistent").is_err());
        }
        entries.push(entries[0].clone());
        assert!(runtime_execution_configuration_hash(
            &envelope(entries).to_string(),
            "claude_local",
            "claude-one"
        )
        .is_err());
    }
}
