//! Reads tags of a directory-source file through ffprobe. Only whitelisted tags are requested,
//! so tags such as `account_id` (the iTunes account owner) and lyrics never reach the companion.

const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const MAX_STDOUT: u64 = 1024 * 1024;
const MAX_STDERR: u64 = 16 * 1024;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MORA_LABEL_CODE: &str = "45b1d925-1448-5784-b4da-b89901050a13";
const MORA_PACKAGE_ID: &str = "8e90f26b-372a-5c8c-bb05-1ec0f36ee60c";
const MORA_MATERIAL_NO: &str = "be242671-3d48-5ac8-b762-7d2db4f584b8";
const MORA_ISRC: &str = "93a74bea-ce97-5571-a56a-c5084dba9873";

// ffprobe matches these tag names case-insensitively.
static SHOW_ENTRIES: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    format!(
        "format=duration:format_tags=title,artist,album_artist,albumartist,album,isrc,{MORA_LABEL_CODE},{MORA_PACKAGE_ID},{MORA_MATERIAL_NO},{MORA_ISRC}"
    )
});

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Probe {
    pub duration_ms: Option<i64>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album_artist: Option<String>,
    pub album: Option<String>,
    pub isrc: Option<String>,
    pub mora_label_code: Option<String>,
    pub mora_package_id: Option<String>,
    pub mora_material_no: Option<String>,
}

/// Fails with [`crate::error::Error::FfprobeLaunch`] when ffprobe can't be started, and with
/// [`crate::error::Error::Ffprobe`] for anything specific to this file.
pub async fn probe(ffprobe: &str, path: &std::path::Path) -> crate::error::Result<Probe> {
    use tokio::io::AsyncReadExt as _;

    // The "file:" prefix keeps ffprobe from reading a leading "name:" as a protocol.
    let mut input = std::ffi::OsString::from("file:");
    input.push(path.as_os_str());
    let mut command = tokio::process::Command::new(ffprobe);
    command
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-of",
            "json",
            "-show_entries",
            &SHOW_ENTRIES,
        ])
        .arg(input)
        // FFREPORT would make ffprobe write a log file into its working directory.
        .env_remove("FFREPORT")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(crate::error::Error::FfprobeLaunch)?;
    let mut stdout = child
        .stdout
        .take()
        .expect("stdout is piped")
        .take(MAX_STDOUT + 1);
    let mut stderr = child
        .stderr
        .take()
        .expect("stderr is piped")
        .take(MAX_STDERR);
    let run = async {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let (read_out, read_err) =
            tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err),);
        read_out?;
        read_err?;
        if out.len() as u64 > MAX_STDOUT {
            return Ok(None);
        }
        Ok::<_, std::io::Error>(Some((child.wait().await?, out, err)))
    };
    let (status, out, err) = match tokio::time::timeout(TIMEOUT, run).await {
        Err(_) => return Err(crate::error::Error::Ffprobe("timed out".to_owned())),
        Ok(Err(e)) => return Err(crate::error::Error::Ffprobe(e.to_string())),
        Ok(Ok(None)) => return Err(crate::error::Error::Ffprobe("output too large".to_owned())),
        Ok(Ok(Some(output))) => output,
    };
    if !status.success() {
        return Err(crate::error::Error::Ffprobe(format!(
            "{status}: {}",
            String::from_utf8_lossy(&err).trim()
        )));
    }
    parse_output(&out).map_err(|e| crate::error::Error::Ffprobe(format!("unreadable output: {e}")))
}

#[derive(serde::Deserialize)]
struct Output {
    format: Option<Format>,
}

#[derive(serde::Deserialize)]
struct Format {
    duration: Option<String>,
    #[serde(default)]
    tags: std::collections::HashMap<String, serde_json::Value>,
}

pub fn parse_output(json: &[u8]) -> crate::error::Result<Probe> {
    let output: Output = serde_json::from_slice(json)?;
    let Some(format) = output.format else {
        return Ok(Probe::default());
    };
    let tags: std::collections::HashMap<String, String> = format
        .tags
        .into_iter()
        .filter_map(|(key, value)| match value {
            serde_json::Value::String(text) => Some((key.to_lowercase(), text)),
            _ => None,
        })
        .collect();
    let tag = |keys: &[&str]| {
        keys.iter()
            .filter_map(|key| tags.get(*key))
            .map(|value| value.trim())
            .find(|value| !value.is_empty())
            .map(str::to_owned)
    };
    Ok(Probe {
        duration_ms: format
            .duration
            .and_then(|d| d.trim().parse::<f64>().ok())
            .filter(|d| d.is_finite() && *d > 0.0)
            .map(|d| (d * 1000.0).round() as i64),
        title: tag(&["title"]),
        artist: tag(&["artist"]),
        album_artist: tag(&["album_artist", "albumartist", "album artist"]),
        album: tag(&["album"]),
        isrc: tag(&["isrc", MORA_ISRC]),
        mora_label_code: tag(&[MORA_LABEL_CODE]),
        mora_package_id: tag(&[MORA_PACKAGE_ID]),
        mora_material_no: tag(&[MORA_MATERIAL_NO]),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_tags_case_insensitively() {
        let json = r#"{
            "format": {
                "duration": "261.959000",
                "tags": {
                    "TITLE": "歩拾道",
                    "Artist": "Someone",
                    "ALBUM_ARTIST": "Various",
                    "album": "Album",
                    "LYRICS": "never kept",
                    "COMMENT": "Visit https://example.bandcamp.com",
                    "45B1D925-1448-5784-B4DA-B89901050A13": "10006001",
                    "8e90f26b-372a-5c8c-bb05-1ec0f36ee60c": "PKG_hires",
                    "be242671-3d48-5ac8-b762-7d2db4f584b8": "35843225",
                    "93a74bea-ce97-5571-a56a-c5084dba9873": " JPR562400335 "
                }
            }
        }"#;
        let probe = crate::sources::ffprobe::parse_output(json.as_bytes()).unwrap();
        assert_eq!(
            probe,
            crate::sources::ffprobe::Probe {
                duration_ms: Some(261959),
                title: Some("歩拾道".to_owned()),
                artist: Some("Someone".to_owned()),
                album_artist: Some("Various".to_owned()),
                album: Some("Album".to_owned()),
                isrc: Some("JPR562400335".to_owned()),
                mora_label_code: Some("10006001".to_owned()),
                mora_package_id: Some("PKG_hires".to_owned()),
                mora_material_no: Some("35843225".to_owned()),
            }
        );
    }

    #[test]
    fn tolerates_missing_format() {
        let probe = crate::sources::ffprobe::parse_output(b"{}").unwrap();
        assert_eq!(probe, crate::sources::ffprobe::Probe::default());
    }
}
