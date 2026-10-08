use std::{
    sync::Arc,
    task::{Context, Poll, Wake, Waker},
    time::Duration,
};

use sqlx::{pool::PoolConnection, Connection, Sqlite, SqliteConnection, SqlitePool};
use tokio::sync::{Mutex, OwnedMutexGuard};

#[derive(Debug, thiserror::Error)]
pub enum ObjectWriteError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

pub struct WriteTransaction {
    connection: Option<PoolConnection<Sqlite>>,
    admission: Option<OwnedMutexGuard<()>>,
}

impl WriteTransaction {
    pub fn connection(&mut self) -> &mut SqliteConnection {
        self.connection
            .as_mut()
            .expect("transaction already finalized")
    }

    pub async fn commit(mut self) -> Result<(), sqlx::Error> {
        sqlx::query("COMMIT").execute(self.connection()).await?;
        self.connection.take();
        Ok(())
    }

    pub async fn rollback(mut self) -> Result<(), sqlx::Error> {
        sqlx::query("ROLLBACK").execute(self.connection()).await?;
        self.connection.take();
        Ok(())
    }
}

impl Drop for WriteTransaction {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.take() {
            // SQLite commands already sent to its worker may outlive cancellation.
            // Detach immediately, but retain admission until close() acknowledges
            // worker shutdown. A Tokio task could itself be cancelled at shutdown;
            // this exceptional-path thread also works when Drop has no runtime.
            let connection = connection.detach();
            let Some(admission) = self.admission.take() else {
                // Auth uses a separate ungated pool: preserve its detached-drop
                // cleanup without allocating a gate-retention thread or waker.
                drop(connection);
                return;
            };
            std::thread::spawn(move || {
                let waker = Waker::from(Arc::new(CloseWake(std::thread::current())));
                let mut context = Context::from_waker(&waker);
                let mut close = connection.close();
                while let Poll::Pending = close.as_mut().poll(&mut context) {
                    std::thread::park();
                }
                drop(admission);
            });
        }
    }
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
    admission: Option<&Arc<Mutex<()>>>,
) -> Result<WriteTransaction, sqlx::Error> {
    tokio::time::timeout(timeout, async {
        let admission = match admission {
            Some(admission) => Some(Arc::clone(admission).lock_owned().await),
            None => None,
        };
        let mut transaction = WriteTransaction {
            connection: Some(pool.acquire().await?),
            admission,
        };
        sqlx::query("BEGIN IMMEDIATE")
            .execute(transaction.connection())
            .await?;
        Ok(transaction)
    })
    .await
    .map_err(|_| sqlx::Error::PoolTimedOut)?
}
