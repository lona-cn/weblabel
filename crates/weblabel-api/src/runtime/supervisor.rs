//! Run supervision and process-tree reclamation.
//!
//! Windows mechanism (exercised for real on this workstation):
//!   1. a PowerShell `Get-CimInstance Win32_Process` snapshot (pid, ppid,
//!      creation time); orphaned children keep their stale parent pid, so
//!      descendants of a crashed child are still discovered;
//!   2. pid-reuse guard: a root pid whose creation time is newer than our
//!      spawn record is a recycled pid and is never touched;
//!   3. `taskkill /pid <root> /T /F` reclaims the live tree, including children
//!      created in new process groups (detached);
//!   4. `taskkill /pid <orphan> /F` for each surviving descendant, identity
//!      re-checked right before the kill;
//!   5. a bounded resnapshot proves that no same-identity target pid remains.
//!
//! POSIX uses the same algorithm with `ps` snapshots and `kill -9`.

use std::collections::{HashMap, HashSet};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::runtime::host::{spawn_host, HostConfig, HostProcess, SpawnError};
use crate::runtime::{ProtocolError, RuntimeEnvelope};

const RECLAIM_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct ReclaimReport {
    pub root_pid: u32,
    pub mechanism: &'static str,
    pub descendants_found: Vec<u32>,
    pub killed: Vec<u32>,
}

/// Identity of the process tree being reclaimed.
#[derive(Debug, Clone, Copy)]
pub struct ReclaimRoot {
    pub root_pid: u32,
    /// Epoch milliseconds taken right after the root process was spawned.
    pub spawned_at_ms: i64,
    /// Epoch milliseconds when the root's exit was observed, when known.
    /// Descendants created after it cannot belong to the tree (pid reuse) and
    /// are leaked rather than killed.
    pub exited_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy)]
pub struct ProcessRecord {
    pub ppid: u32,
    /// Epoch milliseconds of process creation; None when the platform hides it.
    pub created_ms: Option<i64>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn system_tool(name: &str) -> String {
    if cfg!(windows) {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned());
        let candidates = [
            format!("{system_root}\\System32\\{name}"),
            format!("{system_root}\\System32\\WindowsPowerShell\\v1.0\\{name}"),
        ];
        if let Some(found) = candidates
            .iter()
            .find(|candidate| std::path::Path::new(candidate).exists())
        {
            return found.clone();
        }
    }
    name.to_owned()
}

fn run_tool(executable: &str, args: &[&str]) {
    let _ = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub(crate) fn snapshot_records() -> HashMap<u32, ProcessRecord> {
    let output = if cfg!(windows) {
        Command::new(system_tool("powershell.exe"))
            .args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToUniversalTime().ToString('o'))\" }",
            ])
            .output()
    } else {
        Command::new("ps").args(["-A", "-o", "pid=,ppid="]).output()
    };
    let stdout = match output {
        Ok(result) => result.stdout,
        Err(_) => return HashMap::new(),
    };
    let text = String::from_utf8_lossy(&stdout);
    let mut records = HashMap::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (parts.next(), parts.next()) else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) else {
            continue;
        };
        let created_ms = parts
            .next()
            .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
            .map(|when| when.timestamp_millis());
        records.insert(pid, ProcessRecord { ppid, created_ms });
    }
    records
}

#[cfg(test)]
pub(crate) fn snapshot_pids() -> HashSet<u32> {
    snapshot_records().into_keys().collect()
}

fn find_descendants(root: u32, table: &HashMap<u32, ProcessRecord>) -> Vec<u32> {
    let mut found = Vec::new();
    let mut queue = vec![root];
    let mut seen = HashSet::from([root]);
    while let Some(current) = queue.pop() {
        for (&pid, record) in table {
            if record.ppid != current || !seen.insert(pid) {
                continue;
            }
            found.push(pid);
            queue.push(pid);
        }
    }
    found
}

/// A target counts as reclaimed when its pid is gone or now names a different process.
fn still_same_process(
    target_pid: u32,
    target_created: Option<i64>,
    table: &HashMap<u32, ProcessRecord>,
) -> bool {
    match table.get(&target_pid) {
        None => false,
        Some(record) => match (record.created_ms, target_created) {
            (Some(current), Some(original)) => current == original,
            _ => true,
        },
    }
}

pub fn reclaim_process_tree(root: ReclaimRoot) -> Result<ReclaimReport, SpawnError> {
    let cutoff_ms = now_ms();
    let table = snapshot_records();
    let root_is_ours = table.get(&root.root_pid).is_none_or(|record| {
        record
            .created_ms
            .is_none_or(|created| created <= root.spawned_at_ms)
    });
    let descendants: Vec<u32> = find_descendants(root.root_pid, &table)
        .into_iter()
        .filter(|pid| {
            table
                .get(pid)
                .and_then(|record| record.created_ms)
                .is_none_or(|created| {
                    created >= root.spawned_at_ms
                        && created <= root.exited_at_ms.unwrap_or(cutoff_ms)
                })
        })
        .collect();
    let mut targets: Vec<(u32, Option<i64>)> = Vec::new();
    if root_is_ours {
        targets.push((
            root.root_pid,
            table
                .get(&root.root_pid)
                .and_then(|record| record.created_ms),
        ));
    }
    for pid in &descendants {
        targets.push((*pid, table.get(pid).and_then(|record| record.created_ms)));
    }
    let mechanism = if cfg!(windows) {
        "windows taskkill /T + CIM descendant sweep (creation-time identity checked)"
    } else {
        "posix kill -9 + ps snapshot sweep (ps exposes no creation time, so creation identity is unavailable on POSIX)"
    };
    if cfg!(windows) {
        if root_is_ours {
            run_tool(
                &system_tool("taskkill.exe"),
                &["/pid", &root.root_pid.to_string(), "/T", "/F"],
            );
        }
        for (pid, created) in &targets {
            if *pid == root.root_pid {
                continue;
            }
            if still_same_process(*pid, *created, &snapshot_records()) {
                run_tool(
                    &system_tool("taskkill.exe"),
                    &["/pid", &pid.to_string(), "/F"],
                );
            }
        }
    } else {
        for (pid, _) in &targets {
            run_tool("/bin/kill", &["-9", &pid.to_string()]);
        }
    }
    let deadline = Instant::now() + RECLAIM_DEADLINE;
    loop {
        let alive: Vec<u32> = targets
            .iter()
            .filter(|(pid, created)| still_same_process(*pid, *created, &snapshot_records()))
            .map(|(pid, _)| *pid)
            .collect();
        if alive.is_empty() {
            break;
        }
        if Instant::now() >= deadline {
            return Err(SpawnError::SpawnFailed(format!(
                "reclaim incomplete: pids still alive: {alive:?}"
            )));
        }
        thread::sleep(Duration::from_millis(250));
    }
    Ok(ReclaimReport {
        root_pid: root.root_pid,
        mechanism,
        descendants_found: descendants,
        killed: targets.into_iter().map(|(pid, _)| pid).collect(),
    })
}

pub struct RunEntry {
    pub run_id: String,
    pub started_at: Instant,
    pub deadline: Option<Instant>,
    pub host: HostProcess,
}

pub struct Supervisor {
    config: HostConfig,
    run_timeout: Option<Duration>,
    runs: HashMap<String, RunEntry>,
}

impl Supervisor {
    pub fn new(config: HostConfig, run_timeout: Option<Duration>) -> Self {
        Self {
            config,
            run_timeout,
            runs: HashMap::new(),
        }
    }

    /// Identity for independent teardown while a blocking pipe read is active.
    pub fn reclaim_root(&self, run_id: &str) -> Option<ReclaimRoot> {
        self.runs.get(run_id).map(|entry| ReclaimRoot {
            root_pid: entry.host.pid(),
            spawned_at_ms: entry.host.started_at_ms,
            exited_at_ms: None,
        })
    }

    pub fn start_run(&mut self, run_id: &str) -> Result<(), SpawnError> {
        if self.runs.contains_key(run_id) {
            return Err(SpawnError::SpawnFailed(format!(
                "run {run_id} already exists"
            )));
        }
        let host = spawn_host(&self.config)?;
        let started_at = Instant::now();
        let deadline = self.run_timeout.map(|timeout| started_at + timeout);
        self.runs.insert(
            run_id.to_owned(),
            RunEntry {
                run_id: run_id.to_owned(),
                started_at,
                deadline,
                host,
            },
        );
        Ok(())
    }

    pub fn send(&mut self, run_id: &str, envelope: &RuntimeEnvelope) -> Result<(), SpawnError> {
        let entry = self
            .runs
            .get_mut(run_id)
            .ok_or_else(|| SpawnError::SpawnFailed(format!("unknown run {run_id}")))?;
        entry.host.send(envelope)
    }

    pub fn recv(&mut self, run_id: &str) -> Result<Option<RuntimeEnvelope>, ProtocolError> {
        let entry = self.runs.get_mut(run_id).ok_or(ProtocolError::Truncated)?;
        entry.host.recv()
    }

    pub fn cancel_run(&mut self, run_id: &str) -> Result<ReclaimReport, SpawnError> {
        let mut entry = self
            .runs
            .remove(run_id)
            .ok_or_else(|| SpawnError::SpawnFailed(format!("unknown run {run_id}")))?;
        entry.host.kill_tree()
    }

    /// Reclaim every run that outlived its deadline. A possibly billed request
    /// is never resent: a timed-out run is terminated, not retried.
    pub fn enforce_deadlines(&mut self) -> Vec<String> {
        let now = Instant::now();
        let expired: Vec<String> = self
            .runs
            .values()
            .filter(|entry| entry.deadline.is_some_and(|deadline| now >= deadline))
            .map(|entry| entry.run_id.clone())
            .collect();
        for run_id in &expired {
            let _ = self.cancel_run(run_id);
        }
        expired
    }

    pub fn shutdown(&mut self) -> Vec<ReclaimReport> {
        let run_ids: Vec<String> = self.runs.keys().cloned().collect();
        run_ids
            .iter()
            .filter_map(|run_id| self.cancel_run(run_id).ok())
            .collect()
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::Duration;

    use super::*;
    use crate::runtime::host::HostConfig;
    use crate::runtime::test_support::{fake_runtime, node_executable, process_alive};
    use crate::runtime::{EnvelopeMethod, RuntimeEnvelope};

    fn system_env() -> BTreeMap<String, String> {
        // std::process::Command with env_clear builds a truly bare environment
        // block (no libuv-style baseline), so system essentials must be part of
        // the explicit allowlist like any other variable.
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

    fn spawn_config(mut extra: BTreeMap<String, String>, cwd: &std::path::Path) -> HostConfig {
        let node = node_executable();
        let node_root = node.parent().expect("node parent").to_path_buf();
        for (key, value) in system_env() {
            extra.entry(key).or_insert(value);
        }
        let allowed_env: Vec<String> = extra.keys().cloned().collect();
        HostConfig {
            executable: node,
            argv: vec![fake_runtime().to_string_lossy().into_owned()],
            cwd: cwd.to_path_buf(),
            allowed_env,
            source_env: BTreeMap::new(),
            extra_env: extra,
            trusted_executable_roots: vec![node_root],
            trusted_cwd_roots: vec![cwd.to_path_buf()],
        }
    }

    fn wait_for_file(path: &std::path::Path) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {}",
                path.display()
            );
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn reclaims_detached_orphans_left_by_a_crashed_child() {
        let temp = tempfile::tempdir().expect("tempdir");
        let pid_file = temp.path().join("pids.json");
        let mut extra = BTreeMap::new();
        extra.insert("TEST_SCENARIO".to_owned(), "crash".to_owned());
        extra.insert("FAKE_RUNTIME_SPAWN_CHILD".to_owned(), "1".to_owned());
        extra.insert(
            "FAKE_RUNTIME_PID_FILE".to_owned(),
            pid_file.to_string_lossy().into_owned(),
        );
        let config = spawn_config(extra, temp.path());
        let mut host = spawn_host(&config).expect("spawn host");
        host.send(&RuntimeEnvelope::request(
            "req-1",
            EnvelopeMethod::StartRun,
            serde_json::json!({}),
        ))
        .expect("send start_run");
        let status = host.child.wait().expect("wait for crash");
        assert_eq!(
            status.code(),
            Some(7),
            "fake runtime crash scenario exits 7"
        );

        wait_for_file(&pid_file);
        let pids: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&pid_file).expect("pid file"))
                .expect("pid json");
        let grandchild = pids["grandchild_pid"].as_u64().expect("grandchild pid") as u32;
        assert!(
            process_alive(grandchild),
            "detached grandchild must survive the crash"
        );

        let root_exited_at_ms = now_ms();
        let report = reclaim_process_tree(ReclaimRoot {
            root_pid: host.pid(),
            spawned_at_ms: host.started_at_ms,
            exited_at_ms: Some(root_exited_at_ms),
        })
        .expect("reclaim");
        if cfg!(windows) {
            assert_eq!(
                report.mechanism,
                "windows taskkill /T + CIM descendant sweep (creation-time identity checked)"
            );
        }
        assert!(
            report.descendants_found.contains(&grandchild),
            "orphan found via stale ppid"
        );
        assert!(!process_alive(grandchild), "detached orphan reclaimed");
    }

    #[test]
    fn enforce_deadlines_reclaims_the_tree_of_a_stuck_run() {
        let temp = tempfile::tempdir().expect("tempdir");
        let pid_file = temp.path().join("pids.json");
        let mut extra = BTreeMap::new();
        extra.insert("TEST_SCENARIO".to_owned(), "slow".to_owned());
        extra.insert("FAKE_RUNTIME_SPAWN_CHILD".to_owned(), "1".to_owned());
        extra.insert(
            "FAKE_RUNTIME_PID_FILE".to_owned(),
            pid_file.to_string_lossy().into_owned(),
        );
        let config = spawn_config(extra, temp.path());
        let mut supervisor = Supervisor::new(config, Some(Duration::from_millis(300)));
        supervisor.start_run("run-slow").expect("start run");
        supervisor
            .send(
                "run-slow",
                &RuntimeEnvelope::request("req-1", EnvelopeMethod::StartRun, serde_json::json!({})),
            )
            .expect("send start_run");
        wait_for_file(&pid_file);
        let pids: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&pid_file).expect("pid file"))
                .expect("pid json");
        let grandchild = pids["grandchild_pid"].as_u64().expect("grandchild pid") as u32;

        thread::sleep(Duration::from_millis(500));
        let expired = supervisor.enforce_deadlines();
        assert_eq!(
            expired,
            vec!["run-slow".to_owned()],
            "stuck run reclaimed at its deadline"
        );
        assert!(
            !process_alive(grandchild),
            "grandchild reclaimed with the timed-out run"
        );
    }
}
