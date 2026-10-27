//! Launching native Claude and detector children with spawn-owned containment.
//!
//! `std::process::Command` never goes through a shell; the environment is built
//! from an explicit allowlist after `env_clear`, so the parent `process::env`
//! never reaches the child wholesale. Executable and cwd must stay inside
//! configured trusted roots.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[cfg(any(target_os = "linux", test))]
use crate::runtime::supervisor::ReclaimRoot;
use crate::runtime::supervisor::{self, ReclaimReport};

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

/// Native transport owns both pipes and the original OS process-tree capability.
pub struct NativeProcess {
    pub child: tokio::process::Child,
    pub root: supervisor::NativeRoot,
    #[cfg(not(target_os = "linux"))]
    ownership: supervisor::OwnedTree,
    #[cfg(target_os = "linux")]
    root_owner: std::sync::Arc<supervisor::linux_broker::ReclaimHandle>,
    reclaim_finished: bool,
}

impl NativeProcess {
    #[cfg(test)]
    pub(crate) fn reclaim_root(&self) -> ReclaimRoot {
        #[cfg(target_os = "linux")]
        {
            ReclaimRoot {
                root_pid: self.root.root_pid,
                spawned_at_ms: self.root.spawned_at_ms,
                exited_at_ms: None,
                owner: std::sync::Arc::clone(&self.root_owner),
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            self.root
        }
    }
    pub(crate) fn reclaim_lease(&self) -> Option<supervisor::OwnedReclaimLease> {
        #[cfg(target_os = "linux")]
        {
            Some(supervisor::OwnedReclaimLease::Broker(ReclaimRoot {
                root_pid: self.root.root_pid,
                spawned_at_ms: self.root.spawned_at_ms,
                exited_at_ms: None,
                owner: std::sync::Arc::clone(&self.root_owner),
            }))
        }
        #[cfg(not(target_os = "linux"))]
        {
            self.ownership.lease()
        }
    }

    pub async fn reclaim(&mut self) -> Result<ReclaimReport, SpawnError> {
        let outcome = async {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            #[cfg(target_os = "linux")]
            let report = {
                let lease = self
                    .reclaim_lease()
                    .ok_or_else(|| SpawnError::Io("native ownership unavailable".into()))?;
                tokio::task::spawn_blocking(move || lease.reclaim())
                    .await
                    .map_err(|_| SpawnError::Io("native reclamation task failed".into()))??
            };
            #[cfg(not(target_os = "linux"))]
            let report = {
                let observation = self.ownership.terminate()?;
                while !self.ownership.empty(&observation)? {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(SpawnError::Io("owned job reclamation timed out".into()));
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                self.ownership.report(observation)?
            };
            tokio::time::timeout_at(deadline, self.child.wait())
                .await
                .map_err(|_| SpawnError::Io("native child reap timed out".into()))?
                .map_err(|_| SpawnError::Io("native child reap failed".into()))?;
            Ok(report)
        }
        .await;
        // Cancellation before this point still retains a cleanup lease in Drop.
        // A returned failure is terminal, not a new five-second retry.
        self.reclaim_finished = true;
        outcome
    }
}

impl Drop for NativeProcess {
    fn drop(&mut self) {
        if self.reclaim_finished {
            return;
        }
        let Some(lease) = self.reclaim_lease() else {
            return;
        };
        // Keep original ownership through cancellation/runtime shutdown; never
        // turn a dead root PID or current descendant snapshot into kill authority.
        let reclaim = move || {
            if let Err(error) = lease.reclaim() {
                tracing::error!(%error, "abandoned native process reclamation failed");
            }
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn_blocking(reclaim);
        } else {
            reclaim();
        }
    }
}

/// Reject shell/script/npm wrappers by file identity, not just by extension.
/// Native format is not proof of publisher identity; the trusted local operator
/// still supplies the official CLI and protocol/auth evidence is a separate gate.
pub fn validate_native_executable(path: &Path) -> Result<(), SpawnError> {
    if !path.is_absolute() {
        return Err(SpawnError::ExecutableUntrusted(
            "native executable must be absolute".into(),
        ));
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| SpawnError::ExecutableMissing("native executable".into()))?;
    let basename = canonical
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if [
        "node",
        "nodejs",
        "npm",
        "npx",
        "cmd",
        "powershell",
        "pwsh",
        "sh",
        "bash",
        "python",
        "python3",
    ]
    .contains(&basename.as_str())
    {
        return Err(SpawnError::ShellForbidden);
    }
    let mut magic = [0u8; 4];
    std::fs::File::open(&canonical)
        .and_then(|mut file| file.read_exact(&mut magic))
        .map_err(|_| {
            SpawnError::ExecutableUntrusted("native executable format unavailable".into())
        })?;
    let native = if cfg!(windows) {
        magic[..2] == *b"MZ"
    } else if cfg!(target_os = "macos") {
        matches!(
            magic,
            [0xcf, 0xfa, 0xed, 0xfe]
                | [0xfe, 0xed, 0xfa, 0xcf]
                | [0xca, 0xfe, 0xba, 0xbe]
                | [0xbe, 0xba, 0xfe, 0xca]
        )
    } else {
        magic == *b"\x7fELF"
    };
    if !native {
        return Err(SpawnError::ExecutableUntrusted(
            "script/wrapper is not a native executable".into(),
        ));
    }
    Ok(())
}

pub fn spawn_native(config: &HostConfig) -> Result<NativeProcess, SpawnError> {
    config.validate()?;
    validate_native_executable(&config.executable)?;
    #[cfg(not(target_os = "linux"))]
    let mut ownership = supervisor::OwnedTree::new()?;
    let stamp = supervisor::registration_stamp();
    let executable = config
        .executable
        .canonicalize()
        .map_err(|_| SpawnError::ExecutableMissing("native executable".into()))?;
    let cwd = config
        .cwd
        .canonicalize()
        .map_err(|_| SpawnError::CwdMissing("native cwd".into()))?;
    #[cfg(not(target_os = "linux"))]
    let mut command = tokio::process::Command::new(&executable);
    #[cfg(target_os = "linux")]
    let mut command = tokio::process::Command::new(
        supervisor::linux_broker::executable()
            .map_err(|_| SpawnError::SpawnFailed("native broker executable unavailable".into()))?,
    );
    #[cfg(target_os = "linux")]
    let (completion, inherited_completion, inherited_parent) = {
        use std::os::fd::AsRawFd;
        let channels = supervisor::linux_broker::control(command.as_std_mut())
            .map_err(|_| SpawnError::SpawnFailed("native broker control unavailable".into()))?;
        command
            .arg(supervisor::linux_broker::MODE)
            .arg(channels.1.as_raw_fd().to_string())
            .arg(channels.2.as_raw_fd().to_string())
            .arg(std::process::id().to_string())
            .arg(&executable);
        channels
    };
    command
        .args(&config.argv)
        .current_dir(cwd)
        .env_clear()
        .envs(config.build_env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // On Linux the private broker peer/pidfd owns shutdown, not a root-only
    // kill-on-drop that could terminate the broker before it reaps descendants.
    command.kill_on_drop(!cfg!(target_os = "linux"));
    #[cfg(windows)]
    command.creation_flags(0x00000200 | 0x00000004);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    #[cfg(target_os = "linux")]
    let startup_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut child = command
        .spawn()
        .map_err(|_| SpawnError::SpawnFailed("native child spawn failed".into()))?;
    let root = supervisor::NativeRoot {
        root_pid: child
            .id()
            .ok_or_else(|| SpawnError::SpawnFailed("native child has no pid".into()))?,
        spawned_at_ms: stamp,
        exited_at_ms: None,
    };
    #[cfg(target_os = "linux")]
    let root_owner = {
        drop(inherited_completion);
        drop(inherited_parent);
        match supervisor::linux_broker::capture(root.root_pid, stamp, completion, startup_deadline)
        {
            Ok(owner) => owner,
            Err(error) => {
                while child.try_wait().ok().flatten().is_none()
                    && std::time::Instant::now() < startup_deadline
                {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                return Err(error);
            }
        }
    };
    #[cfg(windows)]
    if let Err(error) = ownership.attach(
        child
            .raw_handle()
            .ok_or_else(|| SpawnError::Io("suspended process handle missing".into()))?
            .cast(),
        root,
    ) {
        // No child instruction ran before containment; root-only abort is safe here.
        let _ = child.start_kill();
        return Err(error);
    }
    Ok(NativeProcess {
        child,
        root,
        reclaim_finished: false,
        #[cfg(not(target_os = "linux"))]
        ownership,
        #[cfg(target_os = "linux")]
        root_owner,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::test_support::{config, scratch};

    #[test]
    fn native_configuration_never_forwards_non_allowlisted_environment() {
        let directory = scratch();
        let mut config = config(directory.path(), "exit", &directory.path().join("pid"));
        config.allowed_env = vec!["R09_NATIVE_MODE".into()];
        config.extra_env.retain(|key, _| key == "R09_NATIVE_MODE");
        config
            .source_env
            .insert("SECRET_CANARY".into(), "must-not-leak".into());
        let env = config.build_env();
        assert_eq!(env.len(), 1);
        assert!(!env.contains_key(std::ffi::OsStr::new("SECRET_CANARY")));
        assert_eq!(env[std::ffi::OsStr::new("R09_NATIVE_MODE")], "exit");
    }

    #[test]
    fn native_configuration_rejects_untrusted_paths_invalid_argv_and_extra_environment() {
        let directory = scratch();
        let mut config = config(directory.path(), "exit", &directory.path().join("pid"));
        let executable = config.executable.clone();
        config.executable = PathBuf::from("relative-native");
        assert!(matches!(
            config.validate(),
            Err(SpawnError::ExecutableUntrusted(_))
        ));
        config.executable = executable;
        let other = scratch();
        config.cwd = other.path().to_owned();
        assert!(matches!(
            config.validate(),
            Err(SpawnError::CwdUntrusted(_))
        ));
        config.cwd = directory.path().to_owned();
        config.argv.push("second\nline".into());
        assert!(matches!(config.validate(), Err(SpawnError::ArgvInvalid(_))));
        config.argv.pop();
        config
            .extra_env
            .insert("NOT_ALLOWLISTED".into(), "x".into());
        assert!(matches!(
            config.validate(),
            Err(SpawnError::EnvNotAllowlisted(_))
        ));
        let wrapper = directory.path().join("wrapper");
        std::fs::write(&wrapper, b"#!/bin/sh\nexit 0\n").unwrap();
        assert!(
            validate_native_executable(&wrapper).is_err(),
            "native execution must reject scripts independent of extension"
        );
    }

    #[cfg(any(windows, target_os = "linux"))]
    #[tokio::test]
    async fn native_argv_preserves_unicode_and_spaces_with_separate_output_pipes() {
        use tokio::io::AsyncReadExt;
        let directory = scratch();
        let mut config = config(directory.path(), "argv", &directory.path().join("pid"));
        config
            .argv
            .extend(["--skip".into(), "参数 with space".into()]);
        let mut process = spawn_native(&config).unwrap();
        let mut stdout = process.child.stdout.take().unwrap();
        let mut stderr = process.child.stderr.take().unwrap();
        let output = async {
            let (mut out, mut err) = (String::new(), String::new());
            let (a, b) = tokio::join!(
                stdout.read_to_string(&mut out),
                stderr.read_to_string(&mut err)
            );
            a.unwrap();
            b.unwrap();
            (out, err)
        };
        let (out, err) = tokio::time::timeout(std::time::Duration::from_secs(5), output)
            .await
            .unwrap();
        assert!(out.contains("native-argv-ok") && !out.contains("native-fixture-log"));
        assert!(err.contains("native-fixture-log") && !err.contains("native-argv-ok"));
        assert!(process.child.wait().await.unwrap().success());
        process.reclaim().await.unwrap();
    }
}
