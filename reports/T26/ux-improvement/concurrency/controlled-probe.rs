use std::time::{Duration, Instant};
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn controlled_continuous_write_deadline_probe() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/concurrency-fixtures");
    std::fs::create_dir_all(&root).unwrap();
    let directory = tempfile::tempdir_in(root).unwrap();
    let state = AppState::open(&test_config(directory.path(), Duration::from_secs(2))).await.unwrap();
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(4));
    let counts = std::sync::Arc::new(std::sync::Mutex::new([0usize; 4]));
    let mut writers = Vec::new();
    for writer in 0..4 {
        let repository = state.repository.clone();
        let barrier = barrier.clone();
        let counts = counts.clone();
        writers.push(tokio::spawn(async move {
            barrier.wait().await;
            let mut max_hold = Duration::ZERO;
            let mut failure = None;
            for wave in 0..500 {
                let start = Instant::now();
                match repository.begin_write().await {
                    Ok(tx) => {
                        let hold = Instant::now();
                        tokio::time::sleep(Duration::from_millis(5)).await;
                        tx.commit().await.unwrap();
                        max_hold = max_hold.max(hold.elapsed());
                        counts.lock().unwrap()[writer] += 1;
                    }
                    Err(error) => {
                        failure = Some(format!("wave={wave} elapsed={:?} error={error:?} completed_at_failure={:?}", start.elapsed(), *counts.lock().unwrap()));
                        break;
                    }
                }
            }
            (writer, max_hold, failure)
        }));
    }
    for writer in writers { println!("{:?}", writer.await.unwrap()); }
    println!("completed={:?}", *counts.lock().unwrap());
}

use sha2::{Digest, Sha256};
use tempfile::tempdir;