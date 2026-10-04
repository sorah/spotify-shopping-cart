//! The in-memory matching index. It holds display data and match keys only: no local paths.

/// Bump when matching changes, so clients keyed on `libraryRevision` re-check.
pub const MATCHER_VERSION: u32 = 1;

/// Everything the index needs to know about one local entry.
#[derive(Debug, Clone)]
pub struct EntryInput {
    pub source: String,
    pub source_label: String,
    pub id: String,
    pub tags: TagNames,
    pub store: Option<StoreNames>,
    pub duration_ms: Option<i64>,
    pub ownership: crate::protocol::Ownership,
    pub format: String,
    pub cloud_only: bool,
    pub ids: crate::protocol::LocalIds,
}

#[derive(Debug, Clone, Default)]
pub struct TagNames {
    pub title: String,
    pub artist: Option<String>,
    pub album_artist: Option<String>,
    pub album: Option<String>,
}

/// Japan-store names resolved through iTunes Lookup.
#[derive(Debug, Clone, Default)]
pub struct StoreNames {
    pub title: String,
    pub artist: Option<String>,
    pub collection_artist: Option<String>,
    pub album: Option<String>,
}

/// One name set of an entry: its tags, or the store's names for its `cnID`.
#[derive(Debug, Clone)]
pub struct NameSet {
    pub via: crate::protocol::MetadataSource,
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub(crate) title_key: crate::normalize::TitleKey,
    pub(crate) artist_keys: Vec<crate::normalize::ArtistKey>,
    pub(crate) album_key: Option<crate::normalize::TitleKey>,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub source: String,
    pub id: String,
    pub names: Vec<NameSet>,
    pub duration_ms: Option<i64>,
    pub ownership: crate::protocol::Ownership,
    pub format: String,
    pub cloud_only: bool,
    pub location: String,
    pub ids: crate::protocol::LocalIds,
}

#[derive(Debug, Default)]
pub struct Index {
    pub revision: String,
    pub entries: Vec<Entry>,
    pub(crate) key_index: std::collections::HashMap<String, Vec<u32>>,
    pub(crate) gram_index: std::collections::HashMap<(char, char), Vec<u32>>,
    pub(crate) isrc_index: std::collections::HashMap<String, Vec<u32>>,
}

impl NameSet {
    fn new(
        via: crate::protocol::MetadataSource,
        title: &str,
        artists: &[Option<&str>],
        album: Option<&str>,
    ) -> Self {
        let mut artist_keys: Vec<crate::normalize::ArtistKey> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for raw in artists.iter().flatten() {
            for variant in crate::matcher::credit_variants(raw) {
                if seen.insert(variant.clone()) {
                    artist_keys.push(crate::normalize::ArtistKey::new(&variant));
                }
            }
        }
        Self {
            via,
            title: title.to_owned(),
            artists: artists
                .iter()
                .flatten()
                .take(1)
                .map(|a| (*a).to_owned())
                .collect(),
            album: album.map(str::to_owned),
            title_key: crate::normalize::TitleKey::new(title),
            artist_keys,
            album_key: album.map(crate::normalize::TitleKey::new),
        }
    }
}

impl Entry {
    fn new(input: EntryInput) -> Self {
        let tags = &input.tags;
        let mut names = vec![NameSet::new(
            crate::protocol::MetadataSource::Tags,
            &tags.title,
            &[tags.artist.as_deref(), tags.album_artist.as_deref()],
            tags.album.as_deref(),
        )];
        if let Some(store) = &input.store
            && !store.title.trim().is_empty()
        {
            names.push(NameSet::new(
                crate::protocol::MetadataSource::ItunesStore,
                &store.title,
                &[store.artist.as_deref(), store.collection_artist.as_deref()],
                store.album.as_deref(),
            ));
        }
        let location = format!(
            "{} · {} / {}",
            input.source_label,
            tags.artist
                .as_deref()
                .or(tags.album_artist.as_deref())
                .unwrap_or("?"),
            tags.album.as_deref().unwrap_or("?"),
        );
        Self {
            source: input.source,
            id: input.id,
            names,
            duration_ms: input.duration_ms,
            ownership: input.ownership,
            format: input.format,
            cloud_only: input.cloud_only,
            location,
            ids: input.ids,
        }
    }
}

pub fn normalize_isrc(isrc: &str) -> Option<String> {
    let isrc = isrc.trim().to_ascii_uppercase();
    (!isrc.is_empty()).then_some(isrc)
}

#[derive(serde::Serialize)]
struct Canonical<'a> {
    source: &'a str,
    id: &'a str,
    ownership: crate::protocol::Ownership,
    duration_ms: Option<i64>,
    format: &'a str,
    cloud_only: bool,
    location: &'a str,
    ids: &'a crate::protocol::LocalIds,
    names: Vec<(
        crate::protocol::MetadataSource,
        &'a str,
        &'a [String],
        Option<&'a str>,
    )>,
}

impl Index {
    pub fn build(inputs: Vec<EntryInput>) -> Self {
        let mut entries: Vec<Entry> = inputs.into_iter().map(Entry::new).collect();
        entries.sort_by(|a, b| (&a.source, &a.id).cmp(&(&b.source, &b.id)));

        let mut index = Index {
            revision: revision(&entries),
            ..Default::default()
        };
        for (i, entry) in entries.iter().enumerate() {
            let i = i as u32;
            for names in &entry.names {
                for key in [&names.title_key.full, &names.title_key.base] {
                    if key.is_empty() {
                        continue;
                    }
                    push_unique(index.key_index.entry(key.clone()).or_default(), i);
                }
                for gram in crate::normalize::Grams::new(&names.title_key.full).distinct() {
                    push_unique(index.gram_index.entry(gram).or_default(), i);
                }
            }
            if let Some(isrc) = entry.ids.isrc.as_deref().and_then(normalize_isrc) {
                push_unique(index.isrc_index.entry(isrc).or_default(), i);
            }
        }
        index.entries = entries;
        index
    }

    pub fn count_by_source(&self, source: &str) -> usize {
        self.entries.iter().filter(|e| e.source == source).count()
    }
}

fn push_unique(list: &mut Vec<u32>, i: u32) {
    if list.last() != Some(&i) {
        list.push(i);
    }
}

fn revision(entries: &[Entry]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&MATCHER_VERSION.to_be_bytes());
    for entry in entries {
        let canonical = Canonical {
            source: &entry.source,
            id: &entry.id,
            ownership: entry.ownership,
            duration_ms: entry.duration_ms,
            format: &entry.format,
            cloud_only: entry.cloud_only,
            location: &entry.location,
            ids: &entry.ids,
            names: entry
                .names
                .iter()
                .map(|n| {
                    (
                        n.via,
                        n.title.as_str(),
                        n.artists.as_slice(),
                        n.album.as_deref(),
                    )
                })
                .collect(),
        };
        serde_json::to_writer(&mut hasher, &canonical).expect("hashing never fails");
        hasher.update(b"\n");
    }
    hasher.finalize().to_hex()[..16].to_owned()
}

#[cfg(test)]
pub(crate) mod tests {
    pub fn input(
        source: &str,
        id: &str,
        title: &str,
        artist: &str,
        album: &str,
    ) -> crate::index::EntryInput {
        crate::index::EntryInput {
            source: source.to_owned(),
            source_label: source.to_owned(),
            id: id.to_owned(),
            tags: crate::index::TagNames {
                title: title.to_owned(),
                artist: Some(artist.to_owned()),
                album_artist: None,
                album: Some(album.to_owned()),
            },
            store: None,
            duration_ms: None,
            ownership: crate::protocol::Ownership::Purchased,
            format: "AAC".to_owned(),
            cloud_only: false,
            ids: Default::default(),
        }
    }

    #[test]
    fn revision_is_order_independent_and_content_sensitive() {
        let a = input("itunes", "A", "Song A", "Artist", "Album");
        let b = input("itunes", "B", "Song B", "Artist", "Album");
        let first = crate::index::Index::build(vec![a.clone(), b.clone()]);
        let second = crate::index::Index::build(vec![b.clone(), a.clone()]);
        assert_eq!(first.revision, second.revision);
        assert_eq!(first.revision.len(), 16);

        let mut changed = b.clone();
        changed.duration_ms = Some(1000);
        let third = crate::index::Index::build(vec![a, changed]);
        assert_ne!(first.revision, third.revision);
    }

    #[test]
    fn location_uses_tags_only() {
        let mut entry = input("rip", "X", "Song", "Artist", "Album");
        entry.source_label = "Library".to_owned();
        entry.tags.album = None;
        let index = crate::index::Index::build(vec![entry]);
        assert_eq!(index.entries[0].location, "Library · Artist / ?");
    }

    #[test]
    fn store_names_add_a_name_set() {
        let mut entry = input(
            "itunes",
            "A",
            "Umibede Aimashou",
            "Mikako Komatsu",
            "Umibede - Single",
        );
        entry.store = Some(crate::index::StoreNames {
            title: "海辺で逢いましょう".to_owned(),
            artist: Some("小松未可子".to_owned()),
            collection_artist: None,
            album: Some("海辺で - Single".to_owned()),
        });
        let index = crate::index::Index::build(vec![entry]);
        let names = &index.entries[0].names;
        assert_eq!(names.len(), 2);
        assert_eq!(names[1].via, crate::protocol::MetadataSource::ItunesStore);
        assert!(index.key_index.contains_key("海辺で逢いましょう"));
        assert!(index.key_index.contains_key("umibede aimashou"));
    }
}
