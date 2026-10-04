pub mod directory;
pub mod ffprobe;
pub mod itunes_xml;
pub mod mp4;

/// Modification time as nanoseconds since the Unix epoch, for change detection only.
pub fn mtime_ns(metadata: &std::fs::Metadata) -> i64 {
    match metadata.modified() {
        Ok(time) => match time.duration_since(std::time::UNIX_EPOCH) {
            Ok(after) => after.as_nanos() as i64,
            Err(before) => -(before.duration().as_nanos() as i64),
        },
        Err(_) => 0,
    }
}
