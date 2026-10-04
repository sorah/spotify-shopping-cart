//! Per-install secrets kept in the data directory: the pairing token and the key for opaque entry IDs.

use crate::error::IoContext as _;
use base64::Engine as _;

const TOKEN_FILE: &str = "token";
const ID_KEY_FILE: &str = "id-key";

pub struct Token {
    pub value: String,
    pub created: bool,
}

pub fn load_or_create_token(data_dir: &std::path::Path) -> crate::error::Result<Token> {
    let path = data_dir.join(TOKEN_FILE);
    if let Some(value) = read_trimmed(&path)? {
        return Ok(Token {
            value,
            created: false,
        });
    }
    let value = generate_token();
    write_secret(&path, &value)?;
    Ok(Token {
        value,
        created: true,
    })
}

pub fn rotate_token(data_dir: &std::path::Path) -> crate::error::Result<String> {
    let value = generate_token();
    write_secret(&data_dir.join(TOKEN_FILE), &value)?;
    Ok(value)
}

pub fn token_matches(expected: &str, presented: &str) -> bool {
    subtle::ConstantTimeEq::ct_eq(expected.as_bytes(), presented.as_bytes()).into()
}

pub fn load_or_create_id_key(data_dir: &std::path::Path) -> crate::error::Result<[u8; 32]> {
    let path = data_dir.join(ID_KEY_FILE);
    if let Some(text) = read_trimmed(&path)?
        && let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&text)
        && let Ok(key) = <[u8; 32]>::try_from(bytes)
    {
        return Ok(key);
    }
    let key: [u8; 32] = rand::random();
    write_secret(
        &path,
        &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key),
    )?;
    Ok(key)
}

fn generate_token() -> String {
    let bytes: [u8; 32] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn read_trimmed(path: &std::path::Path) -> crate::error::Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(text) if !text.trim().is_empty() => Ok(Some(text.trim().to_owned())),
        Ok(_) => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).context(|| format!("reading {}", path.display())),
    }
}

fn write_secret(path: &std::path::Path, value: &str) -> crate::error::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context(|| format!("creating {}", parent.display()))?;
    }
    // Write-then-rename, so a crash never leaves a truncated secret behind.
    let staging = path.with_extension("tmp");
    std::fs::write(&staging, value).context(|| format!("writing {}", staging.display()))?;
    std::fs::rename(&staging, path).context(|| format!("replacing {}", path.display()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn token_is_created_once_and_rotates() {
        let dir = tempfile::tempdir().unwrap();
        let first = crate::secret::load_or_create_token(dir.path()).unwrap();
        assert!(first.created);
        assert_eq!(first.value.len(), 43);
        let second = crate::secret::load_or_create_token(dir.path()).unwrap();
        assert!(!second.created);
        assert_eq!(first.value, second.value);
        let rotated = crate::secret::rotate_token(dir.path()).unwrap();
        assert_ne!(rotated, first.value);
    }

    #[test]
    fn token_comparison() {
        assert!(crate::secret::token_matches("abc", "abc"));
        assert!(!crate::secret::token_matches("abc", "abd"));
        assert!(!crate::secret::token_matches("abc", "ab"));
        assert!(!crate::secret::token_matches("abc", ""));
    }

    #[test]
    fn id_key_is_stable() {
        let dir = tempfile::tempdir().unwrap();
        let first = crate::secret::load_or_create_id_key(dir.path()).unwrap();
        let second = crate::secret::load_or_create_id_key(dir.path()).unwrap();
        assert_eq!(first, second);
    }
}
