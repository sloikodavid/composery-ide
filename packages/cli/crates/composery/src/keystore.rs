//! Cross-language contract: the TS route reads this same `/data/api/keys.json`;
//! store path, JSON shape, and hex SHA-256 hashing must stay identical both sides.

use anyhow::{Context, Result, bail};
use base64::Engine as _;
use fs2::FileExt as _;
use persistence::paths::volume_root;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const KEY_PREFIX: &str = "composery_";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyStore {
    pub version: u32,
    pub keys: Vec<KeyRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyRecord {
    pub id: String,
    pub name: String,
    pub prefix: String,
    pub hash: String,
    pub created_at: u64,
}

pub struct NewKey {
    pub secret: String,
    pub record: KeyRecord,
}

impl Default for KeyStore {
    fn default() -> Self {
        Self {
            version: 1,
            keys: Vec::new(),
        }
    }
}

impl KeyStore {
    pub fn create(&mut self, name: &str) -> Result<NewKey> {
        if name.trim().is_empty() {
            bail!("key name must not be empty");
        }
        let new = generate(name)?;
        self.keys.push(new.record.clone());
        Ok(new)
    }

    pub fn revoke(&mut self, id: &str) -> bool {
        let before = self.keys.len();
        self.keys.retain(|key| key.id != id);
        self.keys.len() != before
    }
}

pub fn store_path() -> PathBuf {
    volume_root().join("api").join("keys.json")
}

pub struct StoreLock {
    _file: File,
}

/// Serialize load-modify-save mutations so two concurrent CLI invocations
/// cannot silently drop each other's keys. Blocks until the peer finishes.
pub fn lock_store(path: &Path) -> Result<StoreLock> {
    let parent = path
        .parent()
        .with_context(|| format!("store path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    ensure_real_dir(parent)?;

    let lock_path = path.with_extension("json.lock");
    ensure_real_file_or_missing(&lock_path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(&lock_path)
        .with_context(|| format!("open lock {}", lock_path.display()))?;
    file.lock_exclusive()
        .with_context(|| format!("acquire lock {}", lock_path.display()))?;
    Ok(StoreLock { _file: file })
}

pub fn load(path: &Path) -> Result<KeyStore> {
    match open_real_file(path) {
        Ok(mut file) => {
            let mut data = Vec::new();
            file.read_to_end(&mut data)
                .with_context(|| format!("read {}", path.display()))?;
            serde_json::from_slice(&data).with_context(|| format!("parse {}", path.display()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(KeyStore::default()),
        Err(error) => Err(error).with_context(|| format!("open {}", path.display())),
    }
}

pub fn save(path: &Path, store: &KeyStore) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("store path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    ensure_real_dir(parent)?;
    ensure_real_file_or_missing(path)?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("chmod 0700 {}", parent.display()))?;

    let mut data = serde_json::to_vec_pretty(store).context("encode key store")?;
    data.push(b'\n');

    let temp = path.with_extension("json.tmp");
    let _ = fs::remove_file(&temp);
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)
            .with_context(|| format!("create {}", temp.display()))?;
        file.write_all(&data)
            .with_context(|| format!("write {}", temp.display()))?;
        // Match the store's owner to its directory (the editor user) so a
        // sudo-run CLI never leaves a root-owned store the server cannot
        // read. Best effort: without privileges this is a no-op.
        let parent_metadata =
            fs::metadata(parent).with_context(|| format!("stat {}", parent.display()))?;
        let _ = unsafe {
            libc::fchown(
                std::os::unix::io::AsRawFd::as_raw_fd(&file),
                parent_metadata.uid(),
                parent_metadata.gid(),
            )
        };
        file.sync_all()
            .with_context(|| format!("fsync {}", temp.display()))?;
    }
    fs::rename(&temp, path)
        .with_context(|| format!("publish {} to {}", temp.display(), path.display()))?;
    let dir = File::open(parent).with_context(|| format!("open {}", parent.display()))?;
    dir.sync_all()
        .with_context(|| format!("fsync {}", parent.display()))
}

pub fn hash_secret(secret: &str) -> String {
    format!("sha256:{}", hex_encode(&Sha256::digest(secret.as_bytes())))
}

fn generate(name: &str) -> Result<NewKey> {
    let mut secret_bytes = [0u8; 32];
    getrandom::fill(&mut secret_bytes).map_err(|error| anyhow::anyhow!("getrandom: {error}"))?;
    let secret = format!(
        "{KEY_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret_bytes)
    );

    let mut id_bytes = [0u8; 6];
    getrandom::fill(&mut id_bytes).map_err(|error| anyhow::anyhow!("getrandom: {error}"))?;
    let id = format!("k_{}", hex_encode(&id_bytes));

    let prefix: String = secret.chars().take(KEY_PREFIX.len() + 8).collect();

    Ok(NewKey {
        record: KeyRecord {
            id,
            name: name.to_string(),
            prefix,
            hash: hash_secret(&secret),
            created_at: now_secs(),
        },
        secret,
    })
}

fn open_real_file(path: &Path) -> std::io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "key store must be a real file",
        ));
    }
    Ok(file)
}

fn ensure_real_file_or_missing(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(()),
        Ok(_) => anyhow::bail!("{} must be a real file", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("stat {}", path.display())),
    }
}

fn ensure_real_dir(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => anyhow::bail!("{} must be a real directory", path.display()),
        Err(error) => Err(error).with_context(|| format!("stat {}", path.display())),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn create_list_revoke_round_trip() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("api/keys.json");

        let mut store = load(&path).unwrap();
        assert!(store.keys.is_empty());
        let new = store.create("ci").unwrap();
        save(&path, &store).unwrap();

        let mut store = load(&path).unwrap();
        assert_eq!(store.keys.len(), 1);
        let record_id = store.keys[0].id.clone();
        assert_eq!(store.keys[0].name, "ci");
        assert!(new.secret.starts_with("composery_"));
        assert_eq!(store.keys[0].hash, hash_secret(&new.secret));

        assert!(store.revoke(&record_id));
        assert!(!store.revoke("k_does_not_exist"));
        save(&path, &store).unwrap();
        assert!(load(&path).unwrap().keys.is_empty());
    }

    #[test]
    fn locked_concurrent_creates_do_not_lose_keys() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("api/keys.json");

        let threads: Vec<_> = (0..8)
            .map(|index| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let _lock = lock_store(&path).unwrap();
                    let mut store = load(&path).unwrap();
                    store.create(&format!("worker-{index}")).unwrap();
                    save(&path, &store).unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }

        assert_eq!(load(&path).unwrap().keys.len(), 8);
    }

    #[test]
    fn hash_is_stable_known_vector() {
        assert_eq!(
            hash_secret(""),
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(hash_secret("composery_abc"), hash_secret("composery_abc"));
    }

    #[test]
    fn store_file_is_private() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("api/keys.json");
        let mut store = KeyStore::default();
        store.create("ci").unwrap();
        save(&path, &store).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn load_rejects_symlink_store() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("api/keys.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let outside = temp.path().join("outside.json");
        fs::write(&outside, r#"{"version":1,"keys":[]}"#).unwrap();
        symlink(&outside, &path).unwrap();

        let error = load(&path).unwrap_err().to_string();

        assert!(error.contains("open"));
    }

    #[test]
    fn save_rejects_symlink_store() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("api/keys.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let outside = temp.path().join("outside.json");
        fs::write(&outside, "outside").unwrap();
        symlink(&outside, &path).unwrap();

        let error = save(&path, &KeyStore::default()).unwrap_err().to_string();

        assert!(error.contains("real file"));
        assert_eq!(fs::read_to_string(outside).unwrap(), "outside");
    }

    #[test]
    fn save_rejects_symlink_store_parent() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("api/keys.json");
        let outside = temp.path().join("outside-api");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, path.parent().unwrap()).unwrap();

        let error = save(&path, &KeyStore::default()).unwrap_err().to_string();

        assert!(error.contains("real directory"));
        assert!(!outside.join("keys.json").exists());
    }

    #[test]
    fn the_store_path_keeps_the_contract_shape() {
        assert!(store_path().ends_with("api/keys.json"));
    }

    // The prefix preview is what an operator uses to tell one key from another;
    // a wrong length would truncate or leak the secret's start.
    #[test]
    fn the_key_prefix_is_the_prefix_only() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("api/keys.json");
        let mut store = KeyStore::default();
        let new = store.create("ci").unwrap();
        save(&path, &store).unwrap();
        assert_eq!(
            new.record.prefix.len(),
            KEY_PREFIX.len() + 8,
            "prefix was {}",
            new.record.prefix
        );
        assert!(new.secret.starts_with(&new.record.prefix));
    }

    // A wall clock that reports 0 (or 1) seconds past the epoch would stamp
    // every key as created in 1970.
    #[test]
    fn keys_are_stamped_with_the_wall_clock() {
        let mut store = KeyStore::default();
        store.create("ci").unwrap();
        assert!(
            store.keys[0].created_at > 1_700_000_000,
            "created_at was {}",
            store.keys[0].created_at
        );
    }

    // A store path whose parent is a file is an error, not a silent success -
    // otherwise a typo'd volume path would look like a working key store.
    #[test]
    fn ensure_real_file_or_missing_rejects_an_unreachable_parent() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("not-a-dir");
        fs::write(&parent, "file").unwrap();
        let path = parent.join("keys.json");
        assert!(ensure_real_file_or_missing(&path).is_err());
    }
}
