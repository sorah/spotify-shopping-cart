//! State shared with the HTTP server. It holds the index and status only, never the
//! configuration's paths or the cache database.

pub struct AppState {
    pub token: String,
    pub allowed_origins: Vec<String>,
    /// The `Host` header value requests must carry.
    pub host: String,
    pub capabilities: Vec<String>,
    index: std::sync::RwLock<Option<std::sync::Arc<crate::index::Index>>>,
    sources: std::sync::Mutex<Vec<crate::protocol::SourceStatus>>,
    pairing_hint_at: std::sync::Mutex<Option<std::time::Instant>>,
    /// Bounds the CPU that concurrent match requests can take.
    pub(crate) match_permits: std::sync::Arc<tokio::sync::Semaphore>,
}

const MATCH_CONCURRENCY: usize = 2;

/// The app sends its status and match requests together, so one hint covers a burst.
const PAIRING_HINT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);

impl AppState {
    pub fn new(config: &crate::config::Config, token: String) -> Self {
        let mut capabilities = vec!["match", "ids.isrc", "ids.itunes", "ids.mora"];
        if config.itunes_lookup.enabled {
            capabilities.push("store-metadata");
        }
        Self {
            token,
            allowed_origins: config.allowed_origins.clone(),
            host: config.host(),
            capabilities: capabilities.into_iter().map(str::to_owned).collect(),
            index: std::sync::RwLock::new(None),
            sources: std::sync::Mutex::new(
                config
                    .sources
                    .iter()
                    .map(|source| crate::protocol::SourceStatus {
                        id: source.id.clone(),
                        label: source.label().to_owned(),
                        state: crate::protocol::SourceState::Indexing,
                        entries: 0,
                        indexed_at: None,
                        progress: None,
                        error: None,
                    })
                    .collect(),
            ),
            pairing_hint_at: std::sync::Mutex::new(None),
            match_permits: std::sync::Arc::new(tokio::sync::Semaphore::new(MATCH_CONCURRENCY)),
        }
    }

    /// Prints the pairing token to the console when an allowed origin presents no valid token.
    /// Returns whether it was printed.
    pub fn pairing_requested(&self, origin: &str) -> bool {
        let mut last = self
            .pairing_hint_at
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if last.is_some_and(|at| at.elapsed() < PAIRING_HINT_INTERVAL) {
            return false;
        }
        *last = Some(std::time::Instant::now());
        println!("{origin} asked to pair. Pairing token: {}", self.token);
        true
    }

    pub fn index(&self) -> Option<std::sync::Arc<crate::index::Index>> {
        self.index
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn publish(&self, index: std::sync::Arc<crate::index::Index>) {
        {
            let mut sources = self.lock_sources();
            for source in sources.iter_mut() {
                source.entries = index.count_by_source(&source.id);
            }
        }
        *self
            .index
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(index);
    }

    pub fn update_source(&self, id: &str, update: impl FnOnce(&mut crate::protocol::SourceStatus)) {
        if let Some(source) = self.lock_sources().iter_mut().find(|s| s.id == id) {
            update(source);
        }
    }

    pub fn status(&self) -> crate::protocol::CompanionStatus {
        crate::protocol::CompanionStatus {
            protocols: crate::protocol::SUPPORTED_PROTOCOLS.to_vec(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            library_revision: self.index().map(|i| i.revision.clone()).unwrap_or_default(),
            capabilities: self.capabilities.clone(),
            sources: self.lock_sources().clone(),
        }
    }

    fn lock_sources(&self) -> std::sync::MutexGuard<'_, Vec<crate::protocol::SourceStatus>> {
        self.sources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn pairing_hint_is_printed_once_per_burst() {
        let config: crate::config::Config =
            serde_json::from_str(include_str!("../config.example.json")).unwrap();
        let state = crate::state::AppState::new(&config, "token".to_owned());
        assert!(state.pairing_requested("https://app.example"));
        assert!(!state.pairing_requested("https://app.example"));
    }
}
