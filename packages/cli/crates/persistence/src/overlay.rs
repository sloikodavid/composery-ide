//! Overlay engine: reserved-subtree layout and the boot-time upper-hygiene pass.
//!
//! When the persistence engine is `overlay`, the kernel maintains the rootfs
//! delta through an overlayfs whose upper lives on the `/data` volume. The
//! entrypoint (`rootfs/opt/composery/init/overlay.sh`) builds and pivots into
//! that overlay; everything here is the part that has to reason about the
//! *contents* of the upper, which belongs in Rust with real xattr reads and
//! tests rather than in shell.
//!
//! ## Reserved subtree
//!
//! Everything the overlay engine owns lives under `<data>/persistence/overlay/`:
//! `upper/` (the persisted delta), `work/` (overlayfs scratch, recreated every
//! boot), and `state/` (the previous image baseline stash, below). This subtree
//! sits on the `/data` volume, which is a *separate mount* bind-moved into the
//! merged tree after the overlay is built - so it is never itself part of the
//! overlay lower and therefore can never be captured into `upper/`. That is the
//! structural guarantee that the reserved subtree stays out of the persisted
//! set (Hazard A is a corruption footgun documented in `docs/persistence.md`,
//! not a permission boundary).
//!
//! ## Upper hygiene (Hazards B and C)
//!
//! An `upper/` built against an old lower can hide content a new image ships:
//!
//! - a **stale whiteout** (a `0/0` character device in the upper) hides a file
//!   the new image (re)introduces at that path;
//! - an **opaque directory** (`trusted.overlay.opaque="y"`) hides every file the
//!   new image adds inside it.
//!
//! Both come from upper records that outlive the lower they were made against.
//! The copy engine has the *same* delete-stays-deleted semantics by design; the
//! difference is only that overlayfs applies them with no chance to notice. So
//! before mounting we walk the upper's markers - bounded by the number of
//! deletions / opaque markers, not by filesystem size - and reconcile them
//! against the image baselines, reporting everything we see.
//!
//! ### Policy, and why it is safe
//!
//! A whiteout at `P` records that the user deleted whatever the image shipped at
//! `P`. Whether delivering the new image's `P` is correct depends on *which*
//! image content the user actually deleted, which we can only know by comparing
//! the image the upper was last booted against (the **previous baseline**,
//! stashed in `state/`) with the image booting now (the **current baseline**,
//! `/opt/persistence/baseline.sqlite`):
//!
//! - **orphan** (`curr` has no `P`): the whiteout masks nothing this image
//!   ships. Dropping it is a semantic no-op that also stops a *future* image
//!   from hitting the hazard at `P`. Dropped.
//! - **reintroduced** (`prev` lacked `P`, `curr` ships it): the image adds
//!   content at a path the user deleted from a *different* image that never had
//!   it. The deletion cannot have targeted this content, so we deliver it.
//!   Dropped.
//! - **changed** (`prev` and `curr` both ship `P`, different content): the image
//!   replaced the file the user deleted. The user deleted the old bytes, not
//!   these, so we deliver the new ones. Dropped.
//! - **unchanged** (`prev` and `curr` ship identical `P`): the image did not
//!   touch `P`; the user's deletion of exactly this file is still valid.
//!   Resurrecting it would break the documented upgrade promise ("your changes
//!   stay on top"). Kept - and reported. A same-image restart is just this case
//!   for every whiteout (`prev == curr`), so restarts never resurrect a delete.
//! - **unknown history** (no previous baseline, e.g. the first overlay boot):
//!   we cannot prove a drop is safe, so we keep every whiteout that has a
//!   current counterpart and only tidy orphans. Fail towards keeping the delete.
//!
//! **Opaque directories are reported, never rewritten.** A provably-correct
//! conversion (de-opaque plus explicit whiteouts for the entries the *previous*
//! image shipped under the directory) is possible, but it is a structural
//! rewrite of the upper, and a wrong one silently corrupts the delta - the one
//! outcome this engine must never produce. The copy engine shadows a replaced
//! directory identically, so reporting-not-fixing is a detectability
//! improvement over today, not a regression. We surface each opaque directory
//! and how many new-image entries it hides so the operator is never left
//! guessing why an upgrade "did not install".

#![cfg(unix)]

use std::{
    fs::{self, File},
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use walkdir::WalkDir;

use crate::{
    baseline::BaselineRecord, internal::StateDb, layout, paths::Paths, public::PublicPath, rootfs,
};

#[cfg(unix)]
use crate::baseline::BaselineDb;

/// The overlay engine's reserved subtree on the durable volume. All paths are
/// derived from one place so the shell entrypoint and this crate cannot drift
/// (the entrypoint reads `upperdir=`/`workdir=` back from `overlay-hygiene`
/// rather than hardcoding them a second time).
#[derive(Debug, Clone)]
pub struct ReservedLayout {
    /// `<data>/persistence/overlay`.
    pub root: PathBuf,
    /// The persisted overlay upper (the whole rootfs delta except `/data`).
    pub upper: PathBuf,
    /// overlayfs work dir - pure scratch, recreated every boot.
    pub work: PathBuf,
    /// Engine bookkeeping that is not the delta (the baseline stash).
    pub state: PathBuf,
    /// Copy of the image baseline this instance last booted overlay against.
    pub previous_baseline: PathBuf,
    /// blake3 of `previous_baseline`, so an unchanged image skips the re-copy.
    pub previous_baseline_id: PathBuf,
}

pub fn reserved(paths: &Paths) -> ReservedLayout {
    let root = paths.data_dir.join("overlay");
    let state = root.join("state");
    ReservedLayout {
        upper: root.join("upper"),
        work: root.join("work"),
        previous_baseline: state.join("previous-baseline.sqlite"),
        previous_baseline_id: state.join("previous-baseline.id"),
        state,
        root,
    }
}

impl ReservedLayout {
    /// Create `upper/` and `state/` (persist across boots) and recreate `work/`
    /// fresh: a hard-killed container can leave the overlay work dir dirty, and
    /// reusing it makes the next mount fail. This is required, not hygiene.
    pub fn prepare(&self) -> Result<()> {
        fs::create_dir_all(&self.upper)
            .with_context(|| format!("create overlay upper {}", self.upper.display()))?;
        fs::create_dir_all(&self.state)
            .with_context(|| format!("create overlay state {}", self.state.display()))?;
        if let Err(error) = fs::remove_dir_all(&self.work)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error)
                .with_context(|| format!("clear overlay work {}", self.work.display()));
        }
        fs::create_dir_all(&self.work)
            .with_context(|| format!("create overlay work {}", self.work.display()))?;
        Ok(())
    }
}

/// What the hygiene pass decided for one whiteout. Every variant except `Keep`
/// removes the whiteout so the new image's file at that path becomes visible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhiteoutAction {
    /// The current image has no file at this path; the whiteout masks nothing.
    DropOrphan,
    /// The previous image lacked this path; the current image (re)introduces it.
    DropReintroduced,
    /// Both images ship this path but with different content.
    DropChanged,
    /// The image did not change this path; the user's deletion is still valid.
    Keep,
}

/// The content identity of a baseline record: enough to answer "did the image
/// change the thing at this path?" Mode/owner/mtime alone do not count - a
/// permission tweak on a file the user deleted is not reason to resurrect it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Signature {
    kind: String,
    content_hash: Option<String>,
    symlink_target: Option<Vec<u8>>,
    rdev_major: Option<i64>,
    rdev_minor: Option<i64>,
}

fn signature(record: &BaselineRecord) -> Signature {
    Signature {
        kind: record.kind.clone(),
        content_hash: record.content_hash.clone(),
        symlink_target: record.symlink_target_bytes.clone(),
        rdev_major: record.rdev_major,
        rdev_minor: record.rdev_minor,
    }
}

/// Decide a whiteout's fate from the two baselines. Pure so the whole policy
/// matrix is unit-testable without a privileged overlay mount. `prev_available`
/// distinguishes "the previous image genuinely lacked this path" from "we have
/// no previous baseline at all", which must fail towards keeping the delete.
fn classify_whiteout(
    prev: Option<&BaselineRecord>,
    curr: Option<&BaselineRecord>,
    prev_available: bool,
) -> WhiteoutAction {
    match curr {
        None => WhiteoutAction::DropOrphan,
        Some(curr) => match prev {
            Some(prev) => {
                if signature(prev) == signature(curr) {
                    WhiteoutAction::Keep
                } else {
                    WhiteoutAction::DropChanged
                }
            }
            None => {
                if prev_available {
                    WhiteoutAction::DropReintroduced
                } else {
                    WhiteoutAction::Keep
                }
            }
        },
    }
}

/// A whiteout in the upper is a `0/0` character device (classic overlayfs
/// whiteout on an ext4 volume, as the spike confirmed on a Docker named volume).
fn is_whiteout(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_char_device() && metadata.rdev() == 0
}

/// An opaque directory carries `trusted.overlay.opaque="y"` (readable only with
/// `CAP_SYS_ADMIN`, which the overlay engine always has).
fn is_opaque_dir(path: &Path, metadata: &fs::Metadata) -> bool {
    metadata.is_dir()
        && xattr::get(path, "trusted.overlay.opaque")
            .ok()
            .flatten()
            .as_deref()
            == Some(b"y")
}

/// One human-readable line per interesting marker, capped so a pathological
/// upper cannot grow the report without bound. The counts below are exact; the
/// samples are for the operator to read.
const MAX_SAMPLES: usize = 64;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HygieneReport {
    pub previous_baseline_present: bool,
    pub whiteouts_scanned: u64,
    pub whiteouts_dropped_orphan: u64,
    pub whiteouts_dropped_reintroduced: u64,
    pub whiteouts_dropped_changed: u64,
    pub whiteouts_kept: u64,
    pub opaque_dirs: u64,
    pub opaque_dirs_shadowing: u64,
    pub opaque_entries_shadowed: u64,
    /// Bounded sample of notable markers, for logs / diagnostics.
    pub samples: Vec<String>,
}

impl HygieneReport {
    pub fn whiteouts_dropped(&self) -> u64 {
        self.whiteouts_dropped_orphan
            + self.whiteouts_dropped_reintroduced
            + self.whiteouts_dropped_changed
    }

    pub fn summary(&self) -> String {
        format!(
            "previousBaseline={} whiteouts={} dropped={}(orphan={},reintroduced={},changed={}) kept={} opaqueDirs={} shadowing={} shadowedEntries={}",
            self.previous_baseline_present,
            self.whiteouts_scanned,
            self.whiteouts_dropped(),
            self.whiteouts_dropped_orphan,
            self.whiteouts_dropped_reintroduced,
            self.whiteouts_dropped_changed,
            self.whiteouts_kept,
            self.opaque_dirs,
            self.opaque_dirs_shadowing,
            self.opaque_entries_shadowed,
        )
    }

    fn push_sample(&mut self, line: String) {
        if self.samples.len() < MAX_SAMPLES {
            self.samples.push(line);
        }
    }
}

/// Reconcile `upper` against the image baselines. `curr` is the baseline of the
/// image booting now; `prev` is the stashed baseline of the image the upper was
/// last booted against (absent on the first overlay boot). `lower_root` is the
/// live image rootfs (`/` in production), read only to count what an opaque
/// directory shadows. Modifying the upper here is safe precisely because the
/// overlay is *not* mounted yet - Hazard A is about writing a *mounted* upper.
pub fn reconcile(
    upper: &Path,
    lower_root: &Path,
    curr: &BaselineDb,
    prev: Option<&BaselineDb>,
) -> Result<HygieneReport> {
    let mut report = HygieneReport {
        previous_baseline_present: prev.is_some(),
        ..HygieneReport::default()
    };

    // Collect markers before mutating so removing a whiteout cannot disturb the
    // walk. Bounded by the number of deletions / opaque markers in the delta.
    let mut whiteouts: Vec<(PathBuf, PublicPath)> = Vec::new();
    let mut opaque_dirs: Vec<(PathBuf, PublicPath)> = Vec::new();

    if upper.exists() {
        for entry in WalkDir::new(upper).follow_links(false).min_depth(1) {
            let entry = entry.with_context(|| format!("walk overlay upper {}", upper.display()))?;
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    // A racing removal is not fatal to a boot-time pass.
                    tracing::warn!(path = %entry.path().display(), error = %error, "skip unreadable upper entry");
                    continue;
                }
            };
            let relative = entry
                .path()
                .strip_prefix(upper)
                .with_context(|| format!("strip upper prefix from {}", entry.path().display()))?;
            let public = PublicPath::from_root_relative(relative)?;
            if is_whiteout(&metadata) {
                whiteouts.push((entry.path().to_path_buf(), public));
            } else if is_opaque_dir(entry.path(), &metadata) {
                opaque_dirs.push((entry.path().to_path_buf(), public));
            }
        }
    }

    let mut removed_any = false;
    for (full_path, public) in whiteouts {
        report.whiteouts_scanned += 1;
        let curr_record = curr
            .get(&public)
            .with_context(|| format!("lookup current baseline for {public}"))?;
        let prev_record = match prev {
            Some(prev) => prev
                .get(&public)
                .with_context(|| format!("lookup previous baseline for {public}"))?,
            None => None,
        };
        let action = classify_whiteout(prev_record.as_ref(), curr_record.as_ref(), prev.is_some());
        match action {
            WhiteoutAction::Keep => {
                report.whiteouts_kept += 1;
                report.push_sample(format!(
                    "keep whiteout {public} (image unchanged; deletion still valid)"
                ));
                continue;
            }
            WhiteoutAction::DropOrphan => report.whiteouts_dropped_orphan += 1,
            WhiteoutAction::DropReintroduced => report.whiteouts_dropped_reintroduced += 1,
            WhiteoutAction::DropChanged => report.whiteouts_dropped_changed += 1,
        }
        fs::remove_file(&full_path)
            .with_context(|| format!("drop stale whiteout {}", full_path.display()))?;
        removed_any = true;
        report.push_sample(format!("drop whiteout {public} ({action:?})"));
    }

    for (_full_path, public) in opaque_dirs {
        report.opaque_dirs += 1;
        let shadowed = count_lower_children(lower_root, &public);
        if shadowed > 0 {
            report.opaque_dirs_shadowing += 1;
            report.opaque_entries_shadowed += shadowed;
            report.push_sample(format!(
                "opaque dir {public} hides {shadowed} entr{} the current image ships (reported, not modified)",
                if shadowed == 1 { "y" } else { "ies" }
            ));
        }
    }

    if removed_any {
        let _ = rootfs::fsync_parent(upper);
    }
    Ok(report)
}

/// How many direct entries the current image ships inside `dir`. Read from the
/// live lower rather than a baseline query because at hygiene time we are
/// standing in the image rootfs, before any mount, so `lower_root/dir` is the
/// pure image directory the opaque marker hides.
fn count_lower_children(lower_root: &Path, dir: &PublicPath) -> u64 {
    let live = lower_root.join(dir.relative_os_string());
    match fs::read_dir(&live) {
        Ok(entries) => entries.filter(|entry| entry.is_ok()).count() as u64,
        Err(_) => 0,
    }
}

/// Open the stashed previous baseline, if any. A corrupt or unreadable stash is
/// treated as "no previous baseline" (report-and-warn), never a boot failure:
/// the worst it costs is a conservative pass that keeps whiteouts it might have
/// dropped, which is the safe direction.
pub fn open_previous_baseline(layout: &ReservedLayout) -> Option<BaselineDb> {
    if !layout.previous_baseline.exists() {
        return None;
    }
    match BaselineDb::open(&layout.previous_baseline) {
        Ok(db) => Some(db),
        Err(error) => {
            tracing::warn!(
                path = %layout.previous_baseline.display(),
                error = %error,
                "ignoring unreadable previous-baseline stash; hygiene will run conservatively"
            );
            None
        }
    }
}

/// Refresh the previous-baseline stash to the image booting now, so the *next*
/// boot can tell an upgrade from a restart. Skips the copy when the image is
/// unchanged (fingerprint match), keeping a plain restart free of volume writes.
pub fn refresh_stash(layout: &ReservedLayout, current_baseline: &Path) -> Result<()> {
    let current_id = file_fingerprint(current_baseline)?;
    let stored = fs::read_to_string(&layout.previous_baseline_id)
        .ok()
        .map(|value| value.trim().to_string());
    if stored.as_deref() == Some(current_id.as_str()) && layout.previous_baseline.exists() {
        return Ok(());
    }

    let temp = layout.previous_baseline.with_extension("sqlite.tmp");
    let _ = fs::remove_file(&temp);
    fs::copy(current_baseline, &temp).with_context(|| {
        format!(
            "stash baseline {} to {}",
            current_baseline.display(),
            temp.display()
        )
    })?;
    File::open(&temp)
        .with_context(|| format!("open {}", temp.display()))?
        .sync_all()
        .with_context(|| format!("fsync {}", temp.display()))?;
    fs::rename(&temp, &layout.previous_baseline).with_context(|| {
        format!(
            "publish baseline stash {} to {}",
            temp.display(),
            layout.previous_baseline.display()
        )
    })?;
    fs::write(
        &layout.previous_baseline_id,
        format!("{current_id}\n").as_bytes(),
    )
    .with_context(|| format!("write {}", layout.previous_baseline_id.display()))?;
    rootfs::fsync_parent(&layout.previous_baseline)?;
    Ok(())
}

fn file_fingerprint(path: &Path) -> Result<String> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}

/// The `overlay-hygiene` boot command, invoked by `init/overlay.sh` before it
/// mounts the overlay. Prepares the reserved subtree, runs the hygiene pass
/// against the image baselines, refreshes the baseline stash, and prints the
/// `upperdir=` / `workdir=` the shell must mount - so the reserved paths have a
/// single source of truth in this crate. All reporting goes to stderr; stdout
/// carries only the two `key=value` lines.
pub fn run_hygiene_command(paths: &Paths) -> Result<()> {
    let layout = reserved(paths);
    layout.prepare()?;
    layout::ensure(paths)?;
    let db = StateDb::open_or_rebuild(paths)?;

    match BaselineDb::open(&paths.baseline_db) {
        Ok(curr) => {
            let prev = open_previous_baseline(&layout);
            let report = reconcile(&layout.upper, Path::new("/"), &curr, prev.as_ref())?;
            drop(prev);
            drop(curr);
            refresh_stash(&layout, &paths.baseline_db)?;

            let summary = report.summary();
            let _ = db.record_diagnostic("overlay_hygiene", &summary);
            tracing::info!(summary = %summary, "overlay upper-hygiene complete");
            eprintln!("[overlay-hygiene] {summary}");
            for sample in &report.samples {
                eprintln!("[overlay-hygiene] {sample}");
            }
        }
        Err(error) => {
            // The overlay boots correctly without hygiene (the kernel maintains
            // the delta regardless); only the stale-whiteout / opaque-dir
            // reconciliation is lost. Say so loudly rather than pretend it ran.
            let summary = format!("skipped: image baseline unreadable ({error:#})");
            let _ = db.record_diagnostic("overlay_hygiene", &summary);
            tracing::warn!(error = %format!("{error:#}"), "overlay upper-hygiene skipped: baseline unreadable");
            eprintln!("[overlay-hygiene] WARNING {summary}");
        }
    }

    // Single source of truth for the reserved mount paths: the shell reads these
    // back instead of hardcoding them a second time.
    println!("upperdir={}", path_kv(&layout.upper)?);
    println!("workdir={}", path_kv(&layout.work)?);
    Ok(())
}

/// The reserved subtree lives on `/data`, whose path is ASCII by deployment
/// contract, so a lossless `to_str` is expected; reject anything else rather
/// than hand the shell a lossy path.
fn path_kv(path: &Path) -> Result<&str> {
    path.to_str()
        .with_context(|| format!("overlay path is not valid UTF-8: {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::baseline::{GenerateOptions, generate};
    use proptest::{
        prelude::*,
        test_runner::{Config as ProptestConfig, RngSeed},
    };
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::ffi::OsStringExt;

    fn record(kind: &str, content_hash: Option<&str>) -> BaselineRecord {
        BaselineRecord {
            path: PublicPath::parse("/x").unwrap(),
            kind: kind.to_string(),
            mode: 0,
            uid: 0,
            gid: 0,
            size: None,
            mtime_ns: 0,
            content_hash: content_hash.map(str::to_string),
            symlink_target_bytes: None,
            symlink_target: None,
            rdev_major: None,
            rdev_minor: None,
            dev: 0,
            ino: 0,
            nlink: 1,
            hardlink_key: None,
            xattr_json: None,
            acl_json: None,
            capability_json: None,
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: 96,
            failure_persistence: None,
            rng_seed: RngSeed::Fixed(0x5748_4954),
            ..ProptestConfig::default()
        })]

        #[test]
        fn whiteout_classification_preserves_only_the_deleted_image_contents(
            previous_available in any::<bool>(),
            previous_contents in proptest::option::of(any::<u16>()),
            current_contents in proptest::option::of(any::<u16>()),
            previous_mode in 0i64..=0o7777,
            current_mode in 0i64..=0o7777,
            previous_uid in any::<u16>(),
            current_uid in any::<u16>(),
        ) {
            let previous_contents = previous_available.then_some(previous_contents).flatten();
            let mut previous = previous_contents
                .map(|contents| record("file", Some(&format!("{contents:04x}"))));
            let mut current = current_contents
                .map(|contents| record("file", Some(&format!("{contents:04x}"))));
            if let Some(previous) = &mut previous {
                previous.mode = previous_mode;
                previous.uid = i64::from(previous_uid);
            }
            if let Some(current) = &mut current {
                current.mode = current_mode;
                current.uid = i64::from(current_uid);
            }

            let expected = match (previous_contents, current_contents) {
                (_, None) => WhiteoutAction::DropOrphan,
                (Some(previous), Some(current)) if previous == current => WhiteoutAction::Keep,
                (Some(_), Some(_)) => WhiteoutAction::DropChanged,
                (None, Some(_)) if previous_available => WhiteoutAction::DropReintroduced,
                (None, Some(_)) => WhiteoutAction::Keep,
            };

            prop_assert_eq!(
                classify_whiteout(
                    previous.as_ref(),
                    current.as_ref(),
                    previous_available,
                ),
                expected,
            );
        }
    }

    /// Make a `0/0` character-device whiteout. Returns false when the kernel /
    /// container denies `mknod` so the caller can skip rather than fail.
    fn make_whiteout(path: &Path) -> bool {
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        let result = unsafe { libc::mknod(c.as_ptr(), libc::S_IFCHR, 0) };
        result == 0
    }

    struct Image {
        _temp: tempfile::TempDir,
        root: PathBuf,
        baseline: PathBuf,
    }

    fn build_image(files: &[(&str, &str)]) -> Image {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        fs::create_dir_all(root.join("opt/persistence")).unwrap();
        for (name, content) in files {
            let path = root.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        let baseline = root.join("opt/persistence/baseline.sqlite");
        generate(&GenerateOptions {
            root: root.clone(),
            output: baseline.clone(),
        })
        .unwrap();
        Image {
            _temp: temp,
            root,
            baseline,
        }
    }

    #[test]
    fn reconcile_drops_stale_whiteouts_but_keeps_valid_deletions() {
        let prev = build_image(&[
            ("same.txt", "keepme"),
            ("changed.txt", "old"),
            ("orphan.txt", "gone-next-image"),
        ]);
        let curr = build_image(&[
            ("same.txt", "keepme"),
            ("changed.txt", "new"),
            ("reintro.txt", "brand-new"),
        ]);

        let upper = prev._temp.path().join("upper");
        for name in ["same.txt", "changed.txt", "reintro.txt", "orphan.txt"] {
            let path = upper.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            if !make_whiteout(&path) {
                eprintln!("skipping reconcile test: mknod is not permitted here");
                return;
            }
        }

        let curr_db = BaselineDb::open(&curr.baseline).unwrap();
        let prev_db = BaselineDb::open(&prev.baseline).unwrap();
        let report = reconcile(&upper, &curr.root, &curr_db, Some(&prev_db)).unwrap();

        // Unchanged image file: the deletion stays, the whiteout stays.
        assert!(upper.join("same.txt").exists());
        // Changed / reintroduced / orphan: whiteouts dropped so the new image
        // content is delivered (or, for the orphan, tidied away).
        assert!(!upper.join("changed.txt").exists());
        assert!(!upper.join("reintro.txt").exists());
        assert!(!upper.join("orphan.txt").exists());

        assert_eq!(report.whiteouts_scanned, 4);
        assert_eq!(report.whiteouts_kept, 1);
        assert_eq!(report.whiteouts_dropped_changed, 1);
        assert_eq!(report.whiteouts_dropped_reintroduced, 1);
        assert_eq!(report.whiteouts_dropped_orphan, 1);
        assert!(report.previous_baseline_present);
    }

    #[test]
    fn reconcile_without_previous_baseline_keeps_all_counterparts() {
        let curr = build_image(&[("changed.txt", "new"), ("reintro.txt", "brand-new")]);
        let upper = curr._temp.path().join("upper");
        for name in ["changed.txt", "reintro.txt", "orphan.txt"] {
            let path = upper.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            if !make_whiteout(&path) {
                eprintln!("skipping reconcile test: mknod is not permitted here");
                return;
            }
        }

        let curr_db = BaselineDb::open(&curr.baseline).unwrap();
        let report = reconcile(&upper, &curr.root, &curr_db, None).unwrap();

        // No history: keep every whiteout that has a current counterpart, drop
        // only the orphan (masks nothing).
        assert!(upper.join("changed.txt").exists());
        assert!(upper.join("reintro.txt").exists());
        assert!(!upper.join("orphan.txt").exists());
        assert_eq!(report.whiteouts_kept, 2);
        assert_eq!(report.whiteouts_dropped_orphan, 1);
        assert!(!report.previous_baseline_present);
    }

    #[test]
    fn refresh_stash_copies_then_skips_when_unchanged() {
        let image = build_image(&[("a.txt", "1")]);
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(
            temp.path().join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        let layout = reserved(&paths);
        layout.prepare().unwrap();

        refresh_stash(&layout, &image.baseline).unwrap();
        assert!(layout.previous_baseline.exists());
        let first_id = fs::read_to_string(&layout.previous_baseline_id).unwrap();

        // Second call with the same image: no re-copy, same fingerprint.
        refresh_stash(&layout, &image.baseline).unwrap();
        assert_eq!(
            fs::read_to_string(&layout.previous_baseline_id).unwrap(),
            first_id
        );

        // A new image changes the fingerprint.
        let next = build_image(&[("a.txt", "2")]);
        refresh_stash(&layout, &next.baseline).unwrap();
        assert_ne!(
            fs::read_to_string(&layout.previous_baseline_id).unwrap(),
            first_id
        );
    }

    #[test]
    fn whiteout_and_opaque_detection_answer_their_shapes() {
        let temp = tempfile::tempdir().unwrap();
        let plain_file = temp.path().join("plain");
        fs::write(&plain_file, "x").unwrap();
        let plain_metadata = fs::metadata(&plain_file).unwrap();
        assert!(!super::is_whiteout(&plain_metadata));

        let dir = temp.path().join("dir");
        fs::create_dir(&dir).unwrap();
        let dir_metadata = fs::metadata(&dir).unwrap();
        assert!(!super::is_opaque_dir(&dir, &dir_metadata));

        let whiteout = temp.path().join("whiteout");
        if !make_whiteout(&whiteout) {
            eprintln!("skipping whiteout shape test: mknod is not permitted here");
            return;
        }
        assert!(super::is_whiteout(&fs::metadata(&whiteout).unwrap()));

        // The opaque xattr needs CAP_SYS_ADMIN; skip when denied.
        if xattr::set(&dir, "trusted.overlay.opaque", b"y").is_err() {
            eprintln!("skipping opaque xattr test: xattr set is not permitted here");
            return;
        }
        assert!(super::is_opaque_dir(&dir, &fs::metadata(&dir).unwrap()));
        // A *file* carrying the marker is not an opaque directory.
        assert!(!super::is_opaque_dir(&plain_file, &fs::metadata(&plain_file).unwrap()));
    }

    #[test]
    fn hygiene_report_counts_and_caps() {
        let mut report = HygieneReport::default();
        report.whiteouts_dropped_orphan = 1;
        report.whiteouts_dropped_reintroduced = 2;
        report.whiteouts_dropped_changed = 3;
        assert_eq!(report.whiteouts_dropped(), 6);

        let summary = report.summary();
        assert!(summary.contains("previousBaseline=false"));
        assert!(summary.contains("dropped=6"));
        assert!(summary.contains("orphan=1"));

        let mut report = HygieneReport::default();
        for index in 0..100 {
            report.push_sample(format!("sample {index}"));
        }
        assert_eq!(report.samples.len(), super::MAX_SAMPLES);
        assert_eq!(report.samples[0], "sample 0");
        assert_eq!(report.samples[super::MAX_SAMPLES - 1], "sample 63");
    }

    #[test]
    fn reconcile_reports_opaque_dir_shadowing_counts() {
        let curr = build_image(&[("hidden/a.txt", "1"), ("hidden/b.txt", "2")]);
        let upper = curr._temp.path().join("upper");
        fs::create_dir_all(upper.join("hidden")).unwrap();
        let marker = upper.join("hidden");
        if xattr::set(&marker, "trusted.overlay.opaque", b"y").is_err() {
            eprintln!("skipping opaque reconcile test: xattr set is not permitted here");
            return;
        }

        let curr_db = BaselineDb::open(&curr.baseline).unwrap();
        let report = reconcile(&upper, &curr.root, &curr_db, None).unwrap();

        assert_eq!(report.opaque_dirs, 1);
        assert_eq!(report.opaque_dirs_shadowing, 1);
        assert_eq!(report.opaque_entries_shadowed, 2);
        assert!(report.samples.iter().any(|line| line.contains("hides 2")));

        // An opaque dir over a path the image ships nothing at shadows nothing.
        let empty = build_image(&[]);
        let empty_upper = empty._temp.path().join("upper");
        fs::create_dir_all(empty_upper.join("empty")).unwrap();
        if xattr::set(&empty_upper.join("empty"), "trusted.overlay.opaque", b"y").is_err() {
            return;
        }
        let empty_db = BaselineDb::open(&empty.baseline).unwrap();
        let report = reconcile(&empty_upper, &empty.root, &empty_db, None).unwrap();
        assert_eq!(report.opaque_dirs_shadowing, 0);
        assert_eq!(report.opaque_entries_shadowed, 0);
    }

    #[test]
    fn count_lower_children_counts_direct_entries() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("dir")).unwrap();
        fs::write(temp.path().join("dir/a"), "").unwrap();
        fs::write(temp.path().join("dir/b"), "").unwrap();
        assert_eq!(
            super::count_lower_children(temp.path(), &PublicPath::parse("/dir").unwrap()),
            2
        );
        assert_eq!(
            super::count_lower_children(temp.path(), &PublicPath::parse("/missing").unwrap()),
            0
        );
    }

    #[test]
    fn open_previous_baseline_reads_a_valid_stash() {
        let image = build_image(&[("a.txt", "1")]);
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(
            temp.path().join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        let layout = reserved(&paths);
        layout.prepare().unwrap();
        fs::copy(&image.baseline, &layout.previous_baseline).unwrap();

        assert!(super::open_previous_baseline(&layout).is_some());
        assert!(
            super::open_previous_baseline(&reserved(&Paths::new(
                temp.path().join("other-opt"),
                temp.path().join("other-run"),
                temp.path().join("other-data"),
            )))
            .is_none()
        );
    }

    // The boot command's contract is its side effects: the baseline stash must
    // exist and the fingerprint file must be written after a run, so the next
    // boot can tell an upgrade from a restart.
    #[test]
    fn run_hygiene_command_refreshes_the_stash() {
        let image = build_image(&[("a.txt", "1")]);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let paths = Paths::new(
            root.join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        fs::create_dir_all(root.join("opt/persistence")).unwrap();
        fs::copy(&image.baseline, &paths.baseline_db).unwrap();
        layout::ensure(&paths).unwrap();

        super::run_hygiene_command(&paths).unwrap();

        let layout = reserved(&paths);
        assert!(layout.previous_baseline.exists());
        assert!(!fs::read_to_string(&layout.previous_baseline_id)
            .unwrap()
            .trim()
            .is_empty());
    }

    #[test]
    fn path_kv_round_trips_utf8_and_refuses_garbage() {
        assert_eq!(super::path_kv(std::path::Path::new("/data/upper")).unwrap(), "/data/upper");
        let bad = std::path::PathBuf::from(std::ffi::OsString::from_vec(vec![0xff]));
        assert!(super::path_kv(&bad).is_err());
    }
}
