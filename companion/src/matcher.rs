//! Matches Spotify tracks against the index. The verdict thresholds are the contract in
//! docs/companion.md ("Matching").

const MAX_GRAM_CANDIDATES: usize = 200;
const MAX_MATCHES: usize = 3;
// Matching cost grows with text length; real Spotify names are far shorter.
const MAX_TEXT_CHARS: usize = 512;
const MAX_ARTISTS: usize = 16;
const MAX_QUERY_GRAMS: usize = 256;

static CV_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(?i)^(.*?)\s*[(\[]\s*(?:cv[.:：]?\s*)?(.*?)\s*[)\]]\s*$").unwrap()
});
static STARRING_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^(.*?)\s+starring\s+(.*)$").unwrap());

/// Expands an artist credit into the names it mentions: list members, `キャラ (CV:声優)` as both
/// names, and `X starring Y` as both names. The raw credit comes first.
pub fn credit_variants(raw: &str) -> Vec<String> {
    let mut out = vec![raw.to_owned()];
    let mut add = |value: &str| {
        if !value.is_empty() && !out.iter().any(|v| v == value) {
            out.push(value.to_owned());
        }
    };
    let text = crate::normalize::nfkc(raw);
    for part in crate::normalize::split_credits(&text) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        add(part);
        for re in [&*CV_RE, &*STARRING_RE] {
            if let Some(caps) = re.captures(part) {
                add(&caps[1]);
                add(&caps[2]);
            }
        }
    }
    out
}

struct TrackKeys {
    title: crate::normalize::TitleKey,
    artists: Vec<crate::normalize::ArtistKey>,
    variant_norms: std::collections::HashSet<String>,
    album: crate::normalize::TitleKey,
    isrc: Option<String>,
    duration_ms: Option<i64>,
}

impl TrackKeys {
    fn new(track: &crate::protocol::MatchTrack) -> Self {
        let artists: Vec<String> = track
            .artists
            .iter()
            .take(MAX_ARTISTS)
            .map(|a| bounded(a))
            .collect();
        Self {
            title: crate::normalize::TitleKey::new(&bounded(&track.title)),
            artists: artists
                .iter()
                .map(|a| crate::normalize::ArtistKey::new(a))
                .collect(),
            variant_norms: artists
                .iter()
                .flat_map(|a| credit_variants(a))
                .map(|v| crate::normalize::norm(&v))
                .filter(|n| !n.is_empty())
                .collect(),
            album: crate::normalize::TitleKey::new(&bounded(&track.album.title)),
            isrc: track
                .isrc
                .as_deref()
                .map(clip)
                .and_then(crate::index::normalize_isrc),
            duration_ms: track.duration_ms,
        }
    }
}

fn clip(text: &str) -> &str {
    match text.char_indices().nth(MAX_TEXT_CHARS) {
        Some((end, _)) => &text[..end],
        None => text,
    }
}

/// NFKC-normalized and clipped, so characters that expand under NFKC can't exceed the limit.
fn bounded(text: &str) -> String {
    clip(&crate::normalize::nfkc(clip(text))).to_owned()
}

#[derive(Debug, Clone, Copy)]
struct Scored {
    entry: u32,
    name: usize,
    score: f64,
    title: f64,
    artist: f64,
    album: Option<f64>,
}

pub fn match_tracks(
    index: &crate::index::Index,
    tracks: &[crate::protocol::MatchTrack],
) -> Vec<crate::protocol::MatchResult> {
    tracks.iter().map(|t| match_track(index, t)).collect()
}

pub fn match_track(
    index: &crate::index::Index,
    track: &crate::protocol::MatchTrack,
) -> crate::protocol::MatchResult {
    let keys = TrackKeys::new(track);
    let isrc_hits: &[u32] = keys
        .isrc
        .as_ref()
        .and_then(|isrc| index.isrc_index.get(isrc))
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut scored: Vec<Scored> = candidates(index, &keys, isrc_hits)
        .into_iter()
        .map(|i| score(&keys, &index.entries[i as usize], i))
        .collect();
    scored.sort_by(|a, b| b.score.total_cmp(&a.score));

    let entry = |s: &Scored| &index.entries[s.entry as usize];
    let owns = |s: &Scored| entry(s).ownership != crate::protocol::Ownership::AppleMusic;
    let delta = |s: &Scored| Some(keys.duration_ms? - entry(s).duration_ms?);

    // The first rule that applies decides; its entry leads `matches`.
    let decision = scored
        .iter()
        .position(|s| owns(s) && isrc_hits.contains(&s.entry))
        .map(|p| {
            (
                crate::protocol::Verdict::Owned,
                crate::protocol::MatchedBy::Isrc,
                p,
            )
        })
        .or_else(|| {
            scored
                .iter()
                .position(|s| {
                    owns(s)
                        && s.title >= 0.92
                        && s.artist >= 0.8
                        && s.album.unwrap_or(0.0) >= 0.8
                        && delta(s).is_none_or(|d| d.abs() <= 3000)
                })
                .map(|p| {
                    (
                        crate::protocol::Verdict::Owned,
                        crate::protocol::MatchedBy::Metadata,
                        p,
                    )
                })
        })
        .or_else(|| {
            scored
                .first()
                .filter(|s| s.title >= 0.85 && s.artist >= 0.5)
                .map(|_| {
                    (
                        crate::protocol::Verdict::Probable,
                        crate::protocol::MatchedBy::Metadata,
                        0,
                    )
                })
        })
        .or_else(|| {
            scored
                .iter()
                .position(|s| s.title >= 0.92 && delta(s).is_some_and(|d| d.abs() <= 1500))
                .map(|p| {
                    (
                        crate::protocol::Verdict::Probable,
                        crate::protocol::MatchedBy::Metadata,
                        p,
                    )
                })
        });

    let Some((verdict, matched_by, deciding)) = decision else {
        return crate::protocol::MatchResult {
            key: track.key.clone(),
            verdict: crate::protocol::Verdict::Absent,
            score: scored.first().map(|s| round3(s.score)).unwrap_or(0.0),
            matched_by: None,
            matches: Vec::new(),
        };
    };
    let first = scored[deciding];
    let matches = std::iter::once(first)
        .chain(
            scored
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != deciding)
                .map(|(_, s)| *s),
        )
        .take(MAX_MATCHES)
        .map(|s| local_match(&keys, entry(&s), &s))
        .collect();
    crate::protocol::MatchResult {
        key: track.key.clone(),
        verdict,
        score: round3(first.score),
        matched_by: Some(matched_by),
        matches,
    }
}

/// Exact title-key hits, then the top entries by title-bigram overlap, then ISRC hits.
fn candidates(index: &crate::index::Index, keys: &TrackKeys, isrc_hits: &[u32]) -> Vec<u32> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for key in [&keys.title.full, &keys.title.base] {
        if key.is_empty() {
            continue;
        }
        for &i in index
            .key_index
            .get(key)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            if seen.insert(i) {
                out.push(i);
            }
        }
    }

    let compact: Vec<char> = keys
        .title
        .full
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let mut position: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    let mut overlap: Vec<(u32, u32)> = Vec::new();
    let mut grams = std::collections::HashSet::new();
    for pair in compact.windows(2) {
        // Each distinct bigram walks its posting list once.
        if !grams.insert((pair[0], pair[1])) {
            continue;
        }
        if grams.len() > MAX_QUERY_GRAMS {
            break;
        }
        let Some(list) = index.gram_index.get(&(pair[0], pair[1])) else {
            continue;
        };
        for &i in list {
            match position.get(&i) {
                Some(&p) => overlap[p].1 += 1,
                None => {
                    position.insert(i, overlap.len());
                    overlap.push((i, 1));
                }
            }
        }
    }
    overlap.sort_by_key(|&(_, count)| std::cmp::Reverse(count));
    for (i, _) in overlap.into_iter().take(MAX_GRAM_CANDIDATES) {
        if seen.insert(i) {
            out.push(i);
        }
    }

    for &i in isrc_hits {
        if seen.insert(i) {
            out.push(i);
        }
    }
    out
}

/// Scores every name set of an entry; the best one wins.
fn score(keys: &TrackKeys, entry: &crate::index::Entry, i: u32) -> Scored {
    let mut best: Option<Scored> = None;
    for (n, names) in entry.names.iter().enumerate() {
        let title = keys.title.similarity(&names.title_key);
        let exact_credit = names
            .artist_keys
            .iter()
            .any(|a| keys.variant_norms.contains(&a.norm));
        let artist = if exact_credit {
            1.0
        } else {
            names
                .artist_keys
                .iter()
                .map(|a| a.similarity(&keys.artists))
                .fold(0.0, f64::max)
        };
        let album = names.album_key.as_ref().map(|k| keys.album.similarity(k));
        let score = 0.6 * title + 0.3 * artist + 0.1 * album.unwrap_or(0.5);
        if best.is_none_or(|b| score > b.score) {
            best = Some(Scored {
                entry: i,
                name: n,
                score,
                title,
                artist,
                album,
            });
        }
    }
    best.expect("every entry has a tag name set")
}

fn local_match(
    keys: &TrackKeys,
    entry: &crate::index::Entry,
    s: &Scored,
) -> crate::protocol::LocalMatch {
    let names = &entry.names[s.name];
    let entry_isrc = entry
        .ids
        .isrc
        .as_deref()
        .and_then(crate::index::normalize_isrc);
    crate::protocol::LocalMatch {
        source: entry.source.clone(),
        id: entry.id.clone(),
        title: names.title.clone(),
        artists: names.artists.clone(),
        album: names.album.clone(),
        duration_ms: entry.duration_ms,
        ownership: entry.ownership,
        format: entry.format.clone(),
        cloud_only: entry.cloud_only,
        location: entry.location.clone(),
        metadata_source: names.via,
        ids: entry.ids.clone(),
        score: round3(s.score),
        signals: crate::protocol::Signals {
            title: round3(s.title),
            artist: round3(s.artist),
            album: s.album.map(round3),
            duration_delta_ms: keys
                .duration_ms
                .zip(entry.duration_ms)
                .map(|(spotify, local)| spotify - local),
            isrc: keys.isrc.as_ref().zip(entry_isrc).map(|(a, b)| *a == b),
        },
    }
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    fn input(
        source: &str,
        id: &str,
        title: &str,
        artist: &str,
        album: &str,
    ) -> crate::index::EntryInput {
        crate::index::tests::input(source, id, title, artist, album)
    }

    fn track(title: &str, artists: &[&str], album: &str) -> crate::protocol::MatchTrack {
        crate::protocol::MatchTrack {
            key: format!("spotify:track:{title}"),
            title: title.to_owned(),
            artists: artists.iter().map(|a| (*a).to_owned()).collect(),
            album: crate::protocol::MatchAlbum {
                title: album.to_owned(),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn run(
        inputs: Vec<crate::index::EntryInput>,
        track: &crate::protocol::MatchTrack,
    ) -> crate::protocol::MatchResult {
        let index = crate::index::Index::build(inputs);
        crate::matcher::match_track(&index, track)
    }

    #[test]
    fn credit_variants_expand_cv_starring_and_lists() {
        assert_eq!(
            crate::matcher::credit_variants("カズサ(CV:夏吉ゆうこ)"),
            vec!["カズサ(CV:夏吉ゆうこ)", "カズサ", "夏吉ゆうこ"]
        );
        assert_eq!(
            crate::matcher::credit_variants("キャラ（CV：声優）, Other"),
            vec![
                "キャラ（CV：声優）, Other",
                "キャラ(CV:声優)",
                "キャラ",
                "声優",
                "Other"
            ]
        );
        assert_eq!(
            crate::matcher::credit_variants("Hero starring Actor"),
            vec!["Hero starring Actor", "Hero", "Actor"]
        );
        assert_eq!(
            crate::matcher::credit_variants("A feat. B"),
            vec!["A feat. B", "A", "B"]
        );
    }

    #[test]
    fn owned_by_metadata() {
        let result = run(
            vec![input("itunes", "A", "Lemon", "米津玄師", "Lemon")],
            &track("Lemon", &["米津玄師"], "Lemon"),
        );
        assert_eq!(result.verdict, crate::protocol::Verdict::Owned);
        assert_eq!(
            result.matched_by,
            Some(crate::protocol::MatchedBy::Metadata)
        );
        assert_eq!(result.matches[0].id, "A");
        assert_eq!(result.score, 1.0);
    }

    #[test]
    fn store_names_match_romanized_tags() {
        let mut entry = input(
            "itunes",
            "A",
            "Umibede Aimashou",
            "Mikako Komatsu",
            "Umibede Aimashou - Single",
        );
        entry.store = Some(crate::index::StoreNames {
            title: "海辺で逢いましょう".to_owned(),
            artist: Some("小松未可子".to_owned()),
            collection_artist: None,
            album: Some("海辺で逢いましょう - Single".to_owned()),
        });
        let result = run(
            vec![entry],
            &track("海辺で逢いましょう", &["小松未可子"], "海辺で逢いましょう"),
        );
        assert_eq!(result.verdict, crate::protocol::Verdict::Owned);
        assert_eq!(
            result.matches[0].metadata_source,
            crate::protocol::MetadataSource::ItunesStore
        );
        assert_eq!(result.matches[0].title, "海辺で逢いましょう");
    }

    #[test]
    fn character_credits_match_voice_actors() {
        let result = run(
            vec![input("itunes", "A", "Song", "夏吉ゆうこ", "Album")],
            &track("Song", &["カズサ(CV:夏吉ゆうこ)"], "Album"),
        );
        assert_eq!(result.verdict, crate::protocol::Verdict::Owned);
        assert_eq!(result.matches[0].signals.artist, 1.0);
    }

    #[test]
    fn owned_by_isrc_ignoring_case_and_whitespace() {
        let mut entry = input("itunes", "A", "Kiss Kitsune", "HIMEHINA", "Bubblin");
        entry.ids.isrc = Some("JPAB01234567".to_owned());
        let mut other = input("itunes", "B", "キスキツネ", "Someone Else", "Other");
        other.ids.isrc = Some("JPZZ99999999".to_owned());
        let mut spotify = track("キスキツネ", &["HIMEHINA"], "キスキツネ");
        spotify.isrc = Some(" jpab01234567 ".to_owned());
        let result = run(vec![entry, other], &spotify);
        assert_eq!(result.verdict, crate::protocol::Verdict::Owned);
        assert_eq!(result.matched_by, Some(crate::protocol::MatchedBy::Isrc));
        assert_eq!(result.matches[0].id, "A");
        assert_eq!(result.matches[0].signals.isrc, Some(true));
        assert_eq!(result.matches[1].signals.isrc, Some(false));
    }

    #[test]
    fn apple_music_never_owns() {
        let mut subscription = input("itunes", "A", "Lemon", "米津玄師", "Lemon");
        subscription.ownership = crate::protocol::Ownership::AppleMusic;
        subscription.ids.isrc = Some("JPAB01234567".to_owned());
        let mut spotify = track("Lemon", &["米津玄師"], "Lemon");
        spotify.isrc = Some("JPAB01234567".to_owned());
        let result = run(vec![subscription.clone()], &spotify);
        assert_eq!(result.verdict, crate::protocol::Verdict::Probable);
        assert_eq!(
            result.matches[0].ownership,
            crate::protocol::Ownership::AppleMusic
        );

        let mut purchased = input("itunes", "B", "Lemon", "米津玄師", "Lemon - Single");
        purchased.ownership = crate::protocol::Ownership::Purchased;
        let result = run(vec![subscription, purchased], &spotify);
        assert_eq!(result.verdict, crate::protocol::Verdict::Owned);
        assert_eq!(
            result.matched_by,
            Some(crate::protocol::MatchedBy::Metadata)
        );
        assert_eq!(result.matches[0].id, "B");
    }

    #[test]
    fn duration_guard_blocks_owned() {
        let mut entry = input("itunes", "A", "Lemon", "米津玄師", "Lemon");
        entry.duration_ms = Some(240_000);
        let mut spotify = track("Lemon", &["米津玄師"], "Lemon");
        spotify.duration_ms = Some(245_000);
        let result = run(vec![entry.clone()], &spotify);
        assert_eq!(result.verdict, crate::protocol::Verdict::Probable);
        assert_eq!(result.matches[0].signals.duration_delta_ms, Some(5000));

        spotify.duration_ms = Some(242_500);
        assert_eq!(
            run(vec![entry], &spotify).verdict,
            crate::protocol::Verdict::Owned
        );
    }

    #[test]
    fn duration_alone_makes_probable() {
        let mut entry = input(
            "itunes",
            "A",
            "Happy Funny Lucky",
            "illumination STARS",
            "Happy Funny Lucky - Single",
        );
        entry.duration_ms = Some(200_000);
        let mut spotify = track(
            "Happy Funny Lucky",
            &["イルミネーションスターズ"],
            "WING 02",
        );
        spotify.duration_ms = Some(200_900);
        let result = run(vec![entry.clone()], &spotify);
        assert_eq!(result.verdict, crate::protocol::Verdict::Probable);
        assert_eq!(result.matches[0].signals.artist, 0.0);

        spotify.duration_ms = Some(202_000);
        let result = run(vec![entry], &spotify);
        assert_eq!(result.verdict, crate::protocol::Verdict::Absent);
        assert!(result.matches.is_empty());
    }

    #[test]
    fn absent_when_nothing_matches() {
        let result = run(
            vec![input(
                "itunes",
                "A",
                "STRAY SHEEP",
                "米津玄師",
                "STRAY SHEEP",
            )],
            &track("Lemon", &["Someone"], "Lemon"),
        );
        assert_eq!(result.verdict, crate::protocol::Verdict::Absent);
        assert_eq!(result.matched_by, None);
    }

    #[test]
    fn clips_oversized_text() {
        let long = "あ".repeat(100_000);
        assert_eq!(crate::matcher::clip(&long).chars().count(), 512);
        assert_eq!(crate::matcher::clip("Lemon"), "Lemon");
        // U+FDFA expands to 18 characters under NFKC.
        let expanding = "\u{FDFA}".repeat(512);
        assert_eq!(crate::matcher::bounded(&expanding).chars().count(), 512);
        let result = run(
            vec![input("itunes", "A", "Lemon", "米津玄師", "Lemon")],
            &track(&long, &[long.as_str()], &long),
        );
        assert_eq!(result.verdict, crate::protocol::Verdict::Absent);
    }

    #[test]
    fn at_most_three_matches_with_the_deciding_entry_first() {
        let inputs = (0..5)
            .map(|i| input("itunes", &format!("E{i}"), "Lemon", "米津玄師", "Lemon"))
            .collect();
        let result = run(inputs, &track("Lemon", &["米津玄師"], "Lemon"));
        assert_eq!(result.matches.len(), 3);
    }
}
