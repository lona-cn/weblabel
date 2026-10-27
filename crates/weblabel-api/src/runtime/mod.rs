//! Private bounded NDJSON codec for native detector workers (contract C5).
//! One JSON message per line; raw size is bounded before decoding.

pub mod agent_tools;
pub mod config;
pub mod detector;
pub mod host;
pub mod mcp;
pub mod providers;
pub mod run_tokens;
pub mod runner;
pub mod supervisor;

#[cfg(test)]
mod native_process_tests;

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ID_LENGTH: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvelopeKind {
    Request,
    Response,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvelopeMethod {
    Probe,
    StartRun,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeEnvelope {
    pub protocol_version: u32,
    pub id: String,
    pub kind: EnvelopeKind,
    pub method: EnvelopeMethod,
    pub payload: serde_json::Value,
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("multi_line_message: an envelope must occupy exactly one line")]
    MultiLine,
    #[error("message_too_large: {0} bytes exceeds the {MAX_LINE_BYTES} byte limit")]
    TooLarge(usize),
    #[error("invalid_json: {0}")]
    InvalidJson(String),
    #[error("invalid_envelope: {0}")]
    InvalidEnvelope(&'static str),
    #[error("protocol_version: expected {PROTOCOL_VERSION}, got {0}")]
    ProtocolVersion(String),
    #[error("invalid_id: id must be a non-empty string of at most {MAX_ID_LENGTH} characters")]
    InvalidId,
    #[error("invalid_kind: {0}")]
    InvalidKind(String),
    #[error("unknown_method: {0}")]
    UnknownMethod(String),
}

fn method_from_str(raw: &str) -> Result<EnvelopeMethod, ProtocolError> {
    match raw {
        "probe" => Ok(EnvelopeMethod::Probe),
        "start_run" => Ok(EnvelopeMethod::StartRun),
        other => Err(ProtocolError::UnknownMethod(other.to_owned())),
    }
}

pub fn parse_envelope(line: &str) -> Result<RuntimeEnvelope, ProtocolError> {
    if line.contains('\n') || line.contains('\r') {
        return Err(ProtocolError::MultiLine);
    }
    // The size cap is checked on the raw line, before any JSON decoding.
    if line.len() > MAX_LINE_BYTES {
        return Err(ProtocolError::TooLarge(line.len()));
    }
    let value: serde_json::Value = serde_json::from_str(line)
        .map_err(|error| ProtocolError::InvalidJson(error.to_string()))?;
    let object = value.as_object().ok_or(ProtocolError::InvalidEnvelope(
        "envelope must be a JSON object",
    ))?;
    let version = object
        .get("protocol_version")
        .and_then(|value| value.as_u64());
    if version != Some(u64::from(PROTOCOL_VERSION)) {
        let raw = object
            .get("protocol_version")
            .map(|value| value.to_string())
            .unwrap_or_else(|| "missing".to_owned());
        return Err(ProtocolError::ProtocolVersion(raw));
    }
    let id = object
        .get("id")
        .and_then(|value| value.as_str())
        .filter(|id| !id.is_empty() && id.len() <= MAX_ID_LENGTH)
        .ok_or(ProtocolError::InvalidId)?
        .to_owned();
    let kind_raw = object
        .get("kind")
        .and_then(|value| value.as_str())
        .ok_or_else(|| ProtocolError::InvalidKind("missing".to_owned()))?;
    let kind = match kind_raw {
        "request" => EnvelopeKind::Request,
        "response" => EnvelopeKind::Response,
        other => return Err(ProtocolError::InvalidKind(other.to_owned())),
    };
    let method_raw = object
        .get("method")
        .and_then(|value| value.as_str())
        .ok_or_else(|| ProtocolError::UnknownMethod("missing".to_owned()))?;
    let method = method_from_str(method_raw)?;
    if !object.contains_key("payload") {
        return Err(ProtocolError::InvalidEnvelope("payload field is required"));
    }
    Ok(RuntimeEnvelope {
        protocol_version: PROTOCOL_VERSION,
        id,
        kind,
        method,
        payload: object["payload"].clone(),
    })
}

impl RuntimeEnvelope {
    pub fn request(id: &str, method: EnvelopeMethod, payload: serde_json::Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id: id.to_owned(),
            kind: EnvelopeKind::Request,
            method,
            payload,
        }
    }

    pub fn to_line(&self) -> Result<String, ProtocolError> {
        let line = serde_json::to_string(self)
            .map_err(|error| ProtocolError::InvalidJson(error.to_string()))?;
        if line.len() > MAX_LINE_BYTES {
            return Err(ProtocolError::TooLarge(line.len()));
        }
        Ok(line)
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use crate::runtime::{host::HostConfig, supervisor};
    use std::{
        collections::BTreeMap,
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        path::{Path, PathBuf},
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    const FIXTURE: &str = "runtime::test_support::native_process_fixture";
    pub fn scratch() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/test-artifacts/R09-native-process");
        std::fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }
    pub fn config(directory: &Path, mode: &str, marker: &Path) -> HostConfig {
        let executable = std::env::current_exe().unwrap();
        let mut env = BTreeMap::from([
            ("R09_NATIVE_MODE".into(), mode.into()),
            (
                "R09_NATIVE_MARKER".into(),
                marker.to_string_lossy().into_owned(),
            ),
        ]);
        for key in ["SystemRoot", "SystemDrive", "WINDIR"] {
            if let Ok(value) = std::env::var(key) {
                env.insert(key.into(), value);
            }
        }
        for key in ["TEMP", "TMP", "TMPDIR"] {
            env.insert(key.into(), directory.to_string_lossy().into_owned());
        }
        HostConfig {
            trusted_executable_roots: vec![executable.parent().unwrap().to_owned()],
            executable,
            argv: vec!["--exact".into(), FIXTURE.into(), "--nocapture".into()],
            cwd: directory.to_owned(),
            trusted_cwd_roots: vec![directory.to_owned()],
            allowed_env: env.keys().cloned().collect(),
            source_env: BTreeMap::new(),
            extra_env: env,
        }
    }
    pub fn foreign(directory: &Path, marker: &Path) -> Command {
        let config = config(directory, "idle", marker);
        let mut command = Command::new(config.executable);
        command
            .args(config.argv)
            .env_clear()
            .envs(config.extra_env)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }
    pub fn process_alive(pid: u32) -> bool {
        supervisor::snapshot_pids().contains(&pid)
    }
    pub fn wait_file(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "fixture did not publish {}",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    pub fn marker(path: &Path) -> serde_json::Value {
        wait_file(path);
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }
    pub fn usable(info: &serde_json::Value) -> bool {
        let Ok(mut stream) =
            TcpStream::connect(("127.0.0.1", info["port"].as_u64().unwrap() as u16))
        else {
            return false;
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut body = String::new();
        stream.read_to_string(&mut body).is_ok() && body == info["pid"].to_string()
    }
    #[test]
    fn native_process_fixture() {
        // Ordinary suite discovery is inert. Only a separately spawned native
        // test executable with private fixture environment enters this branch.
        let Ok(mode) = std::env::var("R09_NATIVE_MODE") else {
            return;
        };
        if mode == "exit" {
            return;
        }
        if mode == "argv" {
            let args: Vec<_> = std::env::args().collect();
            assert!(args
                .windows(2)
                .any(|pair| pair[0] == "--skip" && pair[1] == "参数 with space"));
            println!("native-argv-ok");
            eprintln!("native-fixture-log");
            return;
        }
        let marker = PathBuf::from(std::env::var_os("R09_NATIVE_MARKER").unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let info = serde_json::json!({"pid":std::process::id(),"port":listener.local_addr().unwrap().port()});
        let temporary = marker.with_extension("publishing");
        std::fs::write(&temporary, info.to_string()).unwrap();
        std::fs::rename(&temporary, &marker).unwrap();
        if matches!(mode.as_str(), "tree" | "crash" | "orphan") {
            let mut command = foreign(marker.parent().unwrap(), &marker.with_extension("leaf"));
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                unsafe extern "C" {
                    fn setsid() -> i32;
                }
                unsafe {
                    command.pre_exec(|| {
                        if setsid() < 0 {
                            Err(std::io::Error::last_os_error())
                        } else {
                            Ok(())
                        }
                    });
                }
            }
            let _child = command.spawn().unwrap();
            wait_file(&marker.with_extension("leaf"));
            if mode == "orphan" {
                return;
            }
        }
        loop {
            if mode == "crash" && marker.with_extension("go").exists() {
                std::process::exit(7);
            }
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = write!(stream, "{}", std::process::id());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversized_messages_before_json_decode() {
        let line = "x".repeat(MAX_LINE_BYTES + 1);
        let error = parse_envelope(&line).expect_err("oversized line must be rejected");
        assert!(matches!(error, ProtocolError::TooLarge(_)));
        assert!(error.to_string().contains("message_too_large"));
    }

    #[test]
    fn rejects_mismatched_protocol_version() {
        let line =
            r#"{"protocol_version":99,"id":"x","kind":"request","method":"probe","payload":{}}"#;
        let error = parse_envelope(line).expect_err("version 99 must be rejected");
        assert!(matches!(error, ProtocolError::ProtocolVersion(_)));
        assert!(error.to_string().contains("protocol_version"));
    }

    #[test]
    fn rejects_multi_line_and_truncated_lines() {
        assert!(matches!(
            parse_envelope("{\"a\":1}\n{\"b\":2}"),
            Err(ProtocolError::MultiLine)
        ));
        assert!(matches!(
            parse_envelope("{\"protocol_version\":1,\"id\":\"x\""),
            Err(ProtocolError::InvalidJson(_))
        ));
    }

    #[test]
    fn rejects_unknown_methods_and_invalid_request_identity() {
        let unknown = r#"{"protocol_version":1,"id":"x","kind":"request","method":"shell_exec","payload":{}}"#;
        let error = parse_envelope(unknown).expect_err("unknown method must be rejected");
        assert!(matches!(error, ProtocolError::UnknownMethod(_)));
        for id in ["".to_owned(), "x".repeat(MAX_ID_LENGTH + 1)] {
            let invalid = serde_json::json!({"protocol_version":1,"id":id,"kind":"request","method":"probe","payload":{}});
            assert!(matches!(
                parse_envelope(&invalid.to_string()),
                Err(ProtocolError::InvalidId)
            ));
        }
    }

    #[test]
    fn round_trips_a_valid_envelope() {
        let envelope =
            RuntimeEnvelope::request("req-1", EnvelopeMethod::Probe, serde_json::json!({}));
        let line = envelope.to_line().expect("serialize");
        let parsed = parse_envelope(&line).expect("parse");
        assert_eq!(parsed, envelope);
    }
}
