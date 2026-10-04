//! Port of src/worker/mora/normalize.ts without the kana path, since local entries carry no readings.
//! tests/normalize_parity.rs checks it against fixtures generated from the TypeScript source.
//! Strings are indexed by `char`, where the TypeScript uses UTF-16 units, so bigram scores differ
//! for text outside the BMP.

use unicode_normalization::UnicodeNormalization as _;

static FORMAT_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)hi-?res|ハイレゾ|high[- ]?resolution|[0-9]+(?:\.[0-9]+)?\s*k?hz|[0-9]+\s*bit|flac|lossless|ロスレス|dsd|dolby|atmos|spatial",
    )
    .unwrap()
});
static FEAT_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(?i)^(?:feat\.?|ft\.?|featuring|with)\s").unwrap()
});
// Version, mix, remix and live qualifiers identify different recordings and are deliberately kept.
static EDITION_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)remaster(?:ed)?|deluxe|edition|expanded|anniversary|bonus tracks?|special|complete|standard|limited|通常盤|限定盤|初回|生産|デラックス|リマスター|^(?:single|ep|album)$",
    )
    .unwrap()
});
static TIEUP_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)主題歌|挿入歌|イメージソング|テーマ|cm\s?ソング|タイアップ|オープニング|エンディング|^from\s",
    )
    .unwrap()
});
static DASH_TAIL_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"\s+-\s+").unwrap());
static WHITESPACE_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"\s+").unwrap());
static NON_WORD_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"[^\p{L}\p{N}]+").unwrap());
static VARIOUS_ARTISTS_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"^(?:various artists|v a|オムニバス|ヴァリアス アーティスト)$").unwrap()
});
static CREDIT_SEPARATOR_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(?i)\s*(?:[,、&×/]|\s(?:feat\.?|ft\.?|with|and|x|vs\.?)\s)\s*").unwrap()
});

fn closing_bracket(open: char) -> Option<char> {
    match open {
        '(' => Some(')'),
        '[' => Some(']'),
        '<' => Some('>'),
        '【' => Some('】'),
        '〔' => Some('〕'),
        '〈' => Some('〉'),
        '《' => Some('》'),
        '~' => Some('~'),
        _ => None,
    }
}

pub fn nfkc(text: &str) -> String {
    text.nfkc().collect()
}

fn split_title(title: &str) -> (String, Vec<String>) {
    let text: Vec<char> = nfkc(title).replace('〜', "~").chars().collect();
    let mut main = String::new();
    let mut segments = Vec::new();
    let mut i = 0;
    while i < text.len() {
        let ch = text[i];
        if let Some(close) = closing_bracket(ch)
            && let Some(offset) = text[i + 1..].iter().position(|&c| c == close)
        {
            let end = i + 1 + offset;
            segments.push(text[i + 1..end].iter().collect());
            main.push(' ');
            i = end + 1;
            continue;
        }
        main.push(ch);
        i += 1;
    }
    let mut parts = DASH_TAIL_RE.split(&main);
    let head = parts.next().unwrap_or_default().to_owned();
    segments.extend(parts.map(str::to_owned));
    (head, segments)
}

fn strip_segments(title: &str, patterns: &[&regex::Regex]) -> String {
    let (main, segments) = split_title(title);
    let kept = segments
        .iter()
        .filter(|segment| !patterns.iter().any(|p| p.is_match(segment.trim())));
    let joined = std::iter::once(main.as_str())
        .chain(kept.map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    let result = WHITESPACE_RE.replace_all(&joined, " ").trim().to_owned();
    if result.is_empty() {
        nfkc(title).trim().to_owned()
    } else {
        result
    }
}

pub fn norm(text: &str) -> String {
    NON_WORD_RE
        .replace_all(&nfkc(text).to_lowercase(), " ")
        .trim()
        .to_owned()
}

/// Drops format and featuring annotations only.
pub fn full_key(title: &str) -> String {
    norm(&strip_segments(title, &[&FORMAT_RE, &FEAT_RE]))
}

/// Also drops edition and tie-up annotations.
pub fn base_key(title: &str) -> String {
    norm(&strip_segments(
        title,
        &[&FORMAT_RE, &FEAT_RE, &EDITION_RE, &TIEUP_RE],
    ))
}

pub fn split_credits(text: &str) -> regex::Split<'_, '_> {
    CREDIT_SEPARATOR_RE.split(text)
}

/// Bigram multiset of a string with whitespace removed, for Sørensen–Dice similarity.
#[derive(Debug, Clone, Default)]
pub struct Grams {
    len: usize,
    short: Option<String>,
    sorted: Vec<(char, char)>,
}

impl Grams {
    pub fn new(text: &str) -> Self {
        let compact: Vec<char> = text.chars().filter(|c| !c.is_whitespace()).collect();
        let mut sorted: Vec<(char, char)> = compact.windows(2).map(|w| (w[0], w[1])).collect();
        sorted.sort_unstable();
        Self {
            len: compact.len(),
            short: (compact.len() < 2).then(|| compact.iter().collect()),
            sorted,
        }
    }

    pub fn dice(&self, other: &Self) -> f64 {
        if self.len < 2 || other.len < 2 {
            return if self.len > 0 && self.short.is_some() && self.short == other.short {
                1.0
            } else {
                0.0
            };
        }
        let (mut i, mut j, mut overlap) = (0, 0, 0usize);
        while i < self.sorted.len() && j < other.sorted.len() {
            match self.sorted[i].cmp(&other.sorted[j]) {
                std::cmp::Ordering::Less => i += 1,
                std::cmp::Ordering::Greater => j += 1,
                std::cmp::Ordering::Equal => {
                    overlap += 1;
                    i += 1;
                    j += 1;
                }
            }
        }
        (2 * overlap) as f64 / ((self.len - 1) + (other.len - 1)) as f64
    }

    /// Distinct bigrams, for building a posting index.
    pub fn distinct(&self) -> impl Iterator<Item = (char, char)> + '_ {
        let mut previous = None;
        self.sorted.iter().copied().filter(move |gram| {
            let fresh = previous != Some(*gram);
            previous = Some(*gram);
            fresh
        })
    }
}

pub fn dice(a: &str, b: &str) -> f64 {
    Grams::new(a).dice(&Grams::new(b))
}

/// `fullKey`/`baseKey` of a title with their bigrams, computed once per string.
#[derive(Debug, Clone)]
pub struct TitleKey {
    pub full: String,
    pub base: String,
    full_grams: Grams,
    base_grams: Grams,
}

impl TitleKey {
    pub fn new(title: &str) -> Self {
        let full = full_key(title);
        let base = base_key(title);
        Self {
            full_grams: Grams::new(&full),
            base_grams: Grams::new(&base),
            full,
            base,
        }
    }

    pub fn similarity(&self, other: &Self) -> f64 {
        if !self.full.is_empty() && self.full == other.full {
            return 1.0;
        }
        if !self.base.is_empty() && self.base == other.base {
            return 0.92;
        }
        f64::max(
            self.full_grams.dice(&other.full_grams),
            0.9 * self.base_grams.dice(&other.base_grams),
        )
    }
}

pub fn title_sim(a: &str, b: &str) -> f64 {
    TitleKey::new(a).similarity(&TitleKey::new(b))
}

/// An artist name prepared for `artistSim`, on either side of the comparison.
#[derive(Debug, Clone)]
pub struct ArtistKey {
    pub norm: String,
    parts: Vec<String>,
    grams: Grams,
    various: bool,
}

impl ArtistKey {
    pub fn new(name: &str) -> Self {
        let norm = norm(name);
        Self {
            parts: split_credits(&nfkc(name))
                .map(crate::normalize::norm)
                .collect(),
            grams: Grams::new(&norm),
            various: VARIOUS_ARTISTS_RE.is_match(&norm),
            norm,
        }
    }

    /// `artistSim(spotifyNames, self, null)`.
    pub fn similarity(&self, spotify: &[ArtistKey]) -> f64 {
        let mut best: f64 = 0.0;
        for name in spotify {
            if name.norm.is_empty() {
                continue;
            }
            if name.norm == self.norm || (name.various && self.various) {
                return 1.0;
            }
            if self.parts.contains(&name.norm) {
                best = best.max(0.95);
            }
            best = best.max(name.grams.dice(&self.grams));
        }
        best
    }
}

pub fn artist_sim(spotify_names: &[&str], local: &str) -> f64 {
    let spotify: Vec<ArtistKey> = spotify_names.iter().map(|n| ArtistKey::new(n)).collect();
    ArtistKey::new(local).similarity(&spotify)
}

#[cfg(test)]
mod tests {
    #[test]
    fn title_keys() {
        for (title, full, base) in [
            (
                "STRAY SHEEP (Deluxe Edition)",
                "stray sheep deluxe edition",
                "stray sheep",
            ),
            ("Lemon - Single", "lemon single", "lemon"),
            (
                "うっせぇわ (Giga Remix)",
                "うっせぇわ giga remix",
                "うっせぇわ giga remix",
            ),
            ("Song (feat. Someone)", "song", "song"),
            ("アルバム [ハイレゾ 96kHz/24bit]", "アルバム", "アルバム"),
            (
                "Lemon 〜ドラマ「アンナチュラル」主題歌〜",
                "lemon ドラマ アンナチュラル 主題歌",
                "lemon",
            ),
            (
                "Ｆｕｌｌｗｉｄｔｈ・タイトル",
                "fullwidth タイトル",
                "fullwidth タイトル",
            ),
            ("(Remastered)", "remastered", "remastered"),
        ] {
            assert_eq!(crate::normalize::full_key(title), full, "{title}");
            assert_eq!(crate::normalize::base_key(title), base, "{title}");
        }
    }

    #[test]
    fn similarity() {
        assert!((crate::normalize::dice("night", "nacht") - 0.25).abs() < 1e-9);
        assert_eq!(crate::normalize::dice("a", "a"), 1.0);
        assert_eq!(crate::normalize::dice("a", "b"), 0.0);
        assert_eq!(crate::normalize::dice("", ""), 0.0);
        assert_eq!(crate::normalize::title_sim("Lemon", "Lemon"), 1.0);
        assert_eq!(
            crate::normalize::title_sim("STRAY SHEEP (Deluxe Edition)", "STRAY SHEEP"),
            0.92
        );
        assert_eq!(
            crate::normalize::artist_sim(&["Various Artists"], "V.A."),
            1.0
        );
        assert_eq!(
            crate::normalize::artist_sim(&["Other"], "Someone & Other"),
            0.95
        );
    }

    #[test]
    fn distinct_grams() {
        let grams = crate::normalize::Grams::new("abab");
        assert_eq!(
            grams.distinct().collect::<Vec<_>>(),
            vec![('a', 'b'), ('b', 'a')]
        );
    }
}
