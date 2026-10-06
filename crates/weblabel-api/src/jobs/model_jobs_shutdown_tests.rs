use super::RuntimeLease;
use std::{process::Command,time::{Duration,Instant}};
use crate::runtime::{run_tokens::RunTokenStore,supervisor::{reclaim_process_tree,ReclaimRoot}};
#[test]
fn api_runtime_shutdown_waits_for_actual_owned_host_process_reclamation(){
 let directory=tempfile::tempdir().unwrap();let marker=directory.path().join("owned-child.json");
 let script=format!("const{{spawn}}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{stdio:'ignore'}});fs.writeFileSync({},JSON.stringify({{child_pid:child.pid}}));setInterval(()=>{{}},1000)",serde_json::to_string(&marker.to_string_lossy()).unwrap());
 let mut child=Command::new("node").args(["-e",&script]).spawn().unwrap();let root=ReclaimRoot{root_pid:child.id(),spawned_at_ms:chrono::Utc::now().timestamp_millis(),exited_at_ms:None};
 let deadline=Instant::now()+Duration::from_secs(10);while !marker.exists()&&Instant::now()<deadline{std::thread::sleep(Duration::from_millis(10));}
 if !marker.exists(){let _=reclaim_process_tree(root);panic!("owned Node descendant did not start");}
 let marker_body:serde_json::Value=serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
 let runtime=tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
 runtime.block_on(async{let lease=RuntimeLease{root:Some(root),tokens:RunTokenStore::new(),run_id:"t33-owned-synthetic-shutdown".to_owned()};drop(lease);});
 drop(runtime);
 // Child::try_wait reads the retained Windows process handle immediately. A slow
 // process-table probe here would accidentally give a detached reclaimer time to finish.
 let observed=child.try_wait().unwrap();
 let cleanup=reclaim_process_tree(root);if child.try_wait().unwrap().is_none(){let _=child.kill();}let _=child.wait();
 println!("actual_owned_root_pid={} child_pid={} root_exited_before_runtime_return={} final_reclaim={}",root.root_pid,marker_body["child_pid"],observed.is_some(),cleanup.is_ok());
 assert!(observed.is_some(),"API runtime returned while the owned Host root was still alive");
 assert!(cleanup.is_ok(),"synthetic process cleanup backstop failed");
}
