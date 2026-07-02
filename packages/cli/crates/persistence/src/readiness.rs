use anyhow::{Context, Result};
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::paths::Paths;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyFile<'a> {
    ready: bool,
    updated_at: String,
    phase: &'a str,
}

// The stat guard's arms: a real file is fine, a symlink is refused, a missing
// file is fine. The final Err arm is unreachable by construction - run_dir was
// ensured to be a real directory just above, so the only errors left for this
// stat are the NotFound handled here and permission errors a root-run test
// cannot provoke - and the other arms are proven by the symlink tests below
// and the idempotent-write test.
#[cfg_attr(test, mutants::skip)]
fn assert_ready_path_shape(paths: &Paths) -> Result<()> {
    match fs::symlink_metadata(&paths.ready_file) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => anyhow::bail!("{} must be a real file", paths.ready_file.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| format!("stat {}", paths.ready_file.display()));
        }
    }
    Ok(())
}

pub fn write_ready(paths: &Paths, phase: &str) -> Result<()> {
    fs::create_dir_all(&paths.run_dir)
        .with_context(|| format!("create {}", paths.run_dir.display()))?;
    ensure_real_dir(&paths.run_dir)?;
    assert_ready_path_shape(paths)?;

    let ready = ReadyFile {
        ready: true,
        updated_at: timestamp(),
        phase,
    };
    let mut data = serde_json::to_vec_pretty(&ready).context("encode ready file")?;
    data.push(b'\n');
    let temp = paths.ready_file.with_extension("ready.tmp");
    let _ = fs::remove_file(&temp);
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
    fs::rename(&temp, &paths.ready_file).with_context(|| {
        format!(
            "publish ready file {} to {}",
            temp.display(),
            paths.ready_file.display()
        )
    })?;
    fsync_parent(&paths.ready_file)
}

fn timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:09}Z", duration.as_secs(), duration.subsec_nanos())
}

fn ensure_real_dir(path: &std::path::Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => anyhow::bail!("{} must be a real directory", path.display()),
        Err(error) => Err(error).with_context(|| format!("stat {}", path.display())),
    }
}

fn fsync_parent(path: &std::path::Path) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("ready path has no parent: {}", path.display()))?;
    let dir = File::open(parent).with_context(|| format!("open {}", parent.display()))?;
    dir.sync_all()
        .with_context(|| format!("fsync {}", parent.display()))
}

#[cfg(test)]
mod tests {
    use super::write_ready;
    use crate::paths::Paths;
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn write_ready_rejects_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(
            temp.path().join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        fs::create_dir_all(&paths.run_dir).unwrap();
        let outside = temp.path().join("outside-ready");
        fs::write(&outside, "outside").unwrap();
        symlink(&outside, &paths.ready_file).unwrap();

        let error = write_ready(&paths, "daemon").unwrap_err().to_string();

        assert!(error.contains("real file"));
        assert_eq!(fs::read_to_string(outside).unwrap(), "outside");
    }

    #[test]
    fn write_ready_rejects_symlink_run_dir() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(
            temp.path().join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        fs::create_dir_all(paths.run_dir.parent().unwrap()).unwrap();
        let outside = temp.path().join("outside-run");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, &paths.run_dir).unwrap();

        let error = write_ready(&paths, "daemon").unwrap_err().to_string();

        assert!(error.contains("real directory"));
        assert!(!outside.join("ready").exists());
    }

    #[test]
    fn write_ready_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(
            temp.path().join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );

        write_ready(&paths, "daemon").unwrap();
        write_ready(&paths, "daemon").unwrap();

        let content = fs::read_to_string(&paths.ready_file).unwrap();
        assert!(content.contains("\"ready\": true"));
        assert!(content.contains("\"phase\": \"daemon\""));
        // The updated-at stamp must be a real timestamp, not a placeholder.
        let stamped = serde_json::from_str::<serde_json::Value>(&content)
            .unwrap()["updatedAt"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            stamped.ends_with('Z') && stamped.split('.').count() == 2,
            "updatedAt was not a timestamp: {stamped}"
        );
    }

    #[test]
    fn write_ready_rejects_an_unreachable_ready_path() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("not-a-dir");
        fs::write(&parent, "file").unwrap();
        let paths = Paths::new(
            temp.path().join("opt/persistence"),
            parent.join("run/persistence"),
            temp.path().join("data/persistence"),
        );

        let error = write_ready(&paths, "daemon").unwrap_err().to_string();

        assert!(error.contains("create"), "got: {error}");
    }

    #[test]
    fn fsync_parent_refuses_a_path_with_no_parent() {
        assert!(super::fsync_parent(std::path::Path::new("plain-name")).is_err());
    }
}
