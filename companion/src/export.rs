//! Reads the SPA's debug export ("Export debug data") for the `match` command.

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistTrack {
    uri: String,
    name: String,
    #[serde(default)]
    artists: Vec<String>,
    album: PlaylistAlbum,
    duration_ms: Option<i64>,
    isrc: Option<String>,
    track_number: Option<u32>,
    disc_number: Option<u32>,
    #[serde(default)]
    is_local: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistAlbum {
    id: Option<String>,
    name: String,
    #[serde(default)]
    artists: Vec<String>,
    total_tracks: Option<u32>,
}

/// The playlist's tracks as match requests, deduped by URI, without local files.
pub fn read_tracks(json: &str) -> crate::error::Result<Vec<crate::protocol::MatchTrack>> {
    let export: serde_json::Value = serde_json::from_str(json)?;
    let data = export
        .get("swrCache")
        .and_then(serde_json::Value::as_object)
        .and_then(|cache| {
            cache
                .iter()
                .find(|(key, _)| key.starts_with("@\"playlist-items\""))
        })
        .and_then(|(_, entry)| entry.get("data"))
        .cloned()
        .ok_or_else(|| crate::error::Error::Config("no playlist items in the export".to_owned()))?;
    let items: Vec<PlaylistTrack> = serde_json::from_value(data)?;
    let mut seen = std::collections::HashSet::new();
    Ok(items
        .into_iter()
        .filter(|item| !item.is_local && seen.insert(item.uri.clone()))
        .map(|item| crate::protocol::MatchTrack {
            key: item.uri,
            title: item.name,
            artists: item.artists,
            album: crate::protocol::MatchAlbum {
                id: item.album.id,
                title: item.album.name,
                artists: item.album.artists,
                total_tracks: item.album.total_tracks,
            },
            duration_ms: item.duration_ms,
            isrc: item.isrc,
            track_number: item.track_number,
            disc_number: item.disc_number,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_playlist_items() {
        let json = r#"{
            "swrCache": {
                "@\"me\",": {"data": {}},
                "@\"playlist-items\",\"abc\",": {"data": [
                    {"uri": "spotify:track:1", "name": "歩拾道", "artists": ["A"], "album": {"id": "x", "name": "Album", "artists": ["A"], "totalTracks": 1},
                     "durationMs": 261959, "isrc": "JPR562400335", "trackNumber": 1, "discNumber": 1, "isLocal": false},
                    {"uri": "spotify:track:1", "name": "dupe", "artists": [], "album": {"name": "Album"}},
                    {"uri": "spotify:local:x", "name": "local", "artists": [], "album": {"name": ""}, "isLocal": true}
                ]}
            }
        }"#;
        let tracks = crate::export::read_tracks(json).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].title, "歩拾道");
        assert_eq!(tracks[0].album.title, "Album");
        assert_eq!(tracks[0].duration_ms, Some(261959));
    }
}
