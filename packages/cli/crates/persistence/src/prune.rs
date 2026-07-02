use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[cfg(unix)]
use std::{collections::BTreeSet, fs, path::Path};

#[cfg(unix)]
use crate::{
    baseline::BaselineDb,
    config::Config,
    internal::StateDb,
    metadata,
    paths::Paths,
    public, rootfs,
    update::{self, UpdateContext, UpdateOutcome},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneReport {
    pub removed: Vec<String>,
    pub skipped: Vec<String>,
}

#[cfg(unix)]
pub fn run(
    root: &Path,
    paths: &Paths,
    config: &Config,
    baseline: &BaselineDb,
    db: &StateDb,
) -> Result<PruneReport> {
    let mut report = PruneReport {
        removed: Vec::new(),
        skipped: Vec::new(),
    };

    prune_baseline_equal_changed(root, paths, config, baseline, &mut report)?;
    prune_stale_tombstones(paths, config, baseline, &mut report)?;
    prune_stale_metadata(root, paths, config, baseline, &mut report)?;
    prune_empty_changed_dirs(root, paths, config, baseline, &mut report)?;
    prune_empty_removed_dirs(paths, config, &mut report)?;
    db.rebuild_public_index(paths)?;
    Ok(report)
}

#[cfg(not(unix))]
#[cfg_attr(test, mutants::skip)]
pub fn run(_paths: &crate::paths::Paths, _db: &crate::internal::StateDb) -> Result<PruneReport> {
    Ok(PruneReport {
        removed: Vec::new(),
        skipped: vec!["prune is only supported on Unix".into()],
    })
}

#[cfg(unix)]
fn prune_baseline_equal_changed(
    root: &Path,
    paths: &Paths,
    config: &Config,
    baseline: &BaselineDb,
    report: &mut PruneReport,
) -> Result<()> {
    let ctx = UpdateContext {
        root,
        paths,
        config,
        baseline,
    };
    let mut store = metadata::MetadataStore::load(&paths.metadata_file)?;

    for entry in public::list_public_entries(&paths.changed_dir)? {
        if public::is_excluded(&entry.path, config) {
            report.skipped.push(format!("excluded {}", entry.path));
            continue;
        }
        if matches!(
            update::update_public_path(&ctx, &mut store, &entry.path)?,
            UpdateOutcome::Pruned
        ) {
            report
                .removed
                .push(format!("baseline-equal changed {}", entry.path));
        }
    }
    store.flush()?;
    Ok(())
}

#[cfg(unix)]
fn prune_stale_tombstones(
    paths: &Paths,
    config: &Config,
    baseline: &BaselineDb,
    report: &mut PruneReport,
) -> Result<()> {
    for public_path in public::list_public_file_paths(&paths.removed_dir)? {
        if public::is_excluded(&public_path, config) {
            report.skipped.push(format!("excluded {}", public_path));
            continue;
        }
        if baseline.get(&public_path)?.is_none()
            && !exists_no_follow(&public_path.destination(&paths.changed_dir))
        {
            let marker = public_path.destination(&paths.removed_dir);
            rootfs::ensure_safe_parent(&paths.removed_dir, &marker)?;
            public::remove_path(&marker)?;
            report
                .removed
                .push(format!("stale tombstone {}", public_path));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn prune_stale_metadata(
    root: &Path,
    paths: &Paths,
    config: &Config,
    baseline: &BaselineDb,
    report: &mut PruneReport,
) -> Result<()> {
    let mut kept = Vec::new();
    let mut dropped = false;
    for record in metadata::load(&paths.metadata_file)? {
        let public_path = record.public_path()?;
        if public::is_excluded(&public_path, config) {
            kept.push(record);
            report.skipped.push(format!("excluded {}", public_path));
            continue;
        }
        let live_exists = exists_no_follow(&public::live_path(root, &public_path));
        let changed_exists = exists_no_follow(&public_path.destination(&paths.changed_dir));
        let baseline_exists = baseline.get(&public_path)?.is_some();
        if !live_exists && !changed_exists && !baseline_exists && !fallback_only_metadata(&record) {
            report
                .removed
                .push(format!("stale metadata {}", public_path));
            dropped = true;
        } else {
            kept.push(record);
        }
    }

    if dropped {
        metadata::replace(&paths.metadata_file, &kept)?;
    }
    Ok(())
}

#[cfg(unix)]
fn fallback_only_metadata(record: &metadata::MetadataRecord) -> bool {
    matches!(
        record.kind.as_str(),
        "fifo" | "char_device" | "block_device"
    )
}

#[cfg(unix)]
fn prune_empty_changed_dirs(
    root: &Path,
    paths: &Paths,
    config: &Config,
    baseline: &BaselineDb,
    report: &mut PruneReport,
) -> Result<()> {
    if !real_dir_exists(&paths.changed_dir)? {
        return Ok(());
    }
    let metadata_paths = metadata::load(&paths.metadata_file)?
        .into_iter()
        .map(|record| record.public_path().map(|path| path.as_bytes().to_vec()))
        .collect::<Result<BTreeSet<_>>>()?;
    let mut dirs = Vec::new();
    for entry in walkdir::WalkDir::new(&paths.changed_dir)
        .follow_links(false)
        .min_depth(1)
        .contents_first(true)
    {
        let entry = entry?;
        if entry.file_type().is_dir() {
            dirs.push(entry.path().to_path_buf());
        }
    }
    for dir in dirs {
        if fs::read_dir(&dir)?.next().is_some() {
            continue;
        }
        let public_path = dir
            .strip_prefix(&paths.changed_dir)
            .ok()
            .and_then(|path| public::PublicPath::from_root_relative(path).ok());
        let Some(public_path) = public_path else {
            continue;
        };
        if public::is_excluded(&public_path, config) {
            report.skipped.push(format!("excluded {}", public_path));
            continue;
        }
        if metadata_paths.contains(public_path.as_bytes()) {
            continue;
        }
        let live_exists = exists_no_follow(&public::live_path(root, &public_path));
        let baseline_exists = baseline.get(&public_path)?.is_some();
        if baseline_exists || !live_exists {
            fs::remove_dir(&dir)?;
            report
                .removed
                .push(format!("empty changed dir {}", public_path));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn prune_empty_removed_dirs(
    paths: &Paths,
    config: &Config,
    report: &mut PruneReport,
) -> Result<()> {
    if !real_dir_exists(&paths.removed_dir)? {
        return Ok(());
    }
    let mut dirs = Vec::new();
    for entry in walkdir::WalkDir::new(&paths.removed_dir)
        .follow_links(false)
        .min_depth(1)
        .contents_first(true)
    {
        let entry = entry?;
        if entry.file_type().is_dir() {
            dirs.push(entry.path().to_path_buf());
        }
    }
    for dir in dirs {
        if fs::read_dir(&dir)?.next().is_some() {
            continue;
        }
        let public_path = dir
            .strip_prefix(&paths.removed_dir)
            .ok()
            .and_then(|path| public::PublicPath::from_root_relative(path).ok());
        let Some(public_path) = public_path else {
            continue;
        };
        if public::is_excluded(&public_path, config) {
            report.skipped.push(format!("excluded {}", public_path));
            continue;
        }
        fs::remove_dir(&dir)?;
        report
            .removed
            .push(format!("empty removed dir {}", public_path));
    }
    Ok(())
}

#[cfg(unix)]
fn exists_no_follow(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

#[cfg(unix)]
fn real_dir_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(true),
        Ok(_) => anyhow::bail!("{} must be a real directory", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("stat {}", path.display())),
    }
}

// Prints to the process's stdout, which the test harness intercepts before any
// test runs; the report itself is the tested artifact.
#[cfg_attr(test, mutants::skip)]
pub fn print_human(report: &PruneReport) {
    println!("persistence prune:");
    if report.removed.is_empty() {
        println!("  removed: none");
    } else {
        for removed in &report.removed {
            println!("  removed: {removed}");
        }
    }
    for skipped in &report.skipped {
        println!("  skipped: {skipped}");
    }
}

#[cfg(test)]
mod tests {
    use super::run;
    use crate::{
        apply::apply_public_truth,
        baseline::{BaselineDb, GenerateOptions, generate},
        config::Config,
        internal::StateDb,
        layout,
        metadata::{self, MetadataRecord},
        paths::Paths,
        public::PublicPath,
        update::{UpdateContext, update_path},
    };
    use proptest::{
        prelude::*,
        test_runner::{Config as ProptestConfig, RngSeed},
    };
    use std::{fs, os::unix::fs::symlink};

    const GENERATED_PATHS: [&str; 4] = [
        "/generated/alpha",
        "/generated/bravo",
        "/generated/charlie",
        "/generated/delta",
    ];

    #[derive(Clone, Debug)]
    enum Change {
        Write(usize, Vec<u8>),
        Remove(usize),
    }

    fn change() -> impl Strategy<Value = Change> {
        prop_oneof![
            (
                0..GENERATED_PATHS.len(),
                proptest::collection::vec(any::<u8>(), 0..24)
            )
                .prop_map(|(index, contents)| Change::Write(index, contents)),
            (0..GENERATED_PATHS.len()).prop_map(Change::Remove),
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: 48,
            failure_persistence: None,
            rng_seed: RngSeed::Fixed(0x434f_5059),
            ..ProptestConfig::default()
        })]

        #[test]
        fn generated_change_sets_round_trip_through_prune_and_apply_idempotently(
            initial in proptest::collection::vec(
                proptest::option::of(proptest::collection::vec(any::<u8>(), 0..24)),
                GENERATED_PATHS.len()..=GENERATED_PATHS.len(),
            ),
            changes in proptest::collection::vec(change(), 1..24),
        ) {
            let fixture = GeneratedFixture::new(&initial);
            let config = Config::default();
            let ctx = UpdateContext {
                root: &fixture.root,
                paths: &fixture.paths,
                config: &config,
                baseline: &fixture.baseline,
            };

            for change in changes {
                let index = match change {
                    Change::Write(index, contents) => {
                        let path = fixture.root.join(GENERATED_PATHS[index].trim_start_matches('/'));
                        fs::create_dir_all(path.parent().unwrap()).unwrap();
                        fs::write(path, contents).unwrap();
                        index
                    }
                    Change::Remove(index) => {
                        let path = fixture.root.join(GENERATED_PATHS[index].trim_start_matches('/'));
                        match fs::remove_file(path) {
                            Ok(()) => {}
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                            Err(error) => panic!("remove generated path: {error}"),
                        }
                        index
                    }
                };
                update_path(&ctx, GENERATED_PATHS[index]).unwrap();
            }

            let expected = read_generated_state(&fixture.root);
            run(
                &fixture.root,
                &fixture.paths,
                &config,
                &fixture.baseline,
                &fixture.db,
            )
            .unwrap();

            let restored = fixture.fresh_root(&initial);
            apply_public_truth(&restored, &fixture.paths, &config).unwrap();
            prop_assert_eq!(read_generated_state(&restored), expected.clone());

            apply_public_truth(&restored, &fixture.paths, &config).unwrap();
            prop_assert_eq!(read_generated_state(&restored), expected);
        }

        #[test]
        fn image_upgrades_keep_every_captured_user_edit(
            image in proptest::collection::vec(any::<u8>(), 0..32),
            upgrade in proptest::collection::vec(any::<u8>(), 0..32),
            edit in proptest::collection::vec(any::<u8>(), 0..32),
        ) {
            let image = tagged_contents(0, image);
            let upgrade = tagged_contents(1, upgrade);
            let edit = tagged_contents(2, edit);
            let initial = vec![Some(image), None, None, None];
            let fixture = GeneratedFixture::new(&initial);
            let config = Config::default();
            let edited_path = fixture.root.join("generated/alpha");
            fs::write(&edited_path, &edit).unwrap();
            update_path(
                &UpdateContext {
                    root: &fixture.root,
                    paths: &fixture.paths,
                    config: &config,
                    baseline: &fixture.baseline,
                },
                GENERATED_PATHS[0],
            )
            .unwrap();
            run(
                &fixture.root,
                &fixture.paths,
                &config,
                &fixture.baseline,
                &fixture.db,
            )
            .unwrap();

            let upgraded = fixture.fresh_root(&[Some(upgrade), None, None, None]);
            apply_public_truth(&upgraded, &fixture.paths, &config).unwrap();

            prop_assert_eq!(fs::read(upgraded.join("generated/alpha")).unwrap(), edit);
        }
    }

    #[test]
    fn prune_removes_stale_tombstone_and_empty_dirs() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.removed_dir.join("gone")).unwrap();
        fs::write(fixture.paths.removed_dir.join("gone/file"), "").unwrap();

        let report = run(
            &fixture.root,
            &fixture.paths,
            &Config::default(),
            &fixture.baseline,
            &fixture.db,
        )
        .unwrap();

        assert!(
            report
                .removed
                .iter()
                .any(|item| item.contains("stale tombstone"))
        );
        assert!(!fixture.paths.removed_dir.join("gone/file").exists());
    }

    #[test]
    fn prune_removes_baseline_equal_changed_entry() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.changed_dir.join("etc/hello"), "hello").unwrap();

        let report = run(
            &fixture.root,
            &fixture.paths,
            &Config::default(),
            &fixture.baseline,
            &fixture.db,
        )
        .unwrap();

        assert!(
            report
                .removed
                .iter()
                .any(|item| item == "baseline-equal changed /etc/hello")
        );
        assert!(!fixture.paths.changed_dir.join("etc/hello").exists());
        assert!(!fixture.paths.changed_dir.join("etc").exists());
    }

    #[test]
    fn prune_removes_stale_normal_metadata_but_keeps_fallback_only_metadata() {
        let fixture = Fixture::new();
        upsert_metadata(&fixture.paths.metadata_file, "/orphan", "file");
        upsert_metadata(&fixture.paths.metadata_file, "/pipe", "fifo");

        let report = run(
            &fixture.root,
            &fixture.paths,
            &Config::default(),
            &fixture.baseline,
            &fixture.db,
        )
        .unwrap();

        assert!(
            report
                .removed
                .iter()
                .any(|item| item == "stale metadata /orphan")
        );
        assert!(
            !report
                .removed
                .iter()
                .any(|item| item == "stale metadata /pipe")
        );
        let records = metadata::load(&fixture.paths.metadata_file).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].public_path().unwrap().as_bytes(), b"/pipe");
        assert_eq!(records[0].kind, "fifo");
    }

    #[test]
    fn prune_leaves_excluded_dormant_public_truth_untouched() {
        let fixture = Fixture::new();
        let mut config = Config::default();
        config.exclusions.push("/secret".into());
        fs::create_dir_all(fixture.paths.changed_dir.join("secret")).unwrap();
        fs::write(fixture.paths.changed_dir.join("secret/file"), "user").unwrap();
        fs::create_dir_all(fixture.paths.removed_dir.join("secret")).unwrap();
        fs::write(fixture.paths.removed_dir.join("secret/deleted"), "").unwrap();
        upsert_metadata(&fixture.paths.metadata_file, "/secret/meta", "file");

        let report = run(
            &fixture.root,
            &fixture.paths,
            &config,
            &fixture.baseline,
            &fixture.db,
        )
        .unwrap();

        assert!(fixture.paths.changed_dir.join("secret/file").exists());
        assert!(fixture.paths.removed_dir.join("secret/deleted").exists());
        assert_eq!(
            metadata::load(&fixture.paths.metadata_file).unwrap().len(),
            1
        );
        assert!(
            report
                .skipped
                .iter()
                .any(|item| item == "excluded /secret/file")
        );
        assert!(
            report
                .skipped
                .iter()
                .any(|item| item == "excluded /secret/deleted")
        );
        assert!(
            report
                .skipped
                .iter()
                .any(|item| item == "excluded /secret/meta")
        );
    }

    #[test]
    fn prune_keeps_user_created_empty_changed_directory() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.root.join("empty-user-dir")).unwrap();
        fs::create_dir(fixture.paths.changed_dir.join("empty-user-dir")).unwrap();

        let report = run(
            &fixture.root,
            &fixture.paths,
            &Config::default(),
            &fixture.baseline,
            &fixture.db,
        )
        .unwrap();

        assert!(fixture.paths.changed_dir.join("empty-user-dir").is_dir());
        assert!(
            !report
                .removed
                .iter()
                .any(|item| item.contains("/empty-user-dir"))
        );
    }

    #[test]
    fn exists_no_follow_counts_broken_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let link = temp.path().join("broken");
        symlink("/missing-target", &link).unwrap();

        assert!(super::exists_no_follow(&link));
    }

    // A missing removed dir is the normal first-run state (nothing was ever
    // removed); prune must answer a clean report, not fail.
    #[test]
    fn prune_tolerates_a_missing_removed_dir() {
        let fixture = Fixture::new();
        fs::remove_dir_all(&fixture.paths.removed_dir).unwrap();

        let report = run(
            &fixture.root,
            &fixture.paths,
            &Config::default(),
            &fixture.baseline,
            &fixture.db,
        )
        .unwrap();

        assert!(report.removed.is_empty());
    }

    // A removed dir that is a regular file is a broken layout, not a silent
    // "nothing to prune".
    #[test]
    fn prune_refuses_a_file_where_the_removed_dir_should_be() {
        let fixture = Fixture::new();
        fs::remove_dir_all(&fixture.paths.removed_dir).unwrap();
        fs::write(&fixture.paths.removed_dir, "file").unwrap();

        assert!(run(
            &fixture.root,
            &fixture.paths,
            &Config::default(),
            &fixture.baseline,
            &fixture.db,
        )
        .is_err());
    }

    // real_dir_exists must refuse a regular file, report a missing dir as
    // absent, and surface an unreachable path as an error - the three answers
    // the prune loops branch on.
    #[test]
    fn real_dir_exists_answers_the_three_cases() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("plain-file");
        fs::write(&file, "x").unwrap();
        assert!(super::real_dir_exists(&file).is_err());

        let missing = temp.path().join("missing");
        assert_eq!(super::real_dir_exists(&missing).unwrap(), false);

        let parent = temp.path().join("not-a-dir");
        fs::write(&parent, "file").unwrap();
        let unreachable = parent.join("child");
        assert!(super::real_dir_exists(&unreachable).is_err());
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        root: std::path::PathBuf,
        paths: Paths,
        baseline: BaselineDb,
        db: StateDb,
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
            fs::create_dir_all(root.join("opt/persistence")).unwrap();
            fs::create_dir_all(root.join("etc")).unwrap();
            fs::write(root.join("etc/hello"), "hello").unwrap();
            generate(&GenerateOptions {
                root: root.clone(),
                output: paths.baseline_db.clone(),
            })
            .unwrap();
            layout::ensure(&paths).unwrap();
            let baseline = BaselineDb::open(&paths.baseline_db).unwrap();
            let db = StateDb::open_or_rebuild(&paths).unwrap();
            Self {
                _temp: temp,
                root,
                paths,
                baseline,
                db,
            }
        }
    }

    struct GeneratedFixture {
        _temp: tempfile::TempDir,
        root: std::path::PathBuf,
        paths: Paths,
        baseline: BaselineDb,
        db: StateDb,
    }

    impl GeneratedFixture {
        fn new(initial: &[Option<Vec<u8>>]) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("root");
            let paths = Paths::new(
                root.join("opt/persistence"),
                temp.path().join("run/persistence"),
                temp.path().join("data/persistence"),
            );
            write_generated_state(&root, initial);
            fs::create_dir_all(root.join("opt/persistence")).unwrap();
            generate(&GenerateOptions {
                root: root.clone(),
                output: paths.baseline_db.clone(),
            })
            .unwrap();
            layout::ensure(&paths).unwrap();
            let baseline = BaselineDb::open(&paths.baseline_db).unwrap();
            let db = StateDb::open_or_rebuild(&paths).unwrap();
            Self {
                _temp: temp,
                root,
                paths,
                baseline,
                db,
            }
        }

        fn fresh_root(&self, state: &[Option<Vec<u8>>]) -> std::path::PathBuf {
            let root = self._temp.path().join("fresh-root");
            write_generated_state(&root, state);
            root
        }
    }

    fn tagged_contents(tag: u8, mut contents: Vec<u8>) -> Vec<u8> {
        contents.insert(0, tag);
        contents
    }

    fn write_generated_state(root: &std::path::Path, state: &[Option<Vec<u8>>]) {
        fs::create_dir_all(root.join("generated")).unwrap();
        for (public_path, contents) in GENERATED_PATHS.iter().zip(state) {
            let path = root.join(public_path.trim_start_matches('/'));
            if let Some(contents) = contents {
                fs::write(path, contents).unwrap();
            }
        }
    }

    fn read_generated_state(root: &std::path::Path) -> Vec<Option<Vec<u8>>> {
        GENERATED_PATHS
            .iter()
            .map(|public_path| {
                let path = root.join(public_path.trim_start_matches('/'));
                match fs::read(path) {
                    Ok(contents) => Some(contents),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => panic!("read generated path: {error}"),
                }
            })
            .collect()
    }

    fn upsert_metadata(path: &std::path::Path, public_path: &str, kind: &str) {
        let public_path = PublicPath::parse(public_path).unwrap();
        let mut record = MetadataRecord {
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
        metadata::upsert(path, record).unwrap();
    }
}
