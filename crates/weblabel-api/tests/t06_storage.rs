use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tempfile::tempdir;
use weblabel_api::{config::ServerConfig, storage::ObjectStore, AppState};

fn test_config(root: &std::path::Path, timeout: Duration) -> ServerConfig {
    ServerConfig {
        bind: "127.0.0.1:0".parse().unwrap(),
        database_url: format!("sqlite:{}", root.join("weblabel.sqlite").display()),
        object_root: root.join("objects"),
        write_timeout: timeout,
        production: true,
    }
}

fn count_files(root: &std::path::Path) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| {
            if entry.path().is_dir() {
                count_files(&entry.path())
            } else {
                1
            }
        })
        .sum()
}

#[tokio::test]
async fn repository_migrates_on_first_open_and_is_idempotent_on_restart() {
    let temp = tempdir().unwrap();
    let config = test_config(temp.path(), Duration::from_millis(500));

    let first = AppState::open(&config).await.unwrap();
    let table_count = first.repository.schema_table_count().await.unwrap();
    assert!(table_count >= 12);
    assert_eq!(
        first.repository.connection_pragmas().await.unwrap(),
        vec![(1, "wal".to_owned()); 5],
    );
    drop(first);

    let restarted = AppState::open(&config).await.unwrap();
    assert_eq!(
        restarted.repository.schema_table_count().await.unwrap(),
        table_count
    );
    assert_eq!(
        restarted.repository.connection_pragmas().await.unwrap(),
        vec![(1, "wal".to_owned()); 5],
    );
}

#[tokio::test]
async fn repository_rejects_object_reference_with_missing_media_revision() {
    let temp = tempdir().unwrap();
    let config = test_config(temp.path(), Duration::from_millis(500));
    let state = AppState::open(&config).await.unwrap();
    let mut transaction = state.repository.begin_write().await.unwrap();
    let error =
        sqlx::query("INSERT INTO media_object_refs(asset_revision_id, sha256) VALUES (?, ?)")
            .bind("missing-media-revision")
            .bind("a".repeat(64))
            .execute(transaction.connection())
            .await
            .unwrap_err();
    assert!(error.to_string().contains("FOREIGN KEY constraint failed"));
    transaction.rollback().await.unwrap();
}

#[test]
fn object_content_deduplicates_and_filename_never_becomes_a_path() {
    let temp = tempdir().unwrap();
    let object_root = temp.path().join("nested").join("objects");
    let store = ObjectStore::new(object_root.clone()).unwrap();
    let bytes = b"same immutable bytes";
    let first = store.put_bytes("first.png", bytes).unwrap();
    let second = store.put_bytes("../../outside/evil.png", bytes).unwrap();

    assert_eq!(first.sha256, second.sha256);
    assert_eq!(first.path, second.path);
    assert!(first.path.starts_with(&object_root));
    assert!(!first.path.to_string_lossy().contains("evil.png"));
}

#[test]
fn more_than_sixteen_identical_objects_can_be_staged_at_once() {
    let temp = tempdir().unwrap();
    let store = ObjectStore::new(temp.path().join("objects")).unwrap();
    let staged = (0..32)
        .map(|_| store.stage_bytes("same.png", b"same bytes"))
        .collect::<std::io::Result<Vec<_>>>()
        .unwrap();

    assert_eq!(staged.len(), 32);
    drop(staged);
    assert_eq!(count_files(store.root()), 0);
}

#[test]
fn concurrent_initialization_durably_creates_nested_object_root() {
    let temp = tempdir().unwrap();
    let object_root = temp
        .path()
        .join("new-parent")
        .join("nested")
        .join("objects");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let threads = (0..8)
        .map(|_| {
            let root = object_root.clone();
            let barrier = std::sync::Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                ObjectStore::new(root).unwrap()
            })
        })
        .collect::<Vec<_>>();
    let stores = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();

    let stored = stores[0].put_bytes("image.png", b"durable object").unwrap();
    assert!(stored.path.starts_with(&object_root));
    assert_eq!(std::fs::read(&stored.path).unwrap(), b"durable object");
}

#[tokio::test]
async fn abandoning_staged_object_before_rename_leaves_no_db_reference_or_file() {
    let temp = tempdir().unwrap();
    let config = test_config(temp.path(), Duration::from_millis(500));
    let state = AppState::open(&config).await.unwrap();
    let bytes = b"not published";
    let hash = format!("{:x}", Sha256::digest(bytes));
    let staged = state
        .repository
        .object_store()
        .stage_bytes("ignored", bytes)
        .unwrap();
    assert_eq!(count_files(state.repository.object_store().root()), 1);
    drop(staged);

    assert!(!state
        .repository
        .object_reference_exists(&hash)
        .await
        .unwrap());
    assert_eq!(count_files(state.repository.object_store().root()), 0);
}

#[tokio::test]
async fn failed_metadata_write_after_rename_leaves_only_an_orphan_file() {
    let temp = tempdir().unwrap();
    let config = test_config(temp.path(), Duration::from_millis(500));
    let state = AppState::open(&config).await.unwrap();
    let bytes = b"renamed before database transaction";
    let hash = format!("{:x}", Sha256::digest(bytes));

    assert!(state
        .repository
        .store_media_object("missing-asset-revision", "../name.png", bytes)
        .await
        .is_err());
    assert!(!state
        .repository
        .object_reference_exists(&hash)
        .await
        .unwrap());
    let object_path = state
        .repository
        .object_store()
        .path_for_hash(&hash)
        .unwrap();
    assert_eq!(count_files(state.repository.object_store().root()), 1);
    assert_eq!(std::fs::read(object_path).unwrap(), bytes);
}

#[tokio::test]
async fn write_lock_conflict_is_bounded_and_work_happens_outside_the_lock() {
    let temp = tempdir().unwrap();
    let timeout = Duration::from_millis(120);
    let config = test_config(temp.path(), timeout);
    let first = AppState::open(&config).await.unwrap();
    let second = AppState::open(&config).await.unwrap();
    let held = first.repository.begin_write().await.unwrap();
    let started = Instant::now();
    let conflict = second.repository.begin_write().await;
    let elapsed = started.elapsed();
    assert!(
        conflict.is_err(),
        "a competing immediate transaction must time out"
    );
    assert!(
        elapsed >= timeout / 2 && elapsed < Duration::from_secs(2),
        "unexpected bounded wait: {elapsed:?}"
    );
    held.rollback().await.unwrap();

    tokio::time::sleep(Duration::from_millis(80)).await;
    let transaction = first.repository.begin_write().await.unwrap();
    transaction.rollback().await.unwrap();
}

#[tokio::test]
async fn abandoned_and_cancelled_writes_roll_back_before_the_next_writer_commits() {
    let temp = tempdir().unwrap();
    let config = test_config(temp.path(), Duration::from_millis(500));
    let state = AppState::open(&config).await.unwrap();
    let observer = AppState::open(&config).await.unwrap();
    let insert = "INSERT INTO projects(project_id, name, description, created_at) \
                  VALUES (?, 'rollback test', '', '2026-10-08T00:00:00Z')";

    let mut abandoned = state.repository.begin_write().await.unwrap();
    sqlx::query(insert)
        .bind("abandoned")
        .execute(abandoned.connection())
        .await
        .unwrap();
    drop(abandoned);

    let repository = state.repository.clone();
    let (written_tx, written_rx) = tokio::sync::oneshot::channel();
    let cancelled = tokio::spawn(async move {
        let mut transaction = repository.begin_write().await.unwrap();
        sqlx::query(insert)
            .bind("cancelled")
            .execute(transaction.connection())
            .await
            .unwrap();
        written_tx.send(()).unwrap();
        std::future::pending::<()>().await;
        transaction.commit().await.unwrap();
    });
    written_rx.await.unwrap();
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());

    let mut recovered = observer.repository.begin_write().await.unwrap();
    let abandoned_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projects WHERE project_id IN ('abandoned', 'cancelled')",
    )
    .fetch_one(recovered.connection())
    .await
    .unwrap();
    assert_eq!(abandoned_count, 0);
    sqlx::query(insert)
        .bind("committed")
        .execute(recovered.connection())
        .await
        .unwrap();
    recovered.commit().await.unwrap();

    let mut next = state.repository.begin_write().await.unwrap();
    let ids: Vec<String> = sqlx::query_scalar("SELECT project_id FROM projects ORDER BY project_id")
        .fetch_all(next.connection())
        .await
        .unwrap();
    assert_eq!(ids, vec!["committed"]);
    next.rollback().await.unwrap();
}

#[tokio::test]
async fn finite_writer_producer_cannot_starve_a_waiting_heartbeat() {
    let temp = tempdir().unwrap();
    let config = test_config(temp.path(), Duration::from_secs(2));
    let state = AppState::open(&config).await.unwrap();
    let queue = weblabel_api::jobs::queue::JobQueue::new(state.repository.clone());
    queue
        .enqueue(None, "probe", "fair-heartbeat", &serde_json::json!({}))
        .await
        .unwrap();
    let lease = queue
        .lease_next("worker", Duration::from_secs(30))
        .await
        .unwrap()
        .unwrap();
    let mut initial = state.repository.begin_write().await.unwrap();
    let initial_total: i64 = sqlx::query_scalar("SELECT progress_total FROM jobs WHERE job_id=?")
        .bind(&lease.job_id)
        .fetch_one(initial.connection())
        .await
        .unwrap();
    assert_eq!(initial_total, 0);
    initial.rollback().await.unwrap();
    let producer = async {
        for _ in 0..70 {
            let mut tx = state.repository.begin_write().await.unwrap();
            sqlx::query("UPDATE jobs SET updated_at=updated_at WHERE job_id=?")
                .bind(&lease.job_id)
                .execute(tx.connection())
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
            tx.commit().await.unwrap();
        }
    };
    let heartbeat = async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        queue
            .report_progress(&lease, 0, 1, &serde_json::json!({"items":[]}))
            .await
    };
    let (_, result) = tokio::join!(producer, heartbeat);
    assert!(
        result.is_ok(),
        "finite internal producer starved heartbeat: {result:?}"
    );
    let mut tx = state.repository.begin_write().await.unwrap();
    let (status, completed, total, worker, fence, attempt, progress): (String, i64, i64, String, i64, i64, String) =
        sqlx::query_as("SELECT state,progress_completed,progress_total,worker_id,fencing_token,attempt,progress_json FROM jobs WHERE job_id=?")
            .bind(&lease.job_id).fetch_one(tx.connection()).await.unwrap();
    assert_eq!(status, "running");
    assert_eq!(
        (completed, total),
        (0, 1),
        "heartbeat progress must be durable"
    );
    assert_eq!(worker, lease.worker_id);
    assert_eq!(fence as u64, lease.fencing_token);
    assert_eq!(attempt as u64, lease.attempt);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&progress).unwrap(),
        serde_json::json!({"items":[]})
    );
    tx.rollback().await.unwrap();
}

// Poll each waiter once while the writer is held: registration order, not sleep
// timing, determines the next turn. Public transactions then prove durable order.
async fn poll_pending<F: std::future::Future>(future: std::pin::Pin<&mut F>) {
    let mut future = future;
    std::future::poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
}

#[tokio::test]
async fn waiting_writers_are_fifo_and_cancellation_does_not_lose_a_turn() {
    let temp = tempdir().unwrap();
    let config = test_config(temp.path(), Duration::from_millis(120));
    let state = AppState::open(&config).await.unwrap();
    let held = state.repository.begin_write().await.unwrap();
    let cancelled_repo = state.repository.clone();
    let mut cancelled = Box::pin(cancelled_repo.begin_write());
    poll_pending(cancelled.as_mut()).await;
    drop(cancelled);
    // Admission is part of the existing overall budget, not an unbounded wait.
    let started = Instant::now();
    assert!(matches!(
        state.repository.begin_write().await,
        Err(sqlx::Error::PoolTimedOut)
    ));
    assert!(started.elapsed() < Duration::from_secs(2));
    let first_repo = state.repository.clone();
    let second_repo = state.repository.clone();
    let mut first = Box::pin(first_repo.begin_write());
    let mut second = Box::pin(second_repo.begin_write());
    poll_pending(first.as_mut()).await;
    poll_pending(second.as_mut()).await;
    held.rollback().await.unwrap();
    let insert = "INSERT INTO projects(project_id,name,description,created_at) VALUES (?, 'fifo', '', 'now')";
    let first_writer = async {
        let mut tx = first.await.unwrap();
        sqlx::query(insert)
            .bind("first")
            .execute(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
    };
    let second_writer = async {
        let mut tx = second.await.unwrap();
        let predecessor: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM projects WHERE project_id='first'")
                .fetch_one(tx.connection())
                .await
                .unwrap();
        assert_eq!(predecessor, 1, "later writer overtook registered writer");
        sqlx::query(insert)
            .bind("second")
            .execute(tx.connection())
            .await
            .unwrap();
        tx.commit().await.unwrap();
    };
    tokio::join!(second_writer, first_writer);
    let mut tx = state.repository.begin_write().await.unwrap();
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT project_id FROM projects ORDER BY project_id")
            .fetch_all(tx.connection())
            .await
            .unwrap();
    assert_eq!(ids, ["first", "second"]);
    tx.rollback().await.unwrap();
}

async fn prove_recovered_writer(
    mut tx: weblabel_api::storage::WriteTransaction,
    repository: &weblabel_api::storage::Repository,
    project_id: &str,
) {
    sqlx::query("INSERT INTO projects(project_id,name,description,created_at) VALUES (?, 'recovered', '', 'now')")
        .bind(project_id).execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    let mut readback = repository.begin_write().await.unwrap();
    let name: String = sqlx::query_scalar("SELECT name FROM projects WHERE project_id=?")
        .bind(project_id)
        .fetch_one(readback.connection())
        .await
        .unwrap();
    assert_eq!(name, "recovered");
    readback.rollback().await.unwrap();
}

#[tokio::test]
async fn cancelled_pending_begin_and_failed_finalization_leave_a_fresh_writer_usable() {
    let temp = tempdir().unwrap();
    let config = test_config(temp.path(), Duration::from_secs(2));
    let state = AppState::open(&config).await.unwrap();
    let external = AppState::open(&config).await.unwrap();
    let held = external.repository.begin_write().await.unwrap();
    let repo = state.repository.clone();
    let pending = tokio::spawn(async move { repo.begin_write().await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    pending.abort();
    assert!(matches!(pending.await, Err(error) if error.is_cancelled()));
    held.rollback().await.unwrap();
    let mut tx = state.repository.begin_write().await.unwrap();
    sqlx::query("PRAGMA defer_foreign_keys=ON")
        .execute(tx.connection())
        .await
        .unwrap();
    sqlx::query("INSERT INTO media_object_refs(asset_revision_id,sha256) VALUES ('missing',?)")
        .bind("a".repeat(64))
        .execute(tx.connection())
        .await
        .unwrap();
    assert!(tx.commit().await.is_err());
    let mut next = state.repository.begin_write().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_object_refs")
        .fetch_one(next.connection())
        .await
        .unwrap();
    assert_eq!(count, 0, "failed COMMIT leaked uncommitted writes");
    sqlx::query("ROLLBACK")
        .execute(next.connection())
        .await
        .unwrap();
    assert!(next.rollback().await.is_err());
    let fresh = state.repository.begin_write().await.unwrap();
    prove_recovered_writer(fresh, &state.repository, "after-failed-finalization").await;
}

#[tokio::test]
async fn cancelled_finalization_discards_failed_commit_and_pending_rollback_connections() {
    let temp = tempdir().unwrap();
    let config = test_config(temp.path(), Duration::from_secs(2));
    let state = AppState::open(&config).await.unwrap();
    for commit in [true, false] {
        let mut tx = state.repository.begin_write().await.unwrap();
        sqlx::query("PRAGMA defer_foreign_keys=ON")
            .execute(tx.connection())
            .await
            .unwrap();
        sqlx::query("INSERT INTO media_object_refs(asset_revision_id,sha256) VALUES ('missing',?)")
            .bind("b".repeat(64))
            .execute(tx.connection())
            .await
            .unwrap();
        // Queue real SQLite work before finalization so cancellation can leave
        // commands in flight, rather than merely dropping an unpolled future.
        let mut work = Box::pin(sqlx::query("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<500000) SELECT sum(x) FROM n")
            .execute(tx.connection()));
        poll_pending(work.as_mut()).await;
        drop(work);
        if commit {
            // This COMMIT cannot succeed: deferred FK validation must fail.
            // A cancelled successful COMMIT may already be durable; cancellation
            // cannot promise to undo an acknowledged database commit.
            let mut finish = Box::pin(tx.commit());
            poll_pending(finish.as_mut()).await;
            drop(finish);
        } else {
            let mut finish = Box::pin(tx.rollback());
            poll_pending(finish.as_mut()).await;
            drop(finish);
        }
        let mut fresh = state.repository.begin_write().await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_object_refs")
            .fetch_one(fresh.connection())
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "cancelled finalization left writes or an uncertain pooled connection"
        );
        let project_id = if commit {
            "after-cancelled-commit"
        } else {
            "after-cancelled-rollback"
        };
        prove_recovered_writer(fresh, &state.repository, project_id).await;
    }
}

#[test]
fn abandoned_writer_closes_without_a_tokio_runtime() {
    let temp = tempdir().unwrap();
    let config = test_config(temp.path(), Duration::from_secs(2));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let state = runtime.block_on(AppState::open(&config)).unwrap();
    let mut tx = runtime.block_on(state.repository.begin_write()).unwrap();
    runtime.block_on(sqlx::query("INSERT INTO projects(project_id,name,description,created_at) VALUES ('abandoned', 'no runtime', '', 'now')")
        .execute(tx.connection())).unwrap();
    drop(runtime);
    drop(tx);
    let replacement = tokio::runtime::Runtime::new().unwrap();
    replacement.block_on(async {
        let mut fresh = state.repository.begin_write().await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects")
            .fetch_one(fresh.connection())
            .await
            .unwrap();
        assert_eq!(count, 0);
        prove_recovered_writer(fresh, &state.repository, "after-runtime-shutdown").await;
    });
}
#[cfg(windows)]
#[test]
fn open_staging_handle_blocks_atomic_publish_without_creating_a_reference_target() {
    use std::os::windows::fs::OpenOptionsExt;

    let temp = tempdir().unwrap();
    let store = ObjectStore::new(temp.path()).unwrap();
    let bytes = b"rename must fail while a handle denies delete sharing";
    let hash = format!("{:x}", Sha256::digest(bytes));
    let destination = store.path_for_hash(&hash).unwrap();
    let staging_directory = destination.parent().unwrap();
    let staged = store.stage_bytes("ignored", bytes).unwrap();
    let temporary_path = std::fs::read_dir(staging_directory)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(".tmp-"))
        })
        .unwrap();
    assert_eq!(temporary_path.parent(), Some(staging_directory));

    let held_open = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0x0000_0001)
        .open(&temporary_path)
        .unwrap();
    let error = staged.publish().unwrap_err();
    assert_eq!(
        error.raw_os_error(),
        Some(32),
        "expected Windows ERROR_SHARING_VIOLATION"
    );
    assert!(!destination.exists());
    drop(held_open);
    std::fs::remove_file(temporary_path).unwrap();
}

#[test]
fn production_configuration_rejects_non_loopback_bind() {
    let temp = tempdir().unwrap();
    let mut config = test_config(temp.path(), Duration::from_millis(100));
    config.bind = "0.0.0.0:48100".parse().unwrap();
    let error = config.validate().unwrap_err();
    assert_eq!(error.code, "NON_LOOPBACK_BIND");
    config.production = false;
    assert!(config.validate().is_ok());
}
