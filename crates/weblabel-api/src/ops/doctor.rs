use std::path::PathBuf;
use serde_json::json;
use crate::{cli::Error, runtime::config::{legacy_host_environment_present, ProfileConfiguration}, server::release::Release};

pub async fn run(build_dir: PathBuf, data_dir: Option<PathBuf>) -> Result<(), Error> {
    let result = tokio::task::spawn_blocking(move || {
        let release = match Release::validate(&build_dir) {
            Ok(release) => json!({"status":"hashes_valid","version":2,"source_commit":release.source_commit,"files":release.file_count}),
            Err(error) => {
                let code = if error.kind() == std::io::ErrorKind::NotFound { "RELEASE_MISSING".to_owned() }
                    else if error.kind() == std::io::ErrorKind::InvalidData { error.to_string() }
                    else { "RELEASE_UNREADABLE".to_owned() };
                json!({"status":"invalid","code":code})
            }
        };
        let configuration = match ProfileConfiguration::from_environment() {
            ProfileConfiguration::Native(Ok(None)) => "not_configured",
            ProfileConfiguration::Native(Ok(Some(_))) => "configured_execution_unavailable",
            ProfileConfiguration::Native(Err(_)) => "invalid",
            ProfileConfiguration::LegacyHost => "invalid",
        };
        let legacy_host = legacy_host_environment_present();
        let storage = data_dir.as_ref().map(|path| super::storage::diagnose(path));
        let failed = release["status"] != "hashes_valid" || configuration == "invalid"
            || storage.as_ref().is_some_and(|storage| storage["code"] == "DATA_DIRECTORY_UNAVAILABLE");
        let mut result = json!({"format":"weblabel-doctor","version":1,"readonly":true,
            "status":if failed {"failed"} else {"passed"},
            "release":release,"configuration":{"status":configuration,"code":if configuration == "invalid" {Some("RUNTIME_CONFIGURATION_UNAVAILABLE")} else {None},"values":"not_disclosed","account_state":"not_inspected"},
            "legacy_host":{"status":if legacy_host {"ignored"} else {"not_present"},"code":if legacy_host {Some("LEGACY_HOST_CONFIGURATION_IGNORED")} else {None}},
            "capabilities":{"webgpu":"browser-device-probe-required","models":"live-not-run","native_execution":"unavailable","manual_editor":"requires-release-and-real-WebGPU"}});
        if let Some(storage) = storage { result["storage"] = storage; }
        result
    }).await?;
    println!("{}", serde_json::to_string(&result)?);
    if result["status"] == "failed" {
        let code = if result["release"]["status"] != "hashes_valid" { "DOCTOR_RELEASE_INVALID" }
            else if result["configuration"]["status"] == "invalid" { "RUNTIME_CONFIGURATION_UNAVAILABLE" }
            else { "DATA_DIRECTORY_UNAVAILABLE" };
        return Err(std::io::Error::other(code).into());
    }
    Ok(())
}
