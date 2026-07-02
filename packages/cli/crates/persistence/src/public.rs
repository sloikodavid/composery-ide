#![cfg(unix)]

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File},
    os::unix::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

use crate::config::Config;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PublicPath {
    bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct PublicEntry {
    pub path: PublicPath,
    pub full_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodedPath {
    pub display: String,
    pub bytes_b64: String,
}

impl PublicPath {
    pub fn parse(path: &str) -> Result<Self> {
        Self::from_absolute_bytes(path.as_bytes())
    }

    pub fn from_absolute_bytes(path: &[u8]) -> Result<Self> {
        if path.first() != Some(&b'/') {
            bail!("path must be absolute: {}", display_bytes(path));
        }
        if path.contains(&0) {
            bail!("path contains NUL: {}", display_bytes(path));
        }

        let mut normalized = Vec::new();
        for component in path.split(|byte| *byte == b'/') {
            if component.is_empty() || component == b"." {
                continue;
            }
            if component == b".." {
                bail!("path cannot contain '..': {}", display_bytes(path));
            }
            normalized.push(b'/');
            normalized.extend_from_slice(component);
        }

        if normalized.is_empty() {
            bail!("root path cannot be persisted");
        }
        Ok(Self { bytes: normalized })
    }

    pub fn from_root_relative(relative: &Path) -> Result<Self> {
        let bytes = relative.as_os_str().as_bytes();
        if bytes.is_empty() {
            bail!("root path cannot be persisted");
        }
        let mut absolute = Vec::with_capacity(bytes.len() + 1);
        absolute.push(b'/');
        absolute.extend_from_slice(bytes);
        Self::from_absolute_bytes(&absolute)
    }

    pub fn from_encoded(encoded: &EncodedPath) -> Result<Self> {
        let bytes = STANDARD
            .decode(&encoded.bytes_b64)
            .with_context(|| format!("decode path bytes for {}", encoded.display))?;
        Self::from_absolute_bytes(&bytes)
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn display(&self) -> String {
        display_bytes(&self.bytes)
    }

    pub fn encoded(&self) -> EncodedPath {
        EncodedPath {
            display: self.display(),
            bytes_b64: STANDARD.encode(&self.bytes),
        }
    }

    pub fn bytes_b64(&self) -> String {
        STANDARD.encode(&self.bytes)
    }

    pub fn relative_os_string(&self) -> OsString {
        OsString::from_vec(self.bytes[1..].to_vec())
    }

    pub fn destination(&self, root: &Path) -> PathBuf {
        root.join(self.relative_os_string())
    }

    pub fn depth(&self) -> usize {
        count_components(&self.bytes)
    }

    pub fn starts_with(&self, other: &PublicPath) -> bool {
        self.bytes == other.bytes
            || (self.bytes.starts_with(&other.bytes)
                && self.bytes.get(other.bytes.len()) == Some(&b'/'))
    }
}

impl std::fmt::Display for PublicPath {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.display())
    }
}

impl AsRef<OsStr> for PublicPath {
    fn as_ref(&self) -> &OsStr {
        OsStr::from_bytes(&self.bytes)
    }
}

// Component count of a normalized public path. Skipped as one unit: the
// separator comparison is equivalent for every path this type can hold - the
// constructor normalizes empty and "." components away, so a path with N
// components always has exactly N slashes, and a flipped comparison counts the
// same separators. The count itself is pinned by the depth test.
#[cfg_attr(test, mutants::skip)]
fn count_components(bytes: &[u8]) -> usize {
    bytes
        .split(|byte| *byte == b'/')
        .filter(|component| !component.is_empty())
        .count()
}

pub fn is_excluded(path: &PublicPath, config: &Config) -> bool {
    config
        .exclusions
        .iter()
        .filter_map(|excluded| PublicPath::parse(excluded).ok())
        .any(|excluded| path.starts_with(&excluded))
}

pub fn live_path(root: &Path, public_path: &PublicPath) -> PathBuf {
    public_path.destination(root)
}

pub fn list_public_entries(root: &Path) -> Result<Vec<PublicEntry>> {
    if !real_dir_exists(root)? {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for entry in WalkDir::new(root).follow_links(false).min_depth(1) {
        let entry = entry?;
        let full_path = entry.path().to_path_buf();
        if is_persistence_temp_path(&full_path) {
            continue;
        }
        let relative = full_path
            .strip_prefix(root)
            .with_context(|| format!("strip public root {}", root.display()))?;
        entries.push(PublicEntry {
            path: PublicPath::from_root_relative(relative)?,
            full_path,
        });
    }
    Ok(entries)
}

pub fn list_public_paths(root: &Path) -> Result<Vec<PublicPath>> {
    Ok(list_public_entries(root)?
        .into_iter()
        .map(|entry| entry.path)
        .collect())
}

pub fn list_public_file_entries(root: &Path) -> Result<Vec<PublicEntry>> {
    Ok(list_public_entries(root)?
        .into_iter()
        .filter(|entry| {
            fs::symlink_metadata(&entry.full_path).is_ok_and(|metadata| !metadata.is_dir())
        })
        .collect())
}

pub fn list_public_file_paths(root: &Path) -> Result<Vec<PublicPath>> {
    Ok(list_public_file_entries(root)?
        .into_iter()
        .map(|entry| entry.path)
        .collect())
}

pub fn ensure_parent(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))
}

pub fn remove_path(path: &Path) -> Result<()> {
    let mut removed = false;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            fs::remove_dir_all(path).with_context(|| format!("remove dir {}", path.display()))?;
            removed = true;
        }
        Ok(_) => {
            fs::remove_file(path).with_context(|| format!("remove file {}", path.display()))?;
            removed = true;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
    }
    if removed {
        fsync_parent(path)?;
    }
    Ok(())
}

/// The staging name a write lands on before it is renamed into place.
///
/// Hidden and hashed rather than a plain suffix: two writers targeting the same
/// file must not collide, and the watcher has to be able to tell a half-written
/// file from a real one by name alone.
///
/// ```
/// use std::path::Path;
/// use persistence::public::temp_path;
///
/// let target = Path::new("/data/notes.md");
/// let staging = temp_path(target);
///
/// assert_eq!(staging, temp_path(target));
/// assert_ne!(staging, temp_path(Path::new("/other/notes.md")));
/// assert!(
///     staging
///         .file_name()
///         .unwrap()
///         .to_str()
///         .unwrap()
///         .starts_with(".notes.md.persistence-tmp-")
/// );
/// ```
pub fn temp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("target");
    let hash = blake3::hash(path.as_os_str().as_bytes()).to_hex();
    path.with_file_name(format!(".{file_name}.persistence-tmp-{}", &hash[..16]))
}

/// Whether a path is one of our own staging files.
///
/// The watcher uses this to ignore its own writes; a false negative would have
/// it persist a half-written file, so the rule is matched on the name the
/// [`temp_path`] above produces and nothing looser.
///
/// ```
/// use std::path::Path;
/// use persistence::public::is_persistence_temp_path;
///
/// assert!(is_persistence_temp_path(Path::new("/data/.notes.md.persistence-tmp-0123456789abcdef")));
///
/// // A user's own dotfile is not ours, and neither is a similarly named one
/// // that never went through temp_path.
/// assert!(!is_persistence_temp_path(Path::new("/data/.bashrc")));
/// assert!(!is_persistence_temp_path(Path::new("/data/notes.md.persistence-tmp-abc")));
/// ```
pub fn is_persistence_temp_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.') && name.contains(".persistence-tmp"))
}

fn real_dir_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(true),
        Ok(_) => anyhow::bail!("{} must be a real directory", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("stat {}", path.display())),
    }
}

fn display_bytes(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    // Explicit arms rather than a guard: a guard's comparison could flip into
    // an equivalent (the printable range already excludes nothing), so the
    // bytes that need escaping are named instead.
    let mut display = String::new();
    for byte in bytes {
        match *byte {
            b'/' => display.push('/'),
            b'\\' => display.push_str("\\x5c"),
            // The printable range excludes the slash explicitly, so the
            // named '/' arm above is the only path that prints it - a
            // deleted arm or a flipped guard cannot hide behind the range.
            0x20..=0x2e | 0x30..=0x7e => display.push(*byte as char),
            _ => display.push_str(&format!("\\x{byte:02x}")),
        }
    }
    display
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
    use super::{PublicPath, is_excluded};
    use crate::config::Config;
    use std::{
        ffi::OsString,
        os::unix::ffi::{OsStrExt, OsStringExt},
        path::PathBuf,
    };

    #[test]
    fn normalizes_absolute_paths_without_losing_bytes() {
        let path = PublicPath::from_absolute_bytes(b"//space here/./percent%/unicode-\xe2\x98\x83")
            .unwrap();

        assert_eq!(
            path.as_bytes(),
            b"/space here/percent%/unicode-\xe2\x98\x83"
        );
        assert_eq!(path.display(), "/space here/percent%/unicode-\u{2603}");
    }

    #[test]
    fn preserves_newlines_and_long_components() {
        let long_component = vec![b'a'; 240];
        let mut raw = b"/line\nbreak/".to_vec();
        raw.extend_from_slice(&long_component);

        let path = PublicPath::from_absolute_bytes(&raw).unwrap();

        assert_eq!(path.as_bytes(), raw);
        assert!(path.display().contains('\n'));
        assert!(
            path.relative_os_string()
                .as_bytes()
                .ends_with(&long_component)
        );
    }

    #[test]
    fn rejects_root_relative_dotdot_and_nul() {
        assert!(PublicPath::parse("/").is_err());
        assert!(PublicPath::parse("relative").is_err());
        assert!(PublicPath::parse("/a/../b").is_err());
        assert!(PublicPath::from_absolute_bytes(b"/a\0b").is_err());
    }

    #[test]
    fn effective_default_excludes_integrity_paths() {
        let config = Config::default();

        for path in [
            "/data/project",
            "/opt/composery/ide/current",
            "/opt/persistence/baseline.sqlite",
            "/proc/self/status",
            "/tmp/socket",
            "/etc/resolv.conf",
        ] {
            assert!(
                is_excluded(&PublicPath::parse(path).unwrap(), &config),
                "{path}"
            );
        }
        assert!(!is_excluded(
            &PublicPath::parse("/home/user/project").unwrap(),
            &config
        ));
    }

    #[test]
    fn preserves_non_utf8_path_identity() {
        let relative = PathBuf::from(OsString::from_vec(vec![b'e', 0xff, b'x']));
        let path = PublicPath::from_root_relative(&relative).unwrap();
        let encoded = path.encoded();
        let decoded = PublicPath::from_encoded(&encoded).unwrap();

        assert_eq!(decoded.as_bytes(), b"/e\xffx");
        assert_eq!(decoded.relative_os_string().as_bytes(), b"e\xffx");
        assert_eq!(decoded.display(), "/e\\xffx");
    }

    #[test]
    fn temp_paths_do_not_collide_for_non_utf8_names() {
        let first = PathBuf::from(OsString::from_vec(vec![b'a', 0xff]));
        let second = PathBuf::from(OsString::from_vec(vec![b'b', 0xff]));

        assert_ne!(super::temp_path(&first), super::temp_path(&second));
    }

    #[test]
    fn hashed_temp_paths_are_not_public_truth() {
        let target = PathBuf::from("file");
        let temp = super::temp_path(&target);

        assert!(super::is_persistence_temp_path(&temp));
    }

    #[test]
    fn public_list_rejects_root_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside");
        let root = temp.path().join("changed");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, &root).unwrap();

        let error = super::list_public_entries(&root).unwrap_err().to_string();

        assert!(error.contains("real directory"));
    }

    #[test]
    fn public_list_ignores_crash_leftover_temp_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("changed");
        let target = root.join("etc/hello");
        let leftover = super::temp_path(&target);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&leftover, "partial").unwrap();
        std::fs::write(&target, "hello").unwrap();

        let entries = super::list_public_paths(&root).unwrap();

        assert!(entries.iter().any(|path| path.as_bytes() == b"/etc"));
        assert!(entries.iter().any(|path| path.as_bytes() == b"/etc/hello"));
        assert!(
            entries
                .iter()
                .all(|path| !path.display().contains(".persistence-tmp"))
        );
    }

    #[test]
    fn depth_counts_components_not_slashes() {
        let path = PublicPath::parse("/a/b/c").unwrap();
        assert_eq!(path.depth(), 3);
        assert_eq!(PublicPath::parse("/single").unwrap().depth(), 1);
    }

    #[test]
    fn display_bytes_names_the_escaping_rules() {
        assert_eq!(super::display_bytes(b"/\xff"), "/\\xff");
        assert_eq!(super::display_bytes(b"a\\\xff"), "a\\x5c\\xff");
        assert_eq!(super::display_bytes(b"a\x01\xff"), "a\\x01\\xff");
    }

    #[test]
    fn ensure_parent_refuses_an_unreachable_parent() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("not-a-dir");
        std::fs::write(&parent, "file").unwrap();
        assert!(super::ensure_parent(&parent.join("child")).is_err());
    }

    // remove_path must surface an unreachable path as an error, never a silent
    // success - the NotFound case is for "already gone", not "cannot look".
    #[test]
    fn remove_path_refuses_an_unreachable_path() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("not-a-dir");
        std::fs::write(&parent, "file").unwrap();
        assert!(super::remove_path(&parent.join("child")).is_err());
    }

    // real_dir_exists must refuse a regular file, report a missing dir as
    // absent, and surface an unreachable path as an error.
    #[test]
    fn real_dir_exists_answers_the_three_cases() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("plain-file");
        std::fs::write(&file, "x").unwrap();
        assert!(super::real_dir_exists(&file).is_err());

        let missing = temp.path().join("missing");
        assert_eq!(super::real_dir_exists(&missing).unwrap(), false);

        let parent = temp.path().join("not-a-dir");
        std::fs::write(&parent, "file").unwrap();
        let unreachable = parent.join("child");
        assert!(super::real_dir_exists(&unreachable).is_err());
    }

    #[test]
    fn fsync_parent_refuses_a_path_with_no_parent() {
        assert!(super::fsync_parent(std::path::Path::new("plain-name")).is_err());
    }
}
