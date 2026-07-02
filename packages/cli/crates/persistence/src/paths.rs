use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub opt_dir: PathBuf,
    pub baseline_db: PathBuf,
    pub run_dir: PathBuf,
    pub ready_file: PathBuf,
    pub data_dir: PathBuf,
    pub config_file: PathBuf,
    pub changed_dir: PathBuf,
    pub removed_dir: PathBuf,
    pub metadata_file: PathBuf,
    pub internal_dir: PathBuf,
    pub state_db: PathBuf,
    pub lock_file: PathBuf,
    pub control_socket: PathBuf,
    pub apply_error_log: PathBuf,
    pub watch_error_log: PathBuf,
}

impl Default for Paths {
    fn default() -> Self {
        Self::new(
            "/opt/persistence",
            "/run/persistence",
            volume_root().join("persistence"),
        )
    }
}

// Volume root is `/data` by deployment contract; COMPOSERY_DOCKER_VOLUME_PATH overrides.
pub fn volume_root() -> PathBuf {
    match std::env::var("COMPOSERY_DOCKER_VOLUME_PATH") {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => PathBuf::from("/data"),
    }
}

impl Paths {
    pub fn new(
        opt_dir: impl Into<PathBuf>,
        run_dir: impl Into<PathBuf>,
        data_dir: impl Into<PathBuf>,
    ) -> Self {
        let opt_dir = opt_dir.into();
        let run_dir = run_dir.into();
        let data_dir = data_dir.into();
        let internal_dir = data_dir.join(".internal");

        Self {
            baseline_db: opt_dir.join("baseline.sqlite"),
            ready_file: run_dir.join("ready"),
            config_file: data_dir.join("config.json"),
            changed_dir: data_dir.join("changed"),
            removed_dir: data_dir.join("removed"),
            metadata_file: data_dir.join("metadata.jsonl"),
            state_db: internal_dir.join("state.sqlite"),
            lock_file: internal_dir.join("lock"),
            control_socket: internal_dir.join("control.sock"),
            apply_error_log: internal_dir.join("apply-error.log"),
            watch_error_log: internal_dir.join("watch-error.log"),
            opt_dir,
            run_dir,
            data_dir,
            internal_dir,
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::Paths;
    use std::sync::Mutex;

    // Tests that set COMPOSERY_DOCKER_VOLUME_PATH serialize on this lock; the
    // volume-root tests here and the certificates tests in the composery crate
    // are the only readers of the variable.
    pub(crate) static VOLUME_ENV: Mutex<()> = Mutex::new(());

    #[test]
    fn default_paths_match_the_public_contract() {
        let paths = Paths::default();

        assert_eq!(
            paths.baseline_db.to_string_lossy(),
            "/opt/persistence/baseline.sqlite"
        );
        assert_eq!(paths.ready_file.to_string_lossy(), "/run/persistence/ready");
        assert_eq!(
            paths.config_file.to_string_lossy(),
            "/data/persistence/config.json"
        );
        assert_eq!(
            paths.changed_dir.to_string_lossy(),
            "/data/persistence/changed"
        );
        assert_eq!(
            paths.removed_dir.to_string_lossy(),
            "/data/persistence/removed"
        );
        assert_eq!(
            paths.metadata_file.to_string_lossy(),
            "/data/persistence/metadata.jsonl"
        );
        assert_eq!(
            paths.state_db.to_string_lossy(),
            "/data/persistence/.internal/state.sqlite"
        );
        assert_eq!(
            paths.lock_file.to_string_lossy(),
            "/data/persistence/.internal/lock"
        );
        assert_eq!(
            paths.control_socket.to_string_lossy(),
            "/data/persistence/.internal/control.sock"
        );
    }

    #[test]
    fn volume_root_honours_a_real_override() {
        let _guard = VOLUME_ENV.lock().unwrap();
        unsafe { std::env::set_var("COMPOSERY_DOCKER_VOLUME_PATH", "/custom/volume") };
        assert_eq!(super::volume_root(), std::path::PathBuf::from("/custom/volume"));
    }

    // Whitespace is not a volume path: a blank override must fall back to the
    // contract default, never to a path that cannot exist.
    #[test]
    fn volume_root_refuses_a_blank_override() {
        let _guard = VOLUME_ENV.lock().unwrap();
        unsafe { std::env::set_var("COMPOSERY_DOCKER_VOLUME_PATH", "   ") };
        assert_eq!(super::volume_root(), std::path::PathBuf::from("/data"));
    }
}
