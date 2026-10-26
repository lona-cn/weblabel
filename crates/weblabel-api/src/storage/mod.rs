mod db;
mod objects;
pub(crate) mod transactions;

pub use db::Repository;
pub use objects::{ObjectStore, StagedObject, StoredObject};
pub use transactions::{ObjectWriteError, WriteTransaction};

#[cfg(test)]
/// Protect read-then-write metadata transactions through custom BEGIN construction.
pub(crate) async fn acquire_metadata_write_connection(
    pool: &sqlx::SqlitePool,
) -> Result<sqlx::pool::PoolConnection<sqlx::Sqlite>, sqlx::Error> {
    let mut connection = pool.acquire().await?;
    // SQLx awaits again after SQLite confirms a custom BEGIN. Before a
    // Transaction exists, cancellation must close this writer rather than pool it.
    connection.close_on_drop();
    Ok(connection)
}
