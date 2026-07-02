use anyhow::{Context, Result};
use fs2::FileExt;
use rusqlite::{Connection, params};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{metadata, paths::Paths, public};

pub struct WriterLock {
    _file: File,
}

impl WriterLock {
    pub fn acquire(paths: &Paths) -> Result<Self> {
        if let Some(parent) = paths.lock_file.parent() {
            ensure_real_dir(parent)?;
        }
        ensure_real_file_or_missing(&paths.lock_file)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&paths.lock_file)
            .with_context(|| format!("open lock {}", paths.lock_file.display()))?;

        file.try_lock_exclusive().with_context(|| {
            format!(
                "acquire lock {} (another persistence process owns this volume; is a second container mounting it?)",
                paths.lock_file.display()
            )
        })?;

        Ok(Self { _file: file })
    }
}

pub struct StateDb {
    conn: Connection,
}

impl StateDb {
    pub fn open_or_rebuild(paths: &Paths) -> Result<Self> {
        match Self::open(paths) {
            Ok(db) => Ok(db),
            Err(error) => {
                tracing::warn!(error = %error, "rebuilding corrupt internal state database");
                move_corrupt_db(paths)?;
                Self::open(paths)
            }
        }
    }

    fn open(paths: &Paths) -> Result<Self> {
        ensure_real_state_db_path(paths)?;
        let conn = Connection::open(&paths.state_db)
            .with_context(|| format!("open {}", paths.state_db.display()))?;
        let db = Self { conn };
        db.migrate()?;
        db.rebuild_public_index(paths)?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        self.conn
            .execute_batch(
                "
                PRAGMA journal_mode = WAL;
                PRAGMA foreign_keys = ON;

                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS public_index (
                    kind TEXT NOT NULL,
                    path TEXT NOT NULL,
                    PRIMARY KEY (kind, path)
                );
                ",
            )
            .context("migrate internal state database")?;
        Ok(())
    }

    pub fn rebuild_public_index(&self, paths: &Paths) -> Result<()> {
        let mut changed = public::list_public_paths(&paths.changed_dir)?;
        let mut removed = public::list_public_file_paths(&paths.removed_dir)?;
        changed.sort();
        removed.sort();

        let metadata_count = metadata::load(&paths.metadata_file)?.len();
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM public_index", [])?;

        for path in changed {
            tx.execute(
                "INSERT OR REPLACE INTO public_index (kind, path) VALUES ('changed', ?1)",
                params![path.display()],
            )?;
        }
        for path in removed {
            tx.execute(
                "INSERT OR REPLACE INTO public_index (kind, path) VALUES ('removed', ?1)",
                params![path.display()],
            )?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('metadata_record_count', ?1)",
            params![metadata_count.to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn public_count(&self, kind: &str) -> Result<u64> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM public_index WHERE kind = ?1",
            params![kind],
            |row| row.get(0),
        )?;
        count.try_into().context("public_count was negative")
    }

    pub fn metadata_record_count(&self) -> Result<u64> {
        let value = match self.conn.query_row(
            "SELECT value FROM meta WHERE key = 'metadata_record_count'",
            [],
            |row| row.get::<_, String>(0),
        ) {
            Ok(value) => value,
            Err(rusqlite::Error::QueryReturnedNoRows) => "0".to_string(),
            Err(error) => return Err(error).context("read metadata_record_count"),
        };
        let count = value.parse().context("parse metadata_record_count")?;
        Ok(count)
    }

    pub fn meta_value(&self, key: &str) -> Result<Option<String>> {
        match self.conn.query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        ) {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error).with_context(|| format!("read meta key {key}")),
        }
    }

    pub fn record_phase_success(&self, phase: &str) -> Result<()> {
        let now = timestamp();
        self.set_meta(&format!("last_{phase}_success_at"), &now)?;
        self.set_meta("last_error", "")?;
        self.set_meta(&format!("last_{phase}_error"), "")?;
        Ok(())
    }

    pub fn record_phase_failure(&self, phase: &str, error: &str) -> Result<()> {
        let now = timestamp();
        self.set_meta(&format!("last_{phase}_failure_at"), &now)?;
        self.set_meta("last_error", error)?;
        self.set_meta(&format!("last_{phase}_error"), error)?;
        Ok(())
    }

    pub fn record_diagnostic(&self, key: &str, value: &str) -> Result<()> {
        self.set_meta(&format!("diagnostic_{key}"), value)
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }
}

fn ensure_real_state_db_path(paths: &Paths) -> Result<()> {
    ensure_real_file_or_missing(&paths.state_db)
}

fn move_corrupt_db(paths: &Paths) -> Result<()> {
    match fs::symlink_metadata(&paths.state_db) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error).with_context(|| format!("stat {}", paths.state_db.display()));
        }
    }

    let backup = paths
        .state_db
        .with_file_name(format!("state.sqlite.corrupt.{}", timestamp()));
    fs::rename(&paths.state_db, &backup).with_context(|| {
        format!(
            "move corrupt state db {} to {}",
            paths.state_db.display(),
            backup.display()
        )
    })
}

fn timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}-{:09}", duration.as_secs(), duration.subsec_nanos())
}

pub fn write_error_log(path: &Path, error: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        ensure_real_dir(parent)?;
    }
    ensure_real_file_or_missing(path)?;

    let temp = path.with_extension("log.tmp");
    let _ = fs::remove_file(&temp);
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .with_context(|| format!("create {}", temp.display()))?;
        file.write_all(format!("{error}\n").as_bytes())
            .with_context(|| format!("write {}", temp.display()))?;
        file.sync_all()
            .with_context(|| format!("fsync {}", temp.display()))?;
    }
    fs::rename(&temp, path)
        .with_context(|| format!("publish error log {} to {}", temp.display(), path.display()))?;
    fsync_parent(path)
}

fn ensure_real_file_or_missing(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => anyhow::bail!("{} must be a real file", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
    }
    Ok(())
}

fn ensure_real_dir(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => anyhow::bail!("{} must be a real directory", path.display()),
        Err(error) => Err(error).with_context(|| format!("stat {}", path.display())),
    }
}

fn fsync_parent(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("path has no parent: {}", path.display()))?;
    let dir = File::open(parent).with_context(|| format!("open {}", parent.display()))?;
    dir.sync_all()
        .with_context(|| format!("fsync {}", parent.display()))
}

#[cfg(test)]
mod tests {
    use super::{StateDb, WriterLock};
    use crate::{layout, paths::Paths};
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn lock_prevents_a_second_writer() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        layout::ensure(&paths).unwrap();

        let _first = WriterLock::acquire(&paths).unwrap();
        assert!(WriterLock::acquire(&paths).is_err());
    }

    #[test]
    fn db_rebuilds_public_index_from_public_truth() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        layout::ensure(&paths).unwrap();
        fs::create_dir_all(paths.changed_dir.join("etc")).unwrap();
        fs::write(paths.changed_dir.join("etc/hosts"), "changed").unwrap();
        fs::create_dir_all(paths.removed_dir.join("nested")).unwrap();
        fs::write(paths.removed_dir.join("nested/deleted"), "").unwrap();
        fs::write(
            &paths.metadata_file,
            "{\"version\":1,\"path\":\"/etc/hosts\",\"pathBytesB64\":\"L2V0Yy9ob3N0cw==\",\"kind\":\"file\"}\n\n",
        )
        .unwrap();

        let db = StateDb::open_or_rebuild(&paths).unwrap();

        assert_eq!(db.public_count("changed").unwrap(), 2);
        assert_eq!(db.public_count("removed").unwrap(), 1);
        assert_eq!(db.metadata_record_count().unwrap(), 1);
    }

    #[test]
    fn corrupt_db_is_moved_aside_and_rebuilt() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        layout::ensure(&paths).unwrap();
        fs::write(&paths.state_db, "not sqlite").unwrap();

        let db = StateDb::open_or_rebuild(&paths).unwrap();

        assert_eq!(db.public_count("changed").unwrap(), 0);
        assert_eq!(db.metadata_record_count().unwrap(), 0);
        assert!(paths.internal_dir.read_dir().unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("state.sqlite.corrupt.")
        }));
    }

    // A symlinked state db must never be opened through the link: open() is the
    // one place the volume's truth is read before the rebuild guard, and a
    // write-through would hand the operator's outside file a sqlite header.
    #[test]
    fn open_refuses_a_symlinked_state_db_without_touching_its_target() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        layout::ensure(&paths).unwrap();
        let outside = temp.path().join("outside.sqlite");
        fs::write(&outside, "keep me").unwrap();
        fs::remove_file(&paths.state_db).unwrap_or(());
        symlink(&outside, &paths.state_db).unwrap();

        let error = match StateDb::open(&paths) {
            Ok(_) => panic!("symlinked state db opened"),
            Err(error) => error.to_string(),
        };
        assert!(error.contains("real file"), "{error}");
        assert_eq!(fs::read_to_string(outside).unwrap(), "keep me");
    }

    #[test]
    fn ensure_real_file_or_missing_rejects_an_unreachable_path() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("not-a-dir");
        fs::write(&parent, "file").unwrap();
        assert!(super::ensure_real_file_or_missing(&parent.join("lock")).is_err());
    }

    #[test]
    fn open_reports_an_unreachable_state_db_as_a_stat_error() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("not-a-dir");
        fs::write(&parent, "file").unwrap();
        let blocked = Paths::new(
            temp.path().join("opt/persistence"),
            temp.path().join("run/persistence"),
            parent.join("persistence"),
        );

        let error = match StateDb::open(&blocked) {
            Ok(_) => panic!("unreachable state db opened"),
            Err(error) => error.to_string(),
        };
        assert!(error.starts_with("stat"), "{error}");
    }

    #[test]
    fn fsync_parent_refuses_a_path_with_no_parent() {
        assert!(super::fsync_parent(std::path::Path::new("plain-name")).is_err());
    }

    // The corrupt-db salvage: a missing state db needs no move, and an
    // unreachable one must surface as an error, never a silent success.
    #[test]
    fn move_corrupt_db_answers_the_two_cases() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        layout::ensure(&paths).unwrap();
        assert!(super::move_corrupt_db(&paths).is_ok());

        let parent = temp.path().join("not-a-dir");
        fs::write(&parent, "file").unwrap();
        let blocked = Paths::new(
            temp.path().join("opt/persistence"),
            temp.path().join("run/persistence"),
            parent.join("persistence"),
        );
        assert!(super::move_corrupt_db(&blocked).is_err());
    }

    #[test]
    fn timestamps_are_wall_clock_shaped() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        layout::ensure(&paths).unwrap();
        let db = StateDb::open_or_rebuild(&paths).unwrap();
        db.record_phase_success("apply").unwrap();

        let stamped = db.meta_value("last_apply_success_at").unwrap().unwrap();
        assert!(
            stamped.starts_with("1"),
            "a 1970-epoch timestamp would be a broken clock: {stamped}"
        );
        assert_eq!(stamped.split('-').count(), 2, "{stamped}");
    }

    #[test]
    fn state_db_symlink_is_moved_aside_and_rebuilt() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        layout::ensure(&paths).unwrap();
        let outside = temp.path().join("outside.sqlite");
        fs::write(&outside, "not sqlite").unwrap();
        fs::remove_file(&paths.state_db).unwrap_or(());
        symlink(&outside, &paths.state_db).unwrap();

        let db = StateDb::open_or_rebuild(&paths).unwrap();

        assert_eq!(db.public_count("changed").unwrap(), 0);
        assert!(
            !fs::symlink_metadata(&paths.state_db)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read_to_string(outside).unwrap(), "not sqlite");
    }

    #[test]
    fn records_phase_failures_and_error_logs() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        layout::ensure(&paths).unwrap();
        let db = StateDb::open_or_rebuild(&paths).unwrap();

        db.record_phase_failure("apply", "missing baseline")
            .unwrap();
        super::write_error_log(&paths.apply_error_log, "missing baseline").unwrap();

        assert_eq!(
            db.meta_value("last_error").unwrap().as_deref(),
            Some("missing baseline")
        );
        db.record_phase_success("apply").unwrap();
        assert_eq!(
            db.meta_value("last_apply_error").unwrap().as_deref(),
            Some("")
        );
        assert!(
            fs::read_to_string(paths.apply_error_log)
                .unwrap()
                .contains("missing baseline")
        );
    }

    #[test]
    fn error_log_write_rejects_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        layout::ensure(&paths).unwrap();
        let outside = temp.path().join("outside.log");
        fs::write(&outside, "outside").unwrap();
        symlink(&outside, &paths.apply_error_log).unwrap();

        let error = super::write_error_log(&paths.apply_error_log, "boom")
            .unwrap_err()
            .to_string();

        assert!(error.contains("real file"));
        assert_eq!(fs::read_to_string(outside).unwrap(), "outside");
    }

    #[test]
    fn lock_rejects_symlink_parent() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.data_dir).unwrap();
        let outside = temp.path().join("outside-internal");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, &paths.internal_dir).unwrap();

        let error = match WriterLock::acquire(&paths) {
            Ok(_) => panic!("lock acquired through symlink parent"),
            Err(error) => error.to_string(),
        };

        assert!(error.contains("real directory"));
        assert!(!outside.join("lock").exists());
    }

    #[test]
    fn error_log_write_rejects_symlink_parent() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.data_dir).unwrap();
        let outside = temp.path().join("outside-internal");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, &paths.internal_dir).unwrap();

        let error = super::write_error_log(&paths.apply_error_log, "boom")
            .unwrap_err()
            .to_string();

        assert!(error.contains("real directory"));
        assert!(!outside.join("apply-error.log").exists());
    }

    fn test_paths(root: &std::path::Path) -> Paths {
        Paths::new(
            root.join("opt/persistence"),
            root.join("run/persistence"),
            root.join("data/persistence"),
        )
    }
}
