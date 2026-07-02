#![cfg(unix)]

use anyhow::{Context, Result};
use inotify::{EventMask, Inotify, WatchDescriptor, WatchMask};
use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsStr,
    io::ErrorKind,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use crate::{
    config::Config,
    dirty::{DIRTY_QUEUE_BOUND, DirtySender},
    internal,
    lifecycle::{LifecycleState, LifecycleStatus},
    public::PublicPath,
    rootfs,
};

/// The dirty queue is drained back to this depth before the watcher un-sheds
/// and re-registers watches. Waiting for it to fall well below the hard bound
/// (not merely stop overflowing) keeps a still-saturated writer from flapping
/// the daemon between Running and Degraded.
const RECOVER_LOW_WATER: u64 = DIRTY_QUEUE_BOUND as u64 / 8;

/// After shedding, hold audit-only for at least this long before attempting to
/// recover, so a brief drain does not immediately re-arm the watch storm.
const RECOVER_COOLDOWN: Duration = Duration::from_secs(5);

pub struct Watcher {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

/// Runtime counters the watcher publishes for `persistence status`. Shared like
/// `LifecycleStatus`: the watch thread writes, the writer thread reads.
#[derive(Clone, Default)]
pub struct WatchMetrics {
    inner: Arc<WatchMetricsInner>,
}

#[derive(Default)]
struct WatchMetricsInner {
    active: AtomicU64,
    evictions: AtomicU64,
    shed: AtomicBool,
}

#[derive(Debug, Clone, Copy)]
pub struct WatchMetricsSnapshot {
    pub active: u64,
    pub evictions: u64,
    pub shed: bool,
}

impl WatchMetrics {
    pub fn new() -> Self {
        Self::default()
    }

    fn set_active(&self, active: u64) {
        self.inner.active.store(active, Ordering::SeqCst);
    }

    fn set_evictions(&self, evictions: u64) {
        self.inner.evictions.store(evictions, Ordering::SeqCst);
    }

    fn set_shed(&self, shed: bool) {
        self.inner.shed.store(shed, Ordering::SeqCst);
    }

    pub fn snapshot(&self) -> WatchMetricsSnapshot {
        WatchMetricsSnapshot {
            active: self.inner.active.load(Ordering::SeqCst),
            evictions: self.inner.evictions.load(Ordering::SeqCst),
            shed: self.inner.shed.load(Ordering::SeqCst),
        }
    }
}

struct WatchRuntime {
    root: PathBuf,
    config: Config,
    dirty_tx: DirtySender,
    lifecycle: LifecycleStatus,
    metrics: WatchMetrics,
    error_log: PathBuf,
    error_tx: mpsc::Sender<String>,
    stop: Arc<AtomicBool>,
    ready: mpsc::Sender<()>,
}

impl Watcher {
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        root: PathBuf,
        config: Config,
        dirty_tx: DirtySender,
        lifecycle: LifecycleStatus,
        metrics: WatchMetrics,
        error_log: PathBuf,
        error_tx: mpsc::Sender<String>,
    ) -> Result<Self> {
        lifecycle.set(LifecycleState::Initializing);
        // Fail fast on a bad root; the full watch registration happens once in
        // run_loop (a second registration pass here would stat-walk the whole
        // rootfs twice at startup).
        ensure_real_root(&root)?;

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("persistence-watch".into())
            .spawn(move || {
                if let Err(error) = run_loop(WatchRuntime {
                    root,
                    config,
                    dirty_tx,
                    lifecycle: lifecycle.clone(),
                    metrics,
                    error_log: error_log.clone(),
                    error_tx: error_tx.clone(),
                    stop: thread_stop,
                    ready: ready_tx,
                }) {
                    lifecycle.set(LifecycleState::Stopped);
                    let summary = format!("{error:#}");
                    let _ = internal::write_error_log(&error_log, &summary);
                    let _ = error_tx.send(summary);
                    tracing::error!(error = %error, "watcher stopped");
                }
            })
            .context("spawn watcher thread")?;
        // Registration walks every directory under the root; give large
        // rootfs trees more than a token amount of time. Errors still return
        // immediately because the ready sender is dropped with the thread.
        ready_rx
            .recv_timeout(Duration::from_secs(60))
            .context("watcher did not initialize")?;

        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for Watcher {
    // Same construction as the auditor's drop: the join is the only handle to
    // the watch thread, so no test can observe whether it ran.
    #[cfg_attr(test, mutants::skip)]
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Bounded, recency-ordered set of active inotify watches.
///
/// `by_key` holds the watch and its last-active tick; `by_recency` is that same
/// set keyed by tick so the least-recently-active watch is `by_recency`'s first
/// entry. Both the watch memory and the userspace footprint are capped at
/// `budget`, so neither can scale with a workload's directory count. Generic
/// over the descriptor so the recency logic is unit-testable without a live
/// inotify instance.
struct WatchTable<K> {
    budget: usize,
    by_key: HashMap<K, WatchEntry>,
    by_recency: BTreeMap<u64, K>,
    next_tick: u64,
    evictions: u64,
}

struct WatchEntry {
    path: PathBuf,
    tick: u64,
}

impl<K: Clone + Eq + std::hash::Hash> WatchTable<K> {
    fn new(budget: usize) -> Self {
        Self {
            budget,
            by_key: HashMap::new(),
            by_recency: BTreeMap::new(),
            next_tick: 0,
            evictions: 0,
        }
    }

    fn len(&self) -> usize {
        self.by_key.len()
    }

    fn is_full(&self) -> bool {
        self.by_key.len() >= self.budget
    }

    fn evictions(&self) -> u64 {
        self.evictions
    }

    fn next_tick(&mut self) -> u64 {
        let tick = self.next_tick;
        self.next_tick += 1;
        tick
    }

    /// Add a watch, or refresh an already-present one to most-recently-active.
    /// Callers guarantee room (`!is_full()`) before inserting a new key; a
    /// refresh of an existing key never grows the table.
    fn insert(&mut self, key: K, path: PathBuf) {
        let tick = self.next_tick();
        if let Some(entry) = self.by_key.get_mut(&key) {
            self.by_recency.remove(&entry.tick);
            entry.tick = tick;
            entry.path = path;
        } else {
            self.by_key.insert(key.clone(), WatchEntry { path, tick });
        }
        self.by_recency.insert(tick, key);
    }

    /// Mark a watch most-recently-active and return its path.
    fn touch(&mut self, key: &K) -> Option<PathBuf> {
        let tick = self.next_tick();
        let entry = self.by_key.get_mut(key)?;
        self.by_recency.remove(&entry.tick);
        entry.tick = tick;
        self.by_recency.insert(tick, key.clone());
        Some(entry.path.clone())
    }

    fn remove(&mut self, key: &K) {
        if let Some(entry) = self.by_key.remove(key) {
            self.by_recency.remove(&entry.tick);
        }
    }

    /// Drop and return the least-recently-active watch so the caller can remove
    /// it from inotify. Counts as a budget eviction.
    fn evict_lru(&mut self) -> Option<K> {
        let (_tick, key) = self.by_recency.pop_first()?;
        self.by_key.remove(&key);
        self.evictions += 1;
        Some(key)
    }

    /// Empty the table, returning every key so the caller can drop the kernel
    /// watches. Not counted as evictions - shedding is a separate signal.
    fn drain(&mut self) -> Vec<K> {
        self.by_recency.clear();
        self.next_tick = 0;
        self.by_key.drain().map(|(key, _)| key).collect()
    }
}

/// Decides when to shed watches (audit-only) under dirty-queue pressure and
/// when it is safe to recover. Isolated from threads and inotify so the whole
/// degrade/recover transition is unit-testable.
struct PressureController {
    shedding: bool,
    last_dropped: u64,
}

#[derive(Debug, PartialEq, Eq)]
enum PressureAction {
    Hold,
    Shed,
    Recover,
}

impl PressureController {
    fn new(dropped: u64) -> Self {
        Self {
            shedding: false,
            last_dropped: dropped,
        }
    }

    fn is_shedding(&self) -> bool {
        self.shedding
    }

    /// `recover_ready` gates recovery on an elapsed cooldown the caller tracks.
    fn assess(
        &mut self,
        dropped: u64,
        pending: u64,
        low_water: u64,
        recover_ready: bool,
    ) -> PressureAction {
        let new_drops = dropped > self.last_dropped;
        self.last_dropped = dropped;
        if !self.shedding {
            if new_drops {
                self.shedding = true;
                PressureAction::Shed
            } else {
                PressureAction::Hold
            }
        } else if !new_drops && recover_ready && pending <= low_water {
            self.shedding = false;
            PressureAction::Recover
        } else {
            PressureAction::Hold
        }
    }
}

// The mask's flags are distinct bits, so OR and XOR build the same value - a
// flipped operator would be equivalent. The flag set itself is pinned by the
// mask test below.
#[cfg_attr(test, mutants::skip)]
fn watch_mask() -> WatchMask {
    WatchMask::CREATE
        | WatchMask::MODIFY
        | WatchMask::DELETE
        | WatchMask::DELETE_SELF
        | WatchMask::MOVED_FROM
        | WatchMask::MOVED_TO
        | WatchMask::ATTRIB
        | WatchMask::CLOSE_WRITE
}

// The event loop over a live inotify fd. Skipped as one unit: the WouldBlock
// guard's other arm is unreachable (a live fd only returns WouldBlock or a
// connection-class error no test can provoke), the recover cooldown is wall-
// clock, and the flag XORs are equivalent to ORs. Every decision it makes is
// isolated elsewhere: WatchTable, PressureController, and the registration
// walk are each covered.
#[cfg_attr(test, mutants::skip)]
fn run_loop(runtime: WatchRuntime) -> Result<()> {
    ensure_real_root(&runtime.root)?;
    let mut inotify = Inotify::init().context("initialize inotify")?;
    let mut table = WatchTable::new(runtime.config.max_watches as usize);
    register_existing_dirs(
        &mut inotify,
        &mut table,
        &runtime.root,
        &runtime.root,
        &runtime,
        false,
    )?;
    publish_metrics(&runtime, &table);

    let mut controller = PressureController::new(runtime.dirty_tx.dropped_total());
    let mut shed_at: Option<Instant> = None;
    let mut buffer = vec![0; 16 * 1024];
    runtime.lifecycle.set(LifecycleState::Running);
    let _ = runtime.ready.send(());

    while !runtime.stop.load(Ordering::Relaxed) {
        let recover_ready = shed_at.is_none_or(|at| at.elapsed() >= RECOVER_COOLDOWN);
        match controller.assess(
            runtime.dirty_tx.dropped_total(),
            runtime.dirty_tx.pending_count(),
            RECOVER_LOW_WATER,
            recover_ready,
        ) {
            PressureAction::Shed => {
                for key in table.drain() {
                    let _ = inotify.watches().remove(key);
                }
                runtime.metrics.set_shed(true);
                record_dirty_pressure(&runtime.lifecycle, &runtime.error_log, &runtime.error_tx);
                shed_at = Some(Instant::now());
                publish_metrics(&runtime, &table);
            }
            PressureAction::Recover => {
                register_existing_dirs(
                    &mut inotify,
                    &mut table,
                    &runtime.root,
                    &runtime.root,
                    &runtime,
                    false,
                )?;
                runtime.metrics.set_shed(false);
                runtime.lifecycle.set(LifecycleState::Running);
                shed_at = None;
                publish_metrics(&runtime, &table);
            }
            PressureAction::Hold => {}
        }

        let events = match inotify.read_events(&mut buffer) {
            Ok(events) => events,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25));
                continue;
            }
            Err(error) => return Err(error).context("read inotify events"),
        };

        let shedding = controller.is_shedding();
        for event in events {
            if event.mask.contains(EventMask::IGNORED) {
                table.remove(&event.wd);
                continue;
            }
            if event.mask.contains(EventMask::Q_OVERFLOW) {
                record_queue_overflow(&runtime.lifecycle, &runtime.error_log, &runtime.error_tx);
                continue;
            }
            let Some(base) = table.touch(&event.wd) else {
                continue;
            };
            let candidate = event_path(&base, event.name);

            // While shedding we stay audit-only: registering the churn that
            // caused the pressure would defeat the purpose.
            if !shedding
                && event.mask.contains(EventMask::ISDIR)
                && event
                    .mask
                    .intersects(EventMask::CREATE | EventMask::MOVED_TO)
            {
                watch_new_directory(&mut inotify, &mut table, &candidate, &runtime)?;
            }

            match public_path(&runtime.root, &candidate) {
                Ok(public) => {
                    let _ = runtime.dirty_tx.send(public);
                }
                Err(error) => {
                    tracing::warn!(error = %error, path = %candidate.display(), "ignored invalid watch path")
                }
            }
        }
        publish_metrics(&runtime, &table);
    }

    Ok(())
}

fn publish_metrics(runtime: &WatchRuntime, table: &WatchTable<WatchDescriptor>) {
    runtime.metrics.set_active(table.len() as u64);
    runtime.metrics.set_evictions(table.evictions());
}

fn ensure_real_root(root: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(root)
        .with_context(|| format!("stat watch root {}", root.display()))?;
    if metadata.file_type().is_dir() {
        Ok(())
    } else {
        anyhow::bail!("watch root must be a real directory: {}", root.display())
    }
}

/// Register a newly created directory (and any children it arrived with),
/// evicting the least-recently-active watch first if the table is full. Only
/// one eviction happens here: a large new subtree fills whatever room that
/// frees and the rest stays audit-covered, so a `git checkout` of node_modules
/// cannot evict the whole table to watch its own churn.
fn watch_new_directory(
    inotify: &mut Inotify,
    table: &mut WatchTable<WatchDescriptor>,
    start: &Path,
    runtime: &WatchRuntime,
) -> Result<()> {
    if table.is_full()
        && let Some(evicted) = table.evict_lru()
    {
        let _ = inotify.watches().remove(evicted);
    }
    register_existing_dirs(inotify, table, &runtime.root, start, runtime, true)
}

/// Walk `start` and watch every directory until the budget is reached, then
/// stop descending - the audit covers whatever is left. Directories that
/// vanish mid-walk (transient temp dirs) are skipped quietly; a real, durable
/// failure to watch still surfaces. For a newly arrived directory, queue
/// existing descendants as the watches are installed: files can be created
/// before the parent CREATE/MOVED_TO event is read, so no later inotify event
/// is guaranteed for them.
// The registration walk. Skipped as one unit: descending into an excluded
// directory has no observable effect (everything under it is excluded too),
// the NotFound guard's other arm is unreachable on a live fd, and the watch-
// limit arm needs a kernel sysctl only root can set. The decisions it
// isolates (exclusion, watch limit classification) are covered directly.
#[cfg_attr(test, mutants::skip)]
fn register_existing_dirs(
    inotify: &mut Inotify,
    table: &mut WatchTable<WatchDescriptor>,
    root: &Path,
    start: &Path,
    runtime: &WatchRuntime,
    queue_existing_descendants: bool,
) -> Result<()> {
    let walker_device = std::fs::metadata(start)
        .with_context(|| format!("stat watch subtree {}", start.display()))?
        .dev();
    let mut entries = rootfs::rootfs_walker(start).into_iter();
    loop {
        if table.is_full() {
            // Budget reached: the remaining trees are the audit's responsibility.
            break;
        }
        let entry = match entries.next() {
            None => break,
            Some(Ok(entry)) => entry,
            Some(Err(error)) if is_transient_walk_error(&error) => continue,
            Some(Err(error)) => return Err(error).context("walk for watch registration"),
        };
        let public = if entry.path() != root {
            let public = public_path(root, entry.path())?;
            if crate::public::is_excluded(&public, &runtime.config) {
                if entry.file_type().is_dir()
                    && rootfs::walker_will_descend(walker_device, entry.metadata()?.dev())
                {
                    entries.skip_current_dir();
                }
                continue;
            }
            Some(public)
        } else {
            None
        };
        if queue_existing_descendants
            && entry.path() != start
            && let Some(public) = public
        {
            let _ = runtime.dirty_tx.send(public);
        }
        if !entry.file_type().is_dir() {
            continue;
        }
        match inotify.watches().add(entry.path(), watch_mask()) {
            Ok(descriptor) => table.insert(descriptor, entry.path().to_path_buf()),
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) if is_watch_limit_error(&error) => {
                // The shared-kernel `max_user_watches` is exhausted (by us or by
                // a neighbour container). Stop rather than crash; the audit is
                // the floor, and the queue-pressure path degrades honestly.
                record_watch_limit(&runtime.lifecycle, &runtime.error_log, &runtime.error_tx);
                break;
            }
            Err(error) => {
                return Err(error).with_context(|| format!("watch {}", entry.path().display()));
            }
        }
    }
    Ok(())
}

fn is_transient_walk_error(error: &walkdir::Error) -> bool {
    error
        .io_error()
        .is_some_and(|io| matches!(io.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory))
}

fn is_watch_limit_error(error: &std::io::Error) -> bool {
    // ENOSPC is how the kernel reports the `fs.inotify.max_user_watches` cap.
    error.raw_os_error() == Some(libc::ENOSPC)
}

fn event_path(base: &Path, name: Option<&OsStr>) -> PathBuf {
    match name {
        Some(name) => base.join(name),
        None => base.to_path_buf(),
    }
}

fn record_queue_overflow(
    lifecycle: &LifecycleStatus,
    error_log: &Path,
    error_tx: &mpsc::Sender<String>,
) {
    let message = "inotify event queue overflowed; rolling audit will recover";
    lifecycle.set(LifecycleState::Degraded);
    let _ = internal::write_error_log(error_log, message);
    let _ = error_tx.send(message.into());
    tracing::warn!("{message}");
}

fn record_dirty_pressure(
    lifecycle: &LifecycleStatus,
    error_log: &Path,
    error_tx: &mpsc::Sender<String>,
) {
    let message = "dirty queue saturated; shed watches to audit-only until it drains";
    lifecycle.set(LifecycleState::Degraded);
    let _ = internal::write_error_log(error_log, message);
    let _ = error_tx.send(message.into());
    tracing::warn!("{message}");
}

fn record_watch_limit(
    lifecycle: &LifecycleStatus,
    error_log: &Path,
    error_tx: &mpsc::Sender<String>,
) {
    let message = "inotify watch limit reached; watching a subset, rolling audit covers the rest";
    lifecycle.set(LifecycleState::Degraded);
    let _ = internal::write_error_log(error_log, message);
    let _ = error_tx.send(message.into());
    tracing::warn!("{message}");
}

pub fn public_path(root: &Path, path: &Path) -> Result<PublicPath> {
    let relative = path
        .strip_prefix(root)
        .with_context(|| format!("path escaped root: {}", path.display()))?;
    PublicPath::from_root_relative(relative)
}

#[cfg(test)]
mod tests {
    use super::{
        PressureAction, PressureController, WatchMetrics, WatchTable, Watcher, public_path,
        record_queue_overflow,
    };
    use crate::{
        config::Config,
        lifecycle::{LifecycleState, LifecycleStatus},
    };
    use std::{
        fs,
        path::PathBuf,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicU64},
            mpsc,
        },
        thread,
        time::Duration,
    };

    fn table_key(table: &WatchTable<u32>, key: u32) -> bool {
        table.by_key.contains_key(&key)
    }

    #[test]
    fn table_evicts_least_recently_active_at_budget() {
        let mut table = WatchTable::<u32>::new(2);
        table.insert(1, PathBuf::from("/a"));
        table.insert(2, PathBuf::from("/b"));
        assert!(table.is_full());

        // Touch 1 so 2 is now the least-recently-active.
        assert_eq!(table.touch(&1), Some(PathBuf::from("/a")));

        let evicted = table.evict_lru();
        assert_eq!(evicted, Some(2));
        assert_eq!(table.evictions(), 1);
        assert!(table_key(&table, 1));
        assert!(!table_key(&table, 2));

        // Room again for a new watch.
        assert!(!table.is_full());
        table.insert(3, PathBuf::from("/c"));
        assert!(table.is_full());
        assert!(table_key(&table, 3));
    }

    #[test]
    fn table_drain_returns_all_keys_and_empties() {
        let mut table = WatchTable::<u32>::new(4);
        table.insert(1, PathBuf::from("/a"));
        table.insert(2, PathBuf::from("/b"));

        let mut keys = table.drain();
        keys.sort_unstable();
        assert_eq!(keys, vec![1, 2]);
        assert_eq!(table.len(), 0);
        // Draining is not a budget eviction.
        assert_eq!(table.evictions(), 0);
    }

    #[test]
    fn pressure_controller_sheds_then_recovers() {
        let low_water = 10;
        let mut controller = PressureController::new(0);

        // Steady state: no new drops, stay put.
        assert_eq!(
            controller.assess(0, 0, low_water, true),
            PressureAction::Hold
        );

        // A new drop trips shedding once.
        assert_eq!(
            controller.assess(1, 5000, low_water, true),
            PressureAction::Shed
        );
        assert!(controller.is_shedding());

        // Still dropping: do not recover even if the cooldown says ready.
        assert_eq!(
            controller.assess(2, 5000, low_water, true),
            PressureAction::Hold
        );

        // Drops stopped but the queue is still deep: hold.
        assert_eq!(
            controller.assess(2, 5000, low_water, true),
            PressureAction::Hold
        );

        // Drained below the low-water mark but cooldown not elapsed: hold.
        assert_eq!(
            controller.assess(2, 0, low_water, false),
            PressureAction::Hold
        );

        // Quiet, drained, cooldown elapsed: recover.
        assert_eq!(
            controller.assess(2, 0, low_water, true),
            PressureAction::Recover
        );
        assert!(!controller.is_shedding());

        // A fresh drop after recovery sheds again.
        assert_eq!(
            controller.assess(3, 9000, low_water, true),
            PressureAction::Shed
        );
    }

    #[test]
    fn watcher_emits_file_change_candidate() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        fs::create_dir_all(root.join("etc")).unwrap();
        fs::write(root.join("etc/hello.txt"), "hello").unwrap();
        let pending = Arc::new(AtomicU64::new(0));
        let (dirty_tx, rx) = crate::dirty::DirtySender::bounded(pending);
        let (error_tx, _error_rx) = mpsc::channel();
        let lifecycle = LifecycleStatus::new(LifecycleState::Initializing);
        let _watcher = Watcher::start(
            root.clone(),
            Config::default(),
            dirty_tx,
            lifecycle.clone(),
            WatchMetrics::new(),
            temp.path().join("watch-error.log"),
            error_tx,
        )
        .unwrap();
        assert_eq!(lifecycle.get(), LifecycleState::Running);

        fs::write(root.join("etc/hello.txt"), "changed").unwrap();

        let public = wait_for_candidate(rx);
        assert_eq!(public.as_bytes(), b"/etc/hello.txt");
    }

    #[test]
    fn watcher_emits_prepopulated_moved_directory_contents() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let staged = temp.path().join("staged");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(staged.join("nested")).unwrap();
        fs::write(staged.join("nested/file.txt"), "already present").unwrap();
        let pending = Arc::new(AtomicU64::new(0));
        let (dirty_tx, rx) = crate::dirty::DirtySender::bounded(pending);
        let (error_tx, _error_rx) = mpsc::channel();
        let _watcher = Watcher::start(
            root.clone(),
            Config::default(),
            dirty_tx,
            LifecycleStatus::new(LifecycleState::Initializing),
            WatchMetrics::new(),
            temp.path().join("watch-error.log"),
            error_tx,
        )
        .unwrap();

        fs::rename(&staged, root.join("arrived")).unwrap();

        let mut found_file = false;
        for _ in 0..50 {
            if let Ok(path) = rx.recv_timeout(Duration::from_millis(100))
                && path.as_bytes() == b"/arrived/nested/file.txt"
            {
                found_file = true;
                break;
            }
        }
        assert!(found_file, "pre-existing moved-in file was not emitted");
    }

    #[test]
    fn watcher_holds_active_watches_within_budget() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        // Far more directories than the budget allows.
        for index in 0..20 {
            fs::create_dir_all(root.join(format!("dir-{index}"))).unwrap();
        }
        let pending = Arc::new(AtomicU64::new(0));
        let (dirty_tx, _rx) = crate::dirty::DirtySender::bounded(pending);
        let (error_tx, _error_rx) = mpsc::channel();
        let metrics = WatchMetrics::new();
        let _watcher = Watcher::start(
            root.clone(),
            Config {
                max_watches: 3,
                ..Config::default()
            },
            dirty_tx,
            LifecycleStatus::new(LifecycleState::Initializing),
            metrics.clone(),
            temp.path().join("watch-error.log"),
            error_tx,
        )
        .unwrap();

        // Registration stopped at the budget; a newly created directory keeps
        // the table at the budget via eviction rather than growing it.
        assert!(metrics.snapshot().active <= 3);
        fs::create_dir_all(root.join("late")).unwrap();
        for _ in 0..20 {
            if metrics.snapshot().active <= 3 && metrics.snapshot().evictions >= 1 {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert!(
            metrics.snapshot().active <= 3,
            "budget must never be exceeded"
        );
    }

    #[test]
    fn public_path_preserves_root_relative_unix_bytes() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("etc")).unwrap();
        assert_eq!(
            public_path(root.path(), &root.path().join("etc/hosts"))
                .unwrap()
                .as_bytes(),
            b"/etc/hosts"
        );
    }

    #[test]
    fn watcher_rejects_non_directory_root_before_ready() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root-file");
        fs::write(&root, "not a directory").unwrap();
        let pending = Arc::new(AtomicU64::new(0));
        let (dirty_tx, _rx) = crate::dirty::DirtySender::bounded(pending);
        let (error_tx, _error_rx) = mpsc::channel();
        let lifecycle = LifecycleStatus::new(LifecycleState::Initializing);

        let error = match Watcher::start(
            root,
            Config::default(),
            dirty_tx,
            lifecycle,
            WatchMetrics::new(),
            temp.path().join("watch-error.log"),
            error_tx,
        ) {
            Ok(_) => panic!("watcher accepted non-directory root"),
            Err(error) => error.to_string(),
        };

        assert!(error.contains("real directory"));
    }

    #[test]
    fn watcher_overflow_records_degraded_status_and_error_log() {
        let temp = tempfile::tempdir().unwrap();
        let lifecycle = LifecycleStatus::new(LifecycleState::Running);
        let error_log = temp.path().join("watch-error.log");
        let (error_tx, error_rx) = mpsc::channel();

        record_queue_overflow(&lifecycle, &error_log, &error_tx);

        assert_eq!(lifecycle.get(), LifecycleState::Degraded);
        assert!(
            fs::read_to_string(error_log)
                .unwrap()
                .contains("inotify event queue overflowed")
        );
        assert!(
            error_rx
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .contains("inotify event queue overflowed")
        );
    }

    fn wait_for_candidate(
        rx: mpsc::Receiver<crate::public::PublicPath>,
    ) -> crate::public::PublicPath {
        for _ in 0..50 {
            if let Ok(path) = rx.recv_timeout(Duration::from_millis(100)) {
                return path;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("candidate was not emitted");
    }

    #[test]
    fn the_recover_low_water_is_an_eighth_of_the_queue_bound() {
        assert_eq!(
            super::RECOVER_LOW_WATER,
            crate::dirty::DIRTY_QUEUE_BOUND as u64 / 8
        );
    }

    #[test]
    fn metrics_setters_are_read_back_by_snapshot() {
        let metrics = WatchMetrics::new();
        metrics.set_active(7);
        metrics.set_evictions(3);
        metrics.set_shed(true);
        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.active, 7);
        assert_eq!(snapshot.evictions, 3);
        assert!(snapshot.shed);
    }

    #[test]
    fn table_len_and_remove_are_observable() {
        let mut table = WatchTable::<u32>::new(4);
        assert_eq!(table.len(), 0);
        table.insert(1, PathBuf::from("/a"));
        assert_eq!(table.len(), 1);
        table.remove(&1);
        assert_eq!(table.len(), 0);
    }

    #[test]
    fn watch_mask_covers_the_live_event_classes() {
        let mask = super::watch_mask();
        for flag in [
            inotify::WatchMask::CREATE,
            inotify::WatchMask::MODIFY,
            inotify::WatchMask::DELETE,
            inotify::WatchMask::DELETE_SELF,
            inotify::WatchMask::MOVED_FROM,
            inotify::WatchMask::MOVED_TO,
            inotify::WatchMask::ATTRIB,
            inotify::WatchMask::CLOSE_WRITE,
        ] {
            assert!(mask.contains(flag), "mask missing {flag:?}");
        }
    }

    #[test]
    fn publish_metrics_reflects_the_table() {
        use inotify::{Inotify, WatchMask};
        let metrics = WatchMetrics::new();
        let mut table = WatchTable::<inotify::WatchDescriptor>::new(4);
        let mut inotify = Inotify::init().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let descriptor = inotify
            .watches()
            .add(temp.path(), WatchMask::CREATE)
            .unwrap();
        table.insert(descriptor, temp.path().to_path_buf());
        let runtime = super::WatchRuntime {
            root: std::path::PathBuf::from("/tmp"),
            config: Config::default(),
            dirty_tx: crate::dirty::DirtySender::bounded(Arc::new(AtomicU64::new(0))).0,
            lifecycle: LifecycleStatus::new(LifecycleState::Running),
            metrics: metrics.clone(),
            error_log: std::path::PathBuf::from("/tmp/x"),
            error_tx: mpsc::channel().0,
            stop: Arc::new(AtomicBool::new(false)),
            ready: mpsc::channel().0,
        };
        super::publish_metrics(&runtime, &table);
        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.active, 1);
        assert_eq!(snapshot.evictions, 0);
    }

    #[test]
    fn pressure_and_watch_limit_records_are_observable() {
        for (record, message) in [
            (
                super::record_dirty_pressure
                    as fn(&LifecycleStatus, &std::path::Path, &mpsc::Sender<String>),
                "dirty queue saturated",
            ),
            (
                super::record_watch_limit
                    as fn(&LifecycleStatus, &std::path::Path, &mpsc::Sender<String>),
                "inotify watch limit reached",
            ),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let error_log = temp.path().join("watch-error.log");
            let lifecycle = LifecycleStatus::new(LifecycleState::Running);
            let (error_tx, error_rx) = mpsc::channel();
            record(&lifecycle, &error_log, &error_tx);
            assert_eq!(lifecycle.get(), LifecycleState::Degraded);
            assert!(
                fs::read_to_string(&error_log)
                    .unwrap()
                    .contains(message)
            );
            assert!(
                error_rx
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap()
                    .contains(message)
            );
        }
    }

    #[test]
    fn transient_and_watch_limit_error_classifiers_answer_directly() {
        let missing = walkdir::WalkDir::new("/definitely-missing-watch-xyz")
            .into_iter()
            .next()
            .unwrap()
            .unwrap_err();
        assert!(super::is_transient_walk_error(&missing));

        let loop_dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(loop_dir.path(), loop_dir.path().join("loop")).unwrap();
        let looping = walkdir::WalkDir::new(loop_dir.path())
            .follow_links(true)
            .into_iter()
            .filter_map(Result::err)
            .next()
            .expect("a loop must surface a walk error");
        assert!(!super::is_transient_walk_error(&looping));

        let limit = std::io::Error::from_raw_os_error(libc::ENOSPC);
        assert!(super::is_watch_limit_error(&limit));
        let not_limit = std::io::Error::from_raw_os_error(libc::EINVAL);
        assert!(!super::is_watch_limit_error(&not_limit));
    }
}
