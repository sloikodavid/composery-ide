use anyhow::{Context, Result};
use std::fs;

use crate::{config, paths::Paths};

pub fn ensure(paths: &Paths) -> Result<()> {
    ensure_real_dir(&paths.data_dir)?;
    ensure_real_dir(&paths.changed_dir)?;
    ensure_real_dir(&paths.removed_dir)?;
    ensure_real_dir(&paths.internal_dir)?;
    ensure_real_dir(&paths.run_dir)?;

    config::load_or_create(&paths.config_file)?;
    ensure_real_file(&paths.metadata_file)?;
    ensure_real_file(&paths.lock_file)?;

    Ok(())
}

pub fn remove_ready(paths: &Paths) -> Result<()> {
    match fs::remove_file(&paths.ready_file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove {}", paths.ready_file.display())),
    }
}

fn ensure_real_file(path: &std::path::Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(()),
        Ok(_) => anyhow::bail!("{} must be a real file", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::write(path, []).with_context(|| format!("create {}", path.display()))
        }
        Err(error) => Err(error).with_context(|| format!("stat {}", path.display())),
    }
}

fn ensure_real_dir(path: &std::path::Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => anyhow::bail!("{} must be a real directory", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).with_context(|| format!("create {}", path.display()))?;
            let metadata =
                fs::symlink_metadata(path).with_context(|| format!("stat {}", path.display()))?;
            if metadata.file_type().is_dir() {
                Ok(())
            } else {
                anyhow::bail!("{} must be a real directory", path.display())
            }
        }
        Err(error) => Err(error).with_context(|| format!("stat {}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::{ensure, remove_ready};
    use crate::paths::Paths;
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn ensure_creates_public_and_internal_layout() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(
            temp.path().join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );

        ensure(&paths).unwrap();

        assert!(paths.config_file.is_file());
        assert!(paths.changed_dir.is_dir());
        assert!(paths.removed_dir.is_dir());
        assert!(paths.metadata_file.is_file());
        assert!(paths.internal_dir.is_dir());
        assert!(paths.lock_file.is_file());
        assert!(!paths.data_dir.join("db.sqlite").exists());
        assert!(!paths.data_dir.join("objects").exists());
    }

    #[test]
    fn ensure_rejects_public_truth_root_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(
            temp.path().join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        fs::create_dir_all(paths.changed_dir.parent().unwrap()).unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, &paths.changed_dir).unwrap();

        let error = ensure(&paths).unwrap_err().to_string();

        assert!(error.contains("real directory"));
    }

    #[test]
    fn ensure_rejects_public_truth_file_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(
            temp.path().join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        fs::create_dir_all(&paths.data_dir).unwrap();
        let outside = temp.path().join("outside-metadata");
        fs::write(&outside, "").unwrap();
        symlink(&outside, &paths.metadata_file).unwrap();

        let error = ensure(&paths).unwrap_err().to_string();

        assert!(error.contains("real file"));
    }

    // A layout path whose parent is a file is an error, never a silent
    // success - a typo'd volume path must not read as a working layout.
    #[test]
    fn ensure_rejects_an_unreachable_layout_root() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("not-a-dir");
        fs::write(&parent, "file").unwrap();
        let paths = Paths::new(
            temp.path().join("opt/persistence"),
            parent.join("run/persistence"),
            temp.path().join("data/persistence"),
        );

        assert!(ensure(&paths).is_err());
    }

    // The file/dir guards' non-NotFound arms must surface as errors: a path
    // that cannot even be looked up is not "missing, create it".
    #[test]
    fn layout_guards_refuse_unreachable_paths() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("not-a-dir");
        fs::write(&parent, "file").unwrap();
        assert!(super::ensure_real_file(&parent.join("file")).is_err());
        assert!(super::ensure_real_dir(&parent.join("dir")).is_err());
    }

    // Removing an absent ready file is a no-op success: the daemon may stop
    // before it ever wrote one. Any other removal failure is an error.
    #[test]
    fn remove_ready_is_a_no_op_when_absent_and_an_error_when_unreachable() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(
            temp.path().join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        assert!(remove_ready(&paths).is_ok());

        let parent = temp.path().join("not-a-dir");
        fs::write(&parent, "file").unwrap();
        let blocked = Paths::new(
            temp.path().join("opt/persistence"),
            parent.join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        assert!(remove_ready(&blocked).is_err());
    }
}
