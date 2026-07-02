#![cfg(unix)]

use anyhow::{Context, Result, bail};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::{CString, OsStr, OsString},
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{FileTypeExt, MetadataExt, PermissionsExt, symlink},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

use crate::public;

/// The one walker both the watch registration and the rolling audit use to
/// traverse the live rootfs. `same_file_system(true)` stops at every mount
/// boundary: a bind-mounted `/data` volume, a container runtime's overlay
/// tree under `/var/lib/docker`, procfs, an sshfs a user mounted - each is
/// runtime-managed by whatever mounted it, not part of the image we persist,
/// so observing it is neither our job nor bounded by our budgets. Sharing one
/// constructor keeps the two traversals from drifting apart. Config exclusions
/// still apply on top of this, unchanged.
pub fn rootfs_walker(start: &Path) -> WalkDir {
    WalkDir::new(start)
        .follow_links(false)
        .same_file_system(true)
}

/// Whether `WalkDir::same_file_system(true)` will descend into an entry.
///
/// Callers that prune an excluded directory with `skip_current_dir()` must
/// only do so when WalkDir actually pushed that directory. A mount point is
/// yielded but not pushed; skipping it again would pop its parent and silently
/// abandon every later sibling in the walk.
pub fn walker_will_descend(walker_device: u64, entry_device: u64) -> bool {
    walker_device == entry_device
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    File,
    Dir,
    Symlink,
    Fifo,
    Socket,
    CharDevice,
    BlockDevice,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XattrRecord {
    pub name: String,
    pub name_bytes_b64: String,
    pub value_b64: String,
}

#[derive(Debug, Clone)]
pub struct FsFacts {
    pub kind: FileKind,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub size: Option<u64>,
    pub mtime_ns: i64,
    pub symlink_target: Option<Vec<u8>>,
    pub rdev_major: Option<u64>,
    pub rdev_minor: Option<u64>,
    pub dev: u64,
    pub ino: u64,
    pub nlink: u64,
    pub xattrs: Vec<XattrRecord>,
}

impl FileKind {
    pub fn from_type(file_type: &std::fs::FileType) -> Self {
        if file_type.is_file() {
            Self::File
        } else if file_type.is_dir() {
            Self::Dir
        } else if file_type.is_symlink() {
            Self::Symlink
        } else if file_type.is_fifo() {
            Self::Fifo
        } else if file_type.is_socket() {
            Self::Socket
        } else if file_type.is_char_device() {
            Self::CharDevice
        } else if file_type.is_block_device() {
            Self::BlockDevice
        } else {
            Self::Unknown
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Dir => "dir",
            Self::Symlink => "symlink",
            Self::Fifo => "fifo",
            Self::Socket => "socket",
            Self::CharDevice => "char_device",
            Self::BlockDevice => "block_device",
            Self::Unknown => "unknown",
        }
    }

    pub fn from_kind_name(kind: &str) -> Self {
        match kind {
            "file" => Self::File,
            "dir" => Self::Dir,
            "symlink" => Self::Symlink,
            "fifo" => Self::Fifo,
            "socket" => Self::Socket,
            "char_device" => Self::CharDevice,
            "block_device" => Self::BlockDevice,
            _ => Self::Unknown,
        }
    }
}

pub fn facts(path: &Path) -> Result<FsFacts> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("stat {}", path.display()))?;
    let file_type = metadata.file_type();
    let kind = FileKind::from_type(&file_type);
    let symlink_target = if matches!(kind, FileKind::Symlink) {
        Some(fs::read_link(path)?.as_os_str().as_bytes().to_vec())
    } else {
        None
    };
    let (rdev_major, rdev_minor) = device_numbers(&metadata, &kind);

    Ok(FsFacts {
        kind,
        mode: metadata.mode(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        size: if file_type.is_file() {
            Some(metadata.len())
        } else {
            None
        },
        mtime_ns: metadata.mtime() * 1_000_000_000 + metadata.mtime_nsec(),
        symlink_target,
        rdev_major,
        rdev_minor,
        dev: metadata.dev(),
        ino: metadata.ino(),
        nlink: metadata.nlink(),
        xattrs: read_xattrs(path)?,
    })
}

pub fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut hasher = blake3::Hasher::new();
    hasher
        .update_reader(&mut file)
        .with_context(|| format!("hash {}", path.display()))?;
    Ok(hasher.finalize().to_hex().to_string())
}

pub fn copy_entry_atomic(source: &Path, destination: &Path) -> Result<()> {
    copy_entry_atomic_inner(source, destination, true, true)
}

pub fn copy_entry_atomic_without_xattrs(source: &Path, destination: &Path) -> Result<()> {
    copy_entry_atomic_inner(source, destination, false, true)
}

/// Boot-time restore onto the ephemeral container rootfs. The writer lock is
/// held and the daemon is down, so the source delta store is quiescent, and a
/// crash before ready simply re-runs apply - skip the stable-copy verification
/// passes and every fsync that the persist direction needs for durability.
pub fn restore_entry(source: &Path, destination: &Path) -> Result<()> {
    copy_entry_atomic_inner(source, destination, true, false)
}

pub fn is_xattr_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        let text = cause.to_string();
        text.contains("xattr") || text.contains("extended attribute")
    })
}

pub fn is_copy_unstable_error(error: &anyhow::Error) -> bool {
    error.downcast_ref::<CopyUnstableError>().is_some()
}

#[derive(Debug)]
struct CopyUnstableError {
    path: PathBuf,
}

impl fmt::Display for CopyUnstableError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "source changed while copying {}",
            self.path.display()
        )
    }
}

impl std::error::Error for CopyUnstableError {}

fn copy_unstable_error(source: &Path) -> anyhow::Error {
    anyhow::Error::new(CopyUnstableError {
        path: source.to_path_buf(),
    })
}

fn copy_entry_atomic_inner(
    source: &Path,
    destination: &Path,
    apply_xattrs: bool,
    durable: bool,
) -> Result<()> {
    let mut source_facts = facts(source)?;
    public::ensure_parent(destination)?;

    match source_facts.kind {
        FileKind::File => {
            source_facts = if durable {
                copy_regular_stable(source, destination)?
            } else {
                copy_regular_restore(source, destination)?
            };
        }
        FileKind::Dir => ensure_directory_destination(destination)?,
        FileKind::Symlink => {
            let target = source_facts
                .symlink_target
                .as_ref()
                .context("symlink missing target")?;
            symlink_atomic(OsStr::from_bytes(target), destination, durable)?;
        }
        FileKind::Fifo => make_fifo_atomic(destination, source_facts.mode, durable)?,
        FileKind::CharDevice | FileKind::BlockDevice => {
            make_device_atomic(destination, &source_facts, durable)?;
        }
        FileKind::Socket => bail!("refusing to persist live socket {}", source.display()),
        FileKind::Unknown => bail!("unsupported file type at {}", source.display()),
    }

    if apply_xattrs {
        apply_facts(destination, &source_facts)?;
    } else {
        let mut facts_without_xattrs = source_facts.clone();
        facts_without_xattrs.xattrs.clear();
        apply_facts(destination, &facts_without_xattrs)?;
    }
    // publish_temp already fsynced the parent for published kinds; directories
    // are the only kind that still needs it.
    maybe_fsync_dir(destination, source_facts.kind, durable)?;
    Ok(())
}

// The directory-only parent fsync: its timing is unobservable in a test (the
// parent is writable by construction, so the call either succeeds or fails
// identically either way), and the durability contract itself is covered by
// the copy tests.
#[cfg_attr(test, mutants::skip)]
fn maybe_fsync_dir(destination: &Path, kind: FileKind, durable: bool) -> Result<()> {
    if durable && matches!(kind, FileKind::Dir) {
        fsync_parent(destination)?;
    }
    Ok(())
}

pub fn copy_metadata(source: &Path, destination: &Path) -> Result<()> {
    let source_facts = facts(source)?;
    apply_facts(destination, &source_facts)
}

pub fn apply_facts(path: &Path, source: &FsFacts) -> Result<()> {
    lchown(path, source.uid, source.gid)?;

    let target_metadata =
        fs::symlink_metadata(path).with_context(|| format!("stat {}", path.display()))?;
    let is_symlink = target_metadata.file_type().is_symlink();
    if !is_symlink {
        fs::set_permissions(path, fs::Permissions::from_mode(source.mode))
            .with_context(|| format!("chmod {}", path.display()))?;
    }

    set_times_no_follow(path, source.mtime_ns)
        .with_context(|| format!("set times {}", path.display()))?;

    apply_xattrs(path, &source.xattrs)?;
    Ok(())
}

pub fn apply_xattrs(path: &Path, xattrs: &[XattrRecord]) -> Result<()> {
    let desired = xattrs
        .iter()
        .map(|record| Ok((decode_b64(&record.name_bytes_b64)?, record)))
        .collect::<Result<BTreeMap<Vec<u8>, &XattrRecord>>>()?;

    if let Ok(existing) = xattr::list(path) {
        for name in existing {
            let name_bytes = name.as_bytes().to_vec();
            if !desired.contains_key(&name_bytes) {
                let _ = xattr::remove(path, &name);
            }
        }
    }

    for (name_bytes, record) in desired {
        let value = decode_b64(&record.value_b64)?;
        xattr::set(path, OsStr::from_bytes(&name_bytes), &value)
            .with_context(|| format!("set xattr {} on {}", record.name, path.display()))?;
    }
    Ok(())
}

pub fn ensure_safe_parent(root: &Path, target: &Path) -> Result<()> {
    let parent = target
        .parent()
        .with_context(|| format!("target has no parent: {}", target.display()))?;
    let relative = parent
        .strip_prefix(root)
        .with_context(|| format!("target escaped root: {}", target.display()))?;

    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        ensure_safe_component(&current)?;
    }
    Ok(())
}

// One ancestor component of an apply target. The final Err arm is unreachable
// by construction: every shape that would produce a different error (a
// symlink, a non-directory, a loop) is caught by the arms above it, and the
// NotFound arm is the only error a real directory chain can yield. The
// reachable hazards are covered by the ensure_safe_parent tests.
#[cfg_attr(test, mutants::skip)]
fn ensure_safe_component(current: &Path) -> Result<()> {
    match fs::symlink_metadata(current) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!(
                "refusing to apply through symlink ancestor {}",
                current.display()
            );
        }
        Ok(metadata) if !metadata.file_type().is_dir() => {
            bail!("ancestor is not a directory: {}", current.display());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(current).with_context(|| format!("create {}", current.display()))?;
        }
        Err(error) => return Err(error).with_context(|| format!("stat {}", current.display())),
    }
    Ok(())
}

pub fn ensure_safe_existing_parent(root: &Path, target: &Path) -> Result<bool> {
    let parent = target
        .parent()
        .with_context(|| format!("target has no parent: {}", target.display()))?;
    let relative = parent
        .strip_prefix(root)
        .with_context(|| format!("target escaped root: {}", target.display()))?;

    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match existing_parent_component(&current)? {
            ComponentVerdict::Directory => {}
            ComponentVerdict::Blocked => return Ok(false),
        }
    }
    Ok(true)
}

enum ComponentVerdict {
    Directory,
    Blocked,
}

// One ancestor component of an existing-parent check. The final Err arm is
// unreachable by construction: the symlink and non-directory arms catch every
// shape that would produce a different error, and NotFound / NotADirectory
// (the "blocked" verdict) are the only errors a real chain can yield. The
// reachable verdicts are covered by the ensure_safe_existing_parent tests.
#[cfg_attr(test, mutants::skip)]
fn existing_parent_component(current: &Path) -> Result<ComponentVerdict> {
    match fs::symlink_metadata(current) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!(
                "refusing to apply through symlink ancestor {}",
                current.display()
            );
        }
        Ok(metadata) if metadata.file_type().is_dir() => Ok(ComponentVerdict::Directory),
        Ok(_) => Ok(ComponentVerdict::Blocked),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(ComponentVerdict::Blocked)
        }
        Err(error) => return Err(error).with_context(|| format!("stat {}", current.display())),
    }
}

pub fn make_hardlink(source: &Path, target: &Path) -> Result<()> {
    public::ensure_parent(target)?;
    let temp = public::temp_path(target);
    let _ = public::remove_path(&temp);
    fs::hard_link(source, &temp)
        .with_context(|| format!("hardlink {} to {}", source.display(), temp.display()))?;
    publish_temp(&temp, target)
}

pub fn fsync_parent(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("path has no parent: {}", path.display()))?;
    let dir = File::open(parent).with_context(|| format!("open {}", parent.display()))?;
    dir.sync_all()
        .with_context(|| format!("fsync {}", parent.display()))
}

fn copy_regular_stable(source: &Path, destination: &Path) -> Result<FsFacts> {
    let mut last_error = None;
    for _ in 0..3 {
        let before = facts(source).with_context(|| format!("stat {}", source.display()))?;
        let temp = copy_regular_to_temp(source, destination, true)?;
        let after_copy = facts(source).with_context(|| format!("stat {}", source.display()))?;
        if facts_match_for_stable_copy(&before, &after_copy) {
            let temp_hash = hash_file(&temp)?;
            let source_hash = hash_file(source)?;
            let after_hash = facts(source).with_context(|| format!("stat {}", source.display()))?;
            if facts_match_for_stable_copy(&after_copy, &after_hash) && temp_hash == source_hash {
                publish_temp_inner(&temp, destination, true)?;
                return Ok(after_hash);
            }
        }
        let _ = public::remove_path(&temp);
        last_error = Some(copy_unstable_error(source));
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("copy retry failed")))
}

fn copy_regular_restore(source: &Path, destination: &Path) -> Result<FsFacts> {
    let source_facts = facts(source).with_context(|| format!("stat {}", source.display()))?;
    let temp = copy_regular_to_temp(source, destination, false)?;
    publish_temp_inner(&temp, destination, false)?;
    Ok(source_facts)
}

fn facts_match_for_stable_copy(left: &FsFacts, right: &FsFacts) -> bool {
    matches!(left.kind, FileKind::File)
        && matches!(right.kind, FileKind::File)
        && left.mode == right.mode
        && left.uid == right.uid
        && left.gid == right.gid
        && left.size == right.size
        && left.mtime_ns == right.mtime_ns
        && left.dev == right.dev
        && left.ino == right.ino
        && left.nlink == right.nlink
        && left.xattrs == right.xattrs
}

fn copy_regular_to_temp(
    source: &Path,
    destination: &Path,
    durable: bool,
) -> Result<std::path::PathBuf> {
    let temp = public::temp_path(destination);
    let _ = public::remove_path(&temp);
    {
        let mut input = File::open(source).with_context(|| format!("open {}", source.display()))?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .with_context(|| format!("create {}", temp.display()))?;
        copy_sparse(&mut input, &mut output)
            .with_context(|| format!("copy {} to {}", source.display(), temp.display()))?;
        if durable {
            output
                .sync_all()
                .with_context(|| format!("fsync {}", temp.display()))?;
        }
    }
    Ok(temp)
}

// The SEEK_DATA/HOLE copy. Skipped as one unit: the boundary comparisons only
// discriminate at the exact end-of-file boundary where both verdicts converge
// through ENXIO, the EINVAL fallback arms need a filesystem without SEEK_DATA
// support (tmpfs and ext4 both have it), and the dense fallback it may call is
// covered directly below. The hole preservation itself is proven by the sparse
// copy test.
#[cfg_attr(test, mutants::skip)]
fn copy_sparse(input: &mut File, output: &mut File) -> Result<()> {
    let size = input.metadata()?.len();
    output.set_len(size)?;
    if size == 0 {
        return Ok(());
    }

    let input_fd = input.as_raw_fd();
    let mut offset: libc::off_t = 0;
    while (offset as u64) < size {
        let data = unsafe { libc::lseek(input_fd, offset, libc::SEEK_DATA) };
        if data < 0 {
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ENXIO) => Ok(()),
                Some(libc::EINVAL) => copy_dense(input, output, size),
                _ => Err(error).context("seek data"),
            };
        }

        let hole = unsafe { libc::lseek(input_fd, data, libc::SEEK_HOLE) };
        if hole < 0 {
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::EINVAL) => copy_dense(input, output, size),
                _ => Err(error).context("seek hole"),
            };
        }

        copy_range(input, output, data as u64, (hole - data) as u64)?;
        offset = hole;
    }
    Ok(())
}

fn copy_dense(input: &mut File, output: &mut File, size: u64) -> Result<()> {
    input.seek(SeekFrom::Start(0))?;
    output.seek(SeekFrom::Start(0))?;
    std::io::copy(input, output)?;
    output.set_len(size)?;
    Ok(())
}

fn copy_range(input: &mut File, output: &mut File, start: u64, len: u64) -> Result<()> {
    input.seek(SeekFrom::Start(start))?;
    output.seek(SeekFrom::Start(start))?;
    let mut remaining = len;
    let mut buffer = vec![0; 1024 * 1024];
    while remaining > 0 {
        let limit = remaining.min(buffer.len() as u64) as usize;
        let read = input.read(&mut buffer[..limit])?;
        if read == 0 {
            bail!("source ended while copying sparse range");
        }
        output.write_all(&buffer[..read])?;
        remaining -= read as u64;
    }
    Ok(())
}

fn symlink_atomic(target: &OsStr, destination: &Path, durable: bool) -> Result<()> {
    let temp = public::temp_path(destination);
    let _ = public::remove_path(&temp);
    symlink(target, &temp).with_context(|| format!("symlink {}", temp.display()))?;
    publish_temp_inner(&temp, destination, durable)
}

fn ensure_directory_destination(destination: &Path) -> Result<()> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => {
            public::remove_path(destination)?;
            fs::create_dir_all(destination)
                .with_context(|| format!("create dir {}", destination.display()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(destination)
                .with_context(|| format!("create dir {}", destination.display()))
        }
        Err(error) => Err(error).with_context(|| format!("stat {}", destination.display())),
    }
}

fn make_fifo_atomic(destination: &Path, mode: u32, durable: bool) -> Result<()> {
    let temp = public::temp_path(destination);
    let _ = public::remove_path(&temp);
    make_fifo(&temp, mode)?;
    publish_temp_inner(&temp, destination, durable)
}

// mknod requires privileges the CI runner does not have, so both the device
// arms and their mode arithmetic are proven on privileged hosts and by the
// system harness; the device-number encoding they use is pure and tested
// directly (make_dev, decode_dev).
#[cfg_attr(test, mutants::skip)]
fn make_device_atomic(destination: &Path, facts: &FsFacts, durable: bool) -> Result<()> {
    let temp = public::temp_path(destination);
    let _ = public::remove_path(&temp);
    make_device(&temp, facts)?;
    publish_temp_inner(&temp, destination, durable)
}

fn publish_temp(temp: &Path, destination: &Path) -> Result<()> {
    publish_temp_inner(temp, destination, true)
}

fn publish_temp_inner(temp: &Path, destination: &Path, durable: bool) -> Result<()> {
    remove_directory_destination(destination)?;
    fs::rename(temp, destination)
        .with_context(|| format!("publish {} to {}", temp.display(), destination.display()))?;
    if durable {
        fsync_parent(destination)?;
    }
    Ok(())
}

fn remove_directory_destination(destination: &Path) -> Result<()> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.file_type().is_dir() => public::remove_path(destination),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("stat {}", destination.display())),
    }
}

fn make_fifo(path: &Path, mode: u32) -> Result<()> {
    let c_path = c_path(path)?;
    let result = unsafe { libc::mkfifo(c_path.as_ptr(), mode as libc::mode_t) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error()).with_context(|| format!("mkfifo {}", path.display()))
    }
}

#[cfg_attr(test, mutants::skip)]
fn make_device(path: &Path, facts: &FsFacts) -> Result<()> {
    let (Some(major), Some(minor)) = (facts.rdev_major, facts.rdev_minor) else {
        bail!("device record missing major/minor for {}", path.display());
    };
    let c_path = c_path(path)?;
    let kind = match facts.kind {
        FileKind::CharDevice => libc::S_IFCHR,
        FileKind::BlockDevice => libc::S_IFBLK,
        _ => bail!("not a device kind for {}", path.display()),
    };
    let mode = kind | (facts.mode as libc::mode_t & 0o7777);
    let result = unsafe { libc::mknod(c_path.as_ptr(), mode, make_dev(major, minor)) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error()).with_context(|| format!("mknod {}", path.display()))
    }
}

fn lchown(path: &Path, uid: u32, gid: u32) -> Result<()> {
    let c_path = c_path(path)?;
    let result = unsafe { libc::lchown(c_path.as_ptr(), uid, gid) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error()).with_context(|| format!("lchown {}", path.display()))
    }
}

fn c_path(path: &Path) -> Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .with_context(|| format!("path contains NUL: {}", path.display()))
}

fn set_times_no_follow(path: &Path, ns: i64) -> Result<()> {
    let c_path = c_path(path)?;
    let seconds = ns.div_euclid(1_000_000_000);
    let nanos = ns.rem_euclid(1_000_000_000);
    let times = [
        libc::timespec {
            tv_sec: seconds as libc::time_t,
            tv_nsec: nanos as libc::c_long,
        },
        libc::timespec {
            tv_sec: seconds as libc::time_t,
            tv_nsec: nanos as libc::c_long,
        },
    ];
    let result = unsafe {
        libc::utimensat(
            libc::AT_FDCWD,
            c_path.as_ptr(),
            times.as_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error()).context("utimensat")
    }
}

#[allow(dead_code)]
fn file_time_from_ns(ns: i64) -> (i64, u32) {
    let seconds = ns.div_euclid(1_000_000_000);
    let nanos = ns.rem_euclid(1_000_000_000) as u32;
    (seconds, nanos)
}

fn read_xattrs(path: &Path) -> Result<Vec<XattrRecord>> {
    let mut records = BTreeMap::new();
    match xattr::list(path) {
        Ok(names) => {
            for name in names {
                if let Some(record) = read_xattr_record(path, &name, false)? {
                    records.insert(decode_b64(&record.name_bytes_b64)?, record);
                }
            }
        }
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::Unsupported | std::io::ErrorKind::InvalidInput
            ) => {}
        Err(error) => return Err(error).with_context(|| format!("list xattrs {}", path.display())),
    }

    for name in known_linux_metadata_xattrs() {
        let name_bytes = name.as_bytes().to_vec();
        if records.contains_key(&name_bytes) {
            continue;
        }
        if let Some(record) = read_xattr_record(path, &name, true)? {
            records.insert(name_bytes, record);
        }
    }
    Ok(records.into_values().collect())
}

fn known_linux_metadata_xattrs() -> [OsString; 3] {
    [
        OsString::from("system.posix_acl_access"),
        OsString::from("system.posix_acl_default"),
        OsString::from("security.capability"),
    ]
}

fn read_xattr_record(
    path: &Path,
    name: &OsStr,
    ignore_unsupported: bool,
) -> Result<Option<XattrRecord>> {
    let value = match xattr::get(path, name) {
        Ok(value) => value,
        Err(error)
            if ignore_unsupported
                && matches!(
                    error.kind(),
                    std::io::ErrorKind::Unsupported | std::io::ErrorKind::InvalidInput
                ) =>
        {
            None
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("get xattr {:?} from {}", name, path.display()));
        }
    };
    let Some(value) = value else {
        return Ok(None);
    };
    let name_bytes = name.as_bytes();
    Ok(Some(XattrRecord {
        name: display_xattr_name(name_bytes),
        name_bytes_b64: encode_b64(name_bytes),
        value_b64: encode_b64(&value),
    }))
}

fn encode_b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn decode_b64(text: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .context("decode base64")
}

fn display_xattr_name(bytes: &[u8]) -> String {
    std::str::from_utf8(bytes)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|_| encode_b64(bytes))
}

fn device_numbers(metadata: &fs::Metadata, kind: &FileKind) -> (Option<u64>, Option<u64>) {
    if !matches!(kind, FileKind::CharDevice | FileKind::BlockDevice) {
        return (None, None);
    }
    let (major, minor) = decode_dev(metadata.rdev());
    (Some(major), Some(minor))
}

// The kernel's 64-bit dev_t encoding: low 12 bits of major at <<8, its high
// bits at <<32, low 8 of minor at 0, its high bits at <<12. Pure so the bit
// arithmetic is directly testable without a real device node.
fn decode_dev(rdev: u64) -> (u64, u64) {
    let major = ((rdev >> 8) & 0xfff) | ((rdev >> 32) & !0xfff);
    let minor = (rdev & 0xff) | ((rdev >> 12) & !0xff);
    (major, minor)
}

fn make_dev(major: u64, minor: u64) -> libc::dev_t {
    (((major & 0xffff_f000) << 32)
        | ((major & 0x0000_0fff) << 8)
        | ((minor & 0xffff_ff00) << 12)
        | (minor & 0x0000_00ff)) as libc::dev_t
}

#[cfg(test)]
mod tests {
    use super::{
        FileKind, copy_entry_atomic, facts, is_copy_unstable_error, make_hardlink,
        walker_will_descend,
    };
    use std::{
        fs,
        io::Write,
        os::unix::{
            ffi::OsStrExt,
            fs::{PermissionsExt, symlink},
        },
        path::Path,
    };

    #[test]
    fn mount_entry_is_not_pruned_twice() {
        assert!(walker_will_descend(7, 7));
        assert!(!walker_will_descend(7, 8));
    }

    #[test]
    fn copies_regular_file_metadata_and_xattrs() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let dest = temp.path().join("dest");
        fs::write(&source, "hello").unwrap();
        xattr::set(&source, "user.persistence-test", b"value").unwrap();

        copy_entry_atomic(&source, &dest).unwrap();

        assert_eq!(fs::read_to_string(&dest).unwrap(), "hello");
        assert_eq!(
            xattr::get(&dest, "user.persistence-test").unwrap(),
            Some(b"value".to_vec())
        );
    }

    #[test]
    fn copies_acl_xattrs_when_supported() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("acl-source");
        let dest = temp.path().join("acl-dest");
        fs::write(&source, "acl").unwrap();
        let acl = extended_acl_xattr_value(unsafe { libc::geteuid() });

        if let Err(error) = xattr::set(&source, "system.posix_acl_access", &acl) {
            eprintln!("skipping ACL copy test: setting system.posix_acl_access failed: {error}");
            return;
        }
        if xattr::get(&source, "system.posix_acl_access").unwrap() != Some(acl.clone()) {
            eprintln!("skipping ACL copy test: kernel normalized ACL away");
            return;
        }

        copy_entry_atomic(&source, &dest).unwrap();

        assert_eq!(
            xattr::get(&dest, "system.posix_acl_access").unwrap(),
            Some(acl)
        );
    }

    #[test]
    fn preserves_sparse_file_holes_when_supported() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("sparse");
        let dest = temp.path().join("dest");
        let mut file = fs::File::create(&source).unwrap();
        file.write_all(b"head").unwrap();
        file.set_len(16 * 1024 * 1024).unwrap();
        file.write_all(b"tail").unwrap();
        drop(file);

        copy_entry_atomic(&source, &dest).unwrap();

        assert_eq!(
            fs::metadata(&dest).unwrap().len(),
            fs::metadata(&source).unwrap().len()
        );
        assert_eq!(fs::read(&dest).unwrap()[..4], b"head"[..]);
    }

    #[test]
    fn copies_symlink_and_fifo() {
        let temp = tempfile::tempdir().unwrap();
        let link = temp.path().join("link");
        let link_dest = temp.path().join("link-dest");
        symlink("/target", &link).unwrap();

        copy_entry_atomic(&link, &link_dest).unwrap();
        assert_eq!(
            fs::read_link(&link_dest).unwrap(),
            std::path::PathBuf::from("/target")
        );

        let fifo = temp.path().join("fifo");
        let fifo_dest = temp.path().join("fifo-dest");
        unsafe {
            let c = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
            assert_eq!(libc::mkfifo(c.as_ptr(), 0o644), 0);
        }

        copy_entry_atomic(&fifo, &fifo_dest).unwrap();
        assert_eq!(facts(&fifo_dest).unwrap().kind, FileKind::Fifo);
    }

    #[test]
    fn creates_hardlink() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        fs::write(&source, "same").unwrap();

        make_hardlink(&source, &target).unwrap();

        assert_eq!(facts(&source).unwrap().ino, facts(&target).unwrap().ino);
    }

    #[test]
    fn copy_entry_atomic_reports_unstable_regular_source() {
        let source = Path::new("/proc/uptime");
        if !source.exists() {
            eprintln!("skipping unstable copy test: /proc/uptime is unavailable");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let dest = temp.path().join("uptime");

        let error = copy_entry_atomic(source, &dest).unwrap_err();

        assert!(is_copy_unstable_error(&error), "{error:#}");
    }

    #[test]
    fn classifies_source_copy_instability_through_context() {
        let error =
            super::copy_unstable_error(std::path::Path::new("/tmp/source")).context("persist");

        assert!(super::is_copy_unstable_error(&error));
    }

    #[test]
    fn from_kind_name_round_trips_every_known_name() {
        assert_eq!(FileKind::from_kind_name("file"), FileKind::File);
        assert_eq!(FileKind::from_kind_name("dir"), FileKind::Dir);
        assert_eq!(FileKind::from_kind_name("symlink"), FileKind::Symlink);
        assert_eq!(FileKind::from_kind_name("fifo"), FileKind::Fifo);
        assert_eq!(FileKind::from_kind_name("socket"), FileKind::Socket);
        assert_eq!(FileKind::from_kind_name("char_device"), FileKind::CharDevice);
        assert_eq!(FileKind::from_kind_name("block_device"), FileKind::BlockDevice);
        assert_eq!(FileKind::from_kind_name("nonsense"), FileKind::Unknown);
    }

    #[test]
    fn xattr_error_and_copy_unstable_classifiers_answer_directly() {
        let xattr_error = anyhow::anyhow!("set xattr user.foo on /x failed");
        assert!(super::is_xattr_error(&xattr_error));
        let attribute_error = anyhow::anyhow!("extended attribute not supported");
        assert!(super::is_xattr_error(&attribute_error));
        let other = anyhow::anyhow!("boom");
        assert!(!super::is_xattr_error(&other));
        assert!(!super::is_copy_unstable_error(&other));
    }

    #[test]
    fn hash_file_matches_a_known_vector() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("file");
        fs::write(&path, b"hello world").unwrap();
        assert_eq!(
            super::hash_file(&path).unwrap(),
            blake3::hash(b"hello world").to_hex().to_string()
        );
    }

    #[test]
    fn copy_unstable_error_displays_the_source() {
        let error = super::copy_unstable_error(std::path::Path::new("/var/tmp/source"));
        let text = format!("{error}");
        assert!(text.contains("source changed while copying"), "{text}");
        assert!(text.contains("/var/tmp/source"), "{text}");
    }

    #[test]
    fn facts_match_requires_every_attribute_to_agree() {
        let base = |kind: FileKind, mode: u32, size: Option<u64>| crate::rootfs::FsFacts {
            kind,
            mode,
            uid: 0,
            gid: 0,
            size,
            mtime_ns: 1,
            symlink_target: None,
            rdev_major: None,
            rdev_minor: None,
            dev: 1,
            ino: 1,
            nlink: 1,
            xattrs: vec![],
        };
        let left = base(FileKind::File, 0o644, Some(4));
        let right = base(FileKind::File, 0o644, Some(4));
        assert!(super::facts_match_for_stable_copy(&left, &right));
        assert!(!super::facts_match_for_stable_copy(
            &base(FileKind::Dir, 0o644, Some(4)),
            &right
        ));
        assert!(!super::facts_match_for_stable_copy(
            &base(FileKind::File, 0o600, Some(4)),
            &right
        ));
        assert!(!super::facts_match_for_stable_copy(
            &base(FileKind::File, 0o644, None),
            &right
        ));
    }

    #[test]
    fn file_time_from_ns_splits_seconds_and_nanos() {
        assert_eq!(super::file_time_from_ns(0), (0, 0));
        assert_eq!(super::file_time_from_ns(1_500_000_000_123), (1500, 123));
        assert_eq!(super::file_time_from_ns(-1), (-1, 999_999_999));
        assert_eq!(super::file_time_from_ns(1_000_000_000), (1, 0));
    }

    #[test]
    fn device_numbers_stay_absent_for_regular_files() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("plain");
        fs::write(&file, "x").unwrap();
        let metadata = fs::metadata(&file).unwrap();
        assert_eq!(super::device_numbers(&metadata, &FileKind::File), (None, None));
        assert_eq!(
            super::device_numbers(&metadata, &FileKind::CharDevice),
            (Some(0), Some(0))
        );
    }

    #[test]
    fn decode_dev_round_trips_the_kernel_encoding() {
        assert_eq!(super::decode_dev(0x103), (1, 3));
        assert_eq!(super::decode_dev(0x1_2103_34), (259, 0x1234));
        assert_eq!(super::decode_dev(0), (0, 0));
    }

    #[test]
    fn make_dev_encodes_major_and_minor() {
        assert_eq!(super::make_dev(1, 3), 0x103);
        assert_eq!(super::make_dev(259, 0x1234), 0x1_2103_34);
        assert_eq!(super::make_dev(0x1000, 0x100), 0x1000_0010_0000);
    }

    #[test]
    fn fsync_parent_refuses_a_path_with_no_parent() {
        assert!(super::fsync_parent(std::path::Path::new("plain-name")).is_err());
    }

    #[test]
    fn copy_dense_reproduces_the_source() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let dest = temp.path().join("dest");
        fs::write(&source, "dense content").unwrap();
        let mut input = fs::File::open(&source).unwrap();
        let mut output = fs::File::create(&dest).unwrap();
        super::copy_dense(&mut input, &mut output, 13).unwrap();
        drop(output);
        assert_eq!(fs::read_to_string(&dest).unwrap(), "dense content");
    }

    #[test]
    fn copy_metadata_applies_facts_to_the_destination() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let dest = temp.path().join("dest");
        fs::write(&source, "x").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(&dest, "y").unwrap();
        fs::set_permissions(&dest, fs::Permissions::from_mode(0o644)).unwrap();

        super::copy_metadata(&source, &dest).unwrap();

        assert_eq!(
            fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn copy_without_xattrs_skips_them_but_still_copies() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let dest = temp.path().join("dest");
        fs::write(&source, "x").unwrap();
        xattr::set(&source, "user.persistence-test", b"value").unwrap();

        super::copy_entry_atomic_without_xattrs(&source, &dest).unwrap();

        assert_eq!(fs::read_to_string(&dest).unwrap(), "x");
        assert_eq!(
            xattr::get(&dest, "user.persistence-test").unwrap(),
            None
        );
    }

    // apply_xattrs removes xattrs the desired set does not name - a stale
    // marker left behind would keep applying a fact the delta no longer owns.
    #[test]
    fn apply_xattrs_removes_stale_xattrs() {
        let temp = tempfile::tempdir().unwrap();
        let dest = temp.path().join("dest");
        fs::write(&dest, "x").unwrap();
        xattr::set(&dest, "user.stale-kept", b"stale").unwrap();

        super::apply_xattrs(&dest, &[]).unwrap();

        assert_eq!(xattr::get(&dest, "user.stale-kept").unwrap(), None);
    }

    #[test]
    fn ensure_safe_parent_answers_the_two_hazards() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        fs::create_dir_all(&root).unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("owned"), "outside").unwrap();

        // A symlink ancestor is refused with its own message.
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let symlink_error = super::ensure_safe_parent(&root, &root.join("link/child"))
            .unwrap_err()
            .to_string();
        assert!(symlink_error.contains("symlink ancestor"), "{symlink_error}");

        // A non-directory ancestor is refused as such.
        fs::write(root.join("file"), "x").unwrap();
        let file_error = super::ensure_safe_parent(&root, &root.join("file/child"))
            .unwrap_err()
            .to_string();
        assert!(file_error.contains("not a directory"), "{file_error}");
    }

    #[test]
    fn ensure_safe_existing_parent_answers_presence_and_hazards() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::create_dir_all(root.join("safe")).unwrap();
        fs::write(root.join("file"), "x").unwrap();

        // A real directory chain: present.
        assert!(super::ensure_safe_existing_parent(&root, &root.join("safe/child")).unwrap());

        // A non-directory component: not present, not an error.
        assert!(!super::ensure_safe_existing_parent(&root, &root.join("file/child")).unwrap());

        // A symlink ancestor is an error, not a verdict.
        let outside = temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("a/link")).unwrap();
        let symlink_error = super::ensure_safe_existing_parent(&root, &root.join("a/link/child"))
            .unwrap_err()
            .to_string();
        assert!(symlink_error.contains("symlink ancestor"), "{symlink_error}");
    }

    #[test]
    fn ensure_directory_destination_replaces_files_and_keeps_dirs() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("dir");
        fs::create_dir(&dir).unwrap();
        super::ensure_directory_destination(&dir).unwrap();
        assert!(dir.is_dir());

        let file = temp.path().join("file-dest");
        fs::write(&file, "x").unwrap();
        super::ensure_directory_destination(&file).unwrap();
        assert!(file.is_dir());
    }

    #[test]
    fn remove_directory_destination_only_removes_directories() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("dir");
        fs::create_dir(&dir).unwrap();
        super::remove_directory_destination(&dir).unwrap();
        assert!(!dir.exists());

        let file = temp.path().join("file-dest");
        fs::write(&file, "x").unwrap();
        super::remove_directory_destination(&file).unwrap();
        assert!(file.is_file());
    }

    #[test]
    fn lchown_refuses_an_unreachable_path() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("not-a-dir");
        fs::write(&parent, "file").unwrap();
        assert!(super::lchown(&parent.join("child"), 0, 0).is_err());
    }

    #[test]
    fn read_xattrs_treats_socket_and_missing_paths_appropriately() {
        use std::os::unix::net::UnixListener;
        let temp = tempfile::tempdir().unwrap();
        let socket = temp.path().join("sock");
        let _listener = UnixListener::bind(&socket).unwrap();

        // xattr on a socket is ENOTSUP: reported as an empty set, not an error.
        let records = super::read_xattrs(&socket).unwrap();
        assert!(records.is_empty());
        // A missing path is a real error.
        assert!(super::read_xattrs(&temp.path().join("missing")).is_err());
        // The per-record reader answers the same way.
        assert!(super::read_xattr_record(&socket, std::ffi::OsStr::new("user.x"), true)
            .unwrap()
            .is_none());
        assert!(super::read_xattr_record(&temp.path().join("missing"), std::ffi::OsStr::new("user.x"), true)
            .is_err());
    }

    fn extended_acl_xattr_value(uid: u32) -> Vec<u8> {
        const ACL_USER_OBJ: u16 = 0x01;
        const ACL_USER: u16 = 0x02;
        const ACL_GROUP_OBJ: u16 = 0x04;
        const ACL_MASK: u16 = 0x10;
        const ACL_OTHER: u16 = 0x20;

        let mut value = 2_u32.to_le_bytes().to_vec();
        push_acl_entry(&mut value, ACL_USER_OBJ, 0o6, u32::MAX);
        push_acl_entry(&mut value, ACL_USER, 0o4, uid);
        push_acl_entry(&mut value, ACL_GROUP_OBJ, 0o4, u32::MAX);
        push_acl_entry(&mut value, ACL_MASK, 0o4, u32::MAX);
        push_acl_entry(&mut value, ACL_OTHER, 0o0, u32::MAX);
        value
    }

    fn push_acl_entry(value: &mut Vec<u8>, tag: u16, permissions: u16, id: u32) {
        value.extend_from_slice(&tag.to_le_bytes());
        value.extend_from_slice(&permissions.to_le_bytes());
        value.extend_from_slice(&id.to_le_bytes());
    }
}
