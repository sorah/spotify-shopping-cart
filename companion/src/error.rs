#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("config: {0}")]
    Config(String),
    #[error("{context}: {source}")]
    Io {
        context: String,
        source: std::io::Error,
    },
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Migration(#[from] rusqlite_migration::Error),
    #[error("database connection closed")]
    DatabaseClosed,
    #[error(transparent)]
    Plist(#[from] plist::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error("ffprobe: {0}")]
    Ffprobe(String),
    #[error("cannot run ffprobe: {0}")]
    FfprobeLaunch(std::io::Error),
    #[error("iTunes Lookup: {0}")]
    Lookup(String),
    #[error(transparent)]
    Join(#[from] tokio::task::JoinError),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// A fixed description safe to show over the API: no paths or OS error text.
    pub fn public_message(&self) -> &'static str {
        match self {
            Error::Io { .. } => "library not readable",
            Error::Plist(_) => "iTunes XML could not be parsed",
            Error::Ffprobe(_) | Error::FfprobeLaunch(_) => "ffprobe could not be run",
            Error::Sqlite(_) | Error::Migration(_) | Error::DatabaseClosed => {
                "cache database error"
            }
            Error::Http(_) | Error::Lookup(_) => "iTunes Lookup failed",
            Error::Config(_) => "configuration error",
            Error::Json(_) | Error::Join(_) => "internal error",
        }
    }
}

pub trait IoContext<T> {
    fn context(self, context: impl FnOnce() -> String) -> Result<T>;
}

impl<T> IoContext<T> for std::io::Result<T> {
    fn context(self, context: impl FnOnce() -> String) -> Result<T> {
        self.map_err(|source| Error::Io {
            context: context(),
            source,
        })
    }
}
