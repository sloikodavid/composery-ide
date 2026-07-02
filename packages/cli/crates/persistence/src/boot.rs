use anyhow::{Context, Result};
use std::path::Path;

#[cfg(unix)]
use crate::capabilities;
use crate::{baseline::BaselineDb, config, internal, layout, metadata, paths::Paths};

pub fn apply(paths: &Paths) -> Result<()> {
    apply_with_root(paths, Path::new("/"))
}

fn apply_with_root(paths: &Paths, root: &Path) -> Result<()> {
    tracing::info!("persistence apply starting");
    let started = std::time::Instant::now();
    layout::ensure(paths)?;
    let _lock = internal::WriterLock::acquire(paths)?;
    layout::remove_ready(paths)?;
    let db = internal::StateDb::open_or_rebuild(paths)?;
    match apply_inner(paths, root, &db) {
        Ok(()) => {
            db.record_phase_success("apply")?;
            tracing::info!(
                elapsed_ms = started.elapsed().as_millis() as u64,
                "persistence apply completed"
            );
            Ok(())
        }
        Err(error) => {
            let summary = format!("{error:#}");
            let _ = db.record_phase_failure("apply", &summary);
            let _ = internal::write_error_log(&paths.apply_error_log, &summary);
            Err(error)
        }
    }
}

fn apply_inner(paths: &Paths, root: &Path, db: &internal::StateDb) -> Result<()> {
    let config = config::load_or_create(&paths.config_file)?;
    let _baseline = BaselineDb::open(&paths.baseline_db)
        .with_context(|| format!("apply requires baseline {}", paths.baseline_db.display()))?;
    let capability_report = capabilities::probe(&paths.data_dir)?;
    db.record_diagnostic("capabilities", &serde_json::to_string(&capability_report)?)?;
    metadata::compact(&paths.metadata_file)?;
    #[cfg(unix)]
    crate::apply::apply_public_truth(root, paths, &config)?;
    db.rebuild_public_index(paths)?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use crate::{baseline, internal::StateDb, layout, paths::Paths};
    use std::fs;

    #[test]
    fn apply_fails_without_baseline_and_records_diagnostics() {
        let fixture = Fixture::new();
        fs::create_dir_all(&fixture.paths.run_dir).unwrap();
        fs::write(&fixture.paths.ready_file, "stale").unwrap();

        let error = super::apply_with_root(&fixture.paths, &fixture.root)
            .unwrap_err()
            .to_string();

        assert!(error.contains("baseline"));
        assert!(!fixture.paths.ready_file.exists());
        assert!(fixture.paths.apply_error_log.exists());
        let db = StateDb::open_or_rebuild(&fixture.paths).unwrap();
        assert!(
            db.meta_value("last_apply_error")
                .unwrap()
                .unwrap()
                .contains("baseline")
        );
    }

    // The public entry is apply(), which boots against the real root. With a
    // fixture lacking a baseline it must fail before touching anything outside
    // the fixture - a success here would mean the apply loop silently no-oped.
    #[test]
    fn the_public_apply_refuses_to_run_without_a_baseline() {
        let fixture = Fixture::new();
        assert!(super::apply(&fixture.paths).is_err());
    }

    #[test]
    fn apply_fails_with_corrupt_baseline_and_does_not_write_ready() {
        let fixture = Fixture::new();
        fs::create_dir_all(&fixture.paths.opt_dir).unwrap();
        fs::write(&fixture.paths.baseline_db, "not sqlite").unwrap();

        let error = super::apply_with_root(&fixture.paths, &fixture.root)
            .unwrap_err()
            .to_string();

        assert!(error.contains("baseline"));
        assert!(!fixture.paths.ready_file.exists());
        assert!(
            fs::read_to_string(&fixture.paths.apply_error_log)
                .unwrap()
                .contains("baseline")
        );
    }

    #[test]
    fn apply_success_rebuilds_public_index() {
        let fixture = Fixture::new();
        fs::create_dir_all(&fixture.paths.opt_dir).unwrap();
        baseline::generate(&baseline::GenerateOptions {
            root: fixture.root.clone(),
            output: fixture.paths.baseline_db.clone(),
        })
        .unwrap();
        fs::create_dir_all(fixture.paths.changed_dir.join("tmp")).unwrap();
        fs::write(fixture.paths.changed_dir.join("tmp/persisted"), "value").unwrap();

        super::apply_with_root(&fixture.paths, &fixture.root).unwrap();

        let db = StateDb::open_or_rebuild(&fixture.paths).unwrap();
        assert_eq!(db.public_count("changed").unwrap(), 2);
        assert!(db.meta_value("last_apply_success_at").unwrap().is_some());
        assert!(!fixture.paths.ready_file.exists());
    }

    #[test]
    fn apply_does_not_remove_live_ready_when_writer_lock_is_held() {
        let fixture = Fixture::new();
        layout::ensure(&fixture.paths).unwrap();
        let _lock = crate::internal::WriterLock::acquire(&fixture.paths).unwrap();
        fs::write(&fixture.paths.ready_file, "live").unwrap();

        let error = super::apply_with_root(&fixture.paths, &fixture.root)
            .unwrap_err()
            .to_string();

        assert!(error.contains("lock"));
        assert_eq!(
            fs::read_to_string(&fixture.paths.ready_file).unwrap(),
            "live"
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
                temp.path().join("opt/persistence"),
                temp.path().join("run/persistence"),
                temp.path().join("data/persistence"),
            );
            fs::create_dir_all(&root).unwrap();
            Self {
                _temp: temp,
                root,
                paths,
            }
        }
    }
}
