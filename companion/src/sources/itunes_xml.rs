//! Reads the "iTunes Library.xml" export. The file is only read; it is never touched otherwise.

#[derive(serde::Deserialize)]
struct Library {
    #[serde(rename = "Tracks", default)]
    tracks: std::collections::HashMap<String, RawTrack>,
}

#[derive(serde::Deserialize)]
struct RawTrack {
    #[serde(rename = "Persistent ID")]
    persistent_id: Option<String>,
    #[serde(rename = "Name")]
    name: Option<String>,
    #[serde(rename = "Artist")]
    artist: Option<String>,
    #[serde(rename = "Album Artist")]
    album_artist: Option<String>,
    #[serde(rename = "Album")]
    album: Option<String>,
    #[serde(rename = "Total Time")]
    total_time: Option<i64>,
    #[serde(rename = "Kind")]
    kind: Option<String>,
    #[serde(rename = "Location")]
    location: Option<String>,
    #[serde(rename = "Track Type")]
    track_type: Option<String>,
    #[serde(rename = "Apple Music", default)]
    apple_music: bool,
    #[serde(rename = "Movie", default)]
    movie: bool,
    #[serde(rename = "TV Show", default)]
    tv_show: bool,
    #[serde(rename = "Podcast", default)]
    podcast: bool,
    #[serde(rename = "Has Video", default)]
    has_video: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ItunesTrack {
    pub persistent_id: String,
    pub name: String,
    pub artist: Option<String>,
    pub album_artist: Option<String>,
    pub album: Option<String>,
    pub total_time_ms: Option<i64>,
    pub kind: String,
    pub path: Option<std::path::PathBuf>,
    pub cloud_only: bool,
    pub apple_music: bool,
}

/// Audio tracks sorted by Persistent ID. Videos, TV shows and podcasts are dropped.
pub fn parse(path: &std::path::Path) -> crate::error::Result<Vec<ItunesTrack>> {
    let library: Library = plist::from_file(path)?;
    Ok(convert(library))
}

pub fn parse_bytes(bytes: &[u8]) -> crate::error::Result<Vec<ItunesTrack>> {
    let library: Library = plist::from_bytes(bytes)?;
    Ok(convert(library))
}

fn convert(library: Library) -> Vec<ItunesTrack> {
    let mut tracks: Vec<ItunesTrack> = library
        .tracks
        .into_values()
        .filter(|raw| !(raw.movie || raw.tv_show || raw.podcast || raw.has_video))
        .filter_map(|raw| {
            Some(ItunesTrack {
                persistent_id: raw.persistent_id?,
                name: raw.name.filter(|name| !name.trim().is_empty())?,
                artist: non_empty(raw.artist),
                album_artist: non_empty(raw.album_artist),
                album: non_empty(raw.album),
                total_time_ms: raw.total_time.filter(|&ms| ms > 0),
                kind: raw.kind.unwrap_or_default(),
                path: raw.location.as_deref().and_then(location_to_path),
                cloud_only: raw.track_type.as_deref() == Some("Remote"),
                apple_music: raw.apple_music,
            })
        })
        .collect();
    tracks.sort_by(|a, b| a.persistent_id.cmp(&b.persistent_id));
    tracks
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

/// `file://localhost/D:/…` (percent-encoded) to a local path.
fn location_to_path(location: &str) -> Option<std::path::PathBuf> {
    url::Url::parse(location).ok()?.to_file_path().ok()
}

impl ItunesTrack {
    pub fn ownership(&self) -> crate::protocol::Ownership {
        let kind = self.kind.as_str();
        if self.apple_music || kind.contains("Apple Music") {
            crate::protocol::Ownership::AppleMusic
        } else if kind.contains("Purchased") || kind.contains("購入") || kind.contains("Protected")
        {
            crate::protocol::Ownership::Purchased
        } else if kind.contains("Matched") {
            crate::protocol::Ownership::Matched
        } else {
            crate::protocol::Ownership::Imported
        }
    }

    /// A fixed label from `Kind`; never derived from the file name.
    pub fn format(&self) -> String {
        let kind = self.kind.as_str();
        let label = if kind.contains("Apple Lossless") || kind.contains("ロスレス") {
            "ALAC"
        } else if kind.contains("AIFF") {
            "AIFF"
        } else if kind.contains("WAV") {
            "WAV"
        } else if kind.contains("AAC") {
            "AAC"
        } else if kind.contains("MPEG") {
            "MP3"
        } else {
            "other"
        };
        label.to_owned()
    }

    /// Whether the file may carry MP4 store atoms worth reading.
    pub fn is_mp4(&self) -> bool {
        self.path
            .as_deref()
            .and_then(std::path::Path::extension)
            .map(|ext| {
                let ext = ext.to_string_lossy().to_ascii_lowercase();
                matches!(ext.as_str(), "m4a" | "m4p" | "m4b" | "mp4")
            })
            .unwrap_or(false)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    pub fn plist_xml(tracks: &[String]) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Major Version</key><integer>1</integer>
	<key>Tracks</key>
	<dict>
{}
	</dict>
	<key>Playlists</key>
	<array>
		<dict>
			<key>Name</key><string>Library</string>
			<key>Playlist Items</key>
			<array><dict><key>Track ID</key><integer>1</integer></dict></array>
		</dict>
	</array>
</dict>
</plist>
"#,
            tracks.join("\n")
        )
    }

    pub fn track_xml(id: u32, fields: &[(&str, &str, &str)]) -> String {
        let body: String = fields
            .iter()
            .map(|(key, kind, value)| {
                if *kind == "true" {
                    format!("<key>{key}</key><true/>")
                } else {
                    format!("<key>{key}</key><{kind}>{value}</{kind}>")
                }
            })
            .collect();
        format!("<key>{id}</key><dict><key>Track ID</key><integer>{id}</integer>{body}</dict>")
    }

    #[test]
    fn parses_audio_tracks() {
        let xml = plist_xml(&[
            track_xml(
                1,
                &[
                    ("Name", "string", "You &#38; I"),
                    ("Artist", "string", "Ayaka Ohashi"),
                    ("Album", "string", "You &amp; I - Single"),
                    ("Kind", "string", "購入したAACオーディオファイル"),
                    ("Total Time", "integer", "245000"),
                    ("Persistent ID", "string", "AAAA000000000001"),
                    (
                        "Location",
                        "string",
                        "file://localhost/C:/Music/You%20&#38;%20I.m4a",
                    ),
                ],
            ),
            track_xml(
                2,
                &[
                    ("Name", "string", "Cloud Song"),
                    ("Kind", "string", "Matched AAC audio file"),
                    ("Persistent ID", "string", "AAAA000000000002"),
                    ("Track Type", "string", "Remote"),
                ],
            ),
            track_xml(
                3,
                &[
                    ("Name", "string", "A Movie"),
                    ("Kind", "string", "Purchased MPEG-4 video file"),
                    ("Persistent ID", "string", "AAAA000000000003"),
                    ("Movie", "true", ""),
                ],
            ),
            track_xml(
                4,
                &[
                    ("Name", "string", "Subscription"),
                    ("Kind", "string", "Apple Music AAC audio file"),
                    ("Persistent ID", "string", "AAAA000000000004"),
                    ("Apple Music", "true", ""),
                ],
            ),
        ]);
        let tracks = crate::sources::itunes_xml::parse_bytes(xml.as_bytes()).unwrap();
        assert_eq!(tracks.len(), 3);

        let first = &tracks[0];
        assert_eq!(first.name, "You & I");
        assert_eq!(first.album.as_deref(), Some("You & I - Single"));
        assert_eq!(first.total_time_ms, Some(245000));
        assert_eq!(first.ownership(), crate::protocol::Ownership::Purchased);
        assert_eq!(first.format(), "AAC");
        assert!(first.is_mp4());
        assert!(!first.cloud_only);
        #[cfg(windows)]
        assert_eq!(
            first.path.as_deref(),
            Some(std::path::Path::new(r"C:\Music\You & I.m4a"))
        );

        let cloud = &tracks[1];
        assert!(cloud.cloud_only);
        assert_eq!(cloud.path, None);
        assert_eq!(cloud.ownership(), crate::protocol::Ownership::Matched);

        assert_eq!(
            tracks[2].ownership(),
            crate::protocol::Ownership::AppleMusic
        );
    }
}
