//! Launching the Node Agent Host child with a hardened process policy.
//!
//! `std::process::Command` never goes through a shell; the environment is built
//! from an explicit allowlist after `env_clear`, so the parent `process::env`
//! never reaches the child wholesale. Executable and cwd must stay inside
//! configured trusted roots.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use crate::runtime::supervisor::{self, ReclaimReport, ReclaimRoot};
use crate::runtime::{parse_envelope, ProtocolError, RuntimeEnvelope, MAX_LINE_BYTES};

#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    #[error("shell_forbidden: launching through a shell is never allowed")]
    ShellForbidden,
    #[error("executable_untrusted: {0} is not an absolute path inside a trusted root")]
    ExecutableUntrusted(String),
    #[error("executable_missing: {0}")]
    ExecutableMissing(String),
    #[error("cwd_untrusted: {0} is not an absolute directory inside the restricted cwd root")]
    CwdUntrusted(String),
    #[error("cwd_missing: {0}")]
    CwdMissing(String),
    #[error("env_not_allowlisted: {0}")]
    EnvNotAllowlisted(String),
    #[error("argv_invalid: {0}")]
    ArgvInvalid(String),
    #[error("trusted_root_missing: {0}")]
    TrustedRootMissing(String),
    #[error("spawn_failed: {0}")]
    SpawnFailed(String),
    #[error("io: {0}")]
    Io(String),
}

#[derive(Debug, Clone)]
pub struct HostConfig {
    pub executable: PathBuf,
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    /// Environment names allowed to reach the child; nothing else ever does.
    pub allowed_env: Vec<String>,
    /// Explicit allowlist source. Never populate this from the whole env.
    pub source_env: BTreeMap<String, String>,
    /// Child-specific values (scenario flags, ledger paths); must be allowlisted.
    pub extra_env: BTreeMap<String, String>,
    pub trusted_executable_roots: Vec<PathBuf>,
    pub trusted_cwd_roots: Vec<PathBuf>,
}

fn canonical_existing(
    path: &Path,
    untrusted: fn(String) -> SpawnError,
    missing: fn(String) -> SpawnError,
) -> Result<PathBuf, SpawnError> {
    if !path.is_absolute() {
        return Err(untrusted(path.display().to_string()));
    }
    path.canonicalize()
        .map_err(|_| missing(path.display().to_string()))
}

fn under_any(
    target: &Path,
    roots: &[PathBuf],
    untrusted: fn(String) -> SpawnError,
) -> Result<(), SpawnError> {
    for root in roots {
        let canonical_root = root
            .canonicalize()
            .map_err(|_| SpawnError::TrustedRootMissing(root.display().to_string()))?;
        if target.starts_with(&canonical_root) {
            return Ok(());
        }
    }
    Err(untrusted(target.display().to_string()))
}

impl HostConfig {
    pub fn validate(&self) -> Result<(), SpawnError> {
        if self.argv.iter().any(|argument| argument.contains('\0')) {
            return Err(SpawnError::ArgvInvalid(
                "argv must not contain NUL bytes".to_owned(),
            ));
        }
        if self.argv.iter().any(|argument| argument.contains('\n')) {
            return Err(SpawnError::ArgvInvalid(
                "argv must not contain line breaks; shell-style strings are rejected".to_owned(),
            ));
        }
        if cfg!(windows)
            && self
                .argv
                .iter()
                .any(|argument| argument.starts_with(r"\\?\"))
        {
            return Err(SpawnError::ArgvInvalid(
                r"verbatim \\?\ paths must be passed as regular paths; Node module resolution rejects them".to_owned(),
            ));
        }
        for name in self.allowed_env.iter().chain(self.extra_env.keys()) {
            if name.is_empty()
                || !name
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            {
                return Err(SpawnError::EnvNotAllowlisted(name.clone()));
            }
            if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return Err(SpawnError::EnvNotAllowlisted(name.clone()));
            }
        }
        for name in self.extra_env.keys() {
            if !self.allowed_env.contains(name) {
                return Err(SpawnError::EnvNotAllowlisted(name.clone()));
            }
        }
        let executable = canonical_existing(
            &self.executable,
            SpawnError::ExecutableUntrusted,
            SpawnError::ExecutableMissing,
        )?;
        if !executable.is_file() {
            return Err(SpawnError::ExecutableUntrusted(
                self.executable.display().to_string(),
            ));
        }
        under_any(
            &executable,
            &self.trusted_executable_roots,
            SpawnError::ExecutableUntrusted,
        )?;
        let cwd = canonical_existing(&self.cwd, SpawnError::CwdUntrusted, SpawnError::CwdMissing)?;
        if !cwd.is_dir() {
            return Err(SpawnError::CwdUntrusted(self.cwd.display().to_string()));
        }
        under_any(&cwd, &self.trusted_cwd_roots, SpawnError::CwdUntrusted)?;
        Ok(())
    }

    pub fn build_env(&self) -> BTreeMap<OsString, OsString> {
        let allowed: BTreeSet<&str> = self.allowed_env.iter().map(String::as_str).collect();
        // Case-insensitive source lookup matches Windows environment semantics.
        let source: BTreeMap<String, &String> = self
            .source_env
            .iter()
            .map(|(key, value)| (key.to_lowercase(), value))
            .collect();
        let mut env: BTreeMap<OsString, OsString> = BTreeMap::new();
        for name in &self.allowed_env {
            if let Some(value) = source.get(&name.to_lowercase()) {
                env.insert(OsString::from(name), OsString::from(*value));
            }
        }
        for (name, value) in &self.extra_env {
            if allowed.contains(name.as_str()) {
                env.insert(OsString::from(name), OsString::from(value));
            }
        }
        env
    }
}

pub struct HostProcess {
    pub child: Child,
    pub started_at_ms: i64,
    reader: BufReader<Box<dyn std::io::Read + Send>>,
    tracker: crate::runtime::RequestTracker,
}

impl HostProcess {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// One NDJSON message to the child, verbatim and line-delimited.
    pub fn send(&mut self, envelope: &RuntimeEnvelope) -> Result<(), SpawnError> {
        let line = envelope
            .to_line()
            .map_err(|error| SpawnError::Io(error.to_string()))?;
        let stdin = self
            .child
            .stdin
            .as_mut()
            .ok_or_else(|| SpawnError::Io("stdin closed".to_owned()))?;
        writeln!(stdin, "{line}").map_err(|error| SpawnError::Io(error.to_string()))?;
        stdin
            .flush()
            .map_err(|error| SpawnError::Io(error.to_string()))
    }

    /// One NDJSON message from the child with the same hard limits as the
    /// parent protocol; `Ok(None)` means the child closed its stdout.
    pub fn recv(&mut self) -> Result<Option<RuntimeEnvelope>, ProtocolError> {
        let mut buffer: Vec<u8> = Vec::new();
        // The read itself is bounded: a hostile child streaming a newline-free
        // flood must never buffer more than one message plus a byte in memory.
        let limit = u64::try_from(MAX_LINE_BYTES)
            .unwrap_or(u64::MAX)
            .saturating_add(1);
        let read = (&mut self.reader)
            .take(limit)
            .read_until(b'\n', &mut buffer)
            .map_err(|error| ProtocolError::InvalidJson(error.to_string()))?;
        if read == 0 {
            return Ok(None);
        }
        if buffer.last() == Some(&b'\n') {
            buffer.pop();
            if buffer.last() == Some(&b'\r') {
                buffer.pop();
            }
        } else if buffer.len() as u64 >= limit {
            return Err(ProtocolError::TooLarge(buffer.len()));
        } else {
            return Err(ProtocolError::Truncated);
        }
        if buffer.len() > MAX_LINE_BYTES {
            return Err(ProtocolError::TooLarge(buffer.len()));
        }
        let line = String::from_utf8(buffer)
            .map_err(|_| ProtocolError::InvalidJson("invalid UTF-8".to_owned()))?;
        let envelope = parse_envelope(&line)?;
        // Contract C5: duplicate ids are a protocol error that terminates the
        // run; they are never silently accepted from an untrusted child.
        self.tracker.track(&envelope.id)?;
        Ok(Some(envelope))
    }

    pub fn kill_tree(&mut self) -> Result<ReclaimReport, SpawnError> {
        let root = ReclaimRoot {
            root_pid: self.pid(),
            spawned_at_ms: self.started_at_ms,
            exited_at_ms: None,
        };
        let report = supervisor::reclaim_process_tree(root)?;
        let _ = self.child.wait();
        Ok(report)
    }
}

pub fn spawn_host(config: &HostConfig) -> Result<HostProcess, SpawnError> {
    config.validate()?;
    let executable = config
        .executable
        .canonicalize()
        .map_err(|_| SpawnError::ExecutableMissing(config.executable.display().to_string()))?;
    let cwd = config
        .cwd
        .canonicalize()
        .map_err(|_| SpawnError::CwdMissing(config.cwd.display().to_string()))?;
    let mut command = Command::new(&executable);
    command
        .args(&config.argv)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // No shell is ever involved; env_clear plus the allowlist map keeps the
        // parent environment out of the child entirely.
        .env_clear()
        .envs(config.build_env());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|error| SpawnError::SpawnFailed(error.to_string()))?;
    let started_at_ms = chrono::Utc::now().timestamp_millis();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| SpawnError::Io("stdout missing".to_owned()))?;
    let reader: BufReader<Box<dyn std::io::Read + Send>> = BufReader::new(Box::new(stdout));
    Ok(HostProcess {
        child,
        started_at_ms,
        reader,
        tracker: crate::runtime::RequestTracker::default(),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::runtime::test_support::{fake_runtime, node_executable};
    use crate::runtime::{EnvelopeMethod, RuntimeEnvelope};

    fn system_env() -> BTreeMap<String, String> {
        let names = ["SystemRoot", "SystemDrive", "WINDIR", "TEMP", "TMP", "PATH"];
        names
            .iter()
            .filter_map(|name| {
                std::env::var(name)
                    .ok()
                    .map(|value| ((*name).to_owned(), value))
            })
            .collect()
    }

    fn test_config(temp: &Path) -> HostConfig {
        let node = node_executable();
        let node_root = node.parent().expect("node parent").to_path_buf();
        let mut extra = system_env();
        extra.insert("TEST_SCENARIO".to_owned(), "normal".to_owned());
        let allowed_env = extra.keys().cloned().collect();
        HostConfig {
            executable: node,
            argv: vec![fake_runtime().to_string_lossy().into_owned()],
            cwd: temp.to_path_buf(),
            allowed_env,
            source_env: BTreeMap::new(),
            extra_env: extra,
            trusted_executable_roots: vec![node_root],
            trusted_cwd_roots: vec![temp.to_path_buf()],
        }
    }

    #[test]
    fn build_env_passes_only_allowlisted_names() {
        let mut config = test_config(std::path::Path::new("."));
        config.allowed_env = vec!["TEST_SCENARIO".to_owned()];
        config.extra_env.retain(|key, _| key == "TEST_SCENARIO");
        let mut source = BTreeMap::new();
        source.insert("SECRET_CANARY".to_owned(), "must-not-leak".to_owned());
        source.insert("TEST_SCENARIO".to_owned(), "normal".to_owned());
        config.source_env = source;
        let env = config.build_env();
        assert_eq!(env.len(), 1, "only the allowlisted name reaches the child");
        assert_eq!(
            env.get(std::ffi::OsStr::new("TEST_SCENARIO"))
                .map(|v| v.to_string_lossy().into_owned()),
            Some("normal".to_owned())
        );
        assert!(
            !env.contains_key(std::ffi::OsStr::new("SECRET_CANARY")),
            "the whole process env is never forwarded"
        );
    }

    #[test]
    fn validate_rejects_untrusted_paths_shell_style_argv_and_unknown_env() {
        let temp = std::env::temp_dir();
        let mut config = test_config(&temp);

        config.executable = PathBuf::from("node");
        assert!(matches!(
            config.validate(),
            Err(SpawnError::ExecutableUntrusted(_))
        ));

        config.executable = fake_runtime();
        assert!(matches!(
            config.validate(),
            Err(SpawnError::ExecutableUntrusted(_))
        ));

        config.executable = node_executable();
        config.cwd = PathBuf::from(if cfg!(windows) { "C:\\Windows" } else { "/etc" });
        assert!(matches!(
            config.validate(),
            Err(SpawnError::CwdUntrusted(_))
        ));

        config.cwd = temp.clone();
        config.argv = vec![
            "cmd /c echo shell-string".to_owned(),
            "second\nline".to_owned(),
        ];
        assert!(matches!(config.validate(), Err(SpawnError::ArgvInvalid(_))));

        if cfg!(windows) {
            config.argv = vec![format!(r"\\?\C:\tools\{}", "script with space.mjs")];
            assert!(matches!(config.validate(), Err(SpawnError::ArgvInvalid(_))));
        }

        config.argv = vec![fake_runtime().to_string_lossy().into_owned()];
        config
            .extra_env
            .insert("NOT_ALLOWLISTED".to_owned(), "x".to_owned());
        assert!(matches!(
            config.validate(),
            Err(SpawnError::EnvNotAllowlisted(_))
        ));
    }

    #[test]
    fn spawns_the_fake_runtime_and_round_trips_a_probe_with_cjk_argv() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut config = test_config(temp.path());
        config.argv = vec![
            fake_runtime().to_string_lossy().into_owned(),
            "参数 with space".to_owned(),
        ];
        let mut host = spawn_host(&config).expect("spawn host");
        let mut stderr_pipe = host.child.stderr.take().expect("piped stderr");
        host.send(&RuntimeEnvelope::request(
            "probe-1",
            EnvelopeMethod::Probe,
            serde_json::json!({}),
        ))
        .expect("send probe");
        let response = host.recv().expect("recv probe");
        // Ask for a clean shutdown so stderr reaches EOF, then prove the split:
        // protocol on stdout (recv above), logs only on stderr.
        let _ = host.send(&RuntimeEnvelope::request(
            "shutdown-1",
            EnvelopeMethod::Shutdown,
            serde_json::json!({}),
        ));
        let _ = host.child.wait();
        let mut logs = String::new();
        std::io::Read::read_to_string(&mut stderr_pipe, &mut logs).expect("read stderr");
        let response = match response {
            Some(response) => response,
            None => panic!("probe response missing; child stderr: {logs}"),
        };
        assert!(logs.contains("[fake-runtime]"), "logs go to stderr: {logs}");
        assert_eq!(response.method, EnvelopeMethod::Probe);
        assert_eq!(
            response.payload["argv"],
            serde_json::json!(["参数 with space"])
        );
        assert_eq!(response.payload["ok"], serde_json::json!(true));
        assert_eq!(
            response.payload["profiles"][0]["verification"],
            serde_json::json!("mock_only")
        );
    }
}
