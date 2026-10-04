use crate::error::{Error, IoContext as _};

pub const DATA_DIR_NAME: &str = "ssc-companion";

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub listen: std::net::SocketAddr,
    pub allowed_origins: Vec<String>,
    pub sources: Vec<SourceConfig>,
    #[serde(default)]
    pub exclude: Vec<ExcludeConfig>,
    #[serde(default = "default_ffprobe")]
    pub ffprobe: String,
    #[serde(default = "default_scan_concurrency")]
    pub scan_concurrency: usize,
    #[serde(default = "default_rescan_interval_secs")]
    pub rescan_interval_secs: u64,
    #[serde(default)]
    pub itunes_lookup: ItunesLookupConfig,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceConfig {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: SourceKind,
    pub path: std::path::PathBuf,
    /// Shown to the SPA in place of the path, which never leaves the companion.
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default = "default_extensions")]
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    ItunesXml,
    Directory,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExcludeConfig {
    pub source: String,
    pub path_glob: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ItunesLookupConfig {
    pub enabled: bool,
    pub country: String,
    pub interval_ms: u64,
}

impl Default for ItunesLookupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            country: "jp".to_owned(),
            interval_ms: 3500,
        }
    }
}

fn default_ffprobe() -> String {
    "ffprobe".to_owned()
}

fn default_scan_concurrency() -> usize {
    8
}

fn default_rescan_interval_secs() -> u64 {
    300
}

fn default_extensions() -> Vec<String> {
    ["flac", "mp3", "m4a", "wav"]
        .into_iter()
        .map(str::to_owned)
        .collect()
}

impl SourceConfig {
    pub fn label(&self) -> &str {
        self.label.as_deref().unwrap_or(&self.id)
    }
}

impl Config {
    pub fn load(path: &std::path::Path) -> crate::error::Result<Self> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(Error::Config(format!(
                    "{} not found; copy companion/config.example.json there and edit it",
                    path.display()
                )));
            }
            Err(e) => return Err(e).context(|| format!("reading {}", path.display())),
        };
        let config: Self = serde_json::from_str(&text)
            .map_err(|e| Error::Config(format!("{}: {e}", path.display())))?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> crate::error::Result<()> {
        if !self.listen.ip().is_loopback() {
            return Err(Error::Config(format!(
                "listen must be a loopback address, got {}",
                self.listen
            )));
        }
        if self.allowed_origins.is_empty() {
            return Err(Error::Config("allowedOrigins is empty".to_owned()));
        }
        for origin in &self.allowed_origins {
            let canonical = url::Url::parse(origin)
                .ok()
                .map(|url| url.origin().ascii_serialization());
            if canonical.as_deref() != Some(origin.as_str()) {
                return Err(Error::Config(format!(
                    "allowedOrigins entry {origin:?} must be a bare origin such as https://example.com"
                )));
            }
        }
        let mut ids = std::collections::HashSet::new();
        for source in &self.sources {
            if source.id.is_empty() || !ids.insert(source.id.as_str()) {
                return Err(Error::Config(format!(
                    "source id {:?} is empty or duplicated",
                    source.id
                )));
            }
        }
        for exclude in &self.exclude {
            if !ids.contains(exclude.source.as_str()) {
                return Err(Error::Config(format!(
                    "exclude refers to unknown source {:?}",
                    exclude.source
                )));
            }
        }
        if self.scan_concurrency == 0 {
            return Err(Error::Config("scanConcurrency must be positive".to_owned()));
        }
        Ok(())
    }

    /// The `Host` header value browsers send for `listen`.
    pub fn host(&self) -> String {
        self.listen.to_string()
    }
}

pub fn default_data_dir() -> crate::error::Result<std::path::PathBuf> {
    dirs::data_local_dir()
        .map(|dir| dir.join(DATA_DIR_NAME))
        .ok_or_else(|| Error::Config("cannot determine the local data directory".to_owned()))
}

#[cfg(test)]
mod tests {
    fn parse(json: &str) -> crate::error::Result<crate::config::Config> {
        let config: crate::config::Config = serde_json::from_str(json)?;
        config.validate()?;
        Ok(config)
    }

    #[test]
    fn example_config_parses() {
        let config = parse(include_str!("../config.example.json")).unwrap();
        assert_eq!(config.sources.len(), 2);
        assert_eq!(config.sources[1].kind, crate::config::SourceKind::Directory);
        assert_eq!(config.itunes_lookup.country, "jp");
        assert_eq!(config.host(), "127.0.0.1:47611");
    }

    #[test]
    fn rejects_non_loopback_listen() {
        let err = parse(
            r#"{"listen": "0.0.0.0:47611", "allowedOrigins": ["https://a.example"], "sources": []}"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("loopback"));
    }

    #[test]
    fn rejects_origin_with_path() {
        let err = parse(
            r#"{"listen": "127.0.0.1:47611", "allowedOrigins": ["https://a.example/"], "sources": []}"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("bare origin"));
    }

    #[test]
    fn rejects_unknown_fields() {
        assert!(
            parse(
                r#"{"listen": "127.0.0.1:47611", "allowedOrigins": ["https://a.example"], "sources": [], "typo": 1}"#,
            )
            .is_err()
        );
    }
}
