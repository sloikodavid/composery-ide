#![cfg(unix)]
#![allow(dead_code)]

use anyhow::{Context, Result, bail};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    time::{Duration, Instant},
};

use crate::{
    config::Config,
    metadata::{self, MetadataRecord},
    paths::Paths,
    public::{self, PublicPath},
    rootfs::{self, FileKind, FsFacts},
};

pub fn apply_public_truth(root: &Path, paths: &Paths, config: &Config) -> Result<()> {
    apply_removed(root, paths, config)?;
    apply_changed(root, paths, config)?;
    apply_metadata(root, paths, config)?;
    apply_hardlinks(root, paths, config)?;
    Ok(())
}

fn apply_removed(root: &Path, paths: &Paths, config: &Config) -> Result<()> {
    let mut markers = public::list_public_file_paths(&paths.removed_dir)?;
    markers.sort_by_key(|path| std::cmp::Reverse(path.depth()));

    for public_path in markers {
        if public::is_excluded(&public_path, config) {
            continue;
        }
        let target = public::live_path(root, &public_path);
        if rootfs::ensure_safe_existing_parent(root, &target)? {
            public::remove_path(&target)?;
        }
    }
    Ok(())
}

fn apply_changed(root: &Path, paths: &Paths, config: &Config) -> Result<()> {
    let mut entries = public::list_public_entries(&paths.changed_dir)?;
    entries.sort_by_key(|entry| entry.path.depth());

    let total = entries.len();
    let mut last_progress = Instant::now();
    for (index, entry) in entries.iter().enumerate() {
        if public::is_excluded(&entry.path, config) {
            continue;
        }
        apply_changed_entry(root, &entry.path, &entry.full_path)?;
        maybe_log_progress(&mut last_progress, index + 1, total);
    }
    Ok(())
}

// Progress logging is wall-clock cadence: no test can observe when a log line
// was emitted without a tracing subscriber, and the 5s boundary is a reporting
// nicety, not behavior.
#[cfg_attr(test, mutants::skip)]
fn maybe_log_progress(last_progress: &mut Instant, restored: usize, total: usize) {
    if last_progress.elapsed() >= Duration::from_secs(5) {
        tracing::info!(restored, total, "persistence apply progress");
        *last_progress = Instant::now();
    }
}

fn apply_metadata(root: &Path, paths: &Paths, config: &Config) -> Result<()> {
    let records = metadata::compact(&paths.metadata_file)?;
    let mut kept = Vec::with_capacity(records.len());
    let mut removed_stale = false;

    for record in records {
        let public_path = record.public_path()?;
        if public::is_excluded(&public_path, config) {
            kept.push(record);
            continue;
        }
        let target = public::live_path(root, &public_path);
        if apply_metadata_record(root, &target, &record)? {
            kept.push(record);
        } else {
            removed_stale = true;
            tracing::warn!(path = %public_path, "removed stale metadata record");
        }
    }

    if removed_stale {
        metadata::replace(&paths.metadata_file, &kept)?;
    }
    Ok(())
}
fn apply_changed_entry(root: &Path, public_path: &PublicPath, changed_path: &Path) -> Result<()> {
    let target = public::live_path(root, public_path);
    let source_facts =
        rootfs::facts(changed_path).with_context(|| format!("stat {}", changed_path.display()))?;

    rootfs::ensure_safe_parent(root, &target)?;

    if matches!(source_facts.kind, FileKind::Dir) {
        ensure_directory_target(&target)?;
    } else {
        // ponytail: a destination whose facts already match was restored by an
        // earlier boot of this same container; skip the copy so warm restarts
        // stay near-instant. Stale destination xattrs are the accepted ceiling.
        if let Some(dest_facts) = facts_if_exists(&target)?
            && dest_facts.kind == source_facts.kind
            && dest_facts.size == source_facts.size
            && dest_facts.mtime_ns == source_facts.mtime_ns
            && dest_facts.mode == source_facts.mode
            && dest_facts.uid == source_facts.uid
            && dest_facts.gid == source_facts.gid
            && dest_facts.symlink_target == source_facts.symlink_target
        {
            return Ok(());
        }
        rootfs::restore_entry(changed_path, &target)?;
    }
    Ok(())
}

// The directory-target shape check. Its final Err arm is unreachable by
// construction: ensure_safe_parent ran just before, so the only errors left
// for this stat are the NotFound handled here and permission errors a
// root-run test cannot provoke; the other arms are covered by the
// directory-apply tests.
#[cfg_attr(test, mutants::skip)]
fn ensure_directory_target(target: &Path) -> Result<()> {
    match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => {
            public::remove_path(target)?;
            fs::create_dir_all(target).with_context(|| format!("create {}", target.display()))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(target).with_context(|| format!("create {}", target.display()))?;
        }
        Err(error) => return Err(error).with_context(|| format!("stat {}", target.display())),
    }
    Ok(())
}

fn apply_metadata_record(root: &Path, target: &Path, record: &MetadataRecord) -> Result<bool> {
    let expected = FileKind::from_kind_name(&record.kind);
    let is_fallback = is_fallback_only_kind(&expected);
    let parent_exists = rootfs::ensure_safe_existing_parent(root, target)?;

    if !parent_exists {
        if !is_fallback {
            return Ok(false);
        }
        rootfs::ensure_safe_parent(root, target)?;
    }

    if !is_fallback {
        let Some(mut facts) = facts_if_exists(target)? else {
            return Ok(false);
        };
        if facts.kind != expected {
            return Ok(false);
        }
        let xattrs = metadata_xattrs(record)?;
        apply_record_facts(target, record, &mut facts, xattrs)?;
        return Ok(true);
    }

    let xattrs = metadata_xattrs(record)?;
    if needs_fallback_target(target, record, &expected)? {
        create_fallback_target(target, record, xattrs.as_deref().unwrap_or(&[]))?;
    }

    let Some(mut facts) = facts_if_exists(target)? else {
        bail!("metadata record for {} has no target to apply", record.path);
    };

    if facts.kind != expected {
        bail!(
            "metadata record for {} expected {} but target is {}",
            record.path,
            record.kind,
            facts.kind.as_str()
        );
    }

    apply_record_facts(target, record, &mut facts, xattrs)?;
    Ok(true)
}

fn apply_record_facts(
    target: &Path,
    record: &MetadataRecord,
    facts: &mut FsFacts,
    xattrs: Option<Vec<rootfs::XattrRecord>>,
) -> Result<()> {
    if let Some(mode) = record.mode {
        facts.mode = mode;
    }
    if let Some(uid) = record.uid {
        facts.uid = uid;
    }
    if let Some(gid) = record.gid {
        facts.gid = gid;
    }
    if let Some(mtime_ns) = record.mtime_ns {
        facts.mtime_ns = mtime_ns;
    }
    if let Some(xattrs) = xattrs {
        facts.xattrs = xattrs;
    }
    rootfs::apply_facts(target, facts)
}

fn is_fallback_only_kind(kind: &FileKind) -> bool {
    matches!(
        kind,
        FileKind::Fifo | FileKind::CharDevice | FileKind::BlockDevice
    )
}

fn needs_fallback_target(
    target: &Path,
    record: &MetadataRecord,
    expected: &FileKind,
) -> Result<bool> {
    let Some(facts) = facts_if_exists(target)? else {
        return Ok(true);
    };

    if facts.kind != *expected {
        return Ok(true);
    }
    if matches!(expected, FileKind::CharDevice | FileKind::BlockDevice) {
        return Ok(device_numbers_changed(&facts, record));
    }
    Ok(false)
}

// Reachable only against a real device node: mknod requires privileges the CI
// runner does not have, so the comparison is proven on privileged hosts by the
// device-metadata apply test's success branch and by the system harness.
#[cfg_attr(test, mutants::skip)]
fn device_numbers_changed(facts: &FsFacts, record: &MetadataRecord) -> bool {
    facts.rdev_major != record.rdev_major || facts.rdev_minor != record.rdev_minor
}

fn facts_if_exists(target: &Path) -> Result<Option<FsFacts>> {
    match rootfs::facts(target) {
        Ok(facts) => Ok(Some(facts)),
        Err(error) if is_not_found_error(&error) => Ok(None),
        Err(error) => Err(error).with_context(|| format!("inspect {}", target.display())),
    }
}

fn is_not_found_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.downcast_ref::<std::io::Error>().is_some_and(|io| {
            matches!(
                io.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            )
        })
    })
}

fn create_fallback_target(
    target: &Path,
    record: &MetadataRecord,
    xattrs: &[rootfs::XattrRecord],
) -> Result<()> {
    public::ensure_parent(target)?;
    let facts = FsFacts {
        kind: FileKind::from_kind_name(&record.kind),
        mode: record.mode.unwrap_or(0o644),
        uid: record.uid.unwrap_or(0),
        gid: record.gid.unwrap_or(0),
        size: None,
        mtime_ns: record.mtime_ns.unwrap_or(0),
        symlink_target: None,
        rdev_major: record.rdev_major,
        rdev_minor: record.rdev_minor,
        dev: 0,
        ino: 0,
        nlink: 1,
        xattrs: xattrs.to_vec(),
    };

    match facts.kind {
        FileKind::Fifo | FileKind::CharDevice | FileKind::BlockDevice => {
            let temp = tempfile_like_source(target, &facts)?;
            rootfs::copy_entry_atomic(&temp, target)?;
            public::remove_path(&temp)?;
        }
        _ => {}
    }
    Ok(())
}

fn metadata_xattrs(record: &MetadataRecord) -> Result<Option<Vec<rootfs::XattrRecord>>> {
    if record.xattrs.is_none() && record.acl.is_none() && record.capability.is_none() {
        return Ok(None);
    }
    let mut by_name = BTreeMap::new();
    for xattr in record.xattrs.clone().unwrap_or_default() {
        by_name.insert(xattr.name_bytes_b64.clone(), xattr);
    }
    if let Some(acl) = &record.acl {
        for xattr in serde_json::from_value::<Vec<rootfs::XattrRecord>>(acl.clone())
            .context("decode ACL metadata xattrs")?
        {
            by_name.insert(xattr.name_bytes_b64.clone(), xattr);
        }
    }
    if let Some(capability) = &record.capability {
        let xattr = serde_json::from_value::<rootfs::XattrRecord>(capability.clone())
            .context("decode capability metadata xattr")?;
        by_name.insert(xattr.name_bytes_b64.clone(), xattr);
    }
    Ok(Some(by_name.into_values().collect()))
}

// The fallback device/fifo staging file: mknod requires privileges CI lacks,
// so the device arms and their mode arithmetic are proven on privileged hosts
// (the device-metadata apply test's success branch) and by the system harness.
#[cfg_attr(test, mutants::skip)]
fn tempfile_like_source(target: &Path, facts: &FsFacts) -> Result<std::path::PathBuf> {
    let temp = public::temp_path(target);
    public::remove_path(&temp)?;
    match facts.kind {
        FileKind::Fifo => {
            let c = std::ffi::CString::new(temp.as_os_str().as_encoded_bytes())?;
            let result = unsafe { libc::mkfifo(c.as_ptr(), facts.mode as libc::mode_t) };
            if result != 0 {
                return Err(std::io::Error::last_os_error()).context("mkfifo fallback");
            }
        }
        FileKind::CharDevice | FileKind::BlockDevice => {
            let c = std::ffi::CString::new(temp.as_os_str().as_encoded_bytes())?;
            let mode = match facts.kind {
                FileKind::CharDevice => libc::S_IFCHR,
                FileKind::BlockDevice => libc::S_IFBLK,
                _ => unreachable!(),
            } | (facts.mode as libc::mode_t & 0o7777);
            let dev = make_dev(facts.rdev_major.unwrap_or(0), facts.rdev_minor.unwrap_or(0));
            let result = unsafe { libc::mknod(c.as_ptr(), mode, dev) };
            if result != 0 {
                return Err(std::io::Error::last_os_error()).context("mknod fallback");
            }
        }
        _ => {}
    }
    Ok(temp)
}

fn apply_hardlinks(root: &Path, paths: &Paths, config: &Config) -> Result<()> {
    let mut groups: BTreeMap<String, Vec<PublicPath>> = BTreeMap::new();
    for record in metadata::load(&paths.metadata_file)? {
        let Some(key) = record.hardlink_key.clone() else {
            continue;
        };
        let public_path = record.public_path()?;
        if public::is_excluded(&public_path, config) {
            continue;
        }
        groups.entry(key).or_default().push(public_path);
    }

    for paths in groups.into_values() {
        let mut existing = paths
            .iter()
            .map(|path| public::live_path(root, path))
            .filter(|path| path.exists() || fs::symlink_metadata(path).is_ok())
            .collect::<Vec<_>>();
        for path in &existing {
            rootfs::ensure_safe_parent(root, path)?;
        }
        existing.sort();
        let Some(source) = existing.first().cloned() else {
            continue;
        };
        for target in existing.into_iter().skip(1) {
            rootfs::ensure_safe_parent(root, &target)?;
            let source_facts = rootfs::facts(&source)?;
            let target_facts = rootfs::facts(&target)?;
            if source_facts.dev == target_facts.dev && source_facts.ino == target_facts.ino {
                continue;
            }
            rootfs::make_hardlink(&source, &target)?;
        }
    }
    Ok(())
}

fn make_dev(major: u64, minor: u64) -> libc::dev_t {
    (((major & 0xffff_f000) << 32)
        | ((major & 0x0000_0fff) << 8)
        | ((minor & 0xffff_ff00) << 12)
        | (minor & 0x0000_00ff)) as libc::dev_t
}

#[cfg(test)]
mod tests {
    use super::apply_public_truth;
    use crate::{
        config::Config,
        layout,
        metadata::{self, MetadataRecord},
        paths::Paths,
        public::PublicPath,
    };
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
    };

    #[test]
    fn apply_removes_then_restores_changed_file_so_changed_wins() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("etc/conf"), "image").unwrap();
        fs::create_dir_all(fixture.paths.removed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.removed_dir.join("etc/conf"), "").unwrap();
        fs::create_dir_all(fixture.paths.changed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.changed_dir.join("etc/conf"), "changed").unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert_eq!(
            fs::read_to_string(fixture.root.join("etc/conf")).unwrap(),
            "changed"
        );
    }

    #[test]
    fn apply_changed_file_replaces_crash_leftover_target_temp() {
        let fixture = Fixture::new();
        let target = fixture.root.join("etc/conf");
        let leftover = crate::public::temp_path(&target);
        fs::write(&target, "image").unwrap();
        fs::write(&leftover, "partial").unwrap();
        fs::create_dir_all(fixture.paths.changed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.changed_dir.join("etc/conf"), "changed").unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert_eq!(fs::read_to_string(target).unwrap(), "changed");
        assert!(!leftover.exists());
    }

    #[test]
    fn apply_removes_deleted_image_path() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("remove-me"), "image").unwrap();
        fs::write(fixture.paths.removed_dir.join("remove-me"), "").unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert!(!fixture.root.join("remove-me").exists());
    }

    #[test]
    fn apply_treats_only_removed_files_as_tombstones() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.root.join("usr/bin")).unwrap();
        fs::create_dir_all(fixture.root.join("usr/share/applications")).unwrap();
        fs::write(fixture.root.join("usr/bin/supervisord"), "supervisor").unwrap();
        fs::write(
            fixture
                .root
                .join("usr/share/applications/composery-text-editor.desktop"),
            "desktop",
        )
        .unwrap();
        fs::create_dir_all(fixture.paths.removed_dir.join("usr/share/applications")).unwrap();
        fs::write(
            fixture
                .paths
                .removed_dir
                .join("usr/share/applications/composery-text-editor.desktop"),
            "",
        )
        .unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert!(fixture.root.join("usr/bin/supervisord").exists());
        assert!(
            !fixture
                .root
                .join("usr/share/applications/composery-text-editor.desktop")
                .exists()
        );
    }

    #[test]
    fn apply_removed_does_not_create_missing_parent_dirs() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.removed_dir.join("missing")).unwrap();
        fs::write(fixture.paths.removed_dir.join("missing/child"), "").unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert!(!fixture.root.join("missing").exists());
    }

    #[test]
    fn apply_restores_changed_directory_file_and_symlink() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("dir")).unwrap();
        fs::write(fixture.paths.changed_dir.join("dir/file"), "file").unwrap();
        symlink("/dir/file", fixture.paths.changed_dir.join("link")).unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert_eq!(
            fs::read_to_string(fixture.root.join("dir/file")).unwrap(),
            "file"
        );
        assert_eq!(
            fs::read_link(fixture.root.join("link")).unwrap(),
            std::path::PathBuf::from("/dir/file")
        );
    }

    #[test]
    fn apply_restores_empty_changed_directory() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("empty")).unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert!(fixture.root.join("empty").is_dir());
    }

    #[test]
    fn apply_uses_metadata_for_changed_directory_facts() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("empty")).unwrap();
        let public_path = PublicPath::parse("/empty").unwrap();
        let mut record = MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: String::new(),
            kind: "dir".into(),
            mode: Some(0o700),
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
        metadata::upsert(&fixture.paths.metadata_file, record).unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert_eq!(
            fs::metadata(fixture.root.join("empty"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }

    #[test]
    fn apply_changed_file_does_not_apply_storage_parent_metadata() {
        let fixture = Fixture::new();
        let desktop = fixture.root.join("home/user/Desktop");
        fs::create_dir_all(&desktop).unwrap();
        fs::set_permissions(&desktop, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir_all(fixture.paths.changed_dir.join("home/user/Desktop")).unwrap();
        fs::set_permissions(
            fixture.paths.changed_dir.join("home/user/Desktop"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        fs::write(
            fixture
                .paths
                .changed_dir
                .join("home/user/Desktop/smoke.txt"),
            "hello",
        )
        .unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert_eq!(
            fs::read_to_string(desktop.join("smoke.txt")).unwrap(),
            "hello"
        );
        assert_eq!(
            fs::metadata(desktop).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn apply_metadata_sets_mode_mtime_and_xattr() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("file"), "file").unwrap();
        let public_path = PublicPath::parse("/file").unwrap();
        let mut record = MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: String::new(),
            kind: "file".into(),
            mode: Some(0o600),
            uid: None,
            gid: None,
            mtime_ns: Some(42_000_000_123),
            symlink_target: None,
            symlink_target_bytes_b64: None,
            rdev_major: None,
            rdev_minor: None,
            hardlink_key: None,
            xattrs: Some(vec![crate::rootfs::XattrRecord {
                name: "user.persistence-test".into(),
                name_bytes_b64: {
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD.encode("user.persistence-test")
                },
                value_b64: {
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD.encode("value")
                },
            }]),
            acl: None,
            capability: None,
        };
        record.set_public_path(&public_path);
        metadata::upsert(&fixture.paths.metadata_file, record).unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        let metadata = fs::metadata(fixture.root.join("file")).unwrap();
        assert_eq!(
            std::os::unix::fs::PermissionsExt::mode(&metadata.permissions()) & 0o777,
            0o600
        );
        assert_eq!(std::os::unix::fs::MetadataExt::mtime(&metadata), 42);
        assert_eq!(std::os::unix::fs::MetadataExt::mtime_nsec(&metadata), 123);
        assert_eq!(
            xattr::get(fixture.root.join("file"), "user.persistence-test").unwrap(),
            Some(b"value".to_vec())
        );
    }

    #[test]
    fn apply_metadata_without_xattrs_preserves_existing_xattrs() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("file"), "file").unwrap();
        xattr::set(fixture.root.join("file"), "user.persistence-kept", b"kept").unwrap();
        let public_path = PublicPath::parse("/file").unwrap();
        let mut record = MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: String::new(),
            kind: "file".into(),
            mode: Some(0o600),
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
        metadata::upsert(&fixture.paths.metadata_file, record).unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert_eq!(
            xattr::get(fixture.root.join("file"), "user.persistence-kept").unwrap(),
            Some(b"kept".to_vec())
        );
        assert_eq!(
            fs::metadata(fixture.root.join("file"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn apply_metadata_honors_acl_and_capability_xattr_views() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("file"), "file").unwrap();
        let public_path = PublicPath::parse("/file").unwrap();
        let acl_xattr = crate::rootfs::XattrRecord {
            name: "user.persistence-acl-view".into(),
            name_bytes_b64: {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode("user.persistence-acl-view")
            },
            value_b64: {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode("acl")
            },
        };
        let capability_xattr = crate::rootfs::XattrRecord {
            name: "user.persistence-capability-view".into(),
            name_bytes_b64: {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode("user.persistence-capability-view")
            },
            value_b64: {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode("capability")
            },
        };
        let mut record = MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: String::new(),
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
            acl: Some(serde_json::to_value(vec![acl_xattr]).unwrap()),
            capability: Some(serde_json::to_value(capability_xattr).unwrap()),
        };
        record.set_public_path(&public_path);
        metadata::upsert(&fixture.paths.metadata_file, record).unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert_eq!(
            xattr::get(fixture.root.join("file"), "user.persistence-acl-view").unwrap(),
            Some(b"acl".to_vec())
        );
        assert_eq!(
            xattr::get(
                fixture.root.join("file"),
                "user.persistence-capability-view"
            )
            .unwrap(),
            Some(b"capability".to_vec())
        );
    }

    #[test]
    fn apply_removes_stale_normal_metadata_without_creating_parents() {
        let fixture = Fixture::new();
        upsert_test_metadata(
            &fixture.paths.metadata_file,
            "/missing/normal",
            "file",
            Some(0o600),
            Some("stale-hardlink"),
        );

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert!(!fixture.root.join("missing").exists());
        assert!(
            metadata::load(&fixture.paths.metadata_file)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn apply_removes_staging_rename_leftover_metadata_and_restores_final_tree() {
        let fixture = Fixture::new();
        let final_path = "home/user/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/context7";
        fs::create_dir_all(fixture.paths.changed_dir.join(final_path)).unwrap();
        fs::write(
            fixture
                .paths
                .changed_dir
                .join(final_path)
                .join("plugin.json"),
            "{}",
        )
        .unwrap();
        for path in [
            "/home/user/.claude/plugins/marketplaces/claude-plugins-official.staging/external_plugins/context7",
            "/home/user/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/context7",
        ] {
            upsert_test_metadata(&fixture.paths.metadata_file, path, "dir", Some(0o755), None);
        }

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert_eq!(
            fs::read_to_string(fixture.root.join(final_path).join("plugin.json")).unwrap(),
            "{}"
        );
        assert!(
            !fixture
                .root
                .join("home/user/.claude/plugins/marketplaces/claude-plugins-official.staging")
                .exists()
        );
        assert!(
            metadata::load(&fixture.paths.metadata_file)
                .unwrap()
                .into_iter()
                .all(|record| !record.path.contains(".staging"))
        );
    }

    #[test]
    fn apply_removes_metadata_when_target_type_changes() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("thing"), "image").unwrap();
        fs::set_permissions(
            fixture.root.join("thing"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        upsert_test_metadata(
            &fixture.paths.metadata_file,
            "/thing",
            "dir",
            Some(0o755),
            None,
        );

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert_eq!(
            fs::metadata(fixture.root.join("thing"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
        assert!(
            metadata::load(&fixture.paths.metadata_file)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn apply_replaces_symlink_with_changed_directory() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("safe/link")).unwrap();
        fs::write(fixture.paths.changed_dir.join("safe/link/file"), "nope").unwrap();
        fs::create_dir_all(fixture.root.join("safe")).unwrap();
        symlink("/tmp", fixture.root.join("safe/link")).unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert!(fixture.root.join("safe/link").is_dir());
        assert_eq!(
            fs::read_to_string(fixture.root.join("safe/link/file")).unwrap(),
            "nope"
        );
    }

    #[test]
    fn apply_relinks_hardlink_groups_from_metadata() {
        let fixture = Fixture::new();
        fs::write(fixture.paths.changed_dir.join("a"), "same").unwrap();
        fs::write(fixture.paths.changed_dir.join("b"), "same").unwrap();
        for name in ["/a", "/b"] {
            let public_path = PublicPath::parse(name).unwrap();
            let mut record = MetadataRecord {
                version: 1,
                path: String::new(),
                path_bytes_b64: String::new(),
                kind: "file".into(),
                mode: None,
                uid: None,
                gid: None,
                mtime_ns: None,
                symlink_target: None,
                symlink_target_bytes_b64: None,
                rdev_major: None,
                rdev_minor: None,
                hardlink_key: Some("1:2".into()),
                xattrs: None,
                acl: None,
                capability: None,
            };
            record.set_public_path(&public_path);
            metadata::upsert(&fixture.paths.metadata_file, record).unwrap();
        }

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert_eq!(
            crate::rootfs::facts(&fixture.root.join("a")).unwrap().ino,
            crate::rootfs::facts(&fixture.root.join("b")).unwrap().ino
        );
    }

    #[test]
    fn apply_fifo_metadata_replaces_existing_image_file() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("pipe"), "image").unwrap();
        let public_path = PublicPath::parse("/pipe").unwrap();
        let mut record = MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: String::new(),
            kind: "fifo".into(),
            mode: Some(0o600),
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
        metadata::upsert(&fixture.paths.metadata_file, record).unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        let facts = crate::rootfs::facts(&fixture.root.join("pipe")).unwrap();
        assert_eq!(facts.kind, crate::rootfs::FileKind::Fifo);
    }

    #[test]
    fn apply_device_metadata_creates_device_or_fails_clearly() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("dev-null-copy"), "image").unwrap();
        let public_path = PublicPath::parse("/dev-null-copy").unwrap();
        let mut record = MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: String::new(),
            kind: "char_device".into(),
            mode: Some(0o666),
            uid: None,
            gid: None,
            mtime_ns: None,
            symlink_target: None,
            symlink_target_bytes_b64: None,
            rdev_major: Some(1),
            rdev_minor: Some(3),
            hardlink_key: None,
            xattrs: None,
            acl: None,
            capability: None,
        };
        record.set_public_path(&public_path);
        metadata::upsert(&fixture.paths.metadata_file, record).unwrap();

        match apply_public_truth(&fixture.root, &fixture.paths, &Config::default()) {
            Ok(()) => {
                let facts = crate::rootfs::facts(&fixture.root.join("dev-null-copy")).unwrap();
                assert_eq!(facts.kind, crate::rootfs::FileKind::CharDevice);
                assert_eq!(facts.rdev_major, Some(1));
                assert_eq!(facts.rdev_minor, Some(3));
            }
            Err(error) => {
                let message = format!("{error:#}");
                assert!(message.contains("mknod"), "{message}");
            }
        }
    }

    #[test]
    fn apply_ignores_excluded_changed_removed_and_metadata() {
        let fixture = Fixture::new();
        let mut config = Config::default();
        config.exclusions.push("/secret".into());
        fs::create_dir_all(fixture.root.join("secret")).unwrap();
        fs::write(fixture.root.join("secret/kept"), "live").unwrap();
        fs::set_permissions(
            fixture.root.join("secret/kept"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        fs::create_dir_all(fixture.paths.changed_dir.join("secret")).unwrap();
        fs::write(fixture.paths.changed_dir.join("secret/new"), "changed").unwrap();
        fs::write(fixture.paths.removed_dir.join("secret"), "").unwrap();
        let public_path = PublicPath::parse("/secret/kept").unwrap();
        let mut record = MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: String::new(),
            kind: "file".into(),
            mode: Some(0o600),
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
        metadata::upsert(&fixture.paths.metadata_file, record).unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &config).unwrap();

        assert_eq!(
            fs::read_to_string(fixture.root.join("secret/kept")).unwrap(),
            "live"
        );
        assert!(!fixture.root.join("secret/new").exists());
        assert_eq!(
            fs::metadata(fixture.root.join("secret/kept"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
    }

    #[test]
    fn apply_public_truth_is_idempotent() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("remove-me"), "image").unwrap();
        fs::write(fixture.paths.removed_dir.join("remove-me"), "").unwrap();
        fs::create_dir_all(fixture.paths.changed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.changed_dir.join("etc/conf"), "changed").unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();
        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert!(!fixture.root.join("remove-me").exists());
        assert_eq!(
            fs::read_to_string(fixture.root.join("etc/conf")).unwrap(),
            "changed"
        );
    }

    #[test]
    fn apply_removed_refuses_symlink_ancestor() {
        let fixture = Fixture::new();
        let outside = fixture._temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("owned"), "outside").unwrap();
        fs::create_dir_all(fixture.root.join("safe")).unwrap();
        symlink(&outside, fixture.root.join("safe/link")).unwrap();
        fs::create_dir_all(fixture.paths.removed_dir.join("safe/link")).unwrap();
        fs::write(fixture.paths.removed_dir.join("safe/link/owned"), "").unwrap();

        let error = apply_public_truth(&fixture.root, &fixture.paths, &Config::default())
            .unwrap_err()
            .to_string();

        assert!(error.contains("symlink ancestor"));
        assert_eq!(
            fs::read_to_string(outside.join("owned")).unwrap(),
            "outside"
        );
    }

    #[test]
    fn apply_metadata_refuses_symlink_ancestor() {
        let fixture = Fixture::new();
        let outside = fixture._temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("owned"), "outside").unwrap();
        fs::set_permissions(outside.join("owned"), fs::Permissions::from_mode(0o644)).unwrap();
        fs::create_dir_all(fixture.root.join("safe")).unwrap();
        symlink(&outside, fixture.root.join("safe/link")).unwrap();
        let public_path = PublicPath::parse("/safe/link/owned").unwrap();
        let mut record = MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: String::new(),
            kind: "file".into(),
            mode: Some(0o600),
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
        metadata::upsert(&fixture.paths.metadata_file, record).unwrap();

        let error = apply_public_truth(&fixture.root, &fixture.paths, &Config::default())
            .unwrap_err()
            .to_string();

        assert!(error.contains("symlink ancestor"));
        assert_eq!(
            fs::metadata(outside.join("owned"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
    }

    // A warm restart must not rewrite an already-restored file: the copy-skip
    // keeps the destination's inode, and a flipped comparison would recreate
    // it on every apply.
    #[test]
    fn apply_does_not_rewrite_an_already_matching_destination() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.changed_dir.join("etc/conf"), "changed").unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();
        let first = crate::rootfs::facts(&fixture.root.join("etc/conf")).unwrap().ino;

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();
        let second = crate::rootfs::facts(&fixture.root.join("etc/conf")).unwrap().ino;

        assert_eq!(first, second, "the warm-restart copy-skip must hold");
    }

    #[test]
    fn is_not_found_error_answers_the_two_cases() {
        let not_found = anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert!(super::is_not_found_error(&not_found));
        let refused =
            anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
        assert!(!super::is_not_found_error(&refused));
    }

    // A symlink loop makes facts() fail with ELOOP - a real error, never a
    // silent "missing".
    #[test]
    fn facts_if_exists_reports_a_symlink_loop_as_an_error() {
        let temp = tempfile::tempdir().unwrap();
        let loop_link = temp.path().join("loop");
        symlink("loop", &loop_link).unwrap();
        let target = loop_link.join("child");

        assert!(super::facts_if_exists(&target).is_err());
    }

    // An existing fallback target with the right kind is left alone: recreating
    // it would churn its inode for nothing.
    #[test]
    fn needs_fallback_target_false_for_a_matching_existing_fifo() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("pipe");
        let c = std::ffi::CString::new(target.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let mut record = MetadataRecord {
            version: 1,
            path: "/pipe".into(),
            path_bytes_b64: {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode("/pipe")
            },
            kind: "fifo".into(),
            mode: Some(0o600),
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
        record.set_public_path(&PublicPath::parse("/pipe").unwrap());

        assert!(!super::needs_fallback_target(
            &target,
            &record,
            &crate::rootfs::FileKind::Fifo
        )
        .unwrap());
    }

    // make_dev must encode major/minor into the kernel's 64-bit dev_t layout:
    // low 12 bits of major at <<8, its high bits at <<32, low 8 of minor at 0,
    // its high bits at <<12.
    #[test]
    fn make_dev_encodes_major_and_minor() {
        assert_eq!(super::make_dev(1, 3), 0x103);
        assert_eq!(super::make_dev(0, 0), 0);
        assert_eq!(super::make_dev(259, 0x1234), 0x1_2103_34);
        assert_eq!(super::make_dev(0x100000, 0), 0x10_0000_0000_0000);
        assert_eq!(super::make_dev(0x1000, 0x100), 0x1000_0010_0000);
    }

    // A hardlink group member whose live path is a dangling symlink still
    // counts as present: exists() follows the link and lies, so the no-follow
    // stat is the check that matters.
    #[test]
    fn apply_relinks_through_a_dangling_symlink_member() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("a"), "same").unwrap();
        symlink("/missing-target", fixture.root.join("b")).unwrap();
        for name in ["/a", "/b"] {
            let public_path = PublicPath::parse(name).unwrap();
            let mut record = MetadataRecord {
                version: 1,
                path: String::new(),
                path_bytes_b64: String::new(),
                kind: if name == "/b" { "symlink" } else { "file" }.into(),
                mode: None,
                uid: None,
                gid: None,
                mtime_ns: None,
                symlink_target: None,
                symlink_target_bytes_b64: None,
                rdev_major: None,
                rdev_minor: None,
                hardlink_key: Some("1:2".into()),
                xattrs: None,
                acl: None,
                capability: None,
            };
            record.set_public_path(&public_path);
            metadata::upsert(&fixture.paths.metadata_file, record).unwrap();
        }

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert_eq!(
            crate::rootfs::facts(&fixture.root.join("a")).unwrap().ino,
            crate::rootfs::facts(&fixture.root.join("b")).unwrap().ino
        );
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        root: std::path::PathBuf,
        paths: Paths,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("root");
            let paths = Paths::new(
                root.join("opt/persistence"),
                temp.path().join("run/persistence"),
                temp.path().join("data/persistence"),
            );
            fs::create_dir_all(root.join("etc")).unwrap();
            layout::ensure(&paths).unwrap();
            Self {
                _temp: temp,
                root,
                paths,
            }
        }
    }

    fn upsert_test_metadata(
        metadata_file: &std::path::Path,
        public_path: &str,
        kind: &str,
        mode: Option<u32>,
        hardlink_key: Option<&str>,
    ) {
        let public_path = PublicPath::parse(public_path).unwrap();
        let mut record = MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: String::new(),
            kind: kind.into(),
            mode,
            uid: None,
            gid: None,
            mtime_ns: None,
            symlink_target: None,
            symlink_target_bytes_b64: None,
            rdev_major: None,
            rdev_minor: None,
            hardlink_key: hardlink_key.map(str::to_string),
            xattrs: None,
            acl: None,
            capability: None,
        };
        record.set_public_path(&public_path);
        metadata::upsert(metadata_file, record).unwrap();
    }
}
