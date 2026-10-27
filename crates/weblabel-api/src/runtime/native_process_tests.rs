//! Synthetic native executable fixtures; no Node, provider account or detector.
#![cfg(any(windows, target_os = "linux"))]
use crate::runtime::{
    host::{spawn_native, NativeProcess},
    supervisor::reclaim_process_tree,
    test_support::{self, config, marker, process_alive, scratch, usable},
};
use std::{path::Path, time::Duration};

struct Foreign(std::process::Child);
impl Drop for Foreign {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn descendant(path: &Path) -> serde_json::Value {
    marker(&path.with_extension("leaf"))
}

#[cfg(windows)]
fn original_handle(process: &NativeProcess) -> std::os::windows::io::OwnedHandle {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::{
        Foundation::DuplicateHandle,
        System::Threading::{GetCurrentProcess, PROCESS_SYNCHRONIZE},
    };
    let mut duplicate = std::ptr::null_mut();
    // Duplicate the exact live Child handle before drop, never reopen by PID.
    assert_ne!(
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                process.child.raw_handle().unwrap().cast(),
                GetCurrentProcess(),
                &mut duplicate,
                PROCESS_SYNCHRONIZE,
                0,
                0,
            )
        },
        0
    );
    unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(duplicate) }
}

#[test]
fn api_runtime_shutdown_joins_cleanup_after_complete_native_owner_drop() {
    let directory = scratch();
    let path = directory.path().join("owned.json");
    let mut foreign = Foreign(
        test_support::foreign(directory.path(), &directory.path().join("foreign.json"))
            .spawn()
            .unwrap(),
    );
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let process =
        runtime.block_on(async { spawn_native(&config(directory.path(), "tree", &path)).unwrap() });
    let root_pid = process.root.root_pid;
    let child = descendant(&path);
    assert!(
        usable(&child),
        "the detached native descendant is actually responsive"
    );
    let backstop = process.reclaim_lease().unwrap();
    #[cfg(windows)]
    let original = original_handle(&process);
    runtime.block_on(async {
        drop(process);
    });
    drop(runtime);
    // Observe immediately, before the independent backstop can perform cleanup.
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::WAIT_OBJECT_0, System::Threading::WaitForSingleObject,
        };
        assert_eq!(
            unsafe { WaitForSingleObject(original.as_raw_handle().cast(), 0) },
            WAIT_OBJECT_0,
            "runtime returned before the original native root signaled"
        );
    }
    #[cfg(target_os = "linux")]
    assert!(
        !process_alive(root_pid),
        "runtime returned before owned broker completed cleanup"
    );
    assert!(!process_alive(child["pid"].as_u64().unwrap() as u32));
    assert!(
        backstop.reclaim().is_ok(),
        "strong ownership survives complete owner/registry retirement"
    );
    assert!(foreign.0.try_wait().unwrap().is_none());
    let _ = root_pid;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_native_future_retains_cleanup_after_task_owner_drop() {
    let directory = scratch();
    let path = directory.path().join("cancelled.json");
    let process = spawn_native(&config(directory.path(), "tree", &path)).unwrap();
    let child = descendant(&path);
    assert!(usable(&child));
    let retained = process.reclaim_lease().unwrap();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let _owned = process;
        entered.send(()).unwrap();
        std::future::pending::<()>().await;
    });
    ready.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::task::spawn_blocking(move || retained.reclaim())
        .await
        .unwrap()
        .unwrap();
    assert!(!process_alive(child["pid"].as_u64().unwrap() as u32));
}

#[tokio::test]
async fn stale_root_cannot_kill_responsive_foreign_tree_or_another_run() {
    let directory = scratch();
    let first_path = directory.path().join("first.json");
    let second_path = directory.path().join("second.json");
    let mut first = spawn_native(&config(directory.path(), "tree", &first_path)).unwrap();
    let mut second = spawn_native(&config(directory.path(), "tree", &second_path)).unwrap();
    let mut foreign = Foreign(
        test_support::foreign(directory.path(), &directory.path().join("foreign.json"))
            .spawn()
            .unwrap(),
    );
    let first_root = marker(&first_path);
    let first_leaf = descendant(&first_path);
    let second_leaf = descendant(&second_path);
    assert!(usable(&first_root) && usable(&first_leaf) && usable(&second_leaf));
    let mut stale = first.reclaim_root();
    stale.spawned_at_ms = 0;
    assert!(reclaim_process_tree(stale).is_err());
    assert!(
        usable(&first_root) && usable(&first_leaf),
        "stale metadata cannot authorize root or detached leaf termination"
    );
    let mut unrelated = first.reclaim_root();
    unrelated.root_pid = foreign.0.id();
    unrelated.spawned_at_ms = 0;
    assert!(reclaim_process_tree(unrelated).is_err());
    assert!(foreign.0.try_wait().unwrap().is_none());
    first.reclaim().await.unwrap();
    assert!(!process_alive(first_leaf["pid"].as_u64().unwrap() as u32));
    assert!(
        usable(&second_leaf),
        "cancelling one run cannot terminate another owned tree"
    );
    assert!(foreign.0.try_wait().unwrap().is_none());
    second.reclaim().await.unwrap();
    assert!(!process_alive(second_leaf["pid"].as_u64().unwrap() as u32));
}

#[tokio::test]
async fn native_crash_and_normal_orphan_exit_reclaim_detached_descendants() {
    for mode in ["crash", "orphan"] {
        let directory = scratch();
        let path = directory.path().join("owned.json");
        let mut process = spawn_native(&config(directory.path(), mode, &path)).unwrap();
        let child = descendant(&path);
        if mode == "crash" {
            assert!(usable(&child));
            std::fs::write(path.with_extension("go"), b"crash now").unwrap();
        }
        let status = tokio::time::timeout(Duration::from_secs(5), process.child.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.code(), Some(if mode == "crash" { 7 } else { 0 }));
        process.reclaim().await.unwrap();
        assert!(!process_alive(child["pid"].as_u64().unwrap() as u32));
    }
}

#[tokio::test]
async fn native_immediate_cancel_and_deadline_drop_keep_original_ownership() {
    let directory = scratch();
    let mut immediate = spawn_native(&config(
        directory.path(),
        "idle",
        &directory.path().join("immediate.json"),
    ))
    .unwrap();
    immediate
        .reclaim()
        .await
        .expect("cancel immediately after containment without a heartbeat wait");
    let path = directory.path().join("deadline.json");
    let process = spawn_native(&config(directory.path(), "tree", &path)).unwrap();
    let child = descendant(&path);
    assert!(usable(&child));
    let retained = process.reclaim_lease().unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(50), async move {
        let _owned = process;
        std::future::pending::<()>().await;
    })
    .await
    .is_err());
    tokio::task::spawn_blocking(move || retained.reclaim())
        .await
        .unwrap()
        .unwrap();
    assert!(!process_alive(child["pid"].as_u64().unwrap() as u32));
}
