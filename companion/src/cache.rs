//! Queries over the SQLite cache tables. All functions run on the database thread.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStamp {
    pub size: u64,
    pub mtime_ns: i64,
}

#[derive(Debug, Clone)]
pub struct Mp4Scan {
    pub path: String,
    pub stamp: FileStamp,
    pub result: Result<crate::sources::mp4::Mp4Ids, String>,
}

#[derive(Debug, Clone)]
pub struct DirectoryScan {
    pub rel_path: String,
    pub stamp: FileStamp,
    pub result: Result<crate::sources::ffprobe::Probe, String>,
}

#[derive(Debug, Clone, Default)]
pub struct StoreRow {
    pub track_name: Option<String>,
    pub artist_name: Option<String>,
    pub collection_name: Option<String>,
    pub collection_artist_name: Option<String>,
    pub collection_id: Option<u64>,
}

fn now() -> String {
    jiff::Timestamp::now().to_string()
}

fn stamp_from(row: &rusqlite::Row<'_>, size: usize, mtime: usize) -> rusqlite::Result<FileStamp> {
    Ok(FileStamp {
        size: row.get::<_, i64>(size)? as u64,
        mtime_ns: row.get(mtime)?,
    })
}

pub fn mp4_stamps(
    conn: &rusqlite::Connection,
    source_id: &str,
) -> crate::error::Result<std::collections::HashMap<String, FileStamp>> {
    let mut stmt =
        conn.prepare("SELECT path, size, mtime_ns FROM mp4_scans WHERE source_id = ?1")?;
    let rows = stmt.query_map([source_id], |row| Ok((row.get(0)?, stamp_from(row, 1, 2)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Successful scans only, keyed by path.
pub fn mp4_ids(
    conn: &rusqlite::Connection,
    source_id: &str,
) -> crate::error::Result<std::collections::HashMap<String, crate::sources::mp4::Mp4Ids>> {
    let mut stmt = conn.prepare(
        "SELECT path, store_track_id, store_collection_id, isrc, mora_label_code, mora_package_id, mora_material_no, mora_isrc
         FROM mp4_scans WHERE source_id = ?1 AND error IS NULL",
    )?;
    let rows = stmt.query_map([source_id], |row| {
        Ok((
            row.get(0)?,
            crate::sources::mp4::Mp4Ids {
                store_track_id: row.get::<_, Option<i64>>(1)?.map(|v| v as u64),
                store_collection_id: row.get::<_, Option<i64>>(2)?.map(|v| v as u64),
                isrc: row.get(3)?,
                mora_label_code: row.get(4)?,
                mora_package_id: row.get(5)?,
                mora_material_no: row.get(6)?,
                mora_isrc: row.get(7)?,
            },
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn upsert_mp4(
    conn: &mut rusqlite::Connection,
    source_id: &str,
    scans: &[Mp4Scan],
) -> crate::error::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO mp4_scans
             (source_id, path, size, mtime_ns, store_track_id, store_collection_id, isrc,
              mora_label_code, mora_package_id, mora_material_no, mora_isrc, error, scanned_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )?;
        let scanned_at = now();
        for scan in scans {
            let empty = crate::sources::mp4::Mp4Ids::default();
            let (ids, error) = match &scan.result {
                Ok(ids) => (ids, None),
                Err(e) => (&empty, Some(e.as_str())),
            };
            stmt.execute(rusqlite::params![
                source_id,
                scan.path,
                scan.stamp.size as i64,
                scan.stamp.mtime_ns,
                ids.store_track_id.map(|v| v as i64),
                ids.store_collection_id.map(|v| v as i64),
                ids.isrc,
                ids.mora_label_code,
                ids.mora_package_id,
                ids.mora_material_no,
                ids.mora_isrc,
                error,
                scanned_at,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_mp4(
    conn: &mut rusqlite::Connection,
    source_id: &str,
    paths: &[String],
) -> crate::error::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("DELETE FROM mp4_scans WHERE source_id = ?1 AND path = ?2")?;
        for path in paths {
            stmt.execute([source_id, path])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn directory_stamps(
    conn: &rusqlite::Connection,
    source_id: &str,
) -> crate::error::Result<std::collections::HashMap<String, FileStamp>> {
    let mut stmt =
        conn.prepare("SELECT rel_path, size, mtime_ns FROM directory_scans WHERE source_id = ?1")?;
    let rows = stmt.query_map([source_id], |row| Ok((row.get(0)?, stamp_from(row, 1, 2)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Successful scans only, sorted by relative path.
pub fn directory_probes(
    conn: &rusqlite::Connection,
    source_id: &str,
) -> crate::error::Result<Vec<(String, crate::sources::ffprobe::Probe)>> {
    let mut stmt = conn.prepare(
        "SELECT rel_path, duration_ms, title, artist, album_artist, album, isrc,
                mora_label_code, mora_package_id, mora_material_no
         FROM directory_scans WHERE source_id = ?1 AND error IS NULL ORDER BY rel_path",
    )?;
    let rows = stmt.query_map([source_id], |row| {
        Ok((
            row.get(0)?,
            crate::sources::ffprobe::Probe {
                duration_ms: row.get(1)?,
                title: row.get(2)?,
                artist: row.get(3)?,
                album_artist: row.get(4)?,
                album: row.get(5)?,
                isrc: row.get(6)?,
                mora_label_code: row.get(7)?,
                mora_package_id: row.get(8)?,
                mora_material_no: row.get(9)?,
            },
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn upsert_directory(
    conn: &mut rusqlite::Connection,
    source_id: &str,
    scans: &[DirectoryScan],
) -> crate::error::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO directory_scans
             (source_id, rel_path, size, mtime_ns, duration_ms, title, artist, album_artist, album, isrc,
              mora_label_code, mora_package_id, mora_material_no, error, scanned_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )?;
        let scanned_at = now();
        for scan in scans {
            let empty = crate::sources::ffprobe::Probe::default();
            let (probe, error) = match &scan.result {
                Ok(probe) => (probe, None),
                Err(e) => (&empty, Some(e.as_str())),
            };
            stmt.execute(rusqlite::params![
                source_id,
                scan.rel_path,
                scan.stamp.size as i64,
                scan.stamp.mtime_ns,
                probe.duration_ms,
                probe.title,
                probe.artist,
                probe.album_artist,
                probe.album,
                probe.isrc,
                probe.mora_label_code,
                probe.mora_package_id,
                probe.mora_material_no,
                error,
                scanned_at,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_directory(
    conn: &mut rusqlite::Connection,
    source_id: &str,
    rel_paths: &[String],
) -> crate::error::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt =
            tx.prepare("DELETE FROM directory_scans WHERE source_id = ?1 AND rel_path = ?2")?;
        for rel_path in rel_paths {
            stmt.execute([source_id, rel_path])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Store track IDs referenced by MP4 scans that have no Lookup result yet.
pub fn pending_store_ids(
    conn: &rusqlite::Connection,
    country: &str,
) -> crate::error::Result<Vec<u64>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT m.store_track_id FROM mp4_scans m
         WHERE m.store_track_id IS NOT NULL AND m.error IS NULL
           AND NOT EXISTS (SELECT 1 FROM store_tracks s WHERE s.country = ?1 AND s.track_id = m.store_track_id)
         ORDER BY m.store_track_id",
    )?;
    let rows = stmt.query_map([country], |row| row.get::<_, i64>(0))?;
    Ok(rows
        .map(|r| r.map(|v| v as u64))
        .collect::<rusqlite::Result<_>>()?)
}

pub fn store_rows(
    conn: &rusqlite::Connection,
    country: &str,
) -> crate::error::Result<std::collections::HashMap<u64, StoreRow>> {
    let mut stmt = conn.prepare(
        "SELECT track_id, track_name, artist_name, collection_name, collection_artist_name, collection_id
         FROM store_tracks WHERE country = ?1 AND found = 1",
    )?;
    let rows = stmt.query_map([country], |row| {
        Ok((
            row.get::<_, i64>(0)? as u64,
            StoreRow {
                track_name: row.get(1)?,
                artist_name: row.get(2)?,
                collection_name: row.get(3)?,
                collection_artist_name: row.get(4)?,
                collection_id: row.get::<_, Option<i64>>(5)?.map(|v| v as u64),
            },
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Records a Lookup batch: `found` rows, and every other ID in `requested` as delisted.
pub fn record_lookup(
    conn: &mut rusqlite::Connection,
    country: &str,
    requested: &[u64],
    found: &[crate::lookup::StoreTrack],
) -> crate::error::Result<()> {
    let tx = conn.transaction()?;
    {
        let fetched_at = now();
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO store_tracks
             (country, track_id, found, track_name, artist_name, collection_name, collection_artist_name,
              collection_id, track_time_millis, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?;
        let found_ids: std::collections::HashSet<u64> = found.iter().map(|t| t.track_id).collect();
        for track in found {
            stmt.execute(rusqlite::params![
                country,
                track.track_id as i64,
                1,
                track.track_name,
                track.artist_name,
                track.collection_name,
                track.collection_artist_name,
                track.collection_id.map(|v| v as i64),
                track.track_time_millis,
                fetched_at,
            ])?;
        }
        for &id in requested.iter().filter(|id| !found_ids.contains(id)) {
            stmt.execute(rusqlite::params![
                country,
                id as i64,
                0,
                None::<String>,
                None::<String>,
                None::<String>,
                None::<String>,
                None::<i64>,
                None::<i64>,
                fetched_at,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn lookup_rows_round_trip() {
        let db = crate::db::Db::open_in_memory().await.unwrap();
        db.call(|conn| {
            crate::cache::upsert_mp4(
                conn,
                "itunes",
                &[
                    crate::cache::Mp4Scan {
                        path: "a".to_owned(),
                        stamp: crate::cache::FileStamp {
                            size: 1,
                            mtime_ns: 2,
                        },
                        result: Ok(crate::sources::mp4::Mp4Ids {
                            store_track_id: Some(10),
                            ..Default::default()
                        }),
                    },
                    crate::cache::Mp4Scan {
                        path: "b".to_owned(),
                        stamp: crate::cache::FileStamp {
                            size: 1,
                            mtime_ns: 2,
                        },
                        result: Ok(crate::sources::mp4::Mp4Ids {
                            store_track_id: Some(11),
                            ..Default::default()
                        }),
                    },
                    crate::cache::Mp4Scan {
                        path: "c".to_owned(),
                        stamp: crate::cache::FileStamp {
                            size: 1,
                            mtime_ns: 2,
                        },
                        result: Err("unreadable".to_owned()),
                    },
                ],
            )?;
            assert_eq!(crate::cache::pending_store_ids(conn, "jp")?, vec![10, 11]);
            crate::cache::record_lookup(
                conn,
                "jp",
                &[10, 11],
                &[crate::lookup::StoreTrack {
                    track_id: 10,
                    track_name: Some("曲".to_owned()),
                    artist_name: None,
                    collection_name: None,
                    collection_artist_name: None,
                    collection_id: None,
                    track_time_millis: None,
                }],
            )?;
            assert!(crate::cache::pending_store_ids(conn, "jp")?.is_empty());
            assert_eq!(crate::cache::pending_store_ids(conn, "us")?, vec![10, 11]);
            let rows = crate::cache::store_rows(conn, "jp")?;
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[&10].track_name.as_deref(), Some("曲"));
            assert_eq!(crate::cache::mp4_ids(conn, "itunes")?.len(), 2);
            assert_eq!(crate::cache::mp4_stamps(conn, "itunes")?.len(), 3);
            Ok(())
        })
        .await
        .unwrap();
    }
}
