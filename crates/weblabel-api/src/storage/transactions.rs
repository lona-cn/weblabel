use std::{
    sync::Arc,
    task::{Context, Poll, Wake, Waker},
    time::Duration,
};

use sqlx::{Connection, SqliteConnection, SqlitePool};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Debug, thiserror::Error)]
pub enum ObjectWriteError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// Retains FIFO writer admission until SQLite finalization or worker shutdown.
pub struct WriteTransaction {
    connection: Option<SqliteConnection>,
    permit: Option<OwnedSemaphorePermit>,
}

impl WriteTransaction {
    pub fn connection(&mut self) -> &mut SqliteConnection {
        self.connection
            .as_mut()
            .expect("transaction already finalized")
    }

    pub async fn commit(mut self) -> Result<(), sqlx::Error> {
        sqlx::query("COMMIT").execute(self.connection()).await?;
        // COMMIT is durable; cleanup must not turn success into a retry.
        self.close().await;
        Ok(())
    }

    pub async fn rollback(mut self) -> Result<(), sqlx::Error> {
        sqlx::query("ROLLBACK").execute(self.connection()).await?;
        self.close().await;
        Ok(())
    }

    async fn close(&mut self) {
        if let Some(connection) = self.connection.take() {
            // The owned close thread retains admission even if this waiter is
            // cancelled or the Tokio runtime shuts down.
            let _ = close_worker(self.permit.take(), connection.close()).await;
        }
    }
}

impl Drop for WriteTransaction {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.take() {
            // Commands already sent to SQLite may outlive cancellation. Never
            // return that connection to the pool or release admission early.
            let Some(permit) = self.permit.take() else {
                // Authentication has a separate ungated pool; detached-drop
                // cleanup does not need a gate-retention thread.
                drop(connection);
                return;
            };
            drop(close_worker(Some(permit), connection.close()));
        }
    }
}

fn close_worker(
    permit: Option<OwnedSemaphorePermit>,
    close: impl std::future::Future<Output = Result<(), sqlx::Error>> + Send + 'static,
) -> tokio::sync::oneshot::Receiver<()> {
    let (finished, waiter) = tokio::sync::oneshot::channel();
    // Runtime shutdown must not cancel cleanup and release a live writer's
    // permit. This owned thread also supports Drop without Tokio.
    std::thread::spawn(move || {
        let waker = Waker::from(Arc::new(CloseWake(std::thread::current())));
        let mut context = Context::from_waker(&waker);
        let mut close = std::pin::pin!(close);
        loop {
            match close.as_mut().poll(&mut context) {
                Poll::Pending => std::thread::park(),
                Poll::Ready(result) => {
                    if let Err(error) = result {
                        tracing::error!(%error, "could not close write connection");
                    }
                    break;
                }
            }
        }
        drop(permit);
        let _ = finished.send(());
    });
    waiter
}

struct CloseWake(std::thread::Thread);
impl Wake for CloseWake {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}

pub(crate) async fn begin_immediate(
    pool: &SqlitePool,
    timeout: Duration,
    admission: Option<&Arc<Semaphore>>,
) -> Result<WriteTransaction, sqlx::Error> {
    tokio::time::timeout(timeout, async {
        // One deadline covers FIFO admission, pool acquisition and SQLite.
        let permit = match admission {
            Some(gate) => Some(
                Arc::clone(gate)
                    .acquire_owned()
                    .await
                    .map_err(|_| sqlx::Error::PoolClosed)?,
            ),
            None => None,
        };
        let mut transaction = WriteTransaction {
            connection: Some(pool.acquire().await?.detach()),
            permit,
        };
        sqlx::query("BEGIN IMMEDIATE")
            .execute(transaction.connection())
            .await?;
        Ok(transaction)
    })
    .await
    .map_err(|_| sqlx::Error::PoolTimedOut)?
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    use std::{
        future::Future,
        pin::Pin,
        task::{Context, Poll, Wake, Waker},
        time::Instant,
    };

    struct Noop;
    impl Wake for Noop {
        fn wake(self: Arc<Self>) {}
    }
    fn queue(future: Pin<&mut impl Future>) {
        let waker = Waker::from(Arc::new(Noop));
        assert!(matches!(
            future.poll(&mut Context::from_waker(&waker)),
            Poll::Pending
        ));
    }
    async fn fixture() -> (tempfile::TempDir, SqlitePool, Arc<Semaphore>) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/admission-fixtures");
        std::fs::create_dir_all(&root).unwrap();
        let dir = tempfile::tempdir_in(root).unwrap();
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(dir.path().join("api.sqlite"))
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(2));
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE probe(value INTEGER)")
            .execute(&pool)
            .await
            .unwrap();
        (dir, pool, Arc::new(Semaphore::new(1)))
    }

    #[tokio::test]
    async fn admission_fifo_cancel_and_read_bypass() {
        let (_dir, pool, gate) = fixture().await;
        let held = begin_immediate(&pool, Duration::from_secs(2), Some(&gate))
            .await
            .unwrap();
        let mut first = Box::pin(begin_immediate(&pool, Duration::from_secs(2), Some(&gate)));
        let mut cancelled = Box::pin(begin_immediate(&pool, Duration::from_secs(2), Some(&gate)));
        let mut last = Box::pin(begin_immediate(&pool, Duration::from_secs(2), Some(&gate)));
        queue(first.as_mut());
        queue(cancelled.as_mut());
        queue(last.as_mut());
        drop(cancelled);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM probe")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        held.commit().await.unwrap();
        let first = first.await.unwrap();
        queue(last.as_mut());
        assert_eq!(gate.available_permits(), 0);
        first.rollback().await.unwrap();
        last.await.unwrap().rollback().await.unwrap();
        assert_eq!(gate.available_permits(), 1);
    }

    #[tokio::test]
    async fn admission_deadline_covers_queue_and_sqlite_wait() {
        let (_dir, pool, gate) = fixture().await;
        let mut external = pool.acquire().await.unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *external)
            .await
            .unwrap();
        let held = gate.clone().acquire_owned().await.unwrap();
        let started = Instant::now();
        let mut pending = Box::pin(begin_immediate(
            &pool,
            Duration::from_millis(120),
            Some(&gate),
        ));
        queue(pending.as_mut());
        tokio::time::sleep(Duration::from_millis(60)).await;
        drop(held);
        assert!(matches!(pending.await, Err(sqlx::Error::PoolTimedOut)));
        assert!(started.elapsed() >= Duration::from_millis(110));
        assert!(
            started.elapsed() < Duration::from_millis(175),
            "deadline restarted after admission: {:?}",
            started.elapsed()
        );
        // Cancelled raw BEGIN remains on the SQLx worker until SQLite unlocks.
        assert_eq!(gate.available_permits(), 0);
        sqlx::query("ROLLBACK")
            .execute(&mut *external)
            .await
            .unwrap();
        begin_immediate(&pool, Duration::from_secs(2), Some(&gate))
            .await
            .unwrap()
            .rollback()
            .await
            .unwrap();
        assert_eq!(gate.available_permits(), 1);
    }

    #[tokio::test]
    async fn admission_abandon_rolls_back_before_next_writer() {
        let (_dir, pool, gate) = fixture().await;
        let mut tx = begin_immediate(&pool, Duration::from_secs(2), Some(&gate))
            .await
            .unwrap();
        sqlx::query("INSERT INTO probe VALUES(1)")
            .execute(tx.connection())
            .await
            .unwrap();
        let mut next = Box::pin(begin_immediate(&pool, Duration::from_secs(2), Some(&gate)));
        queue(next.as_mut());
        drop(tx);
        // Drop transfers the permit to the close thread, not to the next writer.
        assert_eq!(gate.available_permits(), 0);
        let mut next = next.await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM probe")
                .fetch_one(next.connection())
                .await
                .unwrap(),
            0
        );
        next.commit().await.unwrap();
        assert_eq!(gate.available_permits(), 1);
    }

    #[tokio::test]
    async fn admission_failed_commit_closes_before_releasing() {
        let (_dir, pool, gate) = fixture().await;
        let tx = begin_immediate(&pool, Duration::from_secs(2), Some(&gate))
            .await
            .unwrap();
        // Ending the SQLite transaction externally makes COMMIT fail; guard
        // still owns admission until its asynchronous close completes.
        let mut tx = tx;
        sqlx::query("ROLLBACK")
            .execute(tx.connection())
            .await
            .unwrap();
        assert!(tx.commit().await.is_err());
        assert_eq!(gate.available_permits(), 0);
        begin_immediate(&pool, Duration::from_secs(2), Some(&gate))
            .await
            .unwrap()
            .rollback()
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn admission_cancelled_commit_keeps_permit_through_close() {
        let (_dir, pool, gate) = fixture().await;
        let mut tx = begin_immediate(&pool, Duration::from_secs(2), Some(&gate))
            .await
            .unwrap();
        sqlx::query("INSERT INTO probe VALUES(1)")
            .execute(tx.connection())
            .await
            .unwrap();
        let mut commit = Box::pin(tx.commit());
        queue(commit.as_mut());
        drop(commit);
        assert_eq!(gate.available_permits(), 0);
        let mut next = begin_immediate(&pool, Duration::from_secs(2), Some(&gate))
            .await
            .unwrap();
        // Cancellation may race a completed COMMIT; either whole transaction
        // committed or whole transaction rolled back, never an open transaction.
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM probe")
            .fetch_one(next.connection())
            .await
            .unwrap();
        assert!(count == 0 || count == 1);
        next.rollback().await.unwrap();
        assert_eq!(gate.available_permits(), 1);
    }

    #[tokio::test]
    async fn admission_queue_timeout_and_acquire_failure_do_not_leak() {
        let (_dir, pool, gate) = fixture().await;
        let held = gate.clone().acquire_owned().await.unwrap();
        assert!(matches!(
            begin_immediate(&pool, Duration::from_millis(30), Some(&gate)).await,
            Err(sqlx::Error::PoolTimedOut)
        ));
        drop(held);
        assert_eq!(gate.available_permits(), 1);
        pool.close().await;
        assert!(matches!(
            begin_immediate(&pool, Duration::from_secs(2), Some(&gate)).await,
            Err(sqlx::Error::PoolClosed)
        ));
        assert_eq!(gate.available_permits(), 1);
    }

    #[tokio::test]
    async fn admission_finalized_connections_release_files_and_preserve_commit_result() {
        for commit in [true, false] {
            let (dir, pool, gate) = fixture().await;
            let mut tx = begin_immediate(&pool, Duration::from_secs(2), Some(&gate))
                .await
                .unwrap();
            sqlx::query("INSERT INTO probe VALUES(7)")
                .execute(tx.connection())
                .await
                .unwrap();
            if commit {
                tx.commit().await.unwrap();
            } else {
                tx.rollback().await.unwrap();
            }
            assert_eq!(gate.available_permits(), 1);
            pool.close().await;
            let moved = dir.path().with_extension("closed");
            std::fs::rename(dir.path(), &moved).unwrap();
            let options = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(moved.join("api.sqlite"))
                .read_only(true);
            let mut reader = SqliteConnection::connect_with(&options).await.unwrap();
            let values: Vec<i64> = sqlx::query_scalar("SELECT value FROM probe")
                .fetch_all(&mut reader)
                .await
                .unwrap();
            assert_eq!(values, if commit { vec![7] } else { vec![] });
            reader.close().await.unwrap();
            std::fs::rename(moved, dir.path()).unwrap();
            dir.close().unwrap();
        }
    }

    #[tokio::test]
    async fn admission_cancelled_close_waiter_retains_owned_future_until_shutdown() {
        for commit in [true, false] {
            let (dir, pool, gate) = fixture().await;
            let mut tx = begin_immediate(&pool, Duration::from_secs(2), Some(&gate))
                .await
                .unwrap();
            sqlx::query("INSERT INTO probe VALUES(9)")
                .execute(tx.connection())
                .await
                .unwrap();
            sqlx::query(if commit { "COMMIT" } else { "ROLLBACK" })
                .execute(tx.connection())
                .await
                .unwrap();
            let connection = tx.connection.take().unwrap();
            let close = connection.close();
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
            // Control only shutdown readiness, using the same owned thread as
            // production. The real SQLx close future and connection stay owned.
            let task = close_worker(tx.permit.take(), async move {
                started_tx.send(()).unwrap();
                finish_rx.await.unwrap();
                close.await
            });
            drop(tx);
            started_rx.await.unwrap();
            let mut waiter = Box::pin(async move { task.await.unwrap() });
            queue(waiter.as_mut());
            drop(waiter);
            let mut next = Box::pin(begin_immediate(&pool, Duration::from_secs(2), Some(&gate)));
            queue(next.as_mut());
            assert_eq!(gate.available_permits(), 0);
            finish_tx.send(()).unwrap();
            let mut next = next.await.unwrap();
            let values: Vec<i64> = sqlx::query_scalar("SELECT value FROM probe")
                .fetch_all(next.connection())
                .await
                .unwrap();
            assert_eq!(values, if commit { vec![9] } else { vec![] });
            next.rollback().await.unwrap();
            assert_eq!(gate.available_permits(), 1);
            pool.close().await;
            dir.close().unwrap();
        }
    }
}
