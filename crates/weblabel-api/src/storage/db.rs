use std::{path::Path, time::Duration};

use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

use super::{transactions::begin_immediate, ObjectStore, ObjectWriteError, WriteTransaction};

#[derive(Clone)]
pub struct Repository {
    pool: SqlitePool,
    objects: ObjectStore,
    write_timeout: Duration,
}

impl Repository {
    pub async fn open(
        database_url: &str,
        object_root: impl AsRef<Path>,
        write_timeout: Duration,
    ) -> Result<Self, sqlx::Error> {
        let filename = database_url.strip_prefix("sqlite:").unwrap_or(database_url);
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(filename)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .busy_timeout(write_timeout);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;
        sqlx::raw_sql(include_str!("../../migrations/0001_core.sql"))
            .execute(&pool)
            .await?;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS schema_migrations (\
             version TEXT PRIMARY KEY NOT NULL,\
             applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
        )
        .execute(&pool)
        .await?;
        for (version, migration) in [(
            "0005_media",
            include_str!("../../migrations/0005_media.sql"),
        )] {
            let mut tx = begin_immediate(&pool, write_timeout).await?;
            let applied: i64 = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?)",
            )
            .bind(version)
            .fetch_one(tx.connection())
            .await?;
            if applied == 0 {
                sqlx::raw_sql(migration).execute(tx.connection()).await?;
                sqlx::query("INSERT INTO schema_migrations(version) VALUES (?)")
                    .bind(version)
                    .execute(tx.connection())
                    .await?;
            }
            tx.commit().await?;
        }
        let objects =
            ObjectStore::new(object_root.as_ref().to_path_buf()).map_err(sqlx::Error::Io)?;
        Ok(Self {
            pool,
            objects,
            write_timeout,
        })
    }

    pub fn object_store(&self) -> &ObjectStore {
        &self.objects
    }

    pub async fn begin_write(&self) -> Result<WriteTransaction, sqlx::Error> {
        begin_immediate(&self.pool, self.write_timeout).await
    }

    pub async fn connection_pragmas(&self) -> Result<Vec<(i64, String)>, sqlx::Error> {
        let mut connections = Vec::with_capacity(5);
        for _ in 0..5 {
            connections.push(self.pool.acquire().await?);
        }
        let mut pragmas = Vec::with_capacity(connections.len());
        for connection in &mut connections {
            let (foreign_keys,) = sqlx::query_as::<_, (i64,)>("PRAGMA foreign_keys")
                .fetch_one(&mut **connection)
                .await?;
            let (journal_mode,) = sqlx::query_as::<_, (String,)>("PRAGMA journal_mode")
                .fetch_one(&mut **connection)
                .await?;
            pragmas.push((foreign_keys, journal_mode));
        }
        Ok(pragmas)
    }

    pub async fn schema_table_count(&self) -> Result<i64, sqlx::Error> {
        let (count,) = sqlx::query_as::<_, (i64,)>(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(count)
    }

    pub async fn object_reference_exists(&self, sha256: &str) -> Result<bool, sqlx::Error> {
        let (exists,) = sqlx::query_as::<_, (i64,)>(
            "SELECT EXISTS(SELECT 1 FROM media_object_refs WHERE sha256 = ?)",
        )
        .bind(sha256)
        .fetch_one(&self.pool)
        .await?;
        Ok(exists != 0)
    }

    pub async fn store_media_object(
        &self,
        asset_revision_id: &str,
        filename: &str,
        bytes: &[u8],
    ) -> Result<String, ObjectWriteError> {
        let object = self.objects.put_bytes(filename, bytes)?;
        sqlx::query(
            "INSERT INTO media_object_refs(asset_revision_id, sha256) VALUES (?, ?) \
             ON CONFLICT(asset_revision_id, sha256) DO NOTHING",
        )
        .bind(asset_revision_id)
        .bind(&object.sha256)
        .execute(&self.pool)
        .await?;
        Ok(object.sha256)
    }
}
