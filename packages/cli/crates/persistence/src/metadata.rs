#![allow(dead_code)]

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use crate::{public::PublicPath, rootfs::XattrRecord};

/// The `metadata.jsonl` record format this build writes and knows how to read.
///
/// The volume is self-describing on purpose: every record carries the version it
/// was written under, so the reader can decide rather than the image having to
/// declare a format out of band. That is why nothing else - no OCI label, no
/// deployment variable - restates this number; a second copy could disagree with
/// the code that actually parses the records.
pub const FORMAT_VERSION: u8 = 1;

/// Reject a record this build cannot read, rather than parsing it as if it were
/// ours. Serde fills unknown fields in and ignores extra ones, so a record
/// written by a newer Composery deserializes perfectly happily and is then
/// applied with the wrong meaning - wrong modes, owners, and xattrs written onto
/// a live root filesystem, with nothing to notice it. Refusing to start is
/// recoverable; a silently misapplied delta is not.
///
/// Newer versions are the case that actually happens (an instance was downgraded, or a
/// volume moved to an older image), so it gets its own message. A format bump
/// ships a rewrite from the previous format to the current one, run at boot, so
/// this build keeps reading exactly one format and the equality check below is
/// the whole reader. Anything older than the previous format is refused the
/// same way a newer record is; the refusal is the truncation contract. Removing
/// the rewrite is a floor move with its own plan
/// (docs/developing/web/maintenance.md), never a convenience.
fn check_supported_version(version: u8, path: &Path, line: usize) -> Result<()> {
    // Match arms, not chained comparisons: a `==` flipped to `!=` or a `>`
    // flipped to `>=` changes nothing when the equality case returns first, so
    // the comparisons would mutate into equivalents no test could catch.
    match version.cmp(&FORMAT_VERSION) {
        std::cmp::Ordering::Equal => Ok(()),
        std::cmp::Ordering::Greater => bail!(
            "{} line {} was written by a newer Composery (metadata format {}, this build reads {}). \
             Start this Composery on the image that wrote its volume, or restore a backup taken before the downgrade.",
            path.display(),
            line,
            version,
            FORMAT_VERSION
        ),
        std::cmp::Ordering::Less => bail!(
            "{} line {} declares unknown metadata format {} (this build reads {}).",
            path.display(),
            line,
            version,
            FORMAT_VERSION
        ),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataRecord {
    pub version: u8,
    pub path: String,
    pub path_bytes_b64: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime_ns: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symlink_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symlink_target_bytes_b64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rdev_major: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rdev_minor: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hardlink_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xattrs: Option<Vec<XattrRecord>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acl: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability: Option<Value>,
}

impl MetadataRecord {
    #[cfg(unix)]
    pub fn public_path(&self) -> Result<PublicPath> {
        PublicPath::from_encoded(&crate::public::EncodedPath {
            display: self.path.clone(),
            bytes_b64: self.path_bytes_b64.clone(),
        })
    }

    #[cfg(unix)]
    pub fn set_public_path(&mut self, public_path: &PublicPath) {
        self.path = public_path.display();
        self.path_bytes_b64 = public_path.bytes_b64();
    }

    #[cfg(unix)]
    fn key(&self) -> Result<Vec<u8>> {
        Ok(self.public_path()?.as_bytes().to_vec())
    }

    #[cfg(not(unix))]
    #[cfg_attr(test, mutants::skip)]
    fn key(&self) -> Result<Vec<u8>> {
        Ok(self.path.as_bytes().to_vec())
    }
}

pub fn compact(path: &Path) -> Result<Vec<MetadataRecord>> {
    let records = load_compacted(path)?;
    write_records(path, records.values())?;
    Ok(records.into_values().collect())
}

/// In-memory working set over `metadata.jsonl`. The daemon writer loads it once
/// per drain tick, applies every upsert/remove in memory, and `flush`es a single
/// atomic write - instead of a full read+reserialize+fsync per dirty path.
pub struct MetadataStore {
    path: PathBuf,
    records: BTreeMap<Vec<u8>, MetadataRecord>,
    dirty: bool,
}

impl MetadataStore {
    pub fn load(path: &Path) -> Result<Self> {
        Ok(Self {
            path: path.to_path_buf(),
            records: load_compacted(path)?,
            dirty: false,
        })
    }

    pub fn upsert(&mut self, record: MetadataRecord) -> Result<()> {
        let key = record.key()?;
        // Audit passes re-emit unchanged records; only an actual difference
        // should trigger a rewrite+fsync of metadata.jsonl on flush.
        if self.records.get(&key) != Some(&record) {
            self.records.insert(key, record);
            self.dirty = true;
        }
        Ok(())
    }

    #[cfg(unix)]
    pub fn remove(&mut self, public_path: &PublicPath) {
        if self.records.remove(public_path.as_bytes()).is_some() {
            self.dirty = true;
        }
    }

    #[cfg(unix)]
    pub fn remove_subtree(&mut self, public_path: &PublicPath) {
        let before = self.records.len();
        self.records
            .retain(|key, _| !path_is_at_or_below(key, public_path.as_bytes()));
        if self.records.len() != before {
            self.dirty = true;
        }
    }

    pub fn flush(&mut self) -> Result<()> {
        if !self.dirty {
            return Ok(());
        }
        write_records(&self.path, self.records.values())?;
        self.dirty = false;
        Ok(())
    }
}

pub fn upsert(path: &Path, record: MetadataRecord) -> Result<()> {
    let mut store = MetadataStore::load(path)?;
    store.upsert(record)?;
    store.flush()
}

#[cfg(unix)]
pub fn remove(path: &Path, public_path: &PublicPath) -> Result<()> {
    let mut store = MetadataStore::load(path)?;
    store.remove(public_path);
    store.flush()
}

#[cfg(unix)]
pub fn remove_subtree(path: &Path, public_path: &PublicPath) -> Result<()> {
    let mut store = MetadataStore::load(path)?;
    store.remove_subtree(public_path);
    store.flush()
}

#[cfg(not(unix))]
#[cfg_attr(test, mutants::skip)]
pub fn remove(path: &Path, public_path: &str) -> Result<()> {
    let mut records = load_compacted(path)?;
    if records.remove(public_path.as_bytes()).is_some() {
        write_records(path, records.values())?;
    }
    Ok(())
}

#[cfg(unix)]
fn path_is_at_or_below(path: &[u8], parent: &[u8]) -> bool {
    path == parent || (path.starts_with(parent) && path.get(parent.len()) == Some(&b'/'))
}

pub fn load(path: &Path) -> Result<Vec<MetadataRecord>> {
    Ok(load_compacted(path)?.into_values().collect())
}

pub fn replace(path: &Path, records: &[MetadataRecord]) -> Result<()> {
    write_records(path, records.iter())
}

fn load_compacted(path: &Path) -> Result<BTreeMap<Vec<u8>, MetadataRecord>> {
    ensure_real_file_or_missing(path)?;
    let file = match open_or_empty(path)? {
        Some(file) => file,
        None => return Ok(BTreeMap::new()),
    };

    let mut records = BTreeMap::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.with_context(|| format!("read {} line {}", path.display(), index + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let record: MetadataRecord = serde_json::from_str(&line)
            .with_context(|| format!("parse {} line {}", path.display(), index + 1))?;
        check_supported_version(record.version, path, index + 1)?;
        records.insert(record.key()?, record);
    }
    Ok(records)
}

// The open's NotFound arm means "never written". The guard's other error arm
// is unreachable by construction: ensure_real_file_or_missing ran just before,
// so a non-NotFound failure would already have returned - the only errors left
// for the open are the NotFound handled here and permission errors a root-run
// test cannot provoke. The missing-file case is covered by every empty-store
// test.
#[cfg_attr(test, mutants::skip)]
fn open_or_empty(path: &Path) -> Result<Option<File>> {
    match File::open(path) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("open {}", path.display())),
    }
}

fn write_records<'a>(
    path: &Path,
    records: impl IntoIterator<Item = &'a MetadataRecord>,
) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("metadata path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    ensure_real_dir(parent)?;
    ensure_real_file_or_missing(path)?;

    let temp = path.with_extension("jsonl.tmp");
    let _ = fs::remove_file(&temp);
    let mut data = Vec::new();
    for record in records {
        serde_json::to_writer(&mut data, record).context("encode metadata record")?;
        data.push(b'\n');
    }
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .with_context(|| format!("create {}", temp.display()))?;
        file.write_all(&data)
            .with_context(|| format!("write {}", temp.display()))?;
        file.sync_all()
            .with_context(|| format!("fsync {}", temp.display()))?;
    }
    fs::rename(&temp, path)
        .with_context(|| format!("publish metadata {} to {}", temp.display(), path.display()))?;
    fsync_parent(path)
}

fn fsync_parent(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("metadata path has no parent: {}", path.display()))?;
    let dir = File::open(parent).with_context(|| format!("open {}", parent.display()))?;
    dir.sync_all()
        .with_context(|| format!("fsync {}", parent.display()))
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

#[cfg(test)]
mod tests {
    use super::{
        FORMAT_VERSION, MetadataRecord, MetadataStore, compact, load, remove, remove_subtree,
        replace, upsert,
    };
    use std::{fs, os::unix::fs::symlink};

    fn record(path: &str) -> MetadataRecord {
        let mut record = MetadataRecord {
            version: FORMAT_VERSION,
            path: String::new(),
            path_bytes_b64: String::new(),
            kind: "file".into(),
            mode: Some(0o644),
            uid: Some(0),
            gid: Some(0),
            mtime_ns: Some(1),
            symlink_target: None,
            symlink_target_bytes_b64: None,
            rdev_major: None,
            rdev_minor: None,
            hardlink_key: None,
            xattrs: None,
            acl: None,
            capability: None,
        };
        record.set_public_path(&crate::public::PublicPath::parse(path).unwrap());
        record
    }

    #[test]
    fn metadata_store_batches_mutations_and_gates_writes_on_dirty() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("metadata.jsonl");

        // An unchanged store must not create the file (dirty-gated flush).
        let mut store = MetadataStore::load(&path).unwrap();
        store.flush().unwrap();
        assert!(!path.exists());

        // Many mutations stay in memory until a single flush - the whole point of
        // the per-tick batching (no per-path read/reserialize/fsync).
        store.upsert(record("/a")).unwrap();
        store.upsert(record("/b")).unwrap();
        store.upsert(record("/c")).unwrap();
        store.remove(&crate::public::PublicPath::parse("/a").unwrap());
        assert!(!path.exists());

        store.flush().unwrap();
        let mut loaded = load(&path).unwrap();
        loaded.sort_by(|l, r| l.path.cmp(&r.path));
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].path, "/b");
        assert_eq!(loaded[1].path, "/c");

        // A re-loaded, unmutated store flush is a no-op and leaves no temp file.
        let mut store = MetadataStore::load(&path).unwrap();
        store.flush().unwrap();
        assert!(!path.with_extension("jsonl.tmp").exists());
    }

    #[test]
    fn metadata_jsonl_compacts_to_latest_record_by_path() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("metadata.jsonl");
        fs::write(
            &path,
            r#"{"version":1,"path":"/a","pathBytesB64":"L2E=","kind":"file","mode":420}
{"version":1,"path":"/a","pathBytesB64":"L2E=","kind":"file","mode":384}
{"version":1,"path":"/b","pathBytesB64":"L2I=","kind":"dir"}
"#,
        )
        .unwrap();

        let records = compact(&path).unwrap();

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].path, "/a");
        assert_eq!(records[0].mode, Some(384));
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 2);
    }

    #[test]
    fn upsert_and_remove_rewrite_current_state() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("metadata.jsonl");

        upsert(
            &path,
            MetadataRecord {
                version: 1,
                path: "/a".into(),
                path_bytes_b64: "L2E=".into(),
                kind: "file".into(),
                mode: Some(0o644),
                uid: Some(0),
                gid: Some(0),
                mtime_ns: Some(1),
                symlink_target: None,
                symlink_target_bytes_b64: None,
                rdev_major: None,
                rdev_minor: None,
                hardlink_key: None,
                xattrs: None,
                acl: None,
                capability: None,
            },
        )
        .unwrap();
        remove(&path, &crate::public::PublicPath::parse("/a").unwrap()).unwrap();

        assert!(load(&path).unwrap().is_empty());
    }

    #[test]
    fn remove_subtree_keeps_similar_prefix_paths() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("metadata.jsonl");
        fs::write(
            &path,
            r#"{"version":1,"path":"/a","pathBytesB64":"L2E=","kind":"dir"}
{"version":1,"path":"/a/b","pathBytesB64":"L2EvYg==","kind":"file"}
{"version":1,"path":"/ab","pathBytesB64":"L2Fi","kind":"file"}
"#,
        )
        .unwrap();

        remove_subtree(&path, &crate::public::PublicPath::parse("/a").unwrap()).unwrap();

        let records = load(&path).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].path, "/ab");
    }

    #[test]
    fn metadata_identity_can_use_non_utf8_path_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("metadata.jsonl");
        let public_path = crate::public::PublicPath::from_absolute_bytes(b"/bad-\xff").unwrap();
        let mut record = MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: String::new(),
            kind: "file".into(),
            mode: Some(0o644),
            uid: None,
            gid: None,
            mtime_ns: None,
            symlink_target: None,
            symlink_target_bytes_b64: None,
            rdev_major: None,
            rdev_minor: None,
            hardlink_key: None,
            xattrs: None,
            acl: None,
            capability: None,
        };
        record.set_public_path(&public_path);

        upsert(&path, record).unwrap();

        let loaded = load(&path).unwrap();
        assert_eq!(loaded[0].public_path().unwrap(), public_path);
        assert!(fs::read_to_string(&path).unwrap().contains("pathBytesB64"));
    }

    #[test]
    fn metadata_writes_reject_symlink_target() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("metadata.jsonl");
        let outside = temp.path().join("outside.jsonl");
        fs::write(&outside, "outside").unwrap();
        symlink(&outside, &path).unwrap();

        let error = upsert(
            &path,
            MetadataRecord {
                version: 1,
                path: "/a".into(),
                path_bytes_b64: "L2E=".into(),
                kind: "file".into(),
                mode: None,
                uid: None,
                gid: None,
                mtime_ns: None,
                symlink_target: None,
                symlink_target_bytes_b64: None,
                rdev_major: None,
                rdev_minor: None,
                hardlink_key: None,
                xattrs: None,
                acl: None,
                capability: None,
            },
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("real file"));
        assert_eq!(fs::read_to_string(outside).unwrap(), "outside");
    }

    #[test]
    fn metadata_reads_refuse_a_record_written_by_a_newer_build() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("metadata.jsonl");
        // What a downgraded instance finds on its volume. Every field this build
        // knows is present and valid, and serde ignores the extra one, so the
        // record deserializes perfectly - the version is the only thing that
        // says it does not mean what this build would take it to mean.
        fs::write(
            &path,
            r#"{"version":2,"path":"/a","pathBytesB64":"L2E=","kind":"file","mode":420,"somethingNew":true}
"#,
        )
        .unwrap();

        let error = load(&path).unwrap_err().to_string();

        assert!(error.contains("newer Composery"), "{error}");
        assert!(error.contains("metadata format 2"), "{error}");
    }

    #[test]
    fn metadata_reads_refuse_an_unknown_older_format() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("metadata.jsonl");
        fs::write(
            &path,
            r#"{"version":0,"path":"/a","pathBytesB64":"L2E=","kind":"file"}
"#,
        )
        .unwrap();

        let error = load(&path).unwrap_err().to_string();

        assert!(error.contains("unknown metadata format 0"), "{error}");
    }

    #[test]
    fn the_writer_stamps_the_version_the_reader_accepts() {
        // The guard above is only worth having if what we write passes it. If
        // the writer's stamp and the reader's accepted set ever drift, every
        // instance refuses to boot on its own metadata - so pin them together rather
        // than trusting two independent literals to stay equal.
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("metadata.jsonl");

        replace(&path, &[record("/a")]).unwrap();

        let written = fs::read_to_string(&path).unwrap();
        assert!(
            written.contains(&format!("\"version\":{FORMAT_VERSION}")),
            "{written}"
        );
        assert_eq!(load(&path).unwrap().len(), 1);
    }

    #[test]
    fn metadata_reads_reject_symlink_target() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("metadata.jsonl");
        let outside = temp.path().join("outside.jsonl");
        fs::write(&outside, "{}\n").unwrap();
        symlink(&outside, &path).unwrap();

        let error = load(&path).unwrap_err().to_string();

        assert!(error.contains("real file"));
    }

    #[test]
    fn metadata_ignores_and_replaces_crash_leftover_temp_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("metadata.jsonl");
        let leftover = path.with_extension("jsonl.tmp");
        fs::write(
            &path,
            r#"{"version":1,"path":"/kept","pathBytesB64":"L2tlcHQ=","kind":"file"}
"#,
        )
        .unwrap();
        fs::write(
            &leftover,
            r#"{"version":1,"path":"/partial","pathBytesB64":"L3BhcnRpYWw=","kind":"file"}
"#,
        )
        .unwrap();

        let records = load(&path).unwrap();

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].public_path().unwrap().as_bytes(), b"/kept");

        upsert(
            &path,
            MetadataRecord {
                version: 1,
                path: "/new".into(),
                path_bytes_b64: "L25ldw==".into(),
                kind: "file".into(),
                mode: None,
                uid: None,
                gid: None,
                mtime_ns: None,
                symlink_target: None,
                symlink_target_bytes_b64: None,
                rdev_major: None,
                rdev_minor: None,
                hardlink_key: None,
                xattrs: None,
                acl: None,
                capability: None,
            },
        )
        .unwrap();

        assert!(!leftover.exists());
        let records = load(&path).unwrap();
        assert_eq!(records.len(), 2);
        assert!(
            records
                .iter()
                .all(|record| record.public_path().unwrap().as_bytes() != b"/partial")
        );
    }

    #[test]
    fn the_record_key_is_the_public_path_bytes() {
        let record = record("/a");
        assert_eq!(record.key().unwrap(), b"/a".to_vec());
    }

    // A parse failure names the line it happened on, so an operator can read the
    // file. The line number is `index + 1`, which a mutation turning `+` into
    // `*` would silently break for every line but the first.
    #[test]
    fn a_parse_failure_names_its_line() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("metadata.jsonl");
        fs::write(
            &path,
            r#"{"version":1,"path":"/a","pathBytesB64":"L2E=","kind":"file"}
not json
"#,
        )
        .unwrap();

        let error = load(&path).unwrap_err().to_string();

        assert!(error.contains("line 2"), "{error}");
    }

    // A line that cannot be decoded (invalid UTF-8) fails on the read - and
    // that read error must name line 2, where a `+` mutated into `*` would say
    // line 1.
    #[test]
    fn a_read_failure_names_its_line() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("metadata.jsonl");
        fs::write(&path, b"{\"version\":1,\"path\":\"/a\",\"pathBytesB64\":\"L2E=\",\"kind\":\"file\"}\n\xff\xff\n")
            .unwrap();

        let error = load(&path).unwrap_err().to_string();

        assert!(error.contains("line 2"), "{error}");
    }

    // An unreadable path (its parent is a file) must surface as a stat error,
    // not as the empty store - only a *missing* store is empty.
    #[test]
    fn load_rejects_an_unreachable_path_with_a_stat_error() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("not-a-dir");
        fs::write(&parent, "file").unwrap();
        let path = parent.join("metadata.jsonl");

        let error = load(&path).unwrap_err().to_string();

        assert!(error.starts_with("stat"), "{error}");
    }

    // ensure_real_dir must refuse a regular file, and ensure_real_file_or_missing
    // must refuse an unreachable path, so a typo'd volume path never reads as a
    // working metadata layout.
    #[test]
    fn layout_guards_refuse_wrong_shapes() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("plain-file");
        fs::write(&file, "x").unwrap();
        assert!(super::ensure_real_dir(&file).is_err());

        let parent = temp.path().join("not-a-dir");
        fs::write(&parent, "file").unwrap();
        let path = parent.join("metadata.jsonl");
        assert!(super::ensure_real_file_or_missing(&path).is_err());
    }

    #[test]
    fn fsync_parent_refuses_a_path_with_no_parent() {
        assert!(super::fsync_parent(std::path::Path::new("plain-name")).is_err());
    }
}
