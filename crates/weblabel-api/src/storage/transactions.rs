use std::time::Duration;

use sqlx::{SqliteConnection, SqlitePool};

#[derive(Debug, thiserror::Error)]
pub enum ObjectWriteError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

pub struct WriteTransaction {
    connection: Option<SqliteConnection>,
}

impl WriteTransaction {
    pub fn connection(&mut self) -> &mut SqliteConnection {
        self.connection
            .as_mut()
            .expect("transaction already finalized")
    }

    pub async fn commit(mut self) -> Result<(), sqlx::Error> {
        let mut connection = self
            .connection
            .take()
            .expect("transaction already finalized");
        sqlx::query("COMMIT").execute(&mut connection).await?;
        Ok(())
    }

    pub async fn rollback(mut self) -> Result<(), sqlx::Error> {
        let mut connection = self
            .connection
            .take()
            .expect("transaction already finalized");
        sqlx::query("ROLLBACK").execute(&mut connection).await?;
        Ok(())
    }
}

pub(crate) async fn begin_immediate(
    pool: &SqlitePool,
    timeout: Duration,
) -> Result<WriteTransaction, sqlx::Error> {
    tokio::time::timeout(timeout, async {
        let mut connection = pool.acquire().await?.detach();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut connection)
            .await?;
        Ok(WriteTransaction {
            connection: Some(connection),
        })
    })
    .await
    .map_err(|_| sqlx::Error::PoolTimedOut)?
}
