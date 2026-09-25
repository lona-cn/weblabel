//! Private NDJSON runtime protocol and host supervision (docs/contracts.md C5).
//!
//! The wire format mirrors `apps/agent-host/src/protocol.ts`: one JSON message
//! per line, a 4 MiB per-line cap enforced BEFORE decoding, and controlled
//! failures for truncation, multi-line input, unknown methods and duplicate
//! request ids.

pub mod host;
pub mod supervisor;

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ID_LENGTH: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvelopeKind {
    Request,
    Response,
    Event,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvelopeMethod {
    Probe,
    StartRun,
    CancelRun,
    Shutdown,
    RunEvent,
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
    #[error("invalid_kind_method_pair: {0}")]
    KindMethodPair(String),
    #[error("truncated_message: stream ended in the middle of a message")]
    Truncated,
    #[error("duplicate_request_id: request id {0} was already used")]
    DuplicateRequestId(String),
}

fn method_from_str(raw: &str) -> Result<EnvelopeMethod, ProtocolError> {
    match raw {
        "probe" => Ok(EnvelopeMethod::Probe),
        "start_run" => Ok(EnvelopeMethod::StartRun),
        "cancel_run" => Ok(EnvelopeMethod::CancelRun),
        "shutdown" => Ok(EnvelopeMethod::Shutdown),
        "run_event" => Ok(EnvelopeMethod::RunEvent),
        other => Err(ProtocolError::UnknownMethod(other.to_owned())),
    }
}

fn check_pair(kind: EnvelopeKind, method: EnvelopeMethod) -> Result<(), ProtocolError> {
    let valid = match kind {
        EnvelopeKind::Request => matches!(
            method,
            EnvelopeMethod::Probe
                | EnvelopeMethod::StartRun
                | EnvelopeMethod::CancelRun
                | EnvelopeMethod::Shutdown
        ),
        EnvelopeKind::Event => matches!(method, EnvelopeMethod::RunEvent),
        EnvelopeKind::Response => true,
    };
    if valid {
        Ok(())
    } else {
        Err(ProtocolError::KindMethodPair(format!(
            "{method:?} with {kind:?}"
        )))
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
        "event" => EnvelopeKind::Event,
        other => return Err(ProtocolError::InvalidKind(other.to_owned())),
    };
    let method_raw = object
        .get("method")
        .and_then(|value| value.as_str())
        .ok_or_else(|| ProtocolError::UnknownMethod("missing".to_owned()))?;
    let method = method_from_str(method_raw)?;
    check_pair(kind, method)?;
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

#[derive(Debug, Default)]
pub struct RequestTracker {
    seen: HashSet<String>,
}

impl RequestTracker {
    pub fn track(&mut self, id: &str) -> Result<(), ProtocolError> {
        if id.is_empty() || id.len() > MAX_ID_LENGTH {
            return Err(ProtocolError::InvalidId);
        }
        if self.seen.insert(id.to_owned()) {
            Ok(())
        } else {
            Err(ProtocolError::DuplicateRequestId(id.to_owned()))
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;
    use std::process::Command;

    use crate::runtime::supervisor;

    /// Locate the Node.js executable the same way the host would: an absolute
    /// path found on PATH, then pinned as a trusted root for the test config.
    pub fn node_executable() -> PathBuf {
        if let Ok(configured) = std::env::var("WEBLABEL_NODE_RUNTIME") {
            return PathBuf::from(configured);
        }
        let program = if cfg!(windows) { "node.exe" } else { "node" };
        let path_var = std::env::var("PATH").unwrap_or_default();
        for entry in std::env::split_paths(&path_var) {
            let candidate = entry.join(program);
            if candidate.is_file() {
                return candidate;
            }
        }
        // Fall back to asking the platform tool once; the result is still pinned
        // to an absolute path before any spawn.
        let output = Command::new(if cfg!(windows) { "where" } else { "which" })
            .arg(program)
            .output()
            .expect("failed to locate node executable");
        let text = String::from_utf8_lossy(&output.stdout);
        PathBuf::from(
            text.lines()
                .find(|line| !line.trim().is_empty())
                .expect("node executable not found")
                .trim(),
        )
    }

    fn strip_verbatim(path: PathBuf) -> PathBuf {
        // Rust canonicalize() yields \\?\-prefixed verbatim paths on Windows;
        // Node's module loader rejects those as entry arguments.
        let text = path.to_string_lossy().into_owned();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            PathBuf::from(format!(r"\\{rest}"))
        } else if let Some(rest) = text.strip_prefix(r"\\?\") {
            PathBuf::from(rest.to_owned())
        } else {
            path
        }
    }

    pub fn fake_runtime() -> PathBuf {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let joined = manifest.join("../../tests/support/fake-runtime.mjs");
        strip_verbatim(
            joined
                .canonicalize()
                .expect("tests/support/fake-runtime.mjs must exist"),
        )
    }

    pub fn process_alive(pid: u32) -> bool {
        supervisor::snapshot_pids().contains(&pid)
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
    fn rejects_unknown_methods_and_duplicate_request_ids() {
        let unknown = r#"{"protocol_version":1,"id":"x","kind":"request","method":"shell_exec","payload":{}}"#;
        let error = parse_envelope(unknown).expect_err("unknown method must be rejected");
        assert!(matches!(error, ProtocolError::UnknownMethod(_)));
        let mut tracker = RequestTracker::default();
        tracker.track("req-1").expect("first use is fine");
        assert!(matches!(
            tracker.track("req-1"),
            Err(ProtocolError::DuplicateRequestId(_))
        ));
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
