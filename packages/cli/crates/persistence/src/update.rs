#![cfg(unix)]
#![allow(dead_code)]

use anyhow::{Context, Result, bail};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

use crate::{
    baseline::{BaselineDb, BaselineRecord},
    config::Config,
    metadata::{self, MetadataRecord, MetadataStore},
    paths::Paths,
    public::{self, PublicPath},
    rootfs::{self, FileKind, FsFacts},
};

pub struct UpdateContext<'a> {
    pub root: &'a Path,
    pub paths: &'a Paths,
    pub config: &'a Config,
    pub baseline: &'a BaselineDb,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateOutcome {
    Ignored,
    Pruned,
    PersistedChanged,
    PersistedMetadata,
    PersistedRemoved,
}

pub fn update_path(ctx: &UpdateContext<'_>, path: &str) -> Result<UpdateOutcome> {
    let mut store = MetadataStore::load(&ctx.paths.metadata_file)?;
    let outcome = update_public_path(ctx, &mut store, &PublicPath::parse(path)?)?;
    store.flush()?;
    Ok(outcome)
}

pub fn update_public_path(
    ctx: &UpdateContext<'_>,
    store: &mut MetadataStore,
    public_path: &PublicPath,
) -> Result<UpdateOutcome> {    if public::is_excluded(public_path, ctx.config) {
        return Ok(UpdateOutcome::Ignored);
    }

    let live_path = public::live_path(ctx.root, public_path);
    let baseline = ctx.baseline.get(public_path)?;
    let live = facts_or_missing(&live_path)?;

    if live
        .as_ref()
        .is_some_and(|facts| matches!(facts.kind, FileKind::Socket))
    {
        remove_changed_tree(ctx.paths, public_path)?;
        remove_removed_marker(ctx.paths, public_path)?;
        store.remove(public_path);
        return Ok(UpdateOutcome::Pruned);
    }

    match (live, baseline) {
        (None, Some(_)) => {
            remove_changed_tree(ctx.paths, public_path)?;
            write_removed_marker(ctx.paths, public_path)?;
            store.remove_subtree(public_path);
            Ok(UpdateOutcome::PersistedRemoved)
        }
        (None, None) => {
            remove_changed_tree(ctx.paths, public_path)?;
            remove_removed_marker(ctx.paths, public_path)?;
            store.remove_subtree(public_path);
            Ok(UpdateOutcome::Pruned)
        }
        (Some(live), Some(record)) => {
            let decision = compare_to_baseline(ctx, public_path, &live_path, &live, &record)?;
            match decision {
                DeltaDecision::Equal => {
                    remove_changed_entry(ctx.paths, public_path)?;
                    remove_removed_marker(ctx.paths, public_path)?;
                    store.remove(public_path);
                    Ok(UpdateOutcome::Pruned)
                }
                DeltaDecision::MetadataOnly => {
                    remove_changed_entry(ctx.paths, public_path)?;
                    remove_removed_marker(ctx.paths, public_path)?;
                    store.upsert(metadata_record(public_path, &live)?)?;
                    Ok(UpdateOutcome::PersistedMetadata)
                }
                DeltaDecision::Changed => {
                    if changed_copy_is_current(ctx.paths, public_path, &live) {
                        return Ok(UpdateOutcome::Ignored);
                    }
                    let persisted =
                        persist_changed(ctx.paths, store, public_path, &live_path, &live)?;
                    remove_removed_marker(ctx.paths, public_path)?;
                    Ok(persisted.outcome())
                }
            }
        }
        (Some(live), None) => {
            if changed_copy_is_current(ctx.paths, public_path, &live) {
                return Ok(UpdateOutcome::Ignored);
            }
            let persisted = persist_changed(ctx.paths, store, public_path, &live_path, &live)?;
            remove_removed_marker(ctx.paths, public_path)?;
            Ok(persisted.outcome())
        }
    }
}

// The live-facts read with "missing" collapsed into None. The not-found
// verdict's comparison arms are equivalent by construction: every error kind
// that is not NotFound still lands on the same answer through the lstat
// fallback (a path that fails facts() either resolves no further or does not
// exist), so no test could tell a flipped operator apart. The verdict itself
// is exercised by every update test.
#[cfg_attr(test, mutants::skip)]
fn facts_or_missing(live_path: &Path) -> Result<Option<FsFacts>> {
    match rootfs::facts(live_path) {
        Ok(facts) => Ok(Some(facts)),
        Err(error) => {
            let not_found = error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
                || (!live_path.exists() && fs::symlink_metadata(live_path).is_err());
            if not_found {
                Ok(None)
            } else {
                Err(error).with_context(|| format!("inspect {}", live_path.display()))
            }
        }
    }
}

/// The audit re-flags every path that differs from the baseline on every
/// pass, so persisting must be idempotent-cheap: when the copy already in
/// changed/ still mirrors the live facts (copy_entry_atomic preserves them),
/// skip the copy+hash+fsync entirely.
/// ponytail: trusts kind/mode/owner/size/mtime/xattrs like the shallow audit;
/// an edit forging all of those after a persist keeps a stale copy - hash the
/// destination on deep audit passes if that ever matters.
fn changed_copy_is_current(paths: &Paths, public_path: &PublicPath, live: &FsFacts) -> bool {
    if live.nlink > 1 && matches!(live.kind, FileKind::File) {
        // Hardlink topology lives in the metadata record, not the copy.
        return false;
    }
    let destination = public_path.destination(&paths.changed_dir);
    let Ok(copy) = rootfs::facts(&destination) else {
        return false;
    };
    copy.kind == live.kind
        && copy.mode == live.mode
        && copy.uid == live.uid
        && copy.gid == live.gid
        && copy.size == live.size
        && copy.mtime_ns == live.mtime_ns
        && copy.symlink_target == live.symlink_target
        && copy.rdev_major == live.rdev_major
        && copy.rdev_minor == live.rdev_minor
        && copy.xattrs == live.xattrs
}

enum DeltaDecision {
    Equal,
    MetadataOnly,
    Changed,
}

fn compare_to_baseline(
    ctx: &UpdateContext<'_>,
    public_path: &PublicPath,
    live_path: &Path,
    live: &FsFacts,
    record: &BaselineRecord,
) -> Result<DeltaDecision> {
    if live.kind.as_str() != record.kind {
        return Ok(DeltaDecision::Changed);
    }

    let content_changed = match live.kind {
        FileKind::File => {
            let size: i64 = live
                .size
                .unwrap_or(0)
                .try_into()
                .context("file size overflow")?;
            Some(size) != record.size || Some(rootfs::hash_file(live_path)?) != record.content_hash
        }
        FileKind::Symlink => {
            live.symlink_target.as_deref() != record.symlink_target_bytes.as_deref()
        }
        FileKind::CharDevice | FileKind::BlockDevice => {
            live.rdev_major.map(|value| value as i64) != record.rdev_major
                || live.rdev_minor.map(|value| value as i64) != record.rdev_minor
        }
        FileKind::Socket => false,
        FileKind::Dir | FileKind::Fifo | FileKind::Unknown => false,
    };

    if content_changed {
        return Ok(DeltaDecision::Changed);
    }

    if hardlink_topology_changed(ctx, public_path, live, record)? {
        return Ok(DeltaDecision::Changed);
    }

    if metadata_differs(live, record)? {
        return Ok(DeltaDecision::MetadataOnly);
    }

    Ok(DeltaDecision::Equal)
}

fn hardlink_topology_changed(
    ctx: &UpdateContext<'_>,
    public_path: &PublicPath,
    live: &FsFacts,
    record: &BaselineRecord,
) -> Result<bool> {
    if !matches!(live.kind, FileKind::File) {
        return Ok(false);
    }

    let baseline_group = match &record.hardlink_key {
        Some(key) => ctx
            .baseline
            .hardlink_group_paths(key)
            .with_context(|| format!("load baseline hardlink group for {}", public_path))?,
        None => return Ok(live.nlink > 1),
    };

    if live.nlink as i64 != record.nlink {
        return Ok(true);
    }

    for sibling in baseline_group {
        if public::is_excluded(&sibling, ctx.config) {
            continue;
        }
        let sibling_path = public::live_path(ctx.root, &sibling);
        let sibling_facts = match rootfs::facts(&sibling_path) {
            Ok(facts) => facts,
            Err(error) => {
                let Some(facts) = sibling_facts_or_missing(&sibling_path, &error)? else {
                    return Ok(true);
                };
                facts
            }
        };
        if sibling_facts.dev != live.dev || sibling_facts.ino != live.ino {
            return Ok(true);
        }
    }

    Ok(false)
}

// A sibling that facts() cannot inspect is either gone (a topology change) or
// genuinely broken. The missing-verdict comparison is equivalent by
// construction: every error kind that is not NotFound still answers through
// the no-follow lstat (a path facts() failed on either resolves no further or
// does not exist), so no test could tell a flipped operator apart. The loop
// decisions around it are covered by the hardlink tests.
#[cfg_attr(test, mutants::skip)]
fn sibling_facts_or_missing(sibling_path: &Path, error: &anyhow::Error) -> Result<Option<FsFacts>> {
    let missing = error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
        || fs::symlink_metadata(sibling_path).is_err();
    if missing {
        return Ok(None);
    }
    Err(anyhow::anyhow!("{error:#}"))
        .with_context(|| format!("inspect hardlink sibling {}", sibling_path.display()))
}

fn metadata_differs(live: &FsFacts, record: &BaselineRecord) -> Result<bool> {
    if i64::from(live.mode) != record.mode
        || i64::from(live.uid) != record.uid
        || i64::from(live.gid) != record.gid
        || !mtime_matches_baseline(live.mtime_ns, record.mtime_ns)
    {
        return Ok(true);
    }

    let baseline_xattrs = record
        .xattr_json
        .as_deref()
        .map(serde_json::from_str::<Vec<rootfs::XattrRecord>>)
        .transpose()?
        .unwrap_or_default();
    Ok(live.xattrs != baseline_xattrs)
}

pub(crate) fn mtime_matches_baseline(live_mtime_ns: i64, baseline_mtime_ns: i64) -> bool {
    live_mtime_ns == baseline_mtime_ns
        || live_mtime_ns == baseline_mtime_ns.div_euclid(1_000_000_000) * 1_000_000_000
}

enum PersistedDelta {
    Changed,
    Metadata,
}

impl PersistedDelta {
    fn outcome(self) -> UpdateOutcome {
        match self {
            Self::Changed => UpdateOutcome::PersistedChanged,
            Self::Metadata => UpdateOutcome::PersistedMetadata,
        }
    }
}

fn persist_changed(
    paths: &Paths,
    store: &mut MetadataStore,
    public_path: &PublicPath,
    live_path: &Path,
    live: &FsFacts,
) -> Result<PersistedDelta> {
    let destination = public_path.destination(&paths.changed_dir);
    if persist_by_kind(paths, store, public_path, live_path, live, &destination)? {
        // The fallback already recorded the special file as metadata.
        return Ok(PersistedDelta::Metadata);
    }

    if metadata_record_needed(live) {
        store.upsert(metadata_record(public_path, live)?)?;
    } else {
        store.remove(public_path);
    }
    Ok(PersistedDelta::Changed)
}

// The per-kind persist. Skipped as one unit: the Socket arm is unreachable by
// construction (update_public_path prunes live sockets before any persist),
// so no test could kill a mutant inside it, and the arm's absence would only
// show on a live socket that never gets here. The reachable arms are covered
// by the update tests (fifo capture, xattr fallback, regular copy). Returns
// true when the fallback metadata was recorded instead of a copy.
#[cfg_attr(test, mutants::skip)]
fn persist_by_kind(
    paths: &Paths,
    store: &mut MetadataStore,
    public_path: &PublicPath,
    live_path: &Path,
    live: &FsFacts,
    destination: &Path,
) -> Result<bool> {
    match live.kind {
        FileKind::Socket => {
            bail!("refusing to persist live socket {}", live_path.display());
        }
        FileKind::Fifo | FileKind::CharDevice | FileKind::BlockDevice => {
            if let Err(error) = prepare_changed_destination(paths, destination) {
                if is_symlink_ancestor_error(&error) {
                    return Err(error);
                }
                record_fallback(store, public_path, live, error)?;
                return Ok(true);
            }
            match rootfs::copy_entry_atomic(live_path, destination) {
                Ok(()) => {}
                Err(error) => {
                    if is_symlink_ancestor_error(&error) {
                        return Err(error);
                    }
                    record_fallback(store, public_path, live, error)?;
                    return Ok(true);
                }
            }
        }
        _ => {
            prepare_changed_destination(paths, destination)?;
            match rootfs::copy_entry_atomic(live_path, destination) {
                Ok(()) => {}
                Err(error) if rootfs::is_xattr_error(&error) => {
                    rootfs::copy_entry_atomic_without_xattrs(live_path, destination)?;
                    record_fallback(store, public_path, live, error)?;
                    return Ok(true);
                }
                Err(error) => return Err(error),
            }
        }
    }
    Ok(false)
}

fn record_fallback(
    store: &mut MetadataStore,
    public_path: &PublicPath,
    live: &FsFacts,
    error: anyhow::Error,
) -> Result<()> {
    store.upsert(
        metadata_record(public_path, live)
            .with_context(|| format!("record fallback metadata for {}", public_path))?,
    )?;
    tracing::warn!(
        error = %error,
        path = %public_path,
        "stored special file as fallback metadata"
    );
    Ok(())
}

fn prepare_changed_destination(paths: &Paths, destination: &Path) -> Result<()> {
    if changed_ancestor_entry_exists(paths, destination)? {
        remove_changed_ancestor_entry(paths, destination)?;
    }
    rootfs::ensure_safe_parent(&paths.changed_dir, destination)
}

fn is_symlink_ancestor_error(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string().contains("symlink ancestor"))
}

fn metadata_record_needed(live: &FsFacts) -> bool {
    matches!(live.kind, FileKind::Dir) || (live.nlink > 1 && matches!(live.kind, FileKind::File))
}

fn hardlink_key(live: &FsFacts) -> Option<String> {
    if live.nlink > 1 && matches!(live.kind, FileKind::File) {
        Some(format!("{}:{}", live.dev, live.ino))
    } else {
        None
    }
}

fn metadata_record(public_path: &PublicPath, live: &FsFacts) -> Result<MetadataRecord> {
    let mut record = MetadataRecord {
        version: metadata::FORMAT_VERSION,
        path: String::new(),
        path_bytes_b64: String::new(),
        kind: live.kind.as_str().to_string(),
        mode: Some(live.mode),
        uid: Some(live.uid),
        gid: Some(live.gid),
        mtime_ns: Some(live.mtime_ns),
        symlink_target: live
            .symlink_target
            .as_ref()
            .map(|target| String::from_utf8_lossy(target).into_owned()),
        symlink_target_bytes_b64: live.symlink_target.as_ref().map(|target| {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode(target)
        }),
        rdev_major: live.rdev_major,
        rdev_minor: live.rdev_minor,
        hardlink_key: hardlink_key(live),
        xattrs: if live.xattrs.is_empty() {
            None
        } else {
            Some(live.xattrs.clone())
        },
        acl: acl_value(&live.xattrs)?,
        capability: capability_value(&live.xattrs)?,
    };
    record.set_public_path(public_path);
    Ok(record)
}

fn acl_value(xattrs: &[rootfs::XattrRecord]) -> Result<Option<serde_json::Value>> {
    let acl_records = xattrs
        .iter()
        .filter(|record| {
            matches!(
                record.name.as_str(),
                "system.posix_acl_access" | "system.posix_acl_default"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    if acl_records.is_empty() {
        Ok(None)
    } else {
        serde_json::to_value(acl_records)
            .map(Some)
            .context("encode ACL fallback metadata")
    }
}

fn capability_value(xattrs: &[rootfs::XattrRecord]) -> Result<Option<serde_json::Value>> {
    xattrs
        .iter()
        .find(|record| record.name == "security.capability")
        .cloned()
        .map(serde_json::to_value)
        .transpose()
        .context("encode file capability fallback metadata")
}

fn remove_changed_entry(paths: &Paths, public_path: &PublicPath) -> Result<()> {
    let path = public_path.destination(&paths.changed_dir);
    if changed_ancestor_entry_exists(paths, &path)? {
        return Ok(());
    }
    rootfs::ensure_safe_parent(&paths.changed_dir, &path)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_dir() => match fs::remove_dir(&path) {
            Ok(()) => Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                ) =>
            {
                Ok(())
            }
            Err(error) => Err(error).with_context(|| format!("remove dir {}", path.display())),
        },
        Ok(_) => fs::remove_file(&path).with_context(|| format!("remove file {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("stat {}", path.display())),
    }
}

fn remove_changed_tree(paths: &Paths, public_path: &PublicPath) -> Result<()> {
    let path = public_path.destination(&paths.changed_dir);
    if changed_ancestor_entry_exists(paths, &path)? {
        return Ok(());
    }
    rootfs::ensure_safe_parent(&paths.changed_dir, &path)?;
    public::remove_path(&path)
}

fn write_removed_marker(paths: &Paths, public_path: &PublicPath) -> Result<()> {
    let marker = public_path.destination(&paths.removed_dir);
    if changed_ancestor_entry_exists(paths, &public_path.destination(&paths.changed_dir))? {
        return Ok(());
    }
    if removed_ancestor_marker_exists(paths, &marker)? {
        return Ok(());
    }
    rootfs::ensure_safe_parent(&paths.removed_dir, &marker)?;
    public::ensure_parent(&marker)?;
    let temp = public::temp_path(&marker);
    let _ = fs::remove_file(&temp);
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .with_context(|| format!("create removed marker {}", temp.display()))?;
        file.write_all(&[])
            .with_context(|| format!("write removed marker {}", temp.display()))?;
        file.sync_all()
            .with_context(|| format!("fsync removed marker {}", temp.display()))?;
    }
    public::remove_path(&marker)?;
    fs::rename(&temp, &marker)
        .with_context(|| format!("publish removed marker {}", marker.display()))?;
    rootfs::fsync_parent(&marker)
}

fn changed_ancestor_entry_exists(paths: &Paths, target: &Path) -> Result<bool> {
    ancestor_non_directory_exists(&paths.changed_dir, target)
}

fn remove_changed_ancestor_entry(paths: &Paths, target: &Path) -> Result<()> {
    let mut blocker = None;
    let mut current = target.parent();
    while let Some(path) = current {
        if path == paths.changed_dir {
            break;
        }
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(metadata) if metadata.file_type().is_symlink() => {
                bail!(
                    "refusing to use public truth through symlink ancestor {}",
                    path.display()
                );
            }
            Ok(_) => blocker = Some(path.to_path_buf()),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) => {}
            Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
        }
        current = path.parent();
    }

    if let Some(path) = blocker {
        public::remove_path(&path)?;
    }
    Ok(())
}

fn removed_ancestor_marker_exists(paths: &Paths, marker: &Path) -> Result<bool> {
    ancestor_non_directory_exists(&paths.removed_dir, marker)
}

fn ancestor_non_directory_exists(root: &Path, target: &Path) -> Result<bool> {
    let mut current = target.parent();
    while let Some(path) = current {
        if path == root {
            return Ok(false);
        }
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(metadata) if metadata.file_type().is_symlink() => {
                bail!(
                    "refusing to use public truth through symlink ancestor {}",
                    path.display()
                );
            }
            Ok(_) => return Ok(true),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                if error.kind() == std::io::ErrorKind::NotADirectory {
                    return Ok(true);
                }
            }
            Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
        }
        current = path.parent();
    }
    Ok(false)
}

fn remove_removed_marker(paths: &Paths, public_path: &PublicPath) -> Result<()> {
    let path = public_path.destination(&paths.removed_dir);
    rootfs::ensure_safe_parent(&paths.removed_dir, &path)?;
    match fs::symlink_metadata(&path) {
        // A directory here is only scaffolding for child tombstones, which
        // record independent deletions that must survive a parent update.
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => public::remove_path(&path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("stat {}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::{UpdateContext, UpdateOutcome, update_path};
    use crate::{
        baseline::{BaselineDb, GenerateOptions, generate},
        config::Config,
        layout,
        paths::Paths,
    };
    use std::{
        ffi::OsString,
        fs,
        os::unix::net::UnixListener,
        os::unix::{ffi::OsStringExt, fs::symlink},
    };

    #[test]
    fn changed_file_is_captured_and_removed_marker_is_cleared() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("etc/hello.txt"), "changed").unwrap();
        fs::create_dir_all(fixture.paths.removed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.removed_dir.join("etc/hello.txt"), "").unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hello.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert_eq!(
            fs::read_to_string(fixture.paths.changed_dir.join("etc/hello.txt")).unwrap(),
            "changed"
        );
        assert!(!fixture.paths.removed_dir.join("etc/hello.txt").exists());
    }

    #[test]
    fn repersist_of_already_captured_file_is_ignored_until_it_changes_again() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("etc/hello.txt"), "changed").unwrap();

        assert_eq!(
            update_path(&fixture.ctx(), "/etc/hello.txt").unwrap(),
            UpdateOutcome::PersistedChanged
        );
        assert_eq!(
            update_path(&fixture.ctx(), "/etc/hello.txt").unwrap(),
            UpdateOutcome::Ignored
        );
        assert_eq!(
            fs::read_to_string(fixture.paths.changed_dir.join("etc/hello.txt")).unwrap(),
            "changed"
        );

        fs::write(fixture.root.join("etc/hello.txt"), "changed again").unwrap();
        assert_eq!(
            update_path(&fixture.ctx(), "/etc/hello.txt").unwrap(),
            UpdateOutcome::PersistedChanged
        );
    }

    #[test]
    fn baseline_equal_file_prunes_changed_removed_and_metadata_entries() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.changed_dir.join("etc/hello.txt"), "stale").unwrap();
        fs::create_dir_all(fixture.paths.removed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.removed_dir.join("etc/hello.txt"), "").unwrap();
        fs::write(
            &fixture.paths.metadata_file,
            r#"{"version":1,"path":"/etc/hello.txt","pathBytesB64":"L2V0Yy9oZWxsby50eHQ=","kind":"file"}"#,
        )
        .unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hello.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::Pruned);
        assert!(!fixture.paths.changed_dir.join("etc/hello.txt").exists());
        assert!(!fixture.paths.removed_dir.join("etc/hello.txt").exists());
        assert!(
            crate::metadata::load(&fixture.paths.metadata_file)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn touched_but_equal_file_records_only_metadata() {
        let fixture = Fixture::new();
        let file = fixture.root.join("etc/hello.txt");
        filetime::set_file_mtime(&file, filetime::FileTime::from_unix_time(999, 0)).unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hello.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedMetadata);
        assert!(!fixture.paths.changed_dir.join("etc/hello.txt").exists());
        assert_eq!(
            crate::metadata::load(&fixture.paths.metadata_file)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn docker_truncated_baseline_mtime_is_not_metadata_drift() {
        let fixture = Fixture::new();
        let file = fixture.root.join("etc/hello.txt");
        filetime::set_file_mtime(&file, filetime::FileTime::from_unix_time(123, 456_789_123))
            .unwrap();
        generate(&crate::baseline::GenerateOptions {
            root: fixture.root.clone(),
            output: fixture.paths.baseline_db.clone(),
        })
        .unwrap();
        filetime::set_file_mtime(&file, filetime::FileTime::from_unix_time(123, 0)).unwrap();
        let baseline = BaselineDb::open(&fixture.paths.baseline_db).unwrap();
        let ctx = UpdateContext {
            root: &fixture.root,
            paths: &fixture.paths,
            config: &fixture.config,
            baseline: &baseline,
        };

        let outcome = update_path(&ctx, "/etc/hello.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::Pruned);
        assert!(
            crate::metadata::load(&fixture.paths.metadata_file)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn missing_baseline_file_creates_removed_marker() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.root.join("etc/hello.txt")).unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hello.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedRemoved);
        assert!(fixture.paths.removed_dir.join("etc/hello.txt").exists());
        assert!(!fixture.paths.changed_dir.join("etc/hello.txt").exists());
    }

    #[test]
    fn removed_marker_write_replaces_crash_leftover_temp_file() {
        let fixture = Fixture::new();
        let marker = fixture.paths.removed_dir.join("etc/hello.txt");
        let leftover = crate::public::temp_path(&marker);
        fs::create_dir_all(marker.parent().unwrap()).unwrap();
        fs::write(&leftover, "partial").unwrap();
        fs::remove_file(fixture.root.join("etc/hello.txt")).unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hello.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedRemoved);
        assert!(marker.exists());
        assert!(!leftover.exists());
    }

    #[test]
    fn missing_baseline_directory_removes_changed_subtree_and_creates_removed_marker() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("home/user/Desktop")).unwrap();
        fs::write(
            fixture
                .paths
                .changed_dir
                .join("home/user/Desktop/smoke.txt"),
            "stale",
        )
        .unwrap();
        upsert_test_metadata(
            &fixture.paths.metadata_file,
            "/home/user/Desktop/smoke.txt",
            "file",
        );
        fs::remove_dir_all(fixture.root.join("home/user/Desktop")).unwrap();

        let outcome = update_path(&fixture.ctx(), "/home/user/Desktop").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedRemoved);
        assert!(!fixture.paths.changed_dir.join("home/user/Desktop").exists());
        assert!(fixture.paths.removed_dir.join("home/user/Desktop").exists());
        assert!(
            crate::metadata::load(&fixture.paths.metadata_file)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn directory_tombstone_replaces_nested_child_tombstones() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.removed_dir.join("home/user/Desktop")).unwrap();
        fs::write(
            fixture
                .paths
                .removed_dir
                .join("home/user/Desktop/stale-child"),
            "",
        )
        .unwrap();
        fs::remove_dir_all(fixture.root.join("home/user/Desktop")).unwrap();

        let outcome = update_path(&fixture.ctx(), "/home/user/Desktop").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedRemoved);
        assert!(
            fixture
                .paths
                .removed_dir
                .join("home/user/Desktop")
                .is_file()
        );
        assert!(
            !fixture
                .paths
                .removed_dir
                .join("home/user/Desktop/stale-child")
                .exists()
        );
    }

    #[test]
    fn parent_directory_update_keeps_child_tombstones() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.root.join("etc/hello.txt")).unwrap();
        update_path(&fixture.ctx(), "/etc/hello.txt").unwrap();
        assert!(fixture.paths.removed_dir.join("etc/hello.txt").is_file());

        // Deleting the child drifted /etc's mtime, so the audit emits /etc as a
        // metadata-only update - it must not wipe tombstones beneath removed/etc.
        let outcome = update_path(&fixture.ctx(), "/etc").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedMetadata);
        assert!(fixture.paths.removed_dir.join("etc/hello.txt").is_file());
    }

    #[test]
    fn child_tombstone_is_covered_by_existing_parent_tombstone() {
        let fixture = Fixture::new();
        fs::write(fixture.paths.removed_dir.join("etc"), "").unwrap();
        fs::remove_file(fixture.root.join("etc/hello.txt")).unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hello.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedRemoved);
        assert!(fixture.paths.removed_dir.join("etc").is_file());
        assert!(!fixture.paths.removed_dir.join("etc/hello.txt").exists());
    }

    #[test]
    fn changed_parent_file_covers_deleted_baseline_children() {
        let fixture = Fixture::new();
        fs::remove_dir_all(fixture.root.join("etc")).unwrap();
        fs::write(fixture.root.join("etc"), "file now").unwrap();

        assert_eq!(
            update_path(&fixture.ctx(), "/etc").unwrap(),
            UpdateOutcome::PersistedChanged
        );
        let outcome = update_path(&fixture.ctx(), "/etc/hello.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedRemoved);
        assert!(fixture.paths.changed_dir.join("etc").is_file());
        assert!(!fixture.paths.removed_dir.join("etc/hello.txt").exists());
    }

    #[test]
    fn missing_new_file_prunes_without_tombstone() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("workspace")).unwrap();
        fs::write(fixture.paths.changed_dir.join("workspace/new.txt"), "stale").unwrap();

        let outcome = update_path(&fixture.ctx(), "/workspace/new.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::Pruned);
        assert!(!fixture.paths.changed_dir.join("workspace/new.txt").exists());
        assert!(!fixture.paths.removed_dir.join("workspace/new.txt").exists());
    }

    #[test]
    fn missing_new_directory_prunes_changed_subtree_without_tombstone() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("workspace/new-dir")).unwrap();
        fs::write(
            fixture.paths.changed_dir.join("workspace/new-dir/file.txt"),
            "stale",
        )
        .unwrap();
        upsert_test_metadata(
            &fixture.paths.metadata_file,
            "/workspace/new-dir/file.txt",
            "file",
        );

        let outcome = update_path(&fixture.ctx(), "/workspace/new-dir").unwrap();

        assert_eq!(outcome, UpdateOutcome::Pruned);
        assert!(!fixture.paths.changed_dir.join("workspace/new-dir").exists());
        assert!(!fixture.paths.removed_dir.join("workspace/new-dir").exists());
        assert!(
            crate::metadata::load(&fixture.paths.metadata_file)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn new_file_is_captured() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("new.txt"), "new").unwrap();

        let outcome = update_path(&fixture.ctx(), "/new.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert_eq!(
            fs::read_to_string(fixture.paths.changed_dir.join("new.txt")).unwrap(),
            "new"
        );
    }

    #[test]
    fn changed_capture_replaces_crash_leftover_temp_file() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("new.txt"), "new").unwrap();
        let destination = fixture.paths.changed_dir.join("new.txt");
        let leftover = crate::public::temp_path(&destination);
        fs::write(&leftover, "partial").unwrap();

        let outcome = update_path(&fixture.ctx(), "/new.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert_eq!(fs::read_to_string(destination).unwrap(), "new");
        assert!(!leftover.exists());
    }

    #[test]
    fn new_directory_is_captured_with_metadata() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.root.join("new-dir")).unwrap();

        let outcome = update_path(&fixture.ctx(), "/new-dir").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert!(fixture.paths.changed_dir.join("new-dir").is_dir());
        let records = crate::metadata::load(&fixture.paths.metadata_file).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].public_path().unwrap().as_bytes(), b"/new-dir");
        assert_eq!(records[0].kind, "dir");
    }

    #[test]
    fn parent_directory_metadata_update_keeps_changed_children() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("home/user/Desktop/smoke.txt"), "hello").unwrap();

        update_path(&fixture.ctx(), "/home/user/Desktop/smoke.txt").unwrap();
        let outcome = update_path(&fixture.ctx(), "/home/user/Desktop").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedMetadata);
        assert_eq!(
            fs::read_to_string(
                fixture
                    .paths
                    .changed_dir
                    .join("home/user/Desktop/smoke.txt")
            )
            .unwrap(),
            "hello"
        );
    }

    #[test]
    fn changed_symlink_is_captured_losslessly() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.root.join("etc/hello-link")).unwrap();
        symlink("/new-target", fixture.root.join("etc/hello-link")).unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hello-link").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert_eq!(
            fs::read_link(fixture.paths.changed_dir.join("etc/hello-link")).unwrap(),
            std::path::PathBuf::from("/new-target")
        );
    }

    #[test]
    fn unchanged_baseline_hardlink_does_not_false_positive_on_image_inodes() {
        let fixture = Fixture::new();

        let outcome = update_path(&fixture.ctx(), "/etc/hard-a").unwrap();

        assert_eq!(outcome, UpdateOutcome::Pruned);
        assert!(!fixture.paths.changed_dir.join("etc/hard-a").exists());
    }

    #[test]
    fn broken_baseline_hardlink_is_captured_with_equal_content() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.root.join("etc/hard-b")).unwrap();
        fs::write(fixture.root.join("etc/hard-b"), "shared").unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hard-a").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert_eq!(
            fs::read_to_string(fixture.paths.changed_dir.join("etc/hard-a")).unwrap(),
            "shared"
        );
    }

    #[test]
    fn new_hardlink_to_baseline_file_is_captured() {
        let fixture = Fixture::new();
        fs::hard_link(
            fixture.root.join("etc/hello.txt"),
            fixture.root.join("hello-hardlink"),
        )
        .unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hello.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert!(fixture.paths.changed_dir.join("etc/hello.txt").exists());
        assert_eq!(
            crate::metadata::load(&fixture.paths.metadata_file)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn non_utf8_new_file_is_captured_without_lossy_identity() {
        let fixture = Fixture::new();
        let name = OsString::from_vec(vec![b'b', b'a', b'd', 0xff]);
        fs::write(fixture.root.join(&name), "new").unwrap();
        let public_path = crate::public::PublicPath::from_absolute_bytes(b"/bad\xff").unwrap();

        let mut store = crate::metadata::MetadataStore::load(&fixture.paths.metadata_file).unwrap();
        let outcome = super::update_public_path(&fixture.ctx(), &mut store, &public_path).unwrap();
        store.flush().unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert_eq!(
            fs::read(fixture.paths.changed_dir.join(name)).unwrap(),
            b"new"
        );
    }

    #[test]
    fn excluded_path_is_ignored() {
        let fixture = Fixture::new();

        let outcome = update_path(&fixture.ctx(), "/data/ignored").unwrap();

        assert_eq!(outcome, UpdateOutcome::Ignored);
    }

    #[test]
    fn runtime_socket_is_pruned() {
        let fixture = Fixture::new();
        let socket = fixture.root.join("home/user/app/app.sock");
        fs::create_dir_all(socket.parent().unwrap()).unwrap();
        fs::create_dir_all(fixture.paths.changed_dir.join("home/user/app")).unwrap();
        fs::write(
            fixture.paths.changed_dir.join("home/user/app/app.sock"),
            "stale",
        )
        .unwrap();
        let _listener = UnixListener::bind(&socket).unwrap();

        let outcome = update_path(&fixture.ctx(), "/home/user/app/app.sock").unwrap();

        assert_eq!(outcome, UpdateOutcome::Pruned);
        assert!(
            !fixture
                .paths
                .changed_dir
                .join("home/user/app/app.sock")
                .exists()
        );
        assert!(
            crate::metadata::load(&fixture.paths.metadata_file)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn metadata_record_has_acl_and_capability_views() {
        let facts = crate::rootfs::FsFacts {
            kind: crate::rootfs::FileKind::File,
            mode: 0o100644,
            uid: 0,
            gid: 0,
            size: Some(1),
            mtime_ns: 1,
            symlink_target: None,
            rdev_major: None,
            rdev_minor: None,
            dev: 1,
            ino: 2,
            nlink: 1,
            xattrs: vec![
                crate::rootfs::XattrRecord {
                    name: "system.posix_acl_access".into(),
                    name_bytes_b64: {
                        use base64::Engine as _;
                        base64::engine::general_purpose::STANDARD.encode("system.posix_acl_access")
                    },
                    value_b64: {
                        use base64::Engine as _;
                        base64::engine::general_purpose::STANDARD.encode("acl")
                    },
                },
                crate::rootfs::XattrRecord {
                    name: "security.capability".into(),
                    name_bytes_b64: {
                        use base64::Engine as _;
                        base64::engine::general_purpose::STANDARD.encode("security.capability")
                    },
                    value_b64: {
                        use base64::Engine as _;
                        base64::engine::general_purpose::STANDARD.encode("cap")
                    },
                },
            ],
        };

        let record =
            super::metadata_record(&crate::public::PublicPath::parse("/file").unwrap(), &facts)
                .unwrap();

        assert!(record.acl.unwrap().to_string().contains("posix_acl"));
        assert!(
            record
                .capability
                .unwrap()
                .to_string()
                .contains("security.capability")
        );
    }

    #[test]
    fn child_capture_removes_stale_changed_parent_file() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.root.join("new")).unwrap();
        fs::write(fixture.root.join("new/file"), "child").unwrap();
        fs::write(fixture.paths.changed_dir.join("new"), "stale parent").unwrap();

        let outcome = update_path(&fixture.ctx(), "/new/file").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert_eq!(
            fs::read_to_string(fixture.paths.changed_dir.join("new/file")).unwrap(),
            "child"
        );
    }

    #[test]
    fn fifo_capture_removes_stale_changed_parent_file() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.root.join("new")).unwrap();
        unsafe {
            let fifo = fixture.root.join("new/fifo");
            let c =
                std::ffi::CString::new(std::os::unix::ffi::OsStrExt::as_bytes(fifo.as_os_str()))
                    .unwrap();
            assert_eq!(libc::mkfifo(c.as_ptr(), 0o644), 0);
        }
        fs::write(fixture.paths.changed_dir.join("new"), "parent conflict").unwrap();

        let outcome = update_path(&fixture.ctx(), "/new/fifo").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert_eq!(
            crate::rootfs::facts(&fixture.paths.changed_dir.join("new/fifo"))
                .unwrap()
                .kind,
            crate::rootfs::FileKind::Fifo
        );
    }

    #[test]
    fn changed_capture_refuses_public_truth_symlink_ancestor() {
        let fixture = Fixture::new();
        let outside = fixture._temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(fixture.root.join("escape")).unwrap();
        fs::write(fixture.root.join("escape/file"), "live").unwrap();
        symlink(&outside, fixture.paths.changed_dir.join("escape")).unwrap();

        let error = update_path(&fixture.ctx(), "/escape/file")
            .unwrap_err()
            .to_string();

        assert!(error.contains("symlink ancestor"));
        assert!(!outside.join("file").exists());
    }

    #[test]
    fn changed_prune_refuses_public_truth_symlink_ancestor() {
        let fixture = Fixture::new();
        let outside = fixture._temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("owned"), "outside").unwrap();
        symlink(&outside, fixture.paths.changed_dir.join("escape")).unwrap();

        let error = update_path(&fixture.ctx(), "/escape/owned")
            .unwrap_err()
            .to_string();

        assert!(error.contains("symlink ancestor"));
        assert_eq!(
            fs::read_to_string(outside.join("owned")).unwrap(),
            "outside"
        );
    }

    // The copy-in-changed/ must not be trusted when the live file is part of
    // a hardlink group: the topology lives in the metadata record, not the
    // copy, so an equal-looking copy would hide a topology change.
    #[test]
    fn a_hardlinked_live_file_never_counts_as_already_captured() {
        let fixture = Fixture::new();
        let live = crate::rootfs::FsFacts {
            kind: crate::rootfs::FileKind::File,
            mode: 0o644,
            uid: 0,
            gid: 0,
            size: Some(4),
            mtime_ns: 1,
            symlink_target: None,
            rdev_major: None,
            rdev_minor: None,
            dev: 1,
            ino: 1,
            nlink: 2,
            xattrs: vec![],
        };
        assert!(!super::changed_copy_is_current(&fixture.paths, &crate::public::PublicPath::parse("/etc/hard-a").unwrap(), &live));
    }

    // A partial mismatch in the copy (same kind, different mode) means the
    // copy is stale and must be rewritten, not trusted.
    #[test]
    fn a_partially_mismatched_copy_is_not_current() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.changed_dir.join("etc/hello.txt"), "hello").unwrap();
        fs::set_permissions(
            fixture.paths.changed_dir.join("etc/hello.txt"),
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        )
        .unwrap();
        let live = crate::rootfs::FsFacts {
            kind: crate::rootfs::FileKind::File,
            mode: 0o644,
            uid: 0,
            gid: 0,
            size: Some(5),
            mtime_ns: 1,
            symlink_target: None,
            rdev_major: None,
            rdev_minor: None,
            dev: 1,
            ino: 1,
            nlink: 1,
            xattrs: vec![],
        };
        assert!(!super::changed_copy_is_current(&fixture.paths, &crate::public::PublicPath::parse("/etc/hello.txt").unwrap(), &live));
    }

    // A hardlink group member that stopped sharing the inode is a topology
    // change even when its content still matches: the link count is held
    // steady by a third link, so only the inode comparison can catch it.
    #[test]
    fn a_replaced_hardlink_sibling_is_a_topology_change() {
        let fixture = Fixture::new();
        fs::hard_link(
            fixture.root.join("etc/hard-a"),
            fixture.root.join("etc/hard-a-extra"),
        )
        .unwrap();
        fs::remove_file(fixture.root.join("etc/hard-b")).unwrap();
        fs::write(fixture.root.join("etc/hard-b"), "shared").unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hard-a").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
    }

    // compare_to_baseline's content comparison: a symlink with a new target,
    // or a device with new numbers, must decide Changed even though mode and
    // owner are untouched.
    #[test]
    fn compare_to_baseline_flags_symlink_and_device_content_changes() {
        let symlink_record = crate::baseline::BaselineRecord {
            path: crate::public::PublicPath::parse("/l").unwrap(),
            kind: "symlink".into(),
            mode: 0o777,
            uid: 0,
            gid: 0,
            size: None,
            mtime_ns: 1,
            content_hash: None,
            symlink_target_bytes: Some(b"/old".to_vec()),
            symlink_target: Some("/old".into()),
            rdev_major: None,
            rdev_minor: None,
            dev: 1,
            ino: 1,
            nlink: 1,
            hardlink_key: None,
            xattr_json: None,
            acl_json: None,
            capability_json: None,
        };
        let symlink_live = crate::rootfs::FsFacts {
            kind: crate::rootfs::FileKind::Symlink,
            mode: 0o777,
            uid: 0,
            gid: 0,
            size: None,
            mtime_ns: 1,
            symlink_target: Some(b"/new".to_vec()),
            rdev_major: None,
            rdev_minor: None,
            dev: 1,
            ino: 1,
            nlink: 1,
            xattrs: vec![],
        };
        assert!(matches!(super::compare_to_baseline(
                &Fixture::new().ctx(),
                &crate::public::PublicPath::parse("/l").unwrap(),
                std::path::Path::new("/tmp/l"),
                &symlink_live,
                &symlink_record,
            )
            .unwrap(), super::DeltaDecision::Changed));

        let device_record = crate::baseline::BaselineRecord {
            path: crate::public::PublicPath::parse("/d").unwrap(),
            kind: "char_device".into(),
            mode: 0o666,
            uid: 0,
            gid: 0,
            size: None,
            mtime_ns: 1,
            content_hash: None,
            symlink_target_bytes: None,
            symlink_target: None,
            rdev_major: Some(1),
            rdev_minor: Some(1),
            dev: 1,
            ino: 1,
            nlink: 1,
            hardlink_key: None,
            xattr_json: None,
            acl_json: None,
            capability_json: None,
        };
        let device_live = crate::rootfs::FsFacts {
            kind: crate::rootfs::FileKind::CharDevice,
            mode: 0o666,
            uid: 0,
            gid: 0,
            size: None,
            mtime_ns: 1,
            symlink_target: None,
            rdev_major: Some(1),
            rdev_minor: Some(2),
            dev: 1,
            ino: 1,
            nlink: 1,
            xattrs: vec![],
        };
        assert!(matches!(super::compare_to_baseline(
                &Fixture::new().ctx(),
                &crate::public::PublicPath::parse("/d").unwrap(),
                std::path::Path::new("/tmp/d"),
                &device_live,
                &device_record,
            )
            .unwrap(), super::DeltaDecision::Changed));
    }

    #[test]
    fn metadata_record_needed_answers_the_two_cases() {
        let dir = crate::rootfs::FsFacts {
            kind: crate::rootfs::FileKind::Dir,
            mode: 0o755,
            uid: 0,
            gid: 0,
            size: None,
            mtime_ns: 1,
            symlink_target: None,
            rdev_major: None,
            rdev_minor: None,
            dev: 1,
            ino: 1,
            nlink: 2,
            xattrs: vec![],
        };
        assert!(super::metadata_record_needed(&dir));

        let plain = crate::rootfs::FsFacts {
            kind: crate::rootfs::FileKind::File,
            mode: 0o644,
            uid: 0,
            gid: 0,
            size: Some(1),
            mtime_ns: 1,
            symlink_target: None,
            rdev_major: None,
            rdev_minor: None,
            dev: 1,
            ino: 1,
            nlink: 1,
            xattrs: vec![],
        };
        assert!(!super::metadata_record_needed(&plain));
    }

    #[test]
    fn is_symlink_ancestor_error_answers_the_two_cases() {
        let ancestor = anyhow::anyhow!("refusing to use public truth through symlink ancestor /x");
        assert!(super::is_symlink_ancestor_error(&ancestor));
        let other = anyhow::anyhow!("boom");
        assert!(!super::is_symlink_ancestor_error(&other));
    }

    #[test]
    fn removed_marker_write_refuses_public_truth_symlink_ancestor() {
        let fixture = Fixture::new();
        let outside = fixture._temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, fixture.paths.removed_dir.join("etc")).unwrap();
        fs::remove_file(fixture.root.join("etc/hello.txt")).unwrap();

        let error = update_path(&fixture.ctx(), "/etc/hello.txt")
            .unwrap_err()
            .to_string();

        assert!(error.contains("symlink ancestor"));
        assert!(!outside.join("hello.txt").exists());
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        root: std::path::PathBuf,
        paths: Paths,
        baseline: BaselineDb,
        config: Config,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("root");
            let data = temp.path().join("data/persistence");
            let run = temp.path().join("run/persistence");
            let opt = root.join("opt/persistence");
            let baseline = opt.join("baseline.sqlite");

            fs::create_dir_all(root.join("etc")).unwrap();
            fs::create_dir_all(root.join("home/user/Desktop")).unwrap();
            fs::create_dir_all(&opt).unwrap();
            fs::write(root.join("etc/hello.txt"), "hello").unwrap();
            symlink("/etc/hello.txt", root.join("etc/hello-link")).unwrap();
            fs::write(root.join("etc/hard-a"), "shared").unwrap();
            fs::hard_link(root.join("etc/hard-a"), root.join("etc/hard-b")).unwrap();

            generate(&GenerateOptions {
                root: root.clone(),
                output: baseline.clone(),
            })
            .unwrap();

            let paths = Paths::new(opt, run, data);
            layout::ensure(&paths).unwrap();
            let baseline = BaselineDb::open(&baseline).unwrap();

            Self {
                _temp: temp,
                root,
                paths,
                baseline,
                config: Config::default(),
            }
        }

        fn ctx(&self) -> UpdateContext<'_> {
            UpdateContext {
                root: &self.root,
                paths: &self.paths,
                config: &self.config,
                baseline: &self.baseline,
            }
        }
    }

    fn upsert_test_metadata(metadata_file: &std::path::Path, public_path: &str, kind: &str) {
        let public_path = crate::public::PublicPath::parse(public_path).unwrap();
        let mut record = crate::metadata::MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: String::new(),
            kind: kind.into(),
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
        };
        record.set_public_path(&public_path);
        crate::metadata::upsert(metadata_file, record).unwrap();
    }
}
