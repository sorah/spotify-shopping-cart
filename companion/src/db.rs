//! The companion's own SQLite cache. Per-file scan results and iTunes Lookup results only; the
//! matching index is rebuilt in memory from these.

const MIGRATION_SLICE: &[rusqlite_migration::M<'static>] = &[rusqlite_migration::M::up(
    r#"
CREATE TABLE mp4_scans (
    source_id TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ns INTEGER NOT NULL,
    store_track_id INTEGER,
    store_collection_id INTEGER,
    isrc TEXT,
    mora_label_code TEXT,
    mora_package_id TEXT,
    mora_material_no TEXT,
    mora_isrc TEXT,
    error TEXT,
    scanned_at TEXT NOT NULL,
    PRIMARY KEY (source_id, path)
) STRICT;

CREATE TABLE directory_scans (
    source_id TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ns INTEGER NOT NULL,
    duration_ms INTEGER,
    title TEXT,
    artist TEXT,
    album_artist TEXT,
    album TEXT,
    isrc TEXT,
    mora_label_code TEXT,
    mora_package_id TEXT,
    mora_material_no TEXT,
    error TEXT,
    scanned_at TEXT NOT NULL,
    PRIMARY KEY (source_id, rel_path)
) STRICT;

CREATE TABLE store_tracks (
    country TEXT NOT NULL,
    track_id INTEGER NOT NULL,
    found INTEGER NOT NULL,
    track_name TEXT,
    artist_name TEXT,
    collection_name TEXT,
    collection_artist_name TEXT,
    collection_id INTEGER,
    track_time_millis INTEGER,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (country, track_id)
) STRICT;
"#,
)];

pub const MIGRATIONS: rusqlite_migration::Migrations<'static> =
    rusqlite_migration::Migrations::from_slice(MIGRATION_SLICE);

pub const DB_FILE: &str = "cache.sqlite3";

#[derive(Clone)]
pub struct Db {
    conn: tokio_rusqlite::Connection,
}

impl Db {
    pub async fn open(path: &std::path::Path) -> crate::error::Result<Self> {
        Self::init(tokio_rusqlite::Connection::open(path).await?).await
    }

    pub async fn open_in_memory() -> crate::error::Result<Self> {
        Self::init(tokio_rusqlite::Connection::open_in_memory().await?).await
    }

    async fn init(conn: tokio_rusqlite::Connection) -> crate::error::Result<Self> {
        let db = Self { conn };
        db.call(|conn| {
            conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
            MIGRATIONS.to_latest(conn)?;
            Ok(())
        })
        .await?;
        Ok(db)
    }

    pub async fn call<F, R>(&self, function: F) -> crate::error::Result<R>
    where
        F: FnOnce(&mut rusqlite::Connection) -> crate::error::Result<R> + Send + 'static,
        R: Send + 'static,
    {
        match self.conn.call(function).await {
            Ok(value) => Ok(value),
            Err(tokio_rusqlite::Error::Error(e)) => Err(e),
            Err(_) => Err(crate::error::Error::DatabaseClosed),
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn migrations_are_valid() {
        crate::db::MIGRATIONS.validate().unwrap();
    }

    #[tokio::test]
    async fn opens_in_memory() {
        let db = crate::db::Db::open_in_memory().await.unwrap();
        let count: i64 = db
            .call(|conn| {
                Ok(conn.query_row("SELECT count(*) FROM store_tracks", [], |row| row.get(0))?)
            })
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}
