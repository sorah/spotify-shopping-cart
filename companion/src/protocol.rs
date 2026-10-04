//! Wire types for protocol v1 (docs/companion.md). Unknown request fields are ignored.

pub const PROTOCOL_VERSION: u32 = 1;
pub const SUPPORTED_PROTOCOLS: &[u32] = &[1];
pub const MAX_TRACKS: usize = 500;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub protocols: Vec<u32>,
    pub version: String,
    pub library_revision: String,
    pub capabilities: Vec<String>,
    pub sources: Vec<SourceStatus>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub id: String,
    pub label: String,
    pub state: SourceState,
    pub entries: usize,
    pub indexed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<Progress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceState {
    Ready,
    Indexing,
    Error,
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ProtocolProbe {
    pub protocol: Option<u32>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct MatchRequest {
    pub protocol: u32,
    pub tracks: Vec<MatchTrack>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchTrack {
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub artists: Vec<String>,
    #[serde(default)]
    pub album: MatchAlbum,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub isrc: Option<String>,
    #[serde(default)]
    pub track_number: Option<u32>,
    #[serde(default)]
    pub disc_number: Option<u32>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchAlbum {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artists: Vec<String>,
    #[serde(default)]
    pub total_tracks: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchResponse {
    pub protocol: u32,
    pub library_revision: String,
    pub results: Vec<MatchResult>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchResult {
    pub key: String,
    pub verdict: Verdict,
    pub score: f64,
    pub matched_by: Option<MatchedBy>,
    pub matches: Vec<LocalMatch>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Owned,
    Probable,
    Absent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MatchedBy {
    Isrc,
    StoreId,
    Metadata,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMatch {
    pub source: String,
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub duration_ms: Option<i64>,
    pub ownership: Ownership,
    pub format: String,
    pub cloud_only: bool,
    pub location: String,
    pub metadata_source: MetadataSource,
    pub ids: LocalIds,
    pub score: f64,
    pub signals: Signals,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Ownership {
    Purchased,
    Matched,
    Imported,
    Flat,
    AppleMusic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MetadataSource {
    Tags,
    ItunesStore,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalIds {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isrc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub itunes_track_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub itunes_collection_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mora: Option<MoraIds>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoraIds {
    pub label_code: String,
    pub package_id: String,
    pub material_no: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signals {
    pub title: f64,
    pub artist: f64,
    pub album: Option<f64>,
    pub duration_delta_ms: Option<i64>,
    pub isrc: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ErrorBody {
    pub protocol: u32,
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
