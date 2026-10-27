use crate::{
    cli::{Error, ExitStatus},
    server::release::Release,
};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::AsyncReadExt;

#[derive(Debug)]
pub struct Options {
    pub build_dir: PathBuf,
    pub data_dir: Option<PathBuf>,
    pub mode: String,
    pub cargo_cwd: Option<PathBuf>,
    pub api_url: Option<String>,
    pub target_release: Option<PathBuf>,
    pub backup_dir: Option<PathBuf>,
    pub support_receipt: Option<PathBuf>,
}
const ALLOWED_ENV: &[&str] = &[
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "COMSPEC",
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "PNPM_HOME",
    "COREPACK_HOME",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "RUSTC",
    "RUSTDOC",
    "VCINSTALLDIR",
    "WindowsSdkDir",
    "INCLUDE",
    "LIB",
    "LIBPATH",
    "TEMP",
    "TMP",
    "TMPDIR",
];
fn probe_argv(name: &str) -> Option<Vec<OsString>> {
    #[cfg(windows)]
    if name == "pnpm" {
        let node = find_executable("node")?;
        let mut entries = Vec::new();
        if let Some(appdata) = std::env::var_os("APPDATA") {
            entries.push(PathBuf::from(appdata).join("npm/node_modules/pnpm/bin/pnpm.cjs"));
        }
        if let Some(parent) = node.parent() {
            entries.push(parent.join("node_modules/corepack/dist/pnpm.js"));
        }
        let entry = entries.into_iter().find(|p| p.is_file())?;
        return Some(vec![
            node.into_os_string(),
            entry.into_os_string(),
            "--version".into(),
        ]);
    }
    Some(vec![name.into(), "--version".into()])
}
#[cfg(windows)]
fn find_executable(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH").or_else(|| std::env::var_os("Path"))?;
    std::env::split_paths(&paths)
        .map(|p| p.join(format!("{name}.exe")))
        .find(|p| p.is_file())
}
async fn version(name: &str, cwd: &Path, seconds: u64) -> Option<String> {
    let argv = probe_argv(name)?;
    let mut command = tokio::process::Command::new(&argv[0]);
    command.args(&argv[1..]).current_dir(cwd).env_clear();
    for key in ALLOWED_ENV {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env("RUSTUP_TOOLCHAIN", "1.96.0")
        .env("RUSTUP_AUTO_INSTALL", "0")
        .env("COREPACK_ENABLE_NETWORK", "0")
        .env("COREPACK_ENABLE_AUTO_PIN", "0")
        .env("COREPACK_DEFAULT_TO_LATEST", "0");
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?.take(65537);
    let operation = async {
        let mut bytes = Vec::new();
        let (read, status) = tokio::join!(stdout.read_to_end(&mut bytes), child.wait());
        read.ok()?;
        if !status.ok()?.success() || bytes.len() > 65536 {
            return None;
        }
        Some(String::from_utf8(bytes).ok()?.trim().to_owned())
    };
    match tokio::time::timeout(Duration::from_secs(seconds), operation).await {
        Ok(value) => value,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            None
        }
    }
}

/// Exactly one unauthenticated readiness response; no redirects, proxy, cookies,
/// credentials, API payloads or non-loopback network destinations are permitted.
pub async fn probe_ready(base: &str) -> Result<Value, Error> {
    let mut url = reqwest::Url::parse(base)?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"))
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(std::io::Error::other("readiness_loopback_required").into());
    }
    url.set_path("/ready");
    url.set_query(None);
    url.set_fragment(None);
    let request = async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(1))
            .build()
            .ok()?;
        let mut response = client.get(url).send().await.ok()?;
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if bytes.len() + chunk.len() > 1024 {
                return Some(json!({"status":"invalid"}));
            }
            bytes.extend_from_slice(&chunk);
        }
        let body: Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => return Some(json!({"status":"invalid"})),
        };
        let Some(object) = body.as_object() else {
            return Some(json!({"status":"invalid"}));
        };
        if object.len() != 2
            || !body["ready"].is_boolean()
            || !matches!(body["mode"].as_str(), Some("normal" | "password_recovery"))
        {
            return Some(json!({"status":"invalid"}));
        }
        let state = if status == 200 && body["ready"] == true && body["mode"] == "normal" {
            "ready"
        } else if status == 503 && body["ready"] == false {
            if body["mode"] == "password_recovery" {
                "maintenance"
            } else {
                "not_ready"
            }
        } else {
            "invalid"
        };
        if state == "invalid" {
            Some(json!({"status":state}))
        } else {
            Some(json!({"status":state,"ready":body["ready"],"mode":body["mode"]}))
        }
    };
    Ok(tokio::time::timeout(Duration::from_secs(1), request)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| json!({"status":"unavailable"})))
}

pub fn support_receipt(result: &Value) -> Value {
    json!({"format":"weblabel-support-receipt","version":1,"mode":result["mode"],"status":result["status"],
        "tools":result["tools"].as_array().into_iter().flatten().map(|tool| json!({"name":tool["name"],"status":tool["status"]})).collect::<Vec<_>>(),
        "release":{"status":result["release"]["status"]},
        "api":result.get("api").map(|api| json!({"status":api["status"]})),
        "storage":result.get("storage").map(|storage| json!({"capacity":if storage["available_bytes"].is_null() {"unknown"} else {"measured"},"warnings":storage["warnings"],"lock_status":storage["lock"]["status"]})),
        "upgrade":result.get("upgrade").map(|upgrade| json!({"status":upgrade["status"],"code":upgrade.get("code"),"source_schema":upgrade["source_schema"],"target_schema":upgrade["target_schema"],"pending_count":upgrade["pending_migrations"].as_array().map_or(0, Vec::len),"rollback":upgrade["rollback"]})),
        "models":"not-run","payloads":"excluded","credentials":"not-inspected"})
}

pub async fn run(options: Options) -> Result<(), Error> {
    let cwd = options
        .cargo_cwd
        .clone()
        .unwrap_or(std::env::current_dir()?);
    let release = match Release::validate(&options.build_dir) {
        Ok(release) => {
            json!({"status":"hashes_valid","version":2,"source_commit":release.source_commit,"files":release.file_count})
        }
        Err(error)
            if !options.build_dir.join("release.json").exists()
                && error.kind() == std::io::ErrorKind::NotFound =>
        {
            json!({"status":"missing"})
        }
        Err(error) => {
            json!({"status":"invalid","code":if error.kind() == std::io::ErrorKind::InvalidData {error.to_string()} else {"RELEASE_UNREADABLE".to_owned()}})
        }
    };
    let mut tools = Vec::new();
    let mut blockers = Vec::new();
    if options.mode == "build" {
        for (name, expected) in [
            ("node", "v24.16.0"),
            ("pnpm", "10.34.5"),
            ("rustc", "rustc 1.96.0 "),
            ("cargo", "cargo 1.96.0 "),
            ("wasm-pack", "wasm-pack 0.15.0"),
            ("wasm-bindgen", "wasm-bindgen 0.2.128"),
        ] {
            let actual = version(name, &cwd, 15).await;
            let status = match actual.as_deref() {
                None => "missing",
                Some(actual)
                    if if expected.ends_with(' ') {
                        actual.starts_with(expected)
                    } else {
                        actual == expected
                    } =>
                {
                    "pinned"
                }
                _ => "version_mismatch",
            };
            if status != "pinned" {
                blockers.push(format!("TOOL_{name}_{status}"));
            }
            tools.push(json!({"name":name,"expected":expected.trim(),"actual":actual.unwrap_or_else(|| "unavailable".into()),"status":status}));
        }
    }
    if release["status"] != "hashes_valid" {
        blockers.push(format!(
            "RELEASE_{}",
            release["status"].as_str().unwrap_or("invalid")
        ));
    }
    let configuration = if options.mode == "ai" {
        "not_inspected"
    } else {
        match crate::runtime::config::profile_configuration_from_environment() {
            Ok(None) => "not_configured",
            Ok(Some(_)) => "configured_metadata_valid",
            Err(_) => {
                blockers.push("RUNTIME_CONFIGURATION_UNAVAILABLE".into());
                "invalid"
            }
        }
    };
    let mut result = json!({"format":"weblabel-doctor","version":1,"readonly":true,"mode":options.mode,"tools":tools,"release":release,
        "configuration":{"status":configuration,"code":if configuration == "invalid" {Some("RUNTIME_CONFIGURATION_UNAVAILABLE")} else {None},"credential_environment":"not_forwarded","values":"not_disclosed","account_state":"not_inspected"},
        "capabilities":{"webgpu":"browser-device-probe-required","models":"live-not-run","native_execution":"implemented-not-live-validated","manual_editor":"requires-release-and-real-WebGPU; no-Node-Python-or-official-CLI-required","process_tree":if cfg!(windows) {"windows-job-object"} else if cfg!(target_os="linux") {"linux-subreaper-broker"} else {"unsupported-spawn-refused"}}});
    if let Some(data) = &options.data_dir {
        result["storage"] = super::storage::diagnose(data);
        if result["storage"]["code"] == "DATA_DIRECTORY_UNAVAILABLE" {
            blockers.push("DATA_DIRECTORY_UNAVAILABLE".into());
        }
    }
    if let Some(url) = &options.api_url {
        let api = probe_ready(url).await?;
        if api["status"] != "ready" {
            blockers.push(format!(
                "API_{}",
                api["status"].as_str().unwrap_or("invalid")
            ));
        }
        result["api"] = api;
    }
    if options.mode == "ai" {
        let mut components = Vec::new();
        for name in ["claude"] {
            components.push(json!({"name":name,"status":if version(name, &cwd, 5).await.is_some() {"installed-version-probe-only"} else {"unavailable"},"required_for_manual":false}));
        }
        result["ai"] =
            json!({"configured":"not-inspected","live":"not-run","components":components});
    }
    if let Some(target) = &options.target_release {
        let data = options
            .data_dir
            .as_ref()
            .ok_or_else(|| std::io::Error::other("required: --data-dir"))?;
        let backup = options
            .backup_dir
            .as_ref()
            .ok_or_else(|| std::io::Error::other("required: --backup-dir"))?;
        let upgrade = super::preflight::run(data, target, backup, None);
        if upgrade["status"] != "compatible" {
            blockers.push(format!(
                "UPGRADE_{}",
                upgrade["status"].as_str().unwrap_or("unsupported")
            ));
        }
        result["upgrade"] = upgrade;
    }
    let status = if result["release"]["status"] == "invalid" || configuration == "invalid" {
        "failed"
    } else if blockers.is_empty() {
        "passed"
    } else {
        "blocked"
    };
    result["status"] = json!(status);
    result["blockers"] = json!(blockers);
    if let Some(path) = &options.support_receipt {
        super::database::exclusive_json(path, &support_receipt(&result))?;
    }
    println!("{}", serde_json::to_string_pretty(&result)?);
    match status {
        "passed" => Ok(()),
        "blocked" => Err(Box::new(ExitStatus(2))),
        _ => Err(Box::new(ExitStatus(1))),
    }
}
