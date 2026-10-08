use std::time::Duration;

use sqlx::{pool::PoolConnection, Sqlite, SqliteConnection, SqlitePool};

#[derive(Debug, thiserror::Error)]
pub enum ObjectWriteError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

pub struct WriteTransaction {
    connection: Option<PoolConnection<Sqlite>>,
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
            // An abandoned or cancelled SQL operation may still be running on
            // SQLite's worker. Never return that connection to another writer.
            drop(connection.detach());
        }
    }
}

pub(crate) async fn begin_immediate(
    pool: &SqlitePool,
    timeout: Duration,
) -> Result<WriteTransaction, sqlx::Error> {
    tokio::time::timeout(timeout, async {
        let mut transaction = WriteTransaction {
            connection: Some(pool.acquire().await?),
        };
        sqlx::query("BEGIN IMMEDIATE")
            .execute(transaction.connection())
            .await?;
        Ok(transaction)
    })
    .await
    .map_err(|_| sqlx::Error::PoolTimedOut)?
}
