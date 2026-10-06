use std::time::Duration;

use serde_json::json;
use tempfile::tempdir;
use weblabel_api::{jobs::queue::JobQueue, storage::Repository};

#[tokio::test]
async fn rejected_outer_operation_leaves_no_claimable_job_or_idempotency() {
    let directory = tempdir().unwrap();
    let repository = Repository::open(
        &format!("sqlite:{}", directory.path().join("queue.sqlite").display()),
        directory.path().join("objects"),
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    let queue = JobQueue::new(repository.clone());

    let mut tx = repository.begin_write().await.unwrap();
    let aborted = JobQueue::enqueue_on(
        tx.connection(),
        None,
        "model_run",
        "atomic-run-op",
        &json!({"input": "first"}),
    )
    .await
    .unwrap();
    tx.rollback().await.unwrap();
    assert!(
        queue
            .lease_next("worker", Duration::from_secs(30))
            .await
            .unwrap()
            .is_none(),
        "a rejected enclosing operation must not leave a runnable job: {}",
        aborted.job_id,
    );
    let mut tx = repository.begin_write().await.unwrap();
    let committed = JobQueue::enqueue_on(
        tx.connection(),
        None,
        "model_run",
        "atomic-run-op",
        &json!({"input": "different input after rollback"}),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let replay = queue
        .enqueue(
            None,
            "model_run",
            "atomic-run-op",
            &json!({"input": "different input after rollback"}),
        )
        .await
        .unwrap();
    assert_eq!(replay.job_id, committed.job_id);
    assert!(replay.duplicate);
    let claimed = queue
        .lease_next("worker", Duration::from_secs(30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.job_id, committed.job_id);
}
