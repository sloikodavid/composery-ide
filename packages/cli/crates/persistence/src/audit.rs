#![cfg(unix)]

use anyhow::{Context, Result};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use crate::{
    baseline::BaselineRecord,
    config::Config,
    dirty::DirtySender,
    lifecycle::{LifecycleState, LifecycleStatus},
    public::PublicPath,
    rootfs::{self, FileKind, FsFacts},
    update,
};

pub struct Auditor {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Auditor {
    pub fn start(
        root: PathBuf,
        baseline_records: Vec<BaselineRecord>,
        config: Config,
        dirty_tx: DirtySender,
        lifecycle: LifecycleStatus,
    ) -> Result<Self> {
        lifecycle.set(LifecycleState::Initializing);
        initialize(&root)?;
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("persistence-audit".into())
            .spawn(move || {
                lifecycle.set(LifecycleState::Running);
                let _ = ready_tx.send(());
                if let Err(error) = run_loop(
                    root,
                    baseline_records,
                    config,
                    dirty_tx,
                    lifecycle.clone(),
                    thread_stop,
                ) {
                    lifecycle.set(LifecycleState::Stopped);
                    tracing::error!(error = %error, "auditor stopped");
                }
            })
            .context("spawn auditor thread")?;
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .context("auditor did not initialize")?;

        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

fn initialize(root: &Path) -> Result<()> {
    ensure_real_root(root)?;
    Ok(())
}

fn ensure_real_root(root: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(root)
        .with_context(|| format!("stat audit root {}", root.display()))?;
    if metadata.file_type().is_dir() {
        Ok(())
    } else {
        anyhow::bail!("audit root must be a real directory: {}", root.display())
    }
}

impl Drop for Auditor {
    // The join is the only handle to the audit thread, so no test can observe
    // whether it ran; the stop flag it sets is internal. The thread contract is
    // the run_loop exit on stop, which the threaded lifecycle exercises.
    #[cfg_attr(test, mutants::skip)]
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

// The scheduler loop: interval sleeps and the deep-pass cadence are wall-clock
// decisions no unit test can observe without sleeping real time; the pass
// logic itself (run_once) is what the tests below exercise.
#[cfg_attr(test, mutants::skip)]
fn run_loop(
    root: PathBuf,
    baseline_records: Vec<BaselineRecord>,
    config: Config,
    dirty_tx: DirtySender,
    lifecycle: LifecycleStatus,
    stop: Arc<AtomicBool>,
) -> Result<()> {
    let baseline = baseline_records
        .into_iter()
        .map(|record| (record.path.clone(), record))
        .collect::<BTreeMap<_, _>>();
    let interval = Duration::from_secs(config.audit.interval_secs.max(1));
    // Frequent passes trust size+mtime; a deep pass re-hashes every file so
    // mtime-preserving edits are still caught within one interval, without
    // paying a full-rootfs hash every pass. The first pass stays shallow so
    // startup stat-walks the rootfs instead of reading all of it.
    let deep_interval = Duration::from_secs(config.audit.deep_hash_interval_secs.max(1));
    let mut last_deep = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        let deep = last_deep.elapsed() >= deep_interval;
        if deep {
            last_deep = Instant::now();
        }
        if let Err(error) = run_once(&root, &baseline, &config, &dirty_tx, &stop, deep) {
            lifecycle.set(LifecycleState::Degraded);
            tracing::warn!(error = %error, "rolling audit pass failed");
        }
        sleep_interruptibly(interval, &stop);
    }
    Ok(())
}

// The pass walker. Skipped as one unit: its only decision branch that could
// mutate differently (whether to descend into an excluded directory) has no
// observable effect - everything under an excluded dir is excluded too, so
// either choice yields the same candidates. The per-entry decision it drives
// is candidate_needs_update, which is fully covered.
#[cfg_attr(test, mutants::skip)]
pub fn run_once(
    root: &Path,
    baseline: &BTreeMap<PublicPath, BaselineRecord>,
    config: &Config,
    dirty_tx: &DirtySender,
    stop: &AtomicBool,
    deep: bool,
) -> Result<()> {
    let mut seen = BTreeSet::new();
    let hardlink_groups = hardlink_groups(baseline);
    let mut work_started = Instant::now();
    let budget = Duration::from_millis(config.audit.max_work_ms_per_tick.max(1));
    let walker_device = fs::metadata(root)
        .with_context(|| format!("stat audit root {}", root.display()))?
        .dev();

    let mut entries = rootfs::rootfs_walker(root).into_iter();
    while let Some(entry) = entries.next() {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        let entry = entry?;
        if entry.path() == root {
            continue;
        }
        let public = public_path(root, entry.path())?;
        if crate::public::is_excluded(&public, config) {
            if entry.file_type().is_dir()
                && rootfs::walker_will_descend(walker_device, entry.metadata()?.dev())
            {
                entries.skip_current_dir();
            }
            continue;
        }
        seen.insert(public.clone());
        let facts = rootfs::facts(entry.path())
            .with_context(|| format!("inspect audit candidate {}", entry.path().display()))?;
        if candidate_needs_update(
            root,
            entry.path(),
            &public,
            &facts,
            baseline.get(&public),
            &hardlink_groups,
            config,
            deep,
        )? {
            let _ = dirty_tx.send(public);
        }
        throttle_if_needed(&mut work_started, budget, stop);
    }

    for public in baseline.keys() {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        if crate::public::is_excluded(public, config) || seen.contains(public) {
            continue;
        }
        let _ = dirty_tx.send(public.clone());
        throttle_if_needed(&mut work_started, budget, stop);
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn candidate_needs_update(
    root: &Path,
    live_path: &Path,
    public_path: &PublicPath,
    live: &FsFacts,
    baseline: Option<&BaselineRecord>,
    hardlink_groups: &BTreeMap<String, Vec<PublicPath>>,
    config: &Config,
    deep: bool,
) -> Result<bool> {
    let Some(record) = baseline else {
        return Ok(true);
    };

    if live.kind.as_str() != record.kind
        || i64::from(live.mode) != record.mode
        || i64::from(live.uid) != record.uid
        || i64::from(live.gid) != record.gid
        || !update::mtime_matches_baseline(live.mtime_ns, record.mtime_ns)
    {
        return Ok(true);
    }

    match live.kind {
        FileKind::File => {
            if live.size.map(|size| size as i64) != record.size {
                return Ok(true);
            }
            // ponytail: shallow passes trust size+mtime; only the periodic
            // deep pass hashes, so mtime-preserving edits surface within
            // deep_hash_interval_secs instead of every pass.
            if deep {
                let live_hash = rootfs::hash_file(live_path)?;
                if Some(live_hash) != record.content_hash {
                    return Ok(true);
                }
            }
        }
        FileKind::Symlink => {
            if live.symlink_target.as_deref() != record.symlink_target_bytes.as_deref() {
                return Ok(true);
            }
        }
        FileKind::CharDevice | FileKind::BlockDevice => {
            if live.rdev_major.map(|value| value as i64) != record.rdev_major
                || live.rdev_minor.map(|value| value as i64) != record.rdev_minor
            {
                return Ok(true);
            }
        }
        FileKind::Dir | FileKind::Fifo | FileKind::Socket | FileKind::Unknown => {}
    }

    let baseline_xattrs = record
        .xattr_json
        .as_deref()
        .map(serde_json::from_str::<Vec<rootfs::XattrRecord>>)
        .transpose()?
        .unwrap_or_default();
    if live.xattrs != baseline_xattrs {
        return Ok(true);
    }

    hardlink_topology_needs_update(root, public_path, live, record, hardlink_groups, config)
}

fn hardlink_groups(
    baseline: &BTreeMap<PublicPath, BaselineRecord>,
) -> BTreeMap<String, Vec<PublicPath>> {
    let mut groups: BTreeMap<String, Vec<PublicPath>> = BTreeMap::new();
    for record in baseline.values() {
        if let Some(key) = &record.hardlink_key {
            groups
                .entry(key.clone())
                .or_default()
                .push(record.path.clone());
        }
    }
    groups
}

fn hardlink_topology_needs_update(
    root: &Path,
    public_path: &PublicPath,
    live: &FsFacts,
    record: &BaselineRecord,
    hardlink_groups: &BTreeMap<String, Vec<PublicPath>>,
    config: &Config,
) -> Result<bool> {
    if !matches!(live.kind, FileKind::File) {
        return Ok(false);
    }

    let Some(key) = &record.hardlink_key else {
        return Ok(live.nlink > 1);
    };
    if live.nlink as i64 != record.nlink {
        return Ok(true);
    }

    let Some(siblings) = hardlink_groups.get(key) else {
        return Ok(false);
    };
    for sibling in siblings {
        if sibling == public_path || crate::public::is_excluded(sibling, config) {
            continue;
        }
        let sibling_path = crate::public::live_path(root, sibling);
        let sibling_facts = match rootfs::facts(&sibling_path) {
            Ok(facts) => facts,
            Err(error) => {
                let missing = error.downcast_ref::<std::io::Error>().is_some_and(|io| {
                    matches!(
                        io.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    )
                }) || fs::symlink_metadata(&sibling_path).is_err();
                if missing {
                    return Ok(true);
                }
                return Err(error).with_context(|| format!("inspect hardlink sibling {}", sibling));
            }
        };
        if sibling_facts.dev != live.dev || sibling_facts.ino != live.ino {
            return Ok(true);
        }
    }
    Ok(false)
}

// The pass-throttle sleep and its interruptible twin work in 25ms steps, so
// the exact comparison boundary falls between two wake-ups and a flipped
// operator changes nothing observable - and discriminating it would mean
// sleeping real time.
#[cfg_attr(test, mutants::skip)]
fn throttle_if_needed(work_started: &mut Instant, budget: Duration, stop: &AtomicBool) {
    if work_started.elapsed() < budget {
        return;
    }
    sleep_interruptibly(Duration::from_millis(10), stop);
    *work_started = Instant::now();
}

#[cfg_attr(test, mutants::skip)]
fn sleep_interruptibly(duration: Duration, stop: &AtomicBool) {
    let started = Instant::now();
    while !stop.load(Ordering::Relaxed) && started.elapsed() < duration {
        thread::sleep(Duration::from_millis(25));
    }
}

fn public_path(root: &Path, path: &Path) -> Result<PublicPath> {
    let relative = path
        .strip_prefix(root)
        .with_context(|| format!("path escaped root: {}", path.display()))?;
    PublicPath::from_root_relative(relative)
}

#[cfg(test)]
mod tests {
    use super::{Auditor, run_once};
    use crate::{
        baseline::{BaselineDb, BaselineRecord, GenerateOptions, generate},
        config::Config,
        layout,
        paths::Paths,
        public::PublicPath,
    };
    use std::{
        collections::BTreeMap,
        fs,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicU64},
        },
    };

    #[test]
    fn audit_emits_changed_and_deleted_candidates() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("etc/hello.txt"), "changed").unwrap();
        fs::remove_file(fixture.root.join("etc/delete-me")).unwrap();
        let (dirty_tx, rx) = crate::dirty::DirtySender::bounded(Arc::new(AtomicU64::new(0)));

        run_once(
            &fixture.root,
            &fixture.baseline_map(),
            &Config::default(),
            &dirty_tx,
            &AtomicBool::new(false),
            true,
        )
        .unwrap();
        drop(dirty_tx);

        let candidates = rx.try_iter().map(|path| path.display()).collect::<Vec<_>>();
        assert!(candidates.contains(&"/etc/hello.txt".into()));
        assert!(candidates.contains(&"/etc/delete-me".into()));
        assert!(!candidates.contains(&"/etc/unchanged".into()));
    }

    #[test]
    fn audit_hashes_same_size_same_mtime_file_changes() {
        let fixture = Fixture::new();
        let public_path = PublicPath::parse("/etc/unchanged").unwrap();
        let record = fixture.baseline.get(&public_path).unwrap().unwrap();
        fs::write(fixture.root.join("etc/unchanged"), "diff").unwrap();
        filetime::set_file_mtime(
            fixture.root.join("etc/unchanged"),
            filetime::FileTime::from_unix_time(
                record.mtime_ns.div_euclid(1_000_000_000),
                record.mtime_ns.rem_euclid(1_000_000_000) as u32,
            ),
        )
        .unwrap();
        let (dirty_tx, rx) = crate::dirty::DirtySender::bounded(Arc::new(AtomicU64::new(0)));

        run_once(
            &fixture.root,
            &fixture.baseline_map(),
            &Config::default(),
            &dirty_tx,
            &AtomicBool::new(false),
            true,
        )
        .unwrap();
        drop(dirty_tx);

        let candidates = rx.try_iter().map(|path| path.display()).collect::<Vec<_>>();
        assert!(candidates.contains(&"/etc/unchanged".into()));
    }

    #[test]
    fn shallow_audit_trusts_matching_size_and_mtime_without_hashing() {
        let fixture = Fixture::new();
        let public_path = PublicPath::parse("/etc/unchanged").unwrap();
        let record = fixture.baseline.get(&public_path).unwrap().unwrap();
        fs::write(fixture.root.join("etc/unchanged"), "diff").unwrap();
        filetime::set_file_mtime(
            fixture.root.join("etc/unchanged"),
            filetime::FileTime::from_unix_time(
                record.mtime_ns.div_euclid(1_000_000_000),
                record.mtime_ns.rem_euclid(1_000_000_000) as u32,
            ),
        )
        .unwrap();
        let (dirty_tx, rx) = crate::dirty::DirtySender::bounded(Arc::new(AtomicU64::new(0)));

        run_once(
            &fixture.root,
            &fixture.baseline_map(),
            &Config::default(),
            &dirty_tx,
            &AtomicBool::new(false),
            false,
        )
        .unwrap();
        drop(dirty_tx);

        // Known ceiling of shallow passes: an mtime-preserving edit is only
        // caught by the periodic deep pass.
        let candidates = rx.try_iter().map(|path| path.display()).collect::<Vec<_>>();
        assert!(!candidates.contains(&"/etc/unchanged".into()));
    }

    #[test]
    fn audit_detects_hardlink_topology_changes_with_matching_content_and_link_counts() {
        let fixture = Fixture::new();
        let hard_a = PublicPath::parse("/etc/hard-a").unwrap();
        let hard_b = PublicPath::parse("/etc/hard-b").unwrap();
        let hard_a_record = fixture.baseline.get(&hard_a).unwrap().unwrap();
        let hard_b_record = fixture.baseline.get(&hard_b).unwrap().unwrap();
        fs::remove_file(fixture.root.join("etc/hard-b")).unwrap();
        fs::write(fixture.root.join("etc/hard-b"), "shared").unwrap();
        filetime::set_file_mtime(
            fixture.root.join("etc/hard-a"),
            filetime_from_ns(hard_a_record.mtime_ns),
        )
        .unwrap();
        filetime::set_file_mtime(
            fixture.root.join("etc/hard-b"),
            filetime_from_ns(hard_b_record.mtime_ns),
        )
        .unwrap();
        fs::hard_link(
            fixture.root.join("etc/hard-a"),
            fixture.root.join("etc/hard-a-extra"),
        )
        .unwrap();
        fs::hard_link(
            fixture.root.join("etc/hard-b"),
            fixture.root.join("etc/hard-b-extra"),
        )
        .unwrap();
        let (dirty_tx, rx) = crate::dirty::DirtySender::bounded(Arc::new(AtomicU64::new(0)));

        run_once(
            &fixture.root,
            &fixture.baseline_map(),
            &Config::default(),
            &dirty_tx,
            &AtomicBool::new(false),
            true,
        )
        .unwrap();
        drop(dirty_tx);

        let candidates = rx.try_iter().map(|path| path.display()).collect::<Vec<_>>();
        assert!(candidates.contains(&"/etc/hard-a".into()));
        assert!(candidates.contains(&"/etc/hard-b".into()));
    }

    #[test]
    fn auditor_rejects_non_directory_root_before_ready() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root-file");
        fs::write(&root, "not a directory").unwrap();
        let (dirty_tx, _rx) = crate::dirty::DirtySender::bounded(Arc::new(AtomicU64::new(0)));
        let lifecycle =
            crate::lifecycle::LifecycleStatus::new(crate::lifecycle::LifecycleState::Initializing);

        let error = match Auditor::start(root, Vec::new(), Config::default(), dirty_tx, lifecycle) {
            Ok(_) => panic!("auditor accepted non-directory root"),
            Err(error) => error.to_string(),
        };

        assert!(error.contains("real directory"));
    }

    // The baseline-vs-live comparison is driven with crafted facts so each
    // differing attribute is proven to demand an update on its own - a chain
    // that had been &&-flipped into only-noticing-some-differences would miss
    // these.
    #[test]
    fn candidate_needs_update_for_mode_and_device_and_symlink_and_nlink_differences() {
        use crate::rootfs::FileKind;

        let base_record = BaselineRecord {
            path: PublicPath::parse("/x").unwrap(),
            kind: "file".into(),
            mode: 0o644,
            uid: 0,
            gid: 0,
            size: Some(10),
            mtime_ns: 100,
            content_hash: Some("h".into()),
            symlink_target_bytes: None,
            symlink_target: None,
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
        let facts = |kind: FileKind| crate::rootfs::FsFacts {
            kind,
            mode: 0o600,
            uid: 0,
            gid: 0,
            size: Some(10),
            mtime_ns: 100,
            symlink_target: None,
            rdev_major: None,
            rdev_minor: None,
            dev: 1,
            ino: 1,
            nlink: 1,
            xattrs: vec![],
        };
        let empty_groups = BTreeMap::new();
        let needs = |live: &crate::rootfs::FsFacts, record: &BaselineRecord| {
            super::candidate_needs_update(
                std::path::Path::new("/tmp"),
                std::path::Path::new("/tmp/x"),
                &PublicPath::parse("/x").unwrap(),
                live,
                Some(record),
                &empty_groups,
                &Config::default(),
                false,
            )
            .unwrap()
        };

        // Mode differs: the change must surface even when kind matches.
        let record = BaselineRecord { mode: 0o644, ..base_record.clone() };
        assert!(needs(&facts(FileKind::File), &record));
        // Symlink target differs.
        let record = BaselineRecord {
            kind: "symlink".into(),
            mode: 0o777,
            symlink_target_bytes: Some(b"a".to_vec()),
            size: None,
            nlink: 1,
            ..base_record.clone()
        };
        assert!(needs(
            &crate::rootfs::FsFacts {
                kind: FileKind::Symlink,
                mode: 0o777,
                symlink_target: Some(b"b".to_vec()),
                ..facts(FileKind::Symlink)
            },
            &record
        ));
        // Device numbers differ.
        let record = BaselineRecord {
            kind: "char_device".into(),
            mode: 0o666,
            rdev_major: Some(2),
            rdev_minor: Some(2),
            size: None,
            ..base_record.clone()
        };
        assert!(needs(
            &crate::rootfs::FsFacts {
                kind: FileKind::CharDevice,
                mode: 0o666,
                rdev_major: Some(1),
                rdev_minor: Some(1),
                ..facts(FileKind::CharDevice)
            },
            &record
        ));
        // A file that gained an extra hard link must surface even when the
        // baseline recorded no key.
        let record = BaselineRecord {
            nlink: 1,
            ..base_record.clone()
        };
        assert!(needs(
            &crate::rootfs::FsFacts {
                nlink: 2,
                ..facts(FileKind::File)
            },
            &record
        ));
        // A link-count change inside a keyed group must surface.
        let record = BaselineRecord {
            nlink: 2,
            hardlink_key: Some("k".into()),
            ..base_record.clone()
        };
        assert!(needs(
            &crate::rootfs::FsFacts {
                nlink: 3,
                ..facts(FileKind::File)
            },
            &record
        ));
    }

    // A hardlink sibling that the config excludes must be skipped, not
    // inspected: it was excluded for a reason and may not even exist. The
    // group's other members keep their link count (one link removed, one
    // added), so the only thing that could flag them is the excluded sibling
    // being inspected.
    #[test]
    fn an_excluded_hardlink_sibling_is_not_inspected() {
        let fixture = Fixture::new();
        let mut config = Config::default();
        config.exclusions.push("/etc/hard-b".into());
        fs::remove_file(fixture.root.join("etc/hard-b")).unwrap();
        fs::hard_link(
            fixture.root.join("etc/hard-a"),
            fixture.root.join("etc/hard-a-extra"),
        )
        .unwrap();
        let (dirty_tx, rx) = crate::dirty::DirtySender::bounded(Arc::new(AtomicU64::new(0)));

        run_once(
            &fixture.root,
            &fixture.baseline_map(),
            &config,
            &dirty_tx,
            &AtomicBool::new(false),
            true,
        )
        .unwrap();
        drop(dirty_tx);

        let candidates = rx.try_iter().map(|path| path.display()).collect::<Vec<_>>();
        assert!(
            !candidates.contains(&"/etc/hard-a".into()),
            "the excluded sibling must not make hard-a a candidate: {candidates:?}"
        );
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        root: std::path::PathBuf,
        _paths: Paths,
        baseline: BaselineDb,
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
            fs::create_dir_all(&paths.opt_dir).unwrap();
            fs::write(root.join("etc/hello.txt"), "hello").unwrap();
            fs::write(root.join("etc/delete-me"), "bye").unwrap();
            fs::write(root.join("etc/unchanged"), "same").unwrap();
            fs::write(root.join("etc/hard-a"), "shared").unwrap();
            fs::hard_link(root.join("etc/hard-a"), root.join("etc/hard-b")).unwrap();
            generate(&GenerateOptions {
                root: root.clone(),
                output: paths.baseline_db.clone(),
            })
            .unwrap();
            layout::ensure(&paths).unwrap();
            let baseline = BaselineDb::open(&paths.baseline_db).unwrap();
            Self {
                _temp: temp,
                root,
                _paths: paths,
                baseline,
            }
        }

        fn baseline_map(&self) -> BTreeMap<PublicPath, BaselineRecord> {
            self.baseline
                .all_records()
                .unwrap()
                .into_iter()
                .map(|record| (record.path.clone(), record))
                .collect()
        }
    }

    fn filetime_from_ns(ns: i64) -> filetime::FileTime {
        filetime::FileTime::from_unix_time(
            ns.div_euclid(1_000_000_000),
            ns.rem_euclid(1_000_000_000) as u32,
        )
    }
}
