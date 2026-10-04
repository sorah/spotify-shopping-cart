//! Keeps the index current: scans sources into the cache, rebuilds the in-memory index, resolves
//! store names, and polls for changes. Library files are only opened for reading.

const CHUNK: usize = 500;

#[derive(Debug, Clone, Copy)]
enum Scan {
    Unchanged,
    Changed([u8; 32]),
}

pub struct Indexer {
    config: std::sync::Arc<crate::config::Config>,
    db: crate::db::Db,
    state: std::sync::Arc<crate::state::AppState>,
    id_key: [u8; 32],
    lookup: Option<crate::lookup::LookupClient>,
    excludes: std::collections::HashMap<String, globset::GlobSet>,
    fingerprints: std::collections::HashMap<String, [u8; 32]>,
    itunes_tracks: std::collections::HashMap<
        String,
        std::sync::Arc<Vec<crate::sources::itunes_xml::ItunesTrack>>,
    >,
}

impl Indexer {
    pub fn new(
        config: std::sync::Arc<crate::config::Config>,
        db: crate::db::Db,
        state: std::sync::Arc<crate::state::AppState>,
        id_key: [u8; 32],
    ) -> crate::error::Result<Self> {
        let lookup = if config.itunes_lookup.enabled {
            Some(crate::lookup::LookupClient::new(
                &config.itunes_lookup.country,
                std::time::Duration::from_millis(config.itunes_lookup.interval_ms),
            )?)
        } else {
            None
        };
        let mut excludes = std::collections::HashMap::new();
        for source in &config.sources {
            let patterns = config
                .exclude
                .iter()
                .filter(|e| e.source == source.id)
                .map(|e| e.path_glob.as_str());
            excludes.insert(
                source.id.clone(),
                crate::sources::directory::build_excludes(patterns)?,
            );
        }
        Ok(Self {
            config,
            db,
            state,
            id_key,
            lookup,
            excludes,
            fingerprints: Default::default(),
            itunes_tracks: Default::default(),
        })
    }

    pub async fn run(mut self) {
        let interval = std::time::Duration::from_secs(self.config.rescan_interval_secs.max(10));
        loop {
            if let Err(e) = self.cycle(true).await {
                tracing::error!(error = %e, "indexing cycle failed");
            }
            tokio::time::sleep(interval).await;
        }
    }

    /// Scans every source, republishes the index if anything changed, then resolves store names.
    pub async fn cycle(&mut self, resolve_store_names: bool) -> crate::error::Result<()> {
        let changed = self.scan_sources().await;
        if changed || self.state.index().is_none() {
            self.rebuild().await?;
        }
        if resolve_store_names && self.resolve_store_names().await {
            self.rebuild().await?;
        }
        Ok(())
    }

    async fn scan_sources(&mut self) -> bool {
        let mut changed = false;
        let sources = self.config.sources.clone();
        for source in &sources {
            let previous = self.fingerprints.get(&source.id).copied();
            let result = match source.kind {
                crate::config::SourceKind::ItunesXml => self.scan_itunes(source, previous).await,
                crate::config::SourceKind::Directory => self.scan_directory(source, previous).await,
            };
            match result {
                Ok(Scan::Unchanged) => {}
                Ok(Scan::Changed(fingerprint)) => {
                    changed = true;
                    self.fingerprints.insert(source.id.clone(), fingerprint);
                    self.state.update_source(&source.id, |s| {
                        s.state = crate::protocol::SourceState::Ready;
                        s.indexed_at = Some(jiff::Timestamp::now().to_string());
                        s.progress = None;
                        s.error = None;
                    });
                }
                Err(e) => {
                    tracing::error!(source = %source.id, error = %e, "scanning source failed");
                    self.fingerprints.remove(&source.id);
                    self.state.update_source(&source.id, |s| {
                        s.state = crate::protocol::SourceState::Error;
                        s.progress = None;
                        s.error = Some(e.public_message().to_owned());
                    });
                }
            }
        }
        changed
    }

    async fn scan_itunes(
        &mut self,
        source: &crate::config::SourceConfig,
        previous: Option<[u8; 32]>,
    ) -> crate::error::Result<Scan> {
        let metadata = tokio::fs::metadata(&source.path)
            .await
            .map_err(|e| io_error(e, "reading iTunes XML metadata", &source.path))?;
        let mut hasher = blake3::Hasher::new();
        hasher.update(&metadata.len().to_be_bytes());
        hasher.update(&crate::sources::mtime_ns(&metadata).to_be_bytes());
        let fingerprint: [u8; 32] = hasher.finalize().into();
        if previous == Some(fingerprint) && self.itunes_tracks.contains_key(&source.id) {
            return Ok(Scan::Unchanged);
        }

        self.set_indexing(&source.id, None);
        let path = source.path.clone();
        let tracks =
            tokio::task::spawn_blocking(move || crate::sources::itunes_xml::parse(&path)).await??;
        tracing::info!(source = %source.id, tracks = tracks.len(), "parsed iTunes XML");
        let tracks = std::sync::Arc::new(tracks);

        let mut files: Vec<(String, std::path::PathBuf)> = tracks
            .iter()
            .filter(|t| t.is_mp4())
            .filter_map(|t| t.path.clone())
            .map(|p| (p.to_string_lossy().into_owned(), p))
            .collect();
        files.sort();
        files.dedup_by(|a, b| a.0 == b.0);

        let source_id = source.id.clone();
        let cached = std::sync::Arc::new(
            self.db
                .call(move |c| crate::cache::mp4_stamps(c, &source_id))
                .await?,
        );
        let current: std::collections::HashSet<&str> =
            files.iter().map(|(k, _)| k.as_str()).collect();
        let mut removed: Vec<String> = cached
            .keys()
            .filter(|k| !current.contains(k.as_str()))
            .cloned()
            .collect();

        let total = files.len();
        let (mut done, mut read) = (0, 0);
        for chunk in files.chunks(CHUNK) {
            let cached = cached.clone();
            let outcomes = parallel_blocking(
                chunk.to_vec(),
                self.config.scan_concurrency,
                move |(key, path)| scan_mp4(&cached, key, &path),
            )
            .await?;
            let mut scans = Vec::new();
            for outcome in outcomes {
                match outcome {
                    Mp4Outcome::Unchanged => {}
                    Mp4Outcome::Missing(key) => removed.push(key),
                    Mp4Outcome::Scanned(scan) => scans.push(scan),
                }
            }
            read += scans.len();
            let source_id = source.id.clone();
            self.db
                .call(move |c| crate::cache::upsert_mp4(c, &source_id, &scans))
                .await?;
            done += chunk.len();
            self.set_indexing(&source.id, Some((done, total)));
        }
        let source_id = source.id.clone();
        self.db
            .call(move |c| crate::cache::delete_mp4(c, &source_id, &removed))
            .await?;
        tracing::info!(source = %source.id, files = total, read, "scanned MP4 store atoms");
        self.itunes_tracks.insert(source.id.clone(), tracks);
        Ok(Scan::Changed(fingerprint))
    }

    async fn scan_directory(
        &mut self,
        source: &crate::config::SourceConfig,
        previous: Option<[u8; 32]>,
    ) -> crate::error::Result<Scan> {
        let root = source.path.clone();
        let extensions = source.extensions.clone();
        let excludes = self.excludes[&source.id].clone();
        let files = tokio::task::spawn_blocking(move || {
            crate::sources::directory::walk(&root, &extensions, &excludes)
        })
        .await??;
        let mut hasher = blake3::Hasher::new();
        for file in &files {
            hasher.update(file.rel_path.as_bytes());
            hasher.update(&[0]);
            hasher.update(&file.size.to_be_bytes());
            hasher.update(&file.mtime_ns.to_be_bytes());
        }
        let fingerprint: [u8; 32] = hasher.finalize().into();
        if previous == Some(fingerprint) {
            return Ok(Scan::Unchanged);
        }

        let source_id = source.id.clone();
        let cached = self
            .db
            .call(move |c| crate::cache::directory_stamps(c, &source_id))
            .await?;
        let current: std::collections::HashSet<&str> =
            files.iter().map(|f| f.rel_path.as_str()).collect();
        let removed: Vec<String> = cached
            .keys()
            .filter(|k| !current.contains(k.as_str()))
            .cloned()
            .collect();
        let to_probe: Vec<crate::sources::directory::DirFile> = files
            .iter()
            .filter(|f| {
                cached.get(&f.rel_path)
                    != Some(&crate::cache::FileStamp {
                        size: f.size,
                        mtime_ns: f.mtime_ns,
                    })
            })
            .cloned()
            .collect();

        let total = to_probe.len();
        if total > 0 {
            self.set_indexing(&source.id, Some((0, total)));
        }
        let semaphore =
            std::sync::Arc::new(tokio::sync::Semaphore::new(self.config.scan_concurrency));
        let mut done = 0;
        for chunk in to_probe.chunks(CHUNK) {
            let mut set = tokio::task::JoinSet::new();
            for file in chunk.iter().cloned() {
                let permit = semaphore
                    .clone()
                    .acquire_owned()
                    .await
                    .expect("semaphore is never closed");
                let ffprobe = self.config.ffprobe.clone();
                set.spawn(async move {
                    let _permit = permit;
                    let result = crate::sources::ffprobe::probe(&ffprobe, &file.abs_path).await;
                    (file, result)
                });
            }
            let mut scans = Vec::new();
            while let Some(joined) = set.join_next().await {
                let (file, result) = joined?;
                let result = match result {
                    Ok(probe) => Ok(probe),
                    Err(crate::error::Error::Ffprobe(message)) => {
                        tracing::warn!(source = %source.id, file = %file.rel_path, %message, "ffprobe failed");
                        Err(message)
                    }
                    Err(e) => return Err(e),
                };
                scans.push(crate::cache::DirectoryScan {
                    rel_path: file.rel_path,
                    stamp: crate::cache::FileStamp {
                        size: file.size,
                        mtime_ns: file.mtime_ns,
                    },
                    result,
                });
            }
            let source_id = source.id.clone();
            self.db
                .call(move |c| crate::cache::upsert_directory(c, &source_id, &scans))
                .await?;
            done += chunk.len();
            self.set_indexing(&source.id, Some((done, total)));
        }
        let removed_count = removed.len();
        let source_id = source.id.clone();
        self.db
            .call(move |c| crate::cache::delete_directory(c, &source_id, &removed))
            .await?;
        tracing::info!(source = %source.id, files = files.len(), probed = total, removed = removed_count, "scanned directory");
        Ok(Scan::Changed(fingerprint))
    }

    fn set_indexing(&self, source_id: &str, progress: Option<(usize, usize)>) {
        self.state.update_source(source_id, |s| {
            s.state = crate::protocol::SourceState::Indexing;
            s.progress = progress.map(|(done, total)| crate::protocol::Progress { done, total });
        });
    }

    /// Builds the index from the cache and the parsed iTunes XML, and publishes it.
    pub async fn rebuild(&self) -> crate::error::Result<std::sync::Arc<crate::index::Index>> {
        let sources = self.config.sources.clone();
        let country = self.lookup.as_ref().map(|l| l.country().to_owned());
        let (cached, store) = self
            .db
            .call(move |c| {
                let mut cached = std::collections::HashMap::new();
                for source in &sources {
                    let rows = match source.kind {
                        crate::config::SourceKind::ItunesXml => {
                            CachedRows::Mp4(crate::cache::mp4_ids(c, &source.id)?)
                        }
                        crate::config::SourceKind::Directory => {
                            CachedRows::Directory(crate::cache::directory_probes(c, &source.id)?)
                        }
                    };
                    cached.insert(source.id.clone(), rows);
                }
                let store = match &country {
                    Some(country) => crate::cache::store_rows(c, country)?,
                    None => Default::default(),
                };
                Ok((cached, store))
            })
            .await?;

        let sources = self.config.sources.clone();
        let itunes_tracks = self.itunes_tracks.clone();
        let id_key = self.id_key;
        let index = tokio::task::spawn_blocking(move || {
            let mut inputs = Vec::new();
            let mut cached = cached;
            for source in &sources {
                match cached.remove(&source.id) {
                    Some(CachedRows::Mp4(mp4)) => {
                        if let Some(tracks) = itunes_tracks.get(&source.id) {
                            inputs.extend(itunes_inputs(source, tracks, &mp4, &store));
                        }
                    }
                    Some(CachedRows::Directory(probes)) => {
                        inputs.extend(directory_inputs(source, probes, &id_key));
                    }
                    None => {}
                }
            }
            crate::index::Index::build(inputs)
        })
        .await?;
        let index = std::sync::Arc::new(index);
        tracing::info!(entries = index.entries.len(), revision = %index.revision, "published index");
        self.state.publish(index.clone());
        Ok(index)
    }

    /// Resolves store names for new store track IDs. Returns whether any were recorded.
    pub async fn resolve_store_names(&self) -> bool {
        let Some(lookup) = &self.lookup else {
            return false;
        };
        let country = lookup.country().to_owned();
        let pending = match self
            .db
            .call(move |c| crate::cache::pending_store_ids(c, &country))
            .await
        {
            Ok(pending) => pending,
            Err(e) => {
                tracing::error!(error = %e, "reading pending store IDs failed");
                return false;
            }
        };
        if pending.is_empty() {
            return false;
        }
        tracing::info!(
            ids = pending.len(),
            "resolving store names through iTunes Lookup"
        );
        let mut recorded = false;
        for (n, batch) in pending.chunks(crate::lookup::BATCH_SIZE).enumerate() {
            let found = match lookup.lookup(batch).await {
                Ok(found) => found,
                Err(e) => {
                    tracing::warn!(error = %e, "iTunes Lookup failed; retrying next cycle");
                    break;
                }
            };
            let country = lookup.country().to_owned();
            let batch = batch.to_vec();
            if let Err(e) = self
                .db
                .call(move |c| crate::cache::record_lookup(c, &country, &batch, &found))
                .await
            {
                tracing::error!(error = %e, "recording iTunes Lookup results failed");
                break;
            }
            recorded = true;
            let done = ((n + 1) * crate::lookup::BATCH_SIZE).min(pending.len());
            if n % 10 == 9 || done == pending.len() {
                tracing::info!(done, total = pending.len(), "iTunes Lookup progress");
            }
        }
        recorded
    }
}

enum CachedRows {
    Mp4(std::collections::HashMap<String, crate::sources::mp4::Mp4Ids>),
    Directory(Vec<(String, crate::sources::ffprobe::Probe)>),
}

enum Mp4Outcome {
    Unchanged,
    Missing(String),
    Scanned(crate::cache::Mp4Scan),
}

fn scan_mp4(
    cached: &std::collections::HashMap<String, crate::cache::FileStamp>,
    key: String,
    path: &std::path::Path,
) -> Mp4Outcome {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return Mp4Outcome::Missing(key),
    };
    let stamp = crate::cache::FileStamp {
        size: metadata.len(),
        mtime_ns: crate::sources::mtime_ns(&metadata),
    };
    if cached.get(&key) == Some(&stamp) {
        return Mp4Outcome::Unchanged;
    }
    let result = crate::sources::mp4::read_ids(path).map_err(|e| e.to_string());
    Mp4Outcome::Scanned(crate::cache::Mp4Scan {
        path: key,
        stamp,
        result,
    })
}

fn io_error(source: std::io::Error, what: &str, path: &std::path::Path) -> crate::error::Error {
    crate::error::Error::Io {
        context: format!("{what} {}", path.display()),
        source,
    }
}

/// Runs `work` over `items` on `workers` blocking threads. Result order is unspecified.
async fn parallel_blocking<T, R, F>(
    items: Vec<T>,
    workers: usize,
    work: F,
) -> crate::error::Result<Vec<R>>
where
    T: Send + 'static,
    R: Send + 'static,
    F: Fn(T) -> R + Send + Sync + 'static,
{
    let queue = std::sync::Arc::new(std::sync::Mutex::new(items.into_iter()));
    let work = std::sync::Arc::new(work);
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..workers.max(1) {
        let queue = queue.clone();
        let work = work.clone();
        set.spawn_blocking(move || {
            let mut out = Vec::new();
            loop {
                let item = queue
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .next();
                let Some(item) = item else { break };
                out.push(work(item));
            }
            out
        });
    }
    let mut results = Vec::new();
    while let Some(joined) = set.join_next().await {
        results.extend(joined?);
    }
    Ok(results)
}

fn itunes_inputs(
    source: &crate::config::SourceConfig,
    tracks: &[crate::sources::itunes_xml::ItunesTrack],
    mp4: &std::collections::HashMap<String, crate::sources::mp4::Mp4Ids>,
    store: &std::collections::HashMap<u64, crate::cache::StoreRow>,
) -> Vec<crate::index::EntryInput> {
    tracks
        .iter()
        .map(|track| {
            let ids = track
                .path
                .as_deref()
                .and_then(|p| mp4.get(p.to_string_lossy().as_ref()));
            let store_row = ids
                .and_then(|ids| ids.store_track_id)
                .and_then(|id| store.get(&id));
            crate::index::EntryInput {
                source: source.id.clone(),
                source_label: source.label().to_owned(),
                id: track.persistent_id.clone(),
                tags: crate::index::TagNames {
                    title: track.name.clone(),
                    artist: track.artist.clone(),
                    album_artist: track.album_artist.clone(),
                    album: track.album.clone(),
                },
                store: store_row.and_then(|row| {
                    Some(crate::index::StoreNames {
                        title: row.track_name.clone()?,
                        artist: row.artist_name.clone(),
                        collection_artist: row.collection_artist_name.clone(),
                        album: row.collection_name.clone(),
                    })
                }),
                duration_ms: track.total_time_ms,
                ownership: track.ownership(),
                format: track.format(),
                cloud_only: track.cloud_only,
                ids: crate::protocol::LocalIds {
                    isrc: ids.and_then(|ids| ids.isrc.clone().or_else(|| ids.mora_isrc.clone())),
                    itunes_track_id: ids.and_then(|ids| ids.store_track_id),
                    itunes_collection_id: ids
                        .and_then(|ids| ids.store_collection_id)
                        .or_else(|| store_row.and_then(|row| row.collection_id)),
                    mora: ids.and_then(|ids| {
                        mora_ids(
                            &ids.mora_label_code,
                            &ids.mora_package_id,
                            &ids.mora_material_no,
                        )
                    }),
                },
            }
        })
        .collect()
}

fn directory_inputs(
    source: &crate::config::SourceConfig,
    probes: Vec<(String, crate::sources::ffprobe::Probe)>,
    id_key: &[u8; 32],
) -> Vec<crate::index::EntryInput> {
    let mut untitled = 0;
    let inputs: Vec<crate::index::EntryInput> = probes
        .into_iter()
        .filter_map(|(rel_path, probe)| {
            let Some(title) = probe.title.clone() else {
                untitled += 1;
                return None;
            };
            let format = rel_path
                .rsplit_once('.')
                .map(|(_, ext)| ext.to_ascii_uppercase())
                .unwrap_or_default();
            Some(crate::index::EntryInput {
                source: source.id.clone(),
                source_label: source.label().to_owned(),
                id: opaque_id(id_key, &source.id, &rel_path),
                tags: crate::index::TagNames {
                    title,
                    artist: probe.artist.clone(),
                    album_artist: probe.album_artist.clone(),
                    album: probe.album.clone(),
                },
                store: None,
                duration_ms: probe.duration_ms,
                ownership: crate::protocol::Ownership::Flat,
                format,
                cloud_only: false,
                ids: crate::protocol::LocalIds {
                    isrc: probe.isrc.clone(),
                    itunes_track_id: None,
                    itunes_collection_id: None,
                    mora: mora_ids(
                        &probe.mora_label_code,
                        &probe.mora_package_id,
                        &probe.mora_material_no,
                    ),
                },
            })
        })
        .collect();
    if untitled > 0 {
        tracing::info!(source = %source.id, files = untitled, "skipped files without a title tag");
    }
    inputs
}

/// A stable ID that can't be traced back to the path without the per-install key.
fn opaque_id(id_key: &[u8; 32], source_id: &str, rel_path: &str) -> String {
    let mut input = Vec::with_capacity(source_id.len() + rel_path.len() + 1);
    input.extend_from_slice(source_id.as_bytes());
    input.push(0);
    input.extend_from_slice(rel_path.as_bytes());
    blake3::keyed_hash(id_key, &input).to_hex()[..16].to_owned()
}

fn mora_ids(
    label_code: &Option<String>,
    package_id: &Option<String>,
    material_no: &Option<String>,
) -> Option<crate::protocol::MoraIds> {
    Some(crate::protocol::MoraIds {
        label_code: label_code.clone()?,
        package_id: package_id.clone()?,
        material_no: material_no.clone()?,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn opaque_ids_depend_on_the_key() {
        let a = crate::indexer::opaque_id(&[1; 32], "rip", "Artist/Album/01.flac");
        let b = crate::indexer::opaque_id(&[2; 32], "rip", "Artist/Album/01.flac");
        assert_eq!(a.len(), 16);
        assert_ne!(a, b);
        assert_eq!(
            a,
            crate::indexer::opaque_id(&[1; 32], "rip", "Artist/Album/01.flac")
        );
        assert!(!a.contains("Artist"));
    }
}
