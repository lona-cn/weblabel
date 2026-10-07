use super::RuntimeLease;
use crate::runtime::{
    host::{spawn_host, HostConfig},
    run_tokens::{RunTokenStore, TokenError},
    test_support::{node_executable, process_alive},
};
use std::{
    collections::BTreeMap,
    process::Command,
    time::{Duration, Instant},
};

#[test]
fn api_runtime_shutdown_waits_for_actual_owned_host_process_reclamation() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("owned-child.json");
    let heartbeat = directory.path().join("heartbeat");
    let descendant_script = format!(
        "const fs=require('node:fs');setInterval(()=>fs.appendFileSync({},'alive\\n'),100)",
        serde_json::to_string(&heartbeat.to_string_lossy()).unwrap(),
    );
    let script = format!(
        "const{{spawn}}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',{}],{{stdio:'ignore',detached:true}});child.unref();fs.writeFileSync({},JSON.stringify({{child_pid:child.pid}}));setInterval(()=>{{}},1000)",
        serde_json::to_string(&descendant_script).unwrap(),
        serde_json::to_string(&marker.to_string_lossy()).unwrap(),
    );
    let node = node_executable();
    let env: BTreeMap<String, String> =
        ["SystemRoot", "SystemDrive", "WINDIR", "TEMP", "TMP", "PATH"]
            .into_iter()
            .filter_map(|key| std::env::var(key).ok().map(|value| (key.to_owned(), value)))
            .collect();
    let mut host = spawn_host(&HostConfig {
        trusted_executable_roots: vec![node.parent().unwrap().to_path_buf()],
        executable: node.clone(),
        argv: vec!["-e".into(), script],
        cwd: directory.path().to_path_buf(),
        trusted_cwd_roots: vec![directory.path().to_path_buf()],
        allowed_env: env.keys().cloned().collect(),
        source_env: BTreeMap::new(),
        extra_env: env,
    })
    .unwrap();
    struct Foreign(std::process::Child);
    impl Drop for Foreign {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut foreign = Foreign(
        Command::new(node)
            .args(["-e", "setInterval(()=>{},1000)"])
            .spawn()
            .unwrap(),
    );
    let root = host.reclaim_root();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !heartbeat.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if !heartbeat.exists() {
        let _ = host.kill_tree();
        panic!("owned detached descendant did not start");
    }
    let marker_body: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
    let descendant = marker_body["child_pid"].as_u64().unwrap() as u32;
    assert!(
        process_alive(descendant),
        "the detached descendant is actually running"
    );
    let tokens = RunTokenStore::new();
    let token = tokens.issue(
        "t33-owned-synthetic-shutdown",
        "owned-project",
        Duration::from_secs(60),
    );
    let foreign_token = tokens.issue("foreign-run", "foreign-project", Duration::from_secs(60));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        drop(RuntimeLease {
            root: Some(root.clone()),
            tokens: tokens.clone(),
            run_id: "t33-owned-synthetic-shutdown".into(),
        });
        assert_eq!(
            tokens.verify(&token),
            Err(TokenError::Revoked),
            "authorization is revoked before asynchronous cleanup"
        );
        assert!(
            tokens.verify(&foreign_token).is_ok(),
            "another run's authorization survives"
        );
    });
    drop(runtime);
    // Observe the retained Child state immediately, before any process-table
    // probe could give an incorrectly detached cleanup thread time to finish.
    let observed = host.child.try_wait().unwrap();
    let cleanup = host.kill_tree();
    println!("actual_owned_root_pid={} child_pid={} root_exited_before_runtime_return={} final_reclaim={}", root.root_pid, descendant, observed.is_some(), cleanup.is_ok());
    assert!(
        observed.is_some(),
        "API runtime returned while the owned Host root was still alive"
    );
    assert!(cleanup.is_ok(), "owned process cleanup backstop failed");
    assert!(
        !process_alive(descendant),
        "shutdown stopped the running detached descendant"
    );
    assert!(
        foreign.0.try_wait().unwrap().is_none(),
        "unrelated process survives shutdown"
    );
}
