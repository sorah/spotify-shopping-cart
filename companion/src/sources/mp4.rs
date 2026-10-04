//! Read-only MP4 metadata reader for iTunes Store and mora IDs.
//!
//! Only the payloads of `cnID`, `plID`, `xid ` and mora's `uuid` boxes are read. Every other box,
//! including `apID`/`ownr` (the account owner) and `©lyr`, is skipped by seeking past it.

const PLACEHOLDER_STORE_ID: u64 = 4_294_967_295;
const MAX_ITEM_SIZE: u64 = 4096;
const MAX_UUID_SIZE: u64 = 1024;

const MORA_LABEL_CODE: [u8; 16] = uuid_bytes(0x45b1d925_1448_5784_b4da_b89901050a13);
const MORA_PACKAGE_ID: [u8; 16] = uuid_bytes(0x8e90f26b_372a_5c8c_bb05_1ec0f36ee60c);
const MORA_MATERIAL_NO: [u8; 16] = uuid_bytes(0xbe242671_3d48_5ac8_b762_7d2db4f584b8);
const MORA_ISRC: [u8; 16] = uuid_bytes(0x93a74bea_ce97_5571_a56a_c5084dba9873);

const fn uuid_bytes(value: u128) -> [u8; 16] {
    value.to_be_bytes()
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Mp4Ids {
    pub store_track_id: Option<u64>,
    pub store_collection_id: Option<u64>,
    /// From `xid ` (`<label>:isrc:<ISRC>`).
    pub isrc: Option<String>,
    pub mora_label_code: Option<String>,
    pub mora_package_id: Option<String>,
    pub mora_material_no: Option<String>,
    pub mora_isrc: Option<String>,
}

pub fn read_ids(path: &std::path::Path) -> std::io::Result<Mp4Ids> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    read_ids_from(&mut file, len)
}

pub fn read_ids_from<R: std::io::Read + std::io::Seek>(
    reader: &mut R,
    len: u64,
) -> std::io::Result<Mp4Ids> {
    let mut ids = Mp4Ids::default();
    let Some(moov) = find_child(reader, 0, len, b"moov")? else {
        return Ok(ids);
    };
    let Some(udta) = find_child(reader, moov.body, moov.end, b"udta")? else {
        return Ok(ids);
    };
    let mut pos = udta.body;
    while let Some(child) = next_box(reader, pos, udta.end)? {
        match &child.kind {
            b"meta" => read_meta(reader, &child, &mut ids)?,
            b"uuid" => read_uuid(reader, &child, &mut ids)?,
            _ => {}
        }
        pos = child.end;
    }
    Ok(ids)
}

#[derive(Debug)]
struct BoxHeader {
    kind: [u8; 4],
    body: u64,
    end: u64,
}

fn next_box<R: std::io::Read + std::io::Seek>(
    reader: &mut R,
    pos: u64,
    end: u64,
) -> std::io::Result<Option<BoxHeader>> {
    if pos.saturating_add(8) > end {
        return Ok(None);
    }
    reader.seek(std::io::SeekFrom::Start(pos))?;
    let mut header = [0u8; 8];
    reader.read_exact(&mut header)?;
    let size32 = u32::from_be_bytes(header[0..4].try_into().unwrap());
    let kind: [u8; 4] = header[4..8].try_into().unwrap();
    let (size, header_len) = match size32 {
        0 => (end - pos, 8),
        1 => {
            if pos + 16 > end {
                return Ok(None);
            }
            let mut large = [0u8; 8];
            reader.read_exact(&mut large)?;
            (u64::from_be_bytes(large), 16)
        }
        n => (u64::from(n), 8),
    };
    // A malformed size ends the walk at this level rather than failing the whole file.
    if size < header_len || pos.saturating_add(size) > end {
        return Ok(None);
    }
    Ok(Some(BoxHeader {
        kind,
        body: pos + header_len,
        end: pos + size,
    }))
}

fn find_child<R: std::io::Read + std::io::Seek>(
    reader: &mut R,
    start: u64,
    end: u64,
    kind: &[u8; 4],
) -> std::io::Result<Option<BoxHeader>> {
    let mut pos = start;
    while let Some(child) = next_box(reader, pos, end)? {
        if &child.kind == kind {
            return Ok(Some(child));
        }
        pos = child.end;
    }
    Ok(None)
}

fn read_meta<R: std::io::Read + std::io::Seek>(
    reader: &mut R,
    meta: &BoxHeader,
    ids: &mut Mp4Ids,
) -> std::io::Result<()> {
    // `meta` is a full box: 4 bytes of version and flags precede its children.
    let mut pos = meta.body + 4;
    while let Some(child) = next_box(reader, pos, meta.end)? {
        match &child.kind {
            b"ilst" => read_ilst(reader, &child, ids)?,
            b"uuid" => read_uuid(reader, &child, ids)?,
            _ => {}
        }
        pos = child.end;
    }
    Ok(())
}

fn read_ilst<R: std::io::Read + std::io::Seek>(
    reader: &mut R,
    ilst: &BoxHeader,
    ids: &mut Mp4Ids,
) -> std::io::Result<()> {
    let mut pos = ilst.body;
    while let Some(item) = next_box(reader, pos, ilst.end)? {
        pos = item.end;
        if !matches!(&item.kind, b"cnID" | b"plID" | b"xid ") {
            continue;
        }
        let Some(data) = find_child(reader, item.body, item.end, b"data")? else {
            continue;
        };
        let body = read_body(reader, &data, MAX_ITEM_SIZE)?;
        // `data` body: 4-byte type indicator, 4-byte locale, then the value.
        if body.len() < 8 {
            continue;
        }
        let type_indicator = u32::from_be_bytes(body[0..4].try_into().unwrap()) & 0x00ff_ffff;
        let value = &body[8..];
        match (&item.kind, type_indicator) {
            (b"cnID", 0 | 21) => {
                ids.store_track_id =
                    be_uint(value).filter(|&id| id != 0 && id != PLACEHOLDER_STORE_ID);
            }
            (b"plID", 0 | 21) => {
                ids.store_collection_id =
                    be_uint(value).filter(|&id| id != 0 && id != PLACEHOLDER_STORE_ID);
            }
            (b"xid ", 1) => {
                ids.isrc = std::str::from_utf8(value)
                    .ok()
                    .and_then(|text| text.split_once(":isrc:"))
                    .and_then(|(_, isrc)| clean(isrc));
            }
            _ => {}
        }
    }
    Ok(())
}

fn read_uuid<R: std::io::Read + std::io::Seek>(
    reader: &mut R,
    uuid: &BoxHeader,
    ids: &mut Mp4Ids,
) -> std::io::Result<()> {
    let body = read_body(reader, uuid, MAX_UUID_SIZE)?;
    // 16-byte UUID, a 4-byte "a01x" tag and 8 more header bytes precede the text value.
    if body.len() < 28 {
        return Ok(());
    }
    let key: [u8; 16] = body[0..16].try_into().unwrap();
    let value = clean(&String::from_utf8_lossy(&body[28..]));
    let slot = match key {
        MORA_LABEL_CODE => &mut ids.mora_label_code,
        MORA_PACKAGE_ID => &mut ids.mora_package_id,
        MORA_MATERIAL_NO => &mut ids.mora_material_no,
        MORA_ISRC => &mut ids.mora_isrc,
        _ => return Ok(()),
    };
    *slot = value;
    Ok(())
}

fn read_body<R: std::io::Read + std::io::Seek>(
    reader: &mut R,
    header: &BoxHeader,
    limit: u64,
) -> std::io::Result<Vec<u8>> {
    let len = header.end - header.body;
    if len > limit {
        return Ok(Vec::new());
    }
    reader.seek(std::io::SeekFrom::Start(header.body))?;
    let mut body = vec![0u8; len as usize];
    reader.read_exact(&mut body)?;
    Ok(body)
}

fn be_uint(bytes: &[u8]) -> Option<u64> {
    if bytes.is_empty() || bytes.len() > 8 {
        return None;
    }
    Some(bytes.iter().fold(0u64, |acc, &b| (acc << 8) | u64::from(b)))
}

fn clean(text: &str) -> Option<String> {
    let text = text.replace('\0', "");
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

#[cfg(test)]
pub(crate) mod tests {
    pub fn mp4_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        out
    }

    pub fn data_item(kind: &[u8; 4], type_indicator: u32, value: &[u8]) -> Vec<u8> {
        let mut data = type_indicator.to_be_bytes().to_vec();
        data.extend_from_slice(&[0, 0, 0, 0]);
        data.extend_from_slice(value);
        mp4_box(kind, &mp4_box(b"data", &data))
    }

    pub fn mora_uuid(key: u128, tag: &[u8; 4], value: &str) -> Vec<u8> {
        let mut body = key.to_be_bytes().to_vec();
        body.extend_from_slice(tag);
        body.extend_from_slice(&[0; 8]);
        body.extend_from_slice(value.as_bytes());
        mp4_box(b"uuid", &body)
    }

    /// A synthetic purchased-AAC-like file with store atoms, mora UUIDs and the boxes that must
    /// never be read.
    pub fn sample_file() -> Vec<u8> {
        let ilst = [
            data_item(b"\xa9nam", 1, "Title".as_bytes()),
            data_item(b"apID", 1, b"owner@example.com"),
            data_item(b"ownr", 1, b"Owner Name"),
            data_item(b"\xa9lyr", 1, b"la la la"),
            data_item(b"cnID", 21, &1_234_567_890u32.to_be_bytes()),
            data_item(b"plID", 21, &987_654_321_000u64.to_be_bytes()),
            data_item(b"xid ", 1, b"SomeLabel:isrc:JPAB01234567"),
            data_item(b"covr", 13, &[0xff; 64]),
        ]
        .concat();
        let mut meta_body = vec![0, 0, 0, 0];
        meta_body.extend(mp4_box(b"hdlr", &[0; 25]));
        meta_body.extend(mp4_box(b"ilst", &ilst));
        meta_body.extend(mora_uuid(
            0x45b1d925_1448_5784_b4da_b89901050a13,
            b"a010",
            "10006001\0",
        ));
        meta_body.extend(mora_uuid(
            0x8e90f26b_372a_5c8c_bb05_1ec0f36ee60c,
            b"a011",
            "PKG-001",
        ));
        meta_body.extend(mora_uuid(
            0xbe242671_3d48_5ac8_b762_7d2db4f584b8,
            b"a012",
            "35843225",
        ));
        meta_body.extend(mora_uuid(
            0x93a74bea_ce97_5571_a56a_c5084dba9873,
            b"a013",
            " tcjpk2576742 ",
        ));
        meta_body.extend(mora_uuid(
            0xff8ca75f_2d68_52eb_85d6_1580486025a4,
            b"a014",
            "102296892",
        ));
        let udta = mp4_box(b"udta", &mp4_box(b"meta", &meta_body));
        let moov = mp4_box(b"moov", &[mp4_box(b"trak", &[0; 32]), udta].concat());
        [
            mp4_box(b"ftyp", b"M4A \0\0\0\0"),
            mp4_box(b"mdat", &[0; 128]),
            moov,
        ]
        .concat()
    }

    fn read(bytes: &[u8]) -> crate::sources::mp4::Mp4Ids {
        let mut cursor = std::io::Cursor::new(bytes);
        crate::sources::mp4::read_ids_from(&mut cursor, bytes.len() as u64).unwrap()
    }

    #[test]
    fn reads_store_and_mora_ids() {
        let ids = read(&sample_file());
        assert_eq!(
            ids,
            crate::sources::mp4::Mp4Ids {
                store_track_id: Some(1_234_567_890),
                store_collection_id: Some(987_654_321_000),
                isrc: Some("JPAB01234567".to_owned()),
                mora_label_code: Some("10006001".to_owned()),
                mora_package_id: Some("PKG-001".to_owned()),
                mora_material_no: Some("35843225".to_owned()),
                mora_isrc: Some("tcjpk2576742".to_owned()),
            }
        );
        let debug = format!("{ids:?}");
        assert!(!debug.contains("owner"));
        assert!(!debug.contains("la la"));
    }

    #[test]
    fn drops_placeholder_store_id() {
        let ilst = data_item(b"cnID", 21, &4_294_967_295u32.to_be_bytes());
        let mut meta = vec![0, 0, 0, 0];
        meta.extend(mp4_box(b"ilst", &ilst));
        let file = mp4_box(b"moov", &mp4_box(b"udta", &mp4_box(b"meta", &meta)));
        assert_eq!(read(&file).store_track_id, None);
    }

    #[test]
    fn handles_largesize_and_size_zero_boxes() {
        let ilst = data_item(b"cnID", 21, &42u32.to_be_bytes());
        let mut meta = vec![0, 0, 0, 0];
        meta.extend(mp4_box(b"ilst", &ilst));
        let udta = mp4_box(b"udta", &mp4_box(b"meta", &meta));
        let mut moov = 1u32.to_be_bytes().to_vec();
        moov.extend_from_slice(b"moov");
        moov.extend_from_slice(&((udta.len() + 16) as u64).to_be_bytes());
        moov.extend(udta);
        let mut file = mp4_box(b"ftyp", b"M4A \0\0\0\0");
        file.extend(moov);
        file.extend_from_slice(&0u32.to_be_bytes());
        file.extend_from_slice(b"mdat");
        file.extend_from_slice(&[0; 16]);
        assert_eq!(read(&file).store_track_id, Some(42));
    }

    #[test]
    fn tolerates_truncated_and_non_mp4_input() {
        let mut file = sample_file();
        file.truncate(file.len() - 10);
        assert_eq!(read(&file), crate::sources::mp4::Mp4Ids::default());
        assert_eq!(
            read(b"ID3\x03\0\0\0\0\0\0garbage"),
            crate::sources::mp4::Mp4Ids::default()
        );
        assert_eq!(read(&[]), crate::sources::mp4::Mp4Ids::default());
    }
}
