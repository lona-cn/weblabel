use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tempfile::tempdir;
use weblabel_api::{config::ServerConfig, storage::ObjectStore, AppState};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn repository_clones_admit_four_sustained_writers_without_starvation() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/admission-fixtures");
    std::fs::create_dir_all(&root).unwrap();
    let directory = tempfile::tempdir_in(root).unwrap();
    let state = AppState::open(&test_config(directory.path(), Duration::from_secs(2)))
        .await
        .unwrap();
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(4));
    let mut writers = Vec::new();
    for writer in 0..4 {
        let repository = state.repository.clone();
        let barrier = barrier.clone();
        writers.push(tokio::spawn(async move {
            barrier.wait().await;
            let mut maximum = Duration::ZERO;
            for wave in 0..500 {
                let start = Instant::now();
                let tx = repository
                    .begin_write()
                    .await
                    .unwrap_or_else(|error| panic!("writer={writer} wave={wave} error={error:?}"));
                maximum = maximum.max(start.elapsed());
                tokio::time::sleep(Duration::from_millis(5)).await;
                tx.commit().await.unwrap();
            }
            (writer, maximum)
        }));
    }
    for writer in writers {
        println!(
            "sustained writer/max_begin_wait={:?}",
            writer.await.unwrap()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn repository_four_short_writers_complete_one_hundred_waves() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/admission-fixtures");
    std::fs::create_dir_all(&root).unwrap();
    let directory = tempfile::tempdir_in(root).unwrap();
    let state = AppState::open(&test_config(directory.path(), Duration::from_secs(2)))
        .await
        .unwrap();
    for _ in 0..100 {
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(4));
        let mut writers = Vec::new();
        for _ in 0..4 {
            let repository = state.repository.clone();
            let barrier = barrier.clone();
            writers.push(tokio::spawn(async move {
                barrier.wait().await;
                let tx = repository.begin_write().await.unwrap();
                tokio::time::sleep(Duration::from_millis(5)).await;
                tx.commit().await.unwrap();
            }));
        }
        for writer in writers {
            writer.await.unwrap();
        }
    }
}

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
    assert!(std::fs::canonicalize(&first.path)
        .unwrap()
        .starts_with(std::fs::canonicalize(&object_root).unwrap()));
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
    assert!(std::fs::canonicalize(&stored.path)
        .unwrap()
        .starts_with(std::fs::canonicalize(&object_root).unwrap()));
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

#[cfg(windows)]
#[test]
fn long_windows_object_paths_publish_atomically_deduplicate_and_survive_reopen() {
    use std::os::windows::ffi::OsStrExt;

    let temp = tempdir().unwrap();
    let base = temp.path().join("long-object-root");
    let padding = 191usize
        .saturating_sub(base.as_os_str().encode_wide().count() + 1)
        .max(1);
    let root = base.join("r".repeat(padding));
    let store = ObjectStore::new(&root).unwrap();
    let bytes = b"immutable media at the Windows native path boundary";
    let hash = format!("{:x}", Sha256::digest(bytes));
    let destination = root.join(&hash[..2]).join(&hash[2..4]).join(&hash);
    assert!(destination.as_os_str().encode_wide().count() >= 260);

    let unpublished = store.stage_bytes("original.jpg", bytes).unwrap();
    assert!(
        !destination.exists(),
        "unpublished bytes must not be a readable object"
    );
    drop(unpublished);
    assert_eq!(count_files(store.root()), 0);

    let first = store
        .stage_bytes("original.jpg", bytes)
        .unwrap()
        .publish()
        .unwrap();
    assert_eq!(first.sha256, hash);
    assert_eq!(first.size_bytes, bytes.len() as u64);
    assert_eq!(std::fs::read(&first.path).unwrap(), bytes);
    let second = store.put_bytes("another-name.jpg", bytes).unwrap();
    assert_eq!(second.sha256, hash);
    assert_eq!(std::fs::read(&second.path).unwrap(), bytes);
    assert_eq!(count_files(store.root()), 1);
    drop(store);

    let reopened = ObjectStore::new(&root).unwrap();
    assert_eq!(
        std::fs::read(reopened.path_for_hash(&hash).unwrap()).unwrap(),
        bytes
    );
    assert_eq!(count_files(reopened.root()), 1);
}
