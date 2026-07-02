use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
};

/// The runtime config. The image owns policy (the integrity and default
/// exclusion sets, in code); the file owns only user intent (`exclude` /
/// `persist`) - the same delta model the product itself uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// User intent: paths to exclude from the persisted delta, on top of the
    /// image's default set.
    pub exclude: Vec<String>,
    /// User intent: paths the image excludes by default that this instance wants
    /// persisted anyway. Never overrides an integrity exclusion.
    pub persist: Vec<String>,
    pub audit: AuditConfig,
    /// Hard cap on live inotify directory watches; see `crate::watch` for why
    /// the watcher's cost must be bounded by construction. Zero is a valid
    /// choice (audit-only); any tree past the cap is covered by the audit.
    pub max_watches: u64,
    /// Effective exclusion set the engine enforces:
    /// integrity ∪ (defaults − persist) ∪ exclude, with integrity always
    /// winning. Derived from the fields above plus the code-owned integrity and
    /// default sets; never written to the file. `crate::public::is_excluded`
    /// reads this and nothing else.
    pub exclusions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditConfig {
    pub max_work_ms_per_tick: u64,
    /// Pause between rolling audit passes. The inotify watcher catches changes
    /// live; the audit only recovers missed events, so a full-rootfs walk does
    /// not need to run back to back. Serde default keeps pre-existing
    /// config.json files on deployed volumes parsing.
    #[serde(default = "default_interval_secs")]
    pub interval_secs: u64,
    /// Frequent audit passes trust size+mtime; a deep pass re-hashes every file
    /// to catch mtime-preserving edits. Serde default keeps pre-existing
    /// config.json files on deployed volumes parsing.
    #[serde(default = "default_deep_hash_interval_secs")]
    pub deep_hash_interval_secs: u64,
}

/// The configurable values read from `config.json`. The generated file also
/// carries a documentation link, which serde deliberately ignores so owners
/// can remove it without changing behavior.
///
/// `exclusions` is the name the single-array layout used before user intent was
/// split from image policy. It is an alias rather than a migration: such a file
/// keeps working, its entries keep excluding what they always did, and nothing
/// has to be rewritten on the volume to make that true. Dropping the name
/// instead would let serde ignore it and silently stop honouring paths the
/// owner chose.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileConfig {
    #[serde(default, alias = "exclusions")]
    exclude: Vec<String>,
    #[serde(default)]
    persist: Vec<String>,
    audit: AuditConfig,
    #[serde(default = "default_max_watches")]
    max_watches: u64,
}

/// What is written to `config.json`: one removable documentation pointer plus
/// user intent. The integrity and default exclusion sets live in code, never on
/// the volume, so a new image can change them without a stale copy on a volume
/// overriding it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredConfig<'a> {
    documentation: &'static str,
    exclude: &'a [String],
    persist: &'a [String],
    audit: &'a AuditConfig,
    max_watches: u64,
}

const DOCUMENTATION_URL: &str = "https://www.composery.io/docs/persistence";

fn default_interval_secs() -> u64 {
    60
}

fn default_deep_hash_interval_secs() -> u64 {
    3600
}

/// Default ceiling on live inotify directory watches.
///
/// Observation cost must not scale with the workload's shape. Each watch costs
/// ~1 KiB of kernel memory plus one userspace map entry, so 8192 watches bound
/// the daemon to roughly ~8 MiB of kernel watch memory and a similarly small
/// userspace table - flat, regardless of how many directories a
/// Docker-in-Docker or node_modules workload creates. `fs.inotify.max_user_watches`
/// is a host-wide sysctl shared by every container under one kernel, so the
/// daemon deliberately claims only a small constant slice and never grows into
/// it; unwatched trees are recovered by the rolling audit. Owners who want more
/// (or zero) live latency can set `maxWatches` in config.json.
pub const MAX_WATCHES_DEFAULT: u64 = 8192;

fn default_max_watches() -> u64 {
    MAX_WATCHES_DEFAULT
}

/// Paths the persistence delta must never touch, enforced in code regardless of
/// the config file: runtime state, the durable volume, and Composery's own
/// update-owned implementation. Folded into every effective set and impossible
/// to remove via `persist` or `exclude`.
fn integrity_exclusions() -> Vec<String> {
    vec![
        crate::paths::volume_root().to_string_lossy().into_owned(),
        "/run".into(),
        "/proc".into(),
        "/sys".into(),
        "/dev".into(),
        "/tmp".into(),
        "/var/run".into(),
        "/opt/persistence".into(),
        "/opt/composery".into(),
        "/etc/hostname".into(),
        "/etc/hosts".into(),
        "/etc/resolv.conf".into(),
    ]
}

/// Excluded by default because they hold regenerable caches (downloaded apt
/// archives and the like), but shipped with the image rather than written into
/// the file - so a future image can change the set, and an instance can override any
/// entry per-path via `persist`.
fn default_exclusions() -> Vec<String> {
    vec!["/var/cache".into()]
}

/// integrity ∪ (defaults − persist) ∪ exclude. Integrity is added first and
/// unconditionally, so nothing in `persist` or `exclude` can ever remove it -
/// that is what makes "integrity always wins" impossible to get wrong.
fn effective_exclusions(exclude: &[String], persist: &[String]) -> Vec<String> {
    let mut result = integrity_exclusions();
    for path in default_exclusions() {
        if !persist.iter().any(|kept| kept == &path) && !result.contains(&path) {
            result.push(path);
        }
    }
    for path in exclude {
        if !result.contains(path) {
            result.push(path.clone());
        }
    }
    result
}

impl AuditConfig {
    fn image_default() -> Self {
        Self {
            max_work_ms_per_tick: 10,
            interval_secs: default_interval_secs(),
            deep_hash_interval_secs: default_deep_hash_interval_secs(),
        }
    }
}

impl Config {
    fn from_intent(
        exclude: Vec<String>,
        persist: Vec<String>,
        audit: AuditConfig,
        max_watches: u64,
    ) -> Self {
        let exclusions = effective_exclusions(&exclude, &persist);
        Self {
            exclude,
            persist,
            audit,
            max_watches,
            exclusions,
        }
    }

    pub fn validate(&self) -> Result<()> {
        for path in self.exclude.iter().chain(self.persist.iter()) {
            validate_config_path(path).with_context(|| format!("invalid config path {path:?}"))?;
        }
        Ok(())
    }
}

impl Default for Config {
    fn default() -> Self {
        Self::from_intent(
            Vec::new(),
            Vec::new(),
            AuditConfig::image_default(),
            default_max_watches(),
        )
    }
}

pub fn load_or_create(path: &Path) -> Result<Config> {
    let parent = path
        .parent()
        .with_context(|| format!("config path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("create config dir {}", parent.display()))?;
    ensure_real_dir(parent)?;

    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            let loaded = fs::read(path)
                .with_context(|| format!("read config {}", path.display()))
                .and_then(|data| {
                    serde_json::from_slice::<FileConfig>(&data)
                        .with_context(|| format!("parse config {}", path.display()))
                })
                .map(|file| {
                    Config::from_intent(file.exclude, file.persist, file.audit, file.max_watches)
                })
                .and_then(|config| {
                    config
                        .validate()
                        .with_context(|| format!("validate config {}", path.display()))?;
                    Ok(config)
                });
            match loaded {
                Ok(config) => Ok(config),
                Err(error) => recover_invalid(path, &error),
            }
        }
        Ok(_) => recover_invalid(
            path,
            &anyhow::anyhow!("{} must be a real file", path.display()),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => create_default(path),
        Err(error) => Err(error).with_context(|| format!("stat config {}", path.display())),
    }
}

fn create_default(path: &Path) -> Result<Config> {
    let config = Config::default();
    config.validate().context("validate default config")?;
    write(path, &config)?;
    Ok(config)
}

fn recover_invalid(path: &Path, error: &anyhow::Error) -> Result<Config> {
    let backup = unused_invalid_path(path)?;
    fs::rename(path, &backup).with_context(|| {
        format!(
            "preserve invalid config {} as {}",
            path.display(),
            backup.display()
        )
    })?;
    rootfs_fsync_parent(path)?;
    tracing::warn!(
        error = %error,
        backup = %backup.display(),
        "replaced invalid persistence config with safe defaults"
    );
    create_default(path)
}

// The reservation loop's only natural failure is AlreadyExists (the parent was
// just proven writable and real), so the final error arm of its match is
// unreachable by construction; the collision walk itself is proven by the
// tests below. Skipped as one unit so the unreachable arm does not shadow the
// walk.
#[cfg_attr(test, mutants::skip)]
fn next_free_invalid_path(path: &Path, source_is_dir: bool) -> Result<std::path::PathBuf> {
    for sequence in 1..=10_000 {
        let candidate = path.with_extension(format!("invalid-{sequence}.json"));
        let reserved = if source_is_dir {
            fs::create_dir(&candidate)
        } else {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
                .map(drop)
        };
        match reserved {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("reserve {}", candidate.display()));
            }
        }
    }
    bail!(
        "too many preserved invalid configs next to {}",
        path.display()
    )
}

fn unused_invalid_path(path: &Path) -> Result<std::path::PathBuf> {
    let source_is_dir = fs::symlink_metadata(path)
        .with_context(|| format!("stat invalid config {}", path.display()))?
        .file_type()
        .is_dir();
    next_free_invalid_path(path, source_is_dir)
}

fn write(path: &Path, config: &Config) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("config path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("create config dir {}", parent.display()))?;
    ensure_real_dir(parent)?;

    let stored = StoredConfig {
        documentation: DOCUMENTATION_URL,
        exclude: &config.exclude,
        persist: &config.persist,
        audit: &config.audit,
        max_watches: config.max_watches,
    };
    let mut data = serde_json::to_vec_pretty(&stored).context("encode config")?;
    data.push(b'\n');
    let temp = path.with_extension("json.tmp");
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
    fs::rename(&temp, path)
        .with_context(|| format!("publish config {} to {}", temp.display(), path.display()))?;
    let dir = File::open(parent).with_context(|| format!("open {}", parent.display()))?;
    dir.sync_all()
        .with_context(|| format!("fsync {}", parent.display()))
}

fn rootfs_fsync_parent(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("config path has no parent: {}", path.display()))?;
    let dir = File::open(parent).with_context(|| format!("open {}", parent.display()))?;
    dir.sync_all()
        .with_context(|| format!("fsync {}", parent.display()))
}

fn ensure_real_dir(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => anyhow::bail!("{} must be a real directory", path.display()),
        Err(error) => Err(error).with_context(|| format!("stat {}", path.display())),
    }
}

fn validate_config_path(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    if bytes.first() != Some(&b'/') {
        bail!("path must be absolute");
    }
    if bytes.contains(&0) {
        bail!("path contains NUL");
    }

    let mut has_component = false;
    for component in bytes.split(|byte| *byte == b'/') {
        if component.is_empty() || component == b"." {
            continue;
        }
        if component == b".." {
            bail!("path cannot contain '..'");
        }
        has_component = true;
    }

    if !has_component {
        bail!("root path cannot be listed");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{AuditConfig, Config, default_max_watches, load_or_create};
    use serde_json::{Value, json};
    use std::fs;

    fn read_json(path: &std::path::Path) -> Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn load_or_create_writes_documentation_and_user_intent_not_the_default_set() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("persistence/config.json");

        let config = load_or_create(&path).unwrap();

        assert_eq!(config, Config::default());
        assert!(path.exists());
        let stored = read_json(&path);
        assert_eq!(
            stored["documentation"],
            json!("https://www.composery.io/docs/persistence")
        );
        assert_eq!(stored["exclude"], json!([]));
        assert_eq!(stored["persist"], json!([]));
        // The `/var/cache` default is shipped with the image now, never frozen
        // onto the volume - so it must not appear in the file...
        assert!(stored.get("exclusions").is_none());
        assert!(!fs::read_to_string(&path).unwrap().contains("/var/cache"));
        // ...but it still governs the effective set, alongside the integrity set.
        assert!(config.exclusions.iter().any(|e| e == "/var/cache"));
        assert!(config.exclusions.iter().any(|e| e == "/data"));

        let reparsed = load_or_create(&path).unwrap();
        assert_eq!(reparsed, Config::default());
    }

    #[test]
    fn effective_set_is_integrity_union_defaults_minus_persist_union_exclude() {
        let with_add = Config::from_intent(
            vec!["/srv/cache".into()],
            Vec::new(),
            AuditConfig::image_default(),
            default_max_watches(),
        );
        assert!(with_add.exclusions.iter().any(|e| e == "/var/cache")); // default kept
        assert!(with_add.exclusions.iter().any(|e| e == "/srv/cache")); // user add
        assert!(with_add.exclusions.iter().any(|e| e == "/opt/composery")); // integrity

        let persisting_default = Config::from_intent(
            Vec::new(),
            vec!["/var/cache".into()],
            AuditConfig::image_default(),
            default_max_watches(),
        );
        // persist removes a default from the effective set.
        assert!(
            !persisting_default
                .exclusions
                .iter()
                .any(|e| e == "/var/cache")
        );
    }

    #[test]
    fn persist_cannot_override_an_integrity_exclusion() {
        // An instance that tries to force-persist Composery's own implementation still
        // cannot: integrity always wins over `persist`.
        let config = Config::from_intent(
            Vec::new(),
            vec!["/opt/composery".into()],
            AuditConfig::image_default(),
            default_max_watches(),
        );
        assert!(config.exclusions.iter().any(|e| e == "/opt/composery"));
    }

    #[test]
    fn a_config_written_before_the_split_keeps_excluding_what_it_named() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("persistence/config.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // The single-array layout an earlier build wrote. Serde ignores unknown
        // fields, so without the alias this file would parse happily and quietly
        // stop honouring the path its owner chose - the worst outcome here.
        fs::write(
            &path,
            r#"{"exclusions":["/srv/data"],"audit":{"maxWorkMsPerTick":10}}"#,
        )
        .unwrap();

        let config = load_or_create(&path).unwrap();

        assert_eq!(config.exclude, vec!["/srv/data".to_string()]);
        assert!(config.exclusions.iter().any(|e| e == "/srv/data"));
        // The image's own default set still applies alongside it.
        assert!(config.exclusions.iter().any(|e| e == "/var/cache"));
    }

    #[test]
    fn config_without_deep_hash_interval_parses_with_default() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("persistence/config.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"exclude":["/data"],"audit":{"maxWorkMsPerTick":10}}"#,
        )
        .unwrap();

        let config = load_or_create(&path).unwrap();

        assert_eq!(config.audit.deep_hash_interval_secs, 3600);
    }

    #[test]
    fn config_without_max_watches_parses_with_default() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("persistence/config.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // A config.json written before the watch budget existed: no maxWatches.
        fs::write(
            &path,
            r#"{"exclude":["/data"],"audit":{"maxWorkMsPerTick":10,"intervalSecs":60,"deepHashIntervalSecs":3600}}"#,
        )
        .unwrap();

        let config = load_or_create(&path).unwrap();

        assert_eq!(config.max_watches, super::MAX_WATCHES_DEFAULT);
        // It must parse in place, not be quarantined and rebuilt: without a
        // serde default the missing field would error into recovery, which
        // would also yield the default value and hide the regression.
        assert!(!path.with_extension("invalid-1.json").exists());
        assert!(fs::read_to_string(&path).unwrap().contains("\"/data\""));
    }

    #[test]
    fn integrity_exclusions_cannot_be_removed_from_the_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("persistence/config.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Even asking to persist integrity paths does not remove them.
        fs::write(
            &path,
            r#"{"persist":["/opt/composery","/data"],"audit":{"maxWorkMsPerTick":10}}"#,
        )
        .unwrap();

        let config = load_or_create(&path).unwrap();

        for required in ["/data", "/proc", "/opt/persistence", "/opt/composery"] {
            assert!(config.exclusions.iter().any(|value| value == required));
        }
        // The file keeps recording only the (ineffective) user intent; the
        // integrity set is never written into it.
        let stored = read_json(&path);
        assert_eq!(stored["persist"], json!(["/opt/composery", "/data"]));
        assert!(stored.get("exclusions").is_none());
    }

    #[test]
    fn load_or_create_preserves_and_recovers_invalid_exclude() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("persistence/config.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"exclude":["relative"],"audit":{"maxWorkMsPerTick":10}}"#,
        )
        .unwrap();

        let recovered = load_or_create(&path).unwrap();

        assert_eq!(recovered, Config::default());
        assert!(path.with_extension("invalid-1.json").is_file());
        let stored = read_json(&path);
        assert_eq!(stored["exclude"], json!([]));
    }

    #[test]
    fn load_or_create_preserves_and_recovers_config_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("persistence/config.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let outside = temp.path().join("outside-config.json");
        fs::write(&outside, "{}").unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();

        let recovered = load_or_create(&path).unwrap();

        assert_eq!(recovered, Config::default());
        assert_eq!(
            fs::read_link(path.with_extension("invalid-1.json")).unwrap(),
            outside
        );
        assert!(path.is_file());
    }

    #[test]
    fn load_or_create_preserves_and_recovers_malformed_json() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("persistence/config.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{not json").unwrap();

        let recovered = load_or_create(&path).unwrap();

        assert_eq!(recovered, Config::default());
        assert_eq!(
            fs::read_to_string(path.with_extension("invalid-1.json")).unwrap(),
            "{not json"
        );
    }

    #[test]
    fn load_or_create_rejects_symlink_parent() {
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside");
        let parent = temp.path().join("persistence");
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, &parent).unwrap();

        let error = load_or_create(&parent.join("config.json"))
            .unwrap_err()
            .to_string();

        assert!(error.contains("real directory"));
        assert!(!outside.join("config.json").exists());
    }

    #[test]
    fn the_default_audit_interval_is_sixty_seconds() {
        assert_eq!(Config::default().audit.interval_secs, 60);
        assert_eq!(AuditConfig::image_default().interval_secs, 60);
    }

    // A symlink to a *valid* config is still refused: reading through the link
    // would let an outside file steer the persistence engine's policy. The
    // recovery must quarantine the link, defaults or not.
    #[test]
    fn a_symlink_to_a_valid_config_is_still_quarantined() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("persistence/config.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let outside = temp.path().join("outside-config.json");
        fs::write(
            &outside,
            r#"{"exclude":["/data"],"audit":{"maxWorkMsPerTick":10}}"#,
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();

        let recovered = load_or_create(&path).unwrap();

        assert_eq!(recovered, Config::default());
        assert!(path.with_extension("invalid-1.json").is_symlink());
        // The outside file was never read for policy.
        assert_eq!(recovered.exclude, Vec::<String>::new());
    }

    // A config path that cannot be stat'd (trailing slash over a regular file)
    // is a stat error, never a silent rebuild - the recovery path is for
    // invalid *content*, not for paths the code cannot resolve.
    #[test]
    fn an_unstatable_config_path_is_a_stat_error() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("persistence/config.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{}").unwrap();

        let slashed = std::path::PathBuf::from(format!("{}/", path.display()));
        let error = load_or_create(&slashed).unwrap_err().to_string();

        assert!(error.starts_with("stat"), "{error}");
    }

    // Collisions with previous quarantines must be walked, not failed: the
    // first preserved config is the one from the last incident.
    #[test]
    fn recovery_skips_to_the_next_free_quarantine_name() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("persistence/config.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{not json").unwrap();
        fs::write(path.with_extension("invalid-1.json"), "taken").unwrap();

        let recovered = load_or_create(&path).unwrap();

        assert_eq!(recovered, Config::default());
        assert!(path.with_extension("invalid-2.json").is_file());
        assert_eq!(
            fs::read_to_string(path.with_extension("invalid-1.json")).unwrap(),
            "taken"
        );
    }

    #[test]
    fn config_path_validation_is_direct() {
        assert!(super::validate_config_path("/a/b").is_ok());
        assert!(super::validate_config_path("/a/./b").is_ok());
        assert!(super::validate_config_path("relative").is_err());
        assert!(super::validate_config_path("/a/../b").is_err());
        assert!(super::validate_config_path("/").is_err());
        assert!(super::validate_config_path("//").is_err());
    }

    #[test]
    fn rootfs_fsync_parent_refuses_a_path_with_no_parent() {
        assert!(super::rootfs_fsync_parent(std::path::Path::new("plain-name")).is_err());
    }
}
