//! Walks a `type: "directory"` source. Files are only listed and stat'ed here.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirFile {
    /// Relative to the source root, `/`-separated. Never leaves the companion.
    pub rel_path: String,
    pub abs_path: std::path::PathBuf,
    pub size: u64,
    pub mtime_ns: i64,
}

pub fn build_excludes<'a>(
    patterns: impl IntoIterator<Item = &'a str>,
) -> crate::error::Result<globset::GlobSet> {
    let mut builder = globset::GlobSetBuilder::new();
    for pattern in patterns {
        let glob = globset::GlobBuilder::new(pattern)
            .case_insensitive(true)
            .literal_separator(true)
            .build()
            .map_err(|e| crate::error::Error::Config(format!("exclude glob {pattern:?}: {e}")))?;
        builder.add(glob);
    }
    builder
        .build()
        .map_err(|e| crate::error::Error::Config(format!("exclude globs: {e}")))
}

/// Audio files under `root` with one of `extensions`, minus `excludes`, sorted by relative path.
pub fn walk(
    root: &std::path::Path,
    extensions: &[String],
    excludes: &globset::GlobSet,
) -> crate::error::Result<Vec<DirFile>> {
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) if e.depth() == 0 => {
                return Err(crate::error::Error::Io {
                    context: format!("walking {}", root.display()),
                    source: e.into(),
                });
            }
            Err(e) => {
                tracing::warn!(error = %e, "skipping unreadable entry");
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let has_extension = entry
            .path()
            .extension()
            .map(|ext| {
                let ext = ext.to_string_lossy();
                extensions
                    .iter()
                    .any(|want| want.eq_ignore_ascii_case(&ext))
            })
            .unwrap_or(false);
        if !has_extension {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let rel_path = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if excludes.is_match(&rel_path) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(e) => {
                tracing::warn!(error = %e, "skipping file without metadata");
                continue;
            }
        };
        files.push(DirFile {
            rel_path,
            abs_path: entry.path().to_path_buf(),
            size: metadata.len(),
            mtime_ns: crate::sources::mtime_ns(&metadata),
        });
    }
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(files)
}

#[cfg(test)]
mod tests {
    #[test]
    fn walks_with_extensions_and_excludes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for rel in [
            "Artist/Album/01 Song.flac",
            "Artist/Album/02 Song.FLAC",
            "Artist/Album/cover.jpg",
            "Unknown Artist/SoundCloud/bootleg.mp3",
            "Unknown Artist/soundcloud/other.mp3",
            "Loose.mp3",
        ] {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"x").unwrap();
        }
        let excludes = crate::sources::directory::build_excludes(["**/SoundCloud/**"]).unwrap();
        let extensions = vec!["flac".to_owned(), "mp3".to_owned()];
        let files = crate::sources::directory::walk(root, &extensions, &excludes).unwrap();
        let rels: Vec<&str> = files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(
            rels,
            vec![
                "Artist/Album/01 Song.flac",
                "Artist/Album/02 Song.FLAC",
                "Loose.mp3"
            ]
        );
        assert_eq!(files[0].size, 1);
    }

    #[test]
    fn missing_root_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let excludes = crate::sources::directory::build_excludes([]).unwrap();
        assert!(
            crate::sources::directory::walk(&dir.path().join("missing"), &[], &excludes).is_err()
        );
    }
}
