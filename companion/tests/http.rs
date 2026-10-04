const ORIGIN: &str = "https://app.example";
const HOST: &str = "127.0.0.1:47611";
const TOKEN: &str = "test-token";

fn config(sources: serde_json::Value) -> ssc_companion::config::Config {
    let config: ssc_companion::config::Config = serde_json::from_value(serde_json::json!({
        "listen": HOST,
        "allowedOrigins": [ORIGIN],
        "sources": sources,
        "itunesLookup": { "enabled": false },
    }))
    .unwrap();
    config.validate().unwrap();
    config
}

fn state_with(
    index: Option<ssc_companion::index::Index>,
) -> std::sync::Arc<ssc_companion::state::AppState> {
    let state = ssc_companion::state::AppState::new(
        &config(
            serde_json::json!([{ "id": "itunes", "type": "itunes-xml", "path": "unused.xml" }]),
        ),
        TOKEN.to_owned(),
    );
    if let Some(index) = index {
        state.publish(std::sync::Arc::new(index));
    }
    std::sync::Arc::new(state)
}

fn lemon_index() -> ssc_companion::index::Index {
    ssc_companion::index::Index::build(vec![ssc_companion::index::EntryInput {
        source: "itunes".to_owned(),
        source_label: "iTunes".to_owned(),
        id: "AAAA000000000001".to_owned(),
        tags: ssc_companion::index::TagNames {
            title: "Lemon".to_owned(),
            artist: Some("米津玄師".to_owned()),
            album_artist: None,
            album: Some("Lemon".to_owned()),
        },
        store: None,
        duration_ms: Some(255_000),
        ownership: ssc_companion::protocol::Ownership::Purchased,
        format: "AAC".to_owned(),
        cloud_only: false,
        ids: Default::default(),
    }])
}

fn request(method: &str, uri: &str) -> axum::http::request::Builder {
    axum::http::Request::builder()
        .method(method)
        .uri(uri)
        .header("host", HOST)
        .header("origin", ORIGIN)
}

fn authorized(method: &str, uri: &str) -> axum::http::request::Builder {
    request(method, uri).header("authorization", format!("Bearer {TOKEN}"))
}

struct Reply {
    status: axum::http::StatusCode,
    headers: axum::http::HeaderMap,
    body: String,
}

impl Reply {
    fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap()
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(|v| v.to_str().unwrap())
    }
}

async fn send(
    state: &std::sync::Arc<ssc_companion::state::AppState>,
    request: axum::http::Request<axum::body::Body>,
) -> Reply {
    use tower::ServiceExt as _;
    let response = ssc_companion::server::router(state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = http_body_util::BodyExt::collect(response.into_body())
        .await
        .unwrap()
        .to_bytes();
    Reply {
        status,
        headers,
        body: String::from_utf8(bytes.to_vec()).unwrap(),
    }
}

fn match_body(tracks: serde_json::Value) -> axum::body::Body {
    axum::body::Body::from(serde_json::json!({ "protocol": 1, "tracks": tracks }).to_string())
}

#[tokio::test]
async fn preflight_answers_cors_and_private_network() {
    let state = state_with(None);
    let reply = send(
        &state,
        request("OPTIONS", "/v1/match")
            .header("access-control-request-method", "POST")
            .header(
                "access-control-request-headers",
                "authorization, content-type",
            )
            .header("access-control-request-private-network", "true")
            .body(axum::body::Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(reply.status, axum::http::StatusCode::NO_CONTENT);
    assert_eq!(reply.header("access-control-allow-origin"), Some(ORIGIN));
    assert_eq!(
        reply.header("access-control-allow-methods"),
        Some("GET, POST")
    );
    assert_eq!(
        reply.header("access-control-allow-headers"),
        Some("Authorization, Content-Type")
    );
    assert_eq!(
        reply.header("access-control-allow-private-network"),
        Some("true")
    );

    let reply = send(
        &state,
        request("OPTIONS", "/v1/status")
            .header("access-control-request-method", "GET")
            .body(axum::body::Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(reply.status, axum::http::StatusCode::NO_CONTENT);
    assert_eq!(reply.header("access-control-allow-private-network"), None);
}

#[tokio::test]
async fn rejects_unknown_origin_and_host_without_cors() {
    let state = state_with(Some(lemon_index()));
    for builder in [
        axum::http::Request::builder()
            .uri("/v1/status")
            .header("host", HOST)
            .header("origin", "https://evil.example")
            .header("authorization", format!("Bearer {TOKEN}")),
        authorized("GET", "/v1/status").header("origin", "https://evil.example"),
        axum::http::Request::builder()
            .uri("/v1/status")
            .header("host", HOST)
            .header("authorization", format!("Bearer {TOKEN}")),
        axum::http::Request::builder()
            .uri("/v1/status")
            .header("host", "evil.example:47611")
            .header("origin", ORIGIN)
            .header("authorization", format!("Bearer {TOKEN}")),
    ] {
        let reply = send(&state, builder.body(axum::body::Body::empty()).unwrap()).await;
        assert_eq!(reply.status, axum::http::StatusCode::FORBIDDEN);
        assert_eq!(reply.json()["code"], "origin_not_allowed");
        assert_eq!(reply.header("access-control-allow-origin"), None);
    }
}

#[tokio::test]
async fn requires_the_pairing_token() {
    let state = state_with(Some(lemon_index()));
    for builder in [
        request("GET", "/v1/status"),
        request("GET", "/v1/status").header("authorization", "Bearer wrong"),
        request("GET", "/v1/status").header("authorization", format!("Basic {TOKEN}")),
    ] {
        let reply = send(&state, builder.body(axum::body::Body::empty()).unwrap()).await;
        assert_eq!(reply.status, axum::http::StatusCode::UNAUTHORIZED);
        assert_eq!(
            reply.json(),
            serde_json::json!({ "protocol": 1, "code": "unpaired" })
        );
        assert_eq!(reply.header("access-control-allow-origin"), Some(ORIGIN));
    }
}

#[tokio::test]
async fn status_reports_sources_and_revision() {
    let state = state_with(Some(lemon_index()));
    let reply = send(
        &state,
        authorized("GET", "/v1/status")
            .body(axum::body::Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(reply.status, axum::http::StatusCode::OK);
    assert_eq!(reply.header("access-control-allow-origin"), Some(ORIGIN));
    assert_eq!(reply.header("vary"), Some("Origin"));
    let status = reply.json();
    assert_eq!(status["protocols"], serde_json::json!([1]));
    assert_eq!(status["libraryRevision"].as_str().unwrap().len(), 16);
    assert_eq!(status["sources"][0]["id"], "itunes");
    assert_eq!(status["sources"][0]["entries"], 1);
    assert!(
        !status["capabilities"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("store-metadata"))
    );
}

#[tokio::test]
async fn match_errors_carry_cors() {
    let state = state_with(None);
    let reply = send(
        &state,
        authorized("POST", "/v1/match")
            .body(match_body(serde_json::json!([])))
            .unwrap(),
    )
    .await;
    assert_eq!(reply.status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(reply.json()["code"], "indexing");
    assert_eq!(reply.header("access-control-allow-origin"), Some(ORIGIN));

    let state = state_with(Some(lemon_index()));
    let reply = send(
        &state,
        authorized("POST", "/v1/match")
            .body(axum::body::Body::from(r#"{"protocol": 2, "tracks": []}"#))
            .unwrap(),
    )
    .await;
    assert_eq!(reply.status, axum::http::StatusCode::CONFLICT);
    assert_eq!(reply.json()["code"], "protocol_mismatch");
    assert_eq!(reply.header("access-control-allow-origin"), Some(ORIGIN));

    let tracks: Vec<serde_json::Value> = (0..501)
        .map(|i| serde_json::json!({ "key": format!("k{i}"), "title": "x", "artists": [], "album": { "title": "" } }))
        .collect();
    let reply = send(
        &state,
        authorized("POST", "/v1/match")
            .body(match_body(serde_json::Value::Array(tracks)))
            .unwrap(),
    )
    .await;
    assert_eq!(reply.status, axum::http::StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(reply.json()["code"], "too_many_tracks");

    let reply = send(
        &state,
        authorized("POST", "/v1/match")
            .body(axum::body::Body::from("{not json"))
            .unwrap(),
    )
    .await;
    assert_eq!(reply.status, axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(reply.json()["code"], "bad_request");

    let reply = send(
        &state,
        authorized("GET", "/v1/nope")
            .body(axum::body::Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(reply.status, axum::http::StatusCode::NOT_FOUND);
    assert_eq!(reply.header("access-control-allow-origin"), Some(ORIGIN));
}

#[tokio::test]
async fn match_returns_results_in_request_order() {
    let state = state_with(Some(lemon_index()));
    let reply = send(
        &state,
        authorized("POST", "/v1/match")
            .header("content-type", "application/json")
            .body(match_body(serde_json::json!([
                { "key": "spotify:track:2", "title": "Unknown Song", "artists": ["Nobody"], "album": { "id": null, "title": "X", "artists": [], "totalTracks": 1 }, "durationMs": 1000, "isrc": null, "trackNumber": 1, "discNumber": 1 },
                { "key": "spotify:track:1", "title": "Lemon", "artists": ["米津玄師"], "album": { "id": "a", "title": "Lemon", "artists": ["米津玄師"], "totalTracks": 2 }, "durationMs": 255500, "isrc": "JPU901800047", "trackNumber": 1, "discNumber": 1, "unknownField": true }
            ])))
            .unwrap(),
    )
    .await;
    assert_eq!(reply.status, axum::http::StatusCode::OK);
    let body = reply.json();
    assert_eq!(body["protocol"], 1);
    let results = body["results"].as_array().unwrap();
    assert_eq!(results[0]["key"], "spotify:track:2");
    assert_eq!(results[0]["verdict"], "absent");
    assert_eq!(results[0]["matches"], serde_json::json!([]));
    assert_eq!(results[1]["verdict"], "owned");
    assert_eq!(results[1]["matchedBy"], "metadata");
    let local = &results[1]["matches"][0];
    assert_eq!(local["location"], "iTunes · 米津玄師 / Lemon");
    assert_eq!(local["ownership"], "purchased");
    assert_eq!(local["metadataSource"], "tags");
    assert_eq!(local["signals"]["durationDeltaMs"], 500);
    assert_eq!(local["signals"]["isrc"], serde_json::Value::Null);
}

fn mp4_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    out
}

fn synthetic_m4a(isrc: &str) -> Vec<u8> {
    let mut data = 1u32.to_be_bytes().to_vec();
    data.extend_from_slice(&[0; 4]);
    data.extend_from_slice(format!("Label:isrc:{isrc}").as_bytes());
    let ilst = mp4_box(b"ilst", &mp4_box(b"xid ", &mp4_box(b"data", &data)));
    let mut meta = vec![0; 4];
    meta.extend(ilst);
    mp4_box(b"moov", &mp4_box(b"udta", &mp4_box(b"meta", &meta)))
}

fn riff_chunk(id: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = id.to_vec();
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    if body.len() % 2 == 1 {
        out.push(0);
    }
    out
}

/// One second of 8 kHz mono silence with RIFF INFO title, artist and album.
fn synthetic_wav(title: &str, artist: &str, album: &str) -> Vec<u8> {
    let mut fmt = Vec::new();
    fmt.extend_from_slice(&1u16.to_le_bytes());
    fmt.extend_from_slice(&1u16.to_le_bytes());
    fmt.extend_from_slice(&8000u32.to_le_bytes());
    fmt.extend_from_slice(&16000u32.to_le_bytes());
    fmt.extend_from_slice(&2u16.to_le_bytes());
    fmt.extend_from_slice(&16u16.to_le_bytes());
    let mut info = b"INFO".to_vec();
    for (id, value) in [(b"INAM", title), (b"IART", artist), (b"IPRD", album)] {
        let mut text = value.as_bytes().to_vec();
        text.push(0);
        info.extend(riff_chunk(id, &text));
    }
    let mut wave = b"WAVE".to_vec();
    wave.extend(riff_chunk(b"fmt ", &fmt));
    wave.extend(riff_chunk(b"LIST", &info));
    wave.extend(riff_chunk(b"data", &vec![0; 16000]));
    riff_chunk(b"RIFF", &wave)
}

fn ffprobe_available() -> bool {
    std::process::Command::new("ffprobe")
        .arg("-version")
        .output()
        .is_ok_and(|o| o.status.success())
}

#[tokio::test]
async fn responses_never_contain_local_paths() {
    if !ffprobe_available() {
        eprintln!("skipping: ffprobe is not on PATH");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let m4a = root
        .join("iTunes Media")
        .join("Secret Folder")
        .join("01 Hidden Name.m4a");
    std::fs::create_dir_all(m4a.parent().unwrap()).unwrap();
    std::fs::write(&m4a, synthetic_m4a("JPAB01234567")).unwrap();
    let location = url::Url::from_file_path(&m4a).unwrap();
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Tracks</key><dict>
<key>1</key><dict><key>Track ID</key><integer>1</integer><key>Name</key><string>Kiss Kitsune</string>
<key>Artist</key><string>HIMEHINA</string><key>Album</key><string>Bubblin</string>
<key>Kind</key><string>Purchased AAC audio file</string><key>Total Time</key><integer>200000</integer>
<key>Persistent ID</key><string>AAAA000000000001</string><key>Location</key><string>{location}</string></dict>
</dict></dict></plist>"#
    );
    let xml_path = root.join("iTunes Library.xml");
    std::fs::write(&xml_path, xml).unwrap();
    let flat = root.join("flat");
    let wav = flat.join("Private Dir").join("02 Hidden Track.wav");
    std::fs::create_dir_all(wav.parent().unwrap()).unwrap();
    std::fs::write(
        &wav,
        synthetic_wav("Folder Song", "Folder Artist", "Folder Album"),
    )
    .unwrap();

    let config = std::sync::Arc::new(config(serde_json::json!([
        { "id": "itunes", "label": "iTunes", "type": "itunes-xml", "path": xml_path },
        { "id": "flat", "label": "Folder", "type": "directory", "path": flat, "extensions": ["wav"] },
    ])));
    let state = std::sync::Arc::new(ssc_companion::state::AppState::new(
        &config,
        TOKEN.to_owned(),
    ));
    let db = ssc_companion::db::Db::open_in_memory().await.unwrap();
    let mut indexer =
        ssc_companion::indexer::Indexer::new(config.clone(), db, state.clone(), [7; 32]).unwrap();
    indexer.cycle(false).await.unwrap();

    let status = send(
        &state,
        authorized("GET", "/v1/status")
            .body(axum::body::Body::empty())
            .unwrap(),
    )
    .await;
    let matched = send(
        &state,
        authorized("POST", "/v1/match")
            .body(match_body(serde_json::json!([
                { "key": "a", "title": "キスキツネ", "artists": ["HIMEHINA"], "album": { "title": "キスキツネ" }, "durationMs": 200000, "isrc": "JPAB01234567" },
                { "key": "b", "title": "Folder Song", "artists": ["Folder Artist"], "album": { "title": "Folder Album" }, "durationMs": 1000 },
            ])))
            .unwrap(),
    )
    .await;
    assert_eq!(matched.status, axum::http::StatusCode::OK);
    let body = matched.json();
    assert_eq!(body["results"][0]["verdict"], "owned");
    assert_eq!(body["results"][0]["matchedBy"], "isrc");
    assert_eq!(body["results"][1]["verdict"], "owned");
    let flat_match = &body["results"][1]["matches"][0];
    assert_eq!(flat_match["ownership"], "flat");
    assert_eq!(flat_match["format"], "WAV");
    assert_eq!(
        flat_match["location"],
        "Folder · Folder Artist / Folder Album"
    );
    assert_eq!(flat_match["durationMs"], 1000);

    let root_text = root.to_string_lossy().into_owned();
    for text in [&status.body, &matched.body] {
        for needle in [
            root_text.as_str(),
            &root_text.replace('\\', "\\\\"),
            &root_text.replace('\\', "/"),
            "Secret Folder",
            "Hidden Name",
            "Private Dir",
            "Hidden Track",
            ".m4a",
            ".wav",
            "\\\\",
            ":/",
        ] {
            assert!(!text.contains(needle), "{needle:?} leaked in {text}");
        }
    }
}
