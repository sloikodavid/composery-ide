//! SSH certificates this instance has issued.
//!
//! Cross-language contract: the TS module in
//! `packages/ide/overlay/src/node/ssh/certificates.ts` writes this same
//! `<volume>/ssh/certificates.json` when it issues one during enrollment, and
//! reads nothing else. Path, the `{ version, certificates: [...] }` shape and the
//! millisecond timestamps must stay identical on both sides;
//! `tests/invariants/keystore-contract.test.ts` pins the pair.
//!
//! Issuing lives on the TS side because enrollment is an HTTP route and has to
//! issue inline. Listing and revoking live here because they need no network at
//! all - being able to open the editor is already the authorization.

use anyhow::{Context, Result};
use persistence::paths::volume_root;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CertificateRecord {
    pub serial: u64,
    pub name: String,
    pub created_at: u64,
    pub expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CertificateStore {
    pub version: u32,
    pub certificates: Vec<CertificateRecord>,
}

impl Default for CertificateStore {
    fn default() -> Self {
        Self {
            version: 1,
            certificates: Vec::new(),
        }
    }
}

pub fn store_path() -> PathBuf {
    volume_root().join("ssh").join("certificates.json")
}

pub fn authority_path() -> PathBuf {
    volume_root().join("ssh").join("ca")
}

pub fn revocation_list_path() -> PathBuf {
    volume_root().join("ssh").join("krl")
}

pub fn load(path: &Path) -> Result<CertificateStore> {
    match fs::read(path) {
        Ok(data) => {
            serde_json::from_slice(&data).with_context(|| format!("parse {}", path.display()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(CertificateStore::default())
        }
        Err(error) => Err(error).with_context(|| format!("open {}", path.display())),
    }
}

pub fn save(path: &Path, store: &CertificateStore) -> Result<()> {
    let mut data = serde_json::to_vec_pretty(store).context("encode certificate store")?;
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
        file.sync_all()
            .with_context(|| format!("fsync {}", temp.display()))?;
    }
    fs::rename(&temp, path)
        .with_context(|| format!("publish {} to {}", temp.display(), path.display()))
}

/// Mark one certificate revoked. Returns false when the serial is unknown or was
/// already revoked, so the caller can say so rather than report a no-op as done.
pub fn revoke(store: &mut CertificateStore, serial: u64, now_ms: u64) -> bool {
    match store
        .certificates
        .iter_mut()
        .find(|record| record.serial == serial && record.revoked_at.is_none())
    {
        Some(record) => {
            record.revoked_at = Some(now_ms);
            true
        }
        None => false,
    }
}

/// The KRL specification `ssh-keygen -k` reads: one `serial:` line per revoked
/// certificate.
///
/// Rebuilt from the whole revoked set rather than appended to. An incremental
/// update that failed halfway would leave a list nobody can reason about, and
/// rebuilding is idempotent - the file always says exactly what the records say.
pub fn revocation_specification(store: &CertificateStore) -> String {
    let mut lines: Vec<String> = store
        .certificates
        .iter()
        .filter(|record| record.revoked_at.is_some())
        .map(|record| format!("serial: {}", record.serial))
        .collect();
    lines.push(String::new());
    lines.join("\n")
}

pub fn write_revocation_list(store: &CertificateStore) -> Result<()> {
    let specification_path = revocation_list_path().with_extension("spec");
    fs::write(&specification_path, revocation_specification(store))
        .with_context(|| format!("write {}", specification_path.display()))?;

    let authority = format!("{}.pub", authority_path().display());
    let status = Command::new("ssh-keygen")
        .arg("-q")
        .arg("-k")
        .arg("-f")
        .arg(revocation_list_path())
        .arg("-s")
        .arg(&authority)
        .arg(&specification_path)
        .status()
        .context("run ssh-keygen to rebuild the revocation list")?;
    let _ = fs::remove_file(&specification_path);

    if !status.success() {
        anyhow::bail!("ssh-keygen could not rebuild the revocation list");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(serial: u64, revoked: Option<u64>) -> CertificateRecord {
        CertificateRecord {
            serial,
            name: format!("device {serial}"),
            created_at: 0,
            expires_at: 0,
            revoked_at: revoked,
        }
    }

    // The paths are the cross-language contract the TS side reads (see the
    // module header); asserted by suffix so the volume-root override env var
    // cannot make the test machine-dependent.
    #[test]
    fn store_paths_keep_the_contract_shape() {
        assert!(store_path().ends_with("ssh/certificates.json"));
        assert!(authority_path().ends_with("ssh/ca"));
        assert!(revocation_list_path().ends_with("ssh/krl"));
    }

    #[test]
    fn revoking_marks_only_the_named_serial() {
        let mut store = CertificateStore {
            version: 1,
            certificates: vec![record(1, None), record(2, None)],
        };
        assert!(revoke(&mut store, 2, 99));
        assert_eq!(store.certificates[0].revoked_at, None);
        assert_eq!(store.certificates[1].revoked_at, Some(99));
    }

    #[test]
    fn revoking_an_unknown_or_already_revoked_serial_reports_no_change() {
        let mut store = CertificateStore {
            version: 1,
            certificates: vec![record(1, Some(5))],
        };
        assert!(!revoke(&mut store, 1, 99));
        assert!(!revoke(&mut store, 7, 99));
    }

    // The list is what sshd reads. A revoked certificate missing from it still
    // works, which is the failure this must not have.
    #[test]
    fn the_specification_names_every_revoked_serial_and_no_others() {
        let store = CertificateStore {
            version: 1,
            certificates: vec![record(1, Some(5)), record(2, None), record(3, Some(6))],
        };
        let specification = revocation_specification(&store);
        assert!(specification.contains("serial: 1"));
        assert!(specification.contains("serial: 3"));
        assert!(!specification.contains("serial: 2"));
    }

    #[test]
    fn an_empty_store_produces_an_empty_specification() {
        assert_eq!(
            revocation_specification(&CertificateStore::default()).trim(),
            ""
        );
    }

    #[test]
    fn a_never_revoked_record_serializes_without_the_field() {
        let encoded = serde_json::to_string(&record(1, None)).expect("encode");
        assert!(!encoded.contains("revoked_at"));
        let decoded: CertificateRecord = serde_json::from_str(&encoded).expect("decode");
        assert_eq!(decoded.revoked_at, None);
    }

    #[test]
    fn load_reads_a_written_store() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("certificates.json");
        let store = CertificateStore {
            version: 1,
            certificates: vec![record(7, None)],
        };
        save(&path, &store).unwrap();

        let loaded = load(&path).unwrap();
        assert_eq!(loaded, store);
    }

    #[test]
    fn load_reports_a_missing_store_as_empty() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("certificates.json");
        assert_eq!(load(&path).unwrap(), CertificateStore::default());
    }

    // A store that exists but cannot be parsed must be an error, not a silent
    // empty store - the empty case is reserved for "never written".
    #[test]
    fn load_rejects_garbage_as_an_error() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("certificates.json");
        std::fs::write(&path, "not json").unwrap();
        assert!(load(&path).is_err());
    }

    // An unreadable path (its parent is a file) must be an error, not the
    // empty store - only a *missing* store is "never written".
    #[test]
    fn load_rejects_an_unreadable_path_as_an_error() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("not-a-dir");
        std::fs::write(&parent, "file").unwrap();
        let path = parent.join("certificates.json");
        assert!(load(&path).is_err());
    }

    // save must fail when the destination cannot exist, so a call that reports
    // success can be trusted.
    #[test]
    fn save_fails_when_the_parent_is_a_file() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("not-a-dir");
        std::fs::write(&parent, "file").unwrap();
        let path = parent.join("certificates.json");
        assert!(save(&path, &CertificateStore::default()).is_err());
    }

    // The revocation list is rebuilt by ssh-keygen signed with the CA key.
    // With no CA public key to sign with, ssh-keygen must fail and the write
    // must report it - a revoke that silently keeps the old list is the exact
    // failure this guards against.
    #[test]
    fn write_revocation_list_fails_without_the_ca_key() {
        let temp = tempfile::tempdir().unwrap();
        let volume = temp.path().join("volume");
        unsafe { std::env::set_var("COMPOSERY_DOCKER_VOLUME_PATH", &volume) };
        std::fs::create_dir_all(volume.join("ssh")).unwrap();

        let mut store = CertificateStore::default();
        store.certificates.push(record(1, Some(9)));
        let result = write_revocation_list(&store);

        unsafe { std::env::remove_var("COMPOSERY_DOCKER_VOLUME_PATH") };
        assert!(result.is_err());
    }
}
