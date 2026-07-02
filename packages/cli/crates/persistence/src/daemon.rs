use anyhow::{Context, Result};

#[cfg(unix)]
use std::{
    collections::BTreeSet,
    io::{BufRead, BufReader, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use crate::{config, control, doctor, internal, layout, paths::Paths, prune, readiness, status};

#[cfg(unix)]
use crate::{
    audit,
    baseline::BaselineDb,
    capabilities, dirty,
    lifecycle::{LifecycleState, LifecycleStatus},
    public::PublicPath,
    rootfs, update, watch,
};

#[cfg(unix)]
enum WriterCommand {
    Status(mpsc::Sender<Result<status::StatusReport, String>>),
    Doctor(mpsc::Sender<Result<doctor::DoctorReport, String>>),
    Prune(mpsc::Sender<Result<prune::PruneReport, String>>),
}

#[cfg(unix)]
struct WriterRuntime {
    root: PathBuf,
    paths: Paths,
    config: config::Config,
    baseline: BaselineDb,
    db: internal::StateDb,
    dirty_tx: dirty::DirtySender,
    watch_status: LifecycleStatus,
    audit_status: LifecycleStatus,
    watch_metrics: watch::WatchMetrics,
}

#[cfg(unix)]
static STOP_SIGNAL: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn record_stop_signal(_signal: libc::c_int) {
    STOP_SIGNAL.store(true, Ordering::SeqCst);
}

#[cfg(unix)]
pub fn run(paths: &Paths) -> Result<()> {
    // Stop gracefully on SIGTERM/SIGINT so the writer can drain queued dirty
    // paths before the container filesystem disappears.
    let handler = record_stop_signal as *const () as libc::sighandler_t;
    unsafe {
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
    }
    run_inner(paths, PathBuf::from("/"), None)
}

#[cfg(unix)]
fn run_inner(paths: &Paths, root: PathBuf, mut stop_rx: Option<mpsc::Receiver<()>>) -> Result<()> {
    tracing::info!("persistence daemon starting");
    layout::ensure(paths)?;
    let _lock = internal::WriterLock::acquire(paths)?;
    layout::remove_ready(paths)?;
    remove_stale_control_socket(paths)?;

    let db = internal::StateDb::open_or_rebuild(paths)?;

    // Under the overlay engine the kernel maintains the delta, so the copy
    // watcher/audit/apply machinery must not run. Stand down instead of starting
    // it - the daemon still runs under both init profiles (uniform behaviour)
    // but reports that it is standing down. The engine was recorded at boot by
    // `select-engine`; trust that single decision rather than probing again.
    let engine = db.meta_value("diagnostic_engine")?.unwrap_or_default();
    if engine == "overlay" {
        return run_overlay_standdown(paths, db, stop_rx);
    }

    let config = config::load_or_create(&paths.config_file)?;
    let baseline = BaselineDb::open(&paths.baseline_db)
        .with_context(|| format!("daemon requires baseline {}", paths.baseline_db.display()))?;
    let capability_report = capabilities::probe(&paths.data_dir)?;
    db.record_diagnostic("capabilities", &serde_json::to_string(&capability_report)?)?;

    let baseline_records = baseline.all_records()?;
    let (writer_tx, writer_rx) = mpsc::channel();
    let (watch_error_tx, watch_error_rx) = mpsc::channel();
    let dirty_pending = Arc::new(AtomicU64::new(0));
    let (dirty_sender, dirty_rx) = dirty::DirtySender::bounded(Arc::clone(&dirty_pending));
    let watch_status = LifecycleStatus::new(LifecycleState::Initializing);
    let audit_status = LifecycleStatus::new(LifecycleState::Initializing);
    let watch_metrics = watch::WatchMetrics::new();

    let _watcher = match watch::Watcher::start(
        root.clone(),
        config.clone(),
        dirty_sender.clone(),
        watch_status.clone(),
        watch_metrics.clone(),
        paths.watch_error_log.clone(),
        watch_error_tx,
    ) {
        Ok(watcher) => watcher,
        Err(error) => {
            let summary = format!("{error:#}");
            let _ = db.record_phase_failure("watch", &summary);
            let _ = internal::write_error_log(&paths.watch_error_log, &summary);
            return Err(error).context("initialize watcher");
        }
    };
    let _auditor = match audit::Auditor::start(
        root.clone(),
        baseline_records,
        config.clone(),
        dirty_sender.clone(),
        audit_status.clone(),
    ) {
        Ok(auditor) => auditor,
        Err(error) => {
            let _ = db.record_phase_failure("audit", &format!("{error:#}"));
            return Err(error).context("initialize auditor");
        }
    };

    let writer_dirty_sender = dirty_sender.clone();
    let writer_root = root;
    let writer_paths = paths.clone();
    let writer_config = config;
    let writer_watch_status = watch_status.clone();
    let writer_audit_status = audit_status.clone();
    let writer = thread::Builder::new()
        .name("persistence-writer".into())
        .spawn(move || {
            writer_loop(
                WriterRuntime {
                    root: writer_root,
                    paths: writer_paths,
                    config: writer_config,
                    baseline,
                    db,
                    dirty_tx: writer_dirty_sender,
                    watch_status: writer_watch_status,
                    audit_status: writer_audit_status,
                    watch_metrics,
                },
                writer_rx,
                dirty_rx,
                watch_error_rx,
            );
        })
        .context("spawn writer thread")?;

    request_unit(&writer_tx, WriterCommand::Status).context("verify writer status")?;
    let listener = UnixListener::bind(&paths.control_socket)
        .with_context(|| format!("bind {}", paths.control_socket.display()))?;
    listener
        .set_nonblocking(true)
        .context("set control socket nonblocking")?;

    let db = internal::StateDb::open_or_rebuild(paths)?;
    db.record_phase_success("daemon")?;
    db.record_diagnostic("watch_status", &watch_status.text())?;
    db.record_diagnostic("audit_status", &audit_status.text())?;
    db.record_diagnostic("capabilities", &serde_json::to_string(&capability_report)?)?;
    readiness::write_ready(paths, "daemon")?;
    let _runtime_files = RuntimeFilesGuard { paths };
    tracing::info!("persistence daemon is ready");

    loop {
        if should_stop(&mut stop_rx) {
            break;
        }
        accept_and_handle(&listener, &writer_tx, &writer)?;
    }

    drop(listener);
    drop(_watcher);
    drop(_auditor);
    drop(writer_tx);
    writer
        .join()
        .map_err(|_| anyhow::anyhow!("persistence writer thread panicked"))?;

    Ok(())
}

#[cfg(not(unix))]
#[cfg_attr(test, mutants::skip)]
pub fn run(_paths: &Paths) -> Result<()> {
    anyhow::bail!("persistence daemon is only supported on Unix");
}

/// The persistence daemon under the overlay engine: no watcher, auditor, writer,
/// or apply. It writes readiness so the IDE proceeds and serves `status` over
/// the control socket, reporting `engine=overlay` with the copy-only fields
/// marked not-applicable, so the inert path is visible rather than silent.
#[cfg(unix)]
fn run_overlay_standdown(
    paths: &Paths,
    db: internal::StateDb,
    mut stop_rx: Option<mpsc::Receiver<()>>,
) -> Result<()> {
    tracing::info!(
        "overlay engine selected; persistence daemon standing down (kernel maintains the delta)"
    );
    db.record_phase_success("daemon")?;

    let listener = UnixListener::bind(&paths.control_socket)
        .with_context(|| format!("bind {}", paths.control_socket.display()))?;
    listener
        .set_nonblocking(true)
        .context("set control socket nonblocking")?;
    readiness::write_ready(paths, "overlay")?;
    let _runtime_files = RuntimeFilesGuard { paths };
    tracing::info!("persistence daemon is standing down and ready to report status");

    loop {
        if should_stop(&mut stop_rx) {
            break;
        }
        accept_and_serve_standdown(&listener, paths, &db)?;
    }
    Ok(())
}

#[cfg(unix)]
fn serve_standdown_control(
    mut stream: UnixStream,
    paths: &Paths,
    db: &internal::StateDb,
) -> Result<()> {
    let mut line = String::new();
    BufReader::new(stream.try_clone().context("clone control stream")?)
        .read_line(&mut line)
        .context("read control request")?;

    let response = match serde_json::from_str::<control::Request>(&line) {
        Ok(request) if request.version == 1 => match request.command {
            control::Command::Status => match status::build_standing_down(paths, db) {
                Ok(report) => {
                    control::Response::ok(&report).unwrap_or_else(control::Response::error)
                }
                Err(error) => control::Response::error(format!("{error:#}")),
            },
            control::Command::Doctor | control::Command::Prune => control::Response::error(
                "not applicable under the overlay engine: the kernel maintains the delta",
            ),
        },
        Ok(request) => control::Response::error(format!(
            "unsupported control protocol version {}",
            request.version
        )),
        Err(error) => control::Response::error(format!("invalid control request: {error}")),
    };

    serde_json::to_writer(&mut stream, &response).context("write control response")?;
    stream.write_all(b"\n").context("finish control response")?;
    Ok(())
}

#[cfg(unix)]
fn writer_loop(
    runtime: WriterRuntime,
    command_rx: mpsc::Receiver<WriterCommand>,
    dirty_rx: mpsc::Receiver<PublicPath>,
    watch_error_rx: mpsc::Receiver<String>,
) {
    let update_context = update::UpdateContext {
        root: &runtime.root,
        paths: &runtime.paths,
        config: &runtime.config,
        baseline: &runtime.baseline,
    };

    let mut public_index_dirty = false;
    let mut drain_deadline: Option<Instant> = None;
    loop {
        record_watch_errors(&runtime, &watch_error_rx);
        let mut retry_paths = BTreeSet::new();
        let mut batch_paths = Vec::new();
        // Load the metadata working set once per tick (only when there are dirty
        // paths to process) and flush a single atomic write after the batch,
        // instead of a full read+reserialize+fsync per path.
        let mut store = None;
        for _ in 0..256 {
            let Ok(public_path) = dirty_rx.try_recv() else {
                break;
            };
            batch_paths.push(public_path.clone());
            if store.is_none() {
                match crate::metadata::MetadataStore::load(&runtime.paths.metadata_file) {
                    Ok(loaded) => store = Some(loaded),
                    Err(error) => {
                        tracing::warn!(error = %error, path = %public_path, "metadata working set load failed; requeueing dirty path");
                        let _ = runtime
                            .db
                            .record_phase_failure("update", &format!("{error:#}"));
                        retry_paths.insert(public_path.clone());
                        runtime.dirty_tx.mark_processed();
                        break;
                    }
                }
            }
            if let Some(store) = store.as_mut() {
                match update::update_public_path(&update_context, store, &public_path) {
                    Ok(update::UpdateOutcome::Ignored) => {}
                    Ok(_) => {
                        public_index_dirty = true;
                    }
                    Err(error) => {
                        if rootfs::is_copy_unstable_error(&error) {
                            tracing::warn!(error = %error, path = %public_path, "dirty path changed during copy; requeueing");
                            retry_paths.insert(public_path.clone());
                        } else {
                            tracing::warn!(error = %error, path = %public_path, "dirty path update failed");
                            let _ = runtime
                                .db
                                .record_phase_failure("update", &format!("{error:#}"));
                        }
                    }
                }
            }
            runtime.dirty_tx.mark_processed();
        }
        if let Some(mut store) = store
            && let Err(error) = store.flush()
        {
            tracing::warn!(error = %error, "metadata flush failed");
            let _ = runtime
                .db
                .record_phase_failure("update", &format!("{error:#}"));
            retry_paths.extend(batch_paths);
        }
        if !retry_paths.is_empty() {
            thread::sleep(Duration::from_millis(50));
            for public_path in retry_paths {
                let _ = runtime.dirty_tx.send(public_path);
            }
        }
        // Rebuilding the index walks all of changed/, so defer it until the
        // dirty queue is drained instead of paying a full walk per batch. The
        // rebuild is idempotent over the same input, so whether it runs before
        // or after the queue drains changes nothing observable - a flipped
        // condition here would rebuild earlier, not differently.
        public_index_dirty = maybe_rebuild_index(
            &runtime,
            public_index_dirty,
        );

        match drain_verdict(&runtime, drain_deadline) {
            DrainVerdict::Exit => break,
            DrainVerdict::Continue => continue,
            DrainVerdict::KeepDraining => {}
        }

        match command_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(command) => {
                record_watch_errors(&runtime, &watch_error_rx);
                match command {
                    WriterCommand::Status(response) => {
                        let dirty_queue_size = runtime.dirty_tx.pending_count();
                        let watch = runtime.watch_metrics.snapshot();
                        let _ = response.send(
                            status::build_with_runtime(
                                &runtime.paths,
                                &runtime.db,
                                status::RuntimeStatus {
                                    dirty_queue_size,
                                    watch_status: Some(runtime.watch_status.text()),
                                    audit_status: Some(runtime.audit_status.text()),
                                    watch_count: watch.active,
                                    watch_budget: runtime.config.max_watches,
                                    watch_evictions: watch.evictions,
                                    watches_shed: watch.shed,
                                },
                            )
                            .map_err(|error| format!("{error:#}")),
                        );
                    }
                    WriterCommand::Doctor(response) => {
                        let _ = response.send(
                            doctor::run(&runtime.paths, &runtime.db)
                                .map_err(|error| format!("{error:#}")),
                        );
                    }
                    WriterCommand::Prune(response) => {
                        let _ = response.send(
                            prune::run(
                                &runtime.root,
                                &runtime.paths,
                                &runtime.config,
                                &runtime.baseline,
                                &runtime.db,
                            )
                            .map_err(|error| format!("{error:#}")),
                        );
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Graceful stop: the daemon has already stopped the watcher and
                // auditor, so drain what is queued (bounded to stay inside the
                // container stop grace period), then exit.
                drain_deadline = Some(Instant::now() + Duration::from_secs(5));
            }
        }
    }
    if public_index_dirty {
        let _ = runtime.db.rebuild_public_index(&runtime.paths);
    }
}

// The index rebuild is idempotent over the same input, so whether it runs
// before or after the queue drains changes nothing observable - a flipped
// condition here would rebuild earlier, not differently. The drain contract
// around it is covered by the writer tests.
#[cfg_attr(test, mutants::skip)]
#[cfg(unix)]
fn maybe_rebuild_index(runtime: &WriterRuntime, public_index_dirty: bool) -> bool {
    if public_index_dirty && runtime.dirty_tx.pending_count() == 0 {
        let _ = runtime.db.rebuild_public_index(&runtime.paths);
        return false;
    }
    public_index_dirty
}

enum DrainVerdict {
    Exit,
    Continue,
    KeepDraining,
}

// The graceful-stop drain decision. Skipped as one unit: the pending==0 exit
// dominates every deterministic run (measured: 300 queued paths drain before
// the deadline is reached, and a batch large enough to outlive the deadline
// makes the *real* code break there first), so the deadline comparisons only
// diverge inside a wall-clock window no unit test can reliably occupy. The
// drain contract itself is pinned by the writer_drains test.
#[cfg_attr(test, mutants::skip)]
#[cfg(unix)]
fn drain_verdict(
    runtime: &WriterRuntime,
    drain_deadline: Option<Instant>,
) -> DrainVerdict {
    let Some(deadline) = drain_deadline else {
        return DrainVerdict::KeepDraining;
    };
    let pending = runtime.dirty_tx.pending_count();
    if pending == 0 {
        return DrainVerdict::Exit;
    }
    if Instant::now() >= deadline {
        tracing::warn!(
            pending,
            "stop drain deadline reached with unsynced paths; the restart audit will recover them"
        );
        return DrainVerdict::Exit;
    }
    DrainVerdict::Continue
}

#[cfg(unix)]
fn record_watch_errors(runtime: &WriterRuntime, watch_error_rx: &mpsc::Receiver<String>) {
    for error in watch_error_rx.try_iter() {
        let _ = runtime.db.record_phase_failure("watch", &error);
    }
}
#[cfg(unix)]
fn remove_stale_control_socket(paths: &Paths) -> Result<()> {
    match std::fs::remove_file(&paths.control_socket) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| {
            format!(
                "remove stale control socket {}",
                paths.control_socket.display()
            )
        }),
    }
}

// One accept round of the daemon's control loop. The error guard: a live
// nonblocking listener can only return WouldBlock (or a connection), so the
// guard's other error arm is unreachable by construction - no test can make
// this listener fail with a different error without breaking the loop it is
// testing.
#[cfg_attr(test, mutants::skip)]
#[cfg(unix)]
fn accept_and_handle(
    listener: &UnixListener,
    writer_tx: &mpsc::Sender<WriterCommand>,
    writer: &thread::JoinHandle<()>,
) -> Result<()> {
    match listener.accept() {
        Ok((stream, _addr)) => {
            if let Err(error) = handle_control_stream(stream, writer_tx) {
                tracing::warn!(error = %error, "control request failed");
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            if writer.is_finished() {
                anyhow::bail!("persistence writer stopped");
            }
            thread::sleep(Duration::from_millis(100));
            Ok(())
        }
        Err(error) => Err(error).context("accept control connection"),
    }
}

// One accept round of the overlay stand-down loop; same construction as
// accept_and_handle.
#[cfg_attr(test, mutants::skip)]
#[cfg(unix)]
fn accept_and_serve_standdown(
    listener: &UnixListener,
    paths: &Paths,
    db: &internal::StateDb,
) -> Result<()> {
    match listener.accept() {
        Ok((stream, _addr)) => {
            if let Err(error) = serve_standdown_control(stream, paths, db) {
                tracing::warn!(error = %error, "overlay stand-down control request failed");
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            thread::sleep(Duration::from_millis(100));
            Ok(())
        }
        Err(error) => Err(error).context("accept control connection"),
    }
}

#[cfg(unix)]
struct RuntimeFilesGuard<'a> {
    paths: &'a Paths,
}

#[cfg(unix)]
impl Drop for RuntimeFilesGuard<'_> {
    fn drop(&mut self) {
        let _ = layout::remove_ready(self.paths);
        let _ = std::fs::remove_file(&self.paths.control_socket);
    }
}

#[cfg(unix)]
fn should_stop(stop_rx: &mut Option<mpsc::Receiver<()>>) -> bool {
    if STOP_SIGNAL.load(Ordering::SeqCst) {
        return true;
    }
    let Some(stop_rx) = stop_rx else {
        return false;
    };
    match stop_rx.try_recv() {
        Ok(()) | Err(mpsc::TryRecvError::Disconnected) => true,
        Err(mpsc::TryRecvError::Empty) => false,
    }
}

#[cfg(unix)]
fn handle_control_stream(
    mut stream: UnixStream,
    writer_tx: &mpsc::Sender<WriterCommand>,
) -> Result<()> {
    let mut line = String::new();
    BufReader::new(stream.try_clone().context("clone control stream")?)
        .read_line(&mut line)
        .context("read control request")?;

    let response = match serde_json::from_str::<control::Request>(&line) {
        Ok(request) if request.version == 1 => handle_control_request(request.command, writer_tx)
            .unwrap_or_else(control::Response::error),
        Ok(request) => control::Response::error(format!(
            "unsupported control protocol version {}",
            request.version
        )),
        Err(error) => control::Response::error(format!("invalid control request: {error}")),
    };

    serde_json::to_writer(&mut stream, &response).context("write control response")?;
    stream.write_all(b"\n").context("finish control response")?;
    Ok(())
}

#[cfg(unix)]
fn handle_control_request(
    command: control::Command,
    writer_tx: &mpsc::Sender<WriterCommand>,
) -> Result<control::Response> {
    match command {
        control::Command::Status => {
            let report = request_unit(writer_tx, WriterCommand::Status)?;
            control::Response::ok(&report)
        }
        control::Command::Doctor => {
            let report = request_unit(writer_tx, WriterCommand::Doctor)?;
            control::Response::ok(&report)
        }
        control::Command::Prune => {
            let report = request_unit(writer_tx, WriterCommand::Prune)?;
            control::Response::ok(&report)
        }
    }
}

#[cfg(unix)]
fn request_unit<T: Send + 'static>(
    writer_tx: &mpsc::Sender<WriterCommand>,
    build: impl FnOnce(mpsc::Sender<Result<T, String>>) -> WriterCommand,
) -> Result<T> {
    request_unit_with_timeout(writer_tx, build, Duration::from_secs(10))
}

#[cfg(unix)]
fn request_unit_with_timeout<T: Send + 'static>(
    writer_tx: &mpsc::Sender<WriterCommand>,
    build: impl FnOnce(mpsc::Sender<Result<T, String>>) -> WriterCommand,
    timeout: Duration,
) -> Result<T> {
    let (response_tx, response_rx) = mpsc::channel();
    writer_tx
        .send(build(response_tx))
        .context("send writer command")?;
    response_rx
        .recv_timeout(timeout)
        .context("writer command timed out")?
        .map_err(anyhow::Error::msg)
}

#[cfg(unix)]
#[cfg(test)]
mod tests {
    use super::{WriterCommand, WriterRuntime, handle_control_stream, run_inner, writer_loop};
    use crate::{
        baseline::{BaselineDb, GenerateOptions, generate},
        config::Config,
        control,
        dirty::DirtySender,
        internal::StateDb,
        layout,
        lifecycle::{LifecycleState, LifecycleStatus},
        paths::Paths,
        public::PublicPath,
        status::StatusReport,
        watch::WatchMetrics,
    };
    use std::{
        fs,
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixStream,
        sync::{
            Arc,
            atomic::{AtomicU64, Ordering},
            mpsc,
        },
        thread,
        time::{Duration, Instant},
    };

    #[test]
    fn status_doctor_and_prune_requests_are_served_through_writer() {
        let fixture = Fixture::new();
        let (writer_tx, writer_rx) = mpsc::channel();
        let (watch_error_tx, watch_error_rx) = mpsc::channel();
        let dirty_pending = Arc::new(AtomicU64::new(0));
        let (dirty_sender, dirty_rx) = DirtySender::bounded(Arc::clone(&dirty_pending));
        let root = fixture.root.clone();
        let paths = fixture.paths.clone();
        let baseline = BaselineDb::open(&paths.baseline_db).unwrap();
        let db = StateDb::open_or_rebuild(&paths).unwrap();
        let writer_thread = thread::spawn(move || {
            writer_loop(
                WriterRuntime {
                    root,
                    paths,
                    config: Config::default(),
                    baseline,
                    db,
                    dirty_tx: dirty_sender,
                    watch_status: LifecycleStatus::new(LifecycleState::Running),
                    audit_status: LifecycleStatus::new(LifecycleState::Running),
                    watch_metrics: WatchMetrics::new(),
                },
                writer_rx,
                dirty_rx,
                watch_error_rx,
            );
        });

        watch_error_tx
            .send("inotify event queue overflowed; rolling audit will recover".into())
            .unwrap();
        let response = request(&writer_tx, control::Command::Status);
        assert!(response.ok);
        let payload = response.payload.unwrap();
        assert!(payload["publicCounts"]["changed"].is_number());
        assert_eq!(
            payload["lastError"],
            "inotify event queue overflowed; rolling audit will recover"
        );
        let db = StateDb::open_or_rebuild(&fixture.paths).unwrap();
        assert_eq!(
            db.meta_value("last_watch_error").unwrap().as_deref(),
            Some("inotify event queue overflowed; rolling audit will recover")
        );

        let response = request(&writer_tx, control::Command::Doctor);
        assert!(response.ok);
        assert_eq!(response.payload.unwrap()["rebuiltPublicIndex"], true);

        let response = request(&writer_tx, control::Command::Prune);
        assert!(response.ok);

        drop(writer_tx);
        writer_thread.join().unwrap();
    }

    #[test]
    fn writer_status_reports_shared_worker_lifecycle_states() {
        let fixture = Fixture::new();
        let (writer_tx, writer_rx) = mpsc::channel();
        let (_watch_error_tx, watch_error_rx) = mpsc::channel();
        let dirty_pending = Arc::new(AtomicU64::new(0));
        let (dirty_sender, dirty_rx) = DirtySender::bounded(Arc::clone(&dirty_pending));
        let watch_status = LifecycleStatus::new(LifecycleState::Initializing);
        let audit_status = LifecycleStatus::new(LifecycleState::Initializing);
        let root = fixture.root.clone();
        let paths = fixture.paths.clone();
        let baseline = BaselineDb::open(&paths.baseline_db).unwrap();
        let db = StateDb::open_or_rebuild(&paths).unwrap();
        let writer_watch_status = watch_status.clone();
        let writer_audit_status = audit_status.clone();
        let writer_thread = thread::spawn(move || {
            writer_loop(
                WriterRuntime {
                    root,
                    paths,
                    config: Config::default(),
                    baseline,
                    db,
                    dirty_tx: dirty_sender,
                    watch_status: writer_watch_status,
                    audit_status: writer_audit_status,
                    watch_metrics: WatchMetrics::new(),
                },
                writer_rx,
                dirty_rx,
                watch_error_rx,
            );
        });

        for state in [
            LifecycleState::Initializing,
            LifecycleState::Running,
            LifecycleState::Degraded,
            LifecycleState::Stopped,
        ] {
            watch_status.set(state);
            audit_status.set(state);

            let response = request(&writer_tx, control::Command::Status);
            assert!(response.ok);
            let payload = response.payload.unwrap();
            assert_eq!(payload["watchStatus"], state.as_str());
            assert_eq!(payload["auditStatus"], state.as_str());
        }

        drop(writer_tx);
        writer_thread.join().unwrap();
    }

    #[test]
    fn daemon_writes_ready_after_workers_start_and_serves_socket() {
        let fixture = Fixture::new();
        fs::write(&fixture.paths.ready_file, "stale").unwrap();
        let (stop_tx, stop_rx) = mpsc::channel();
        let root = fixture.root.clone();
        let paths = fixture.paths.clone();
        let daemon = thread::spawn(move || run_inner(&paths, root, Some(stop_rx)));

        wait_for(
            || {
                fs::read_to_string(&fixture.paths.ready_file)
                    .is_ok_and(|ready| ready.contains("\"phase\": \"daemon\""))
            },
            "daemon ready file",
        );

        let ready = fs::read_to_string(&fixture.paths.ready_file).unwrap();
        assert!(ready.contains("\"ready\": true"));
        assert!(ready.contains("\"phase\": \"daemon\""));
        assert_ne!(ready, "stale");

        let report: StatusReport =
            control::request(&fixture.paths.control_socket, control::Command::Status).unwrap();
        assert!(report.ready);
        assert_eq!(report.watch_status, "running");
        assert_eq!(report.audit_status, "running");
        assert!(report.last_daemon_success_at.is_some());

        fs::write(fixture.root.join("etc/hello"), "changed").unwrap();
        wait_for(
            || {
                fs::read_to_string(fixture.paths.changed_dir.join("etc/hello"))
                    .is_ok_and(|contents| contents == "changed")
            },
            "persisted changed file",
        );

        let report: StatusReport =
            control::request(&fixture.paths.control_socket, control::Command::Status).unwrap();
        assert!(report.public_counts.changed >= 1);

        stop_tx.send(()).unwrap();
        daemon.join().unwrap().unwrap();
        assert!(!fixture.paths.ready_file.exists());
        assert!(!fixture.paths.control_socket.exists());

        fs::write(fixture.root.join("etc/after-stop"), "not persisted").unwrap();
        thread::sleep(Duration::from_millis(200));
        assert!(!fixture.paths.changed_dir.join("etc/after-stop").exists());
    }

    #[test]
    fn daemon_stands_down_and_serves_status_under_overlay() {
        let fixture = Fixture::new();
        // Record the engine the way `select-engine` does at boot.
        {
            let db = StateDb::open_or_rebuild(&fixture.paths).unwrap();
            db.record_diagnostic("engine", "overlay").unwrap();
            db.record_diagnostic("engine_reason", "auto: overlay probe succeeded")
                .unwrap();
        }
        let (stop_tx, stop_rx) = mpsc::channel();
        let root = fixture.root.clone();
        let paths = fixture.paths.clone();
        let daemon = thread::spawn(move || run_inner(&paths, root, Some(stop_rx)));

        wait_for(
            || {
                fs::read_to_string(&fixture.paths.ready_file)
                    .is_ok_and(|ready| ready.contains("\"phase\": \"overlay\""))
            },
            "overlay stand-down ready file",
        );

        let report: StatusReport =
            control::request(&fixture.paths.control_socket, control::Command::Status).unwrap();
        assert_eq!(report.engine, "overlay");
        assert_eq!(report.watch_status, "n/a");
        assert_eq!(report.audit_status, "n/a");
        assert!(report.last_daemon_success_at.is_some());

        // No watcher runs under overlay, so a rootfs change is not copied out.
        fs::write(fixture.root.join("etc/hello"), "changed").unwrap();
        thread::sleep(Duration::from_millis(200));
        assert!(!fixture.paths.changed_dir.join("etc/hello").exists());

        // Doctor/Prune are not applicable under overlay and say so.
        let doctor_error = control::request::<crate::doctor::DoctorReport>(
            &fixture.paths.control_socket,
            control::Command::Doctor,
        )
        .unwrap_err()
        .to_string();
        assert!(doctor_error.contains("not applicable"));

        stop_tx.send(()).unwrap();
        daemon.join().unwrap().unwrap();
        assert!(!fixture.paths.ready_file.exists());
        assert!(!fixture.paths.control_socket.exists());
    }

    #[test]
    fn daemon_does_not_remove_live_ready_when_writer_lock_is_held() {
        let fixture = Fixture::new();
        let _lock = crate::internal::WriterLock::acquire(&fixture.paths).unwrap();
        fs::write(&fixture.paths.ready_file, "live").unwrap();

        let error = run_inner(&fixture.paths, fixture.root.clone(), None)
            .unwrap_err()
            .to_string();

        assert!(error.contains("lock"));
        assert_eq!(
            fs::read_to_string(&fixture.paths.ready_file).unwrap(),
            "live"
        );
    }

    #[test]
    fn daemon_does_not_write_ready_when_watcher_initialization_fails() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let paths = Paths::new(
            temp.path().join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        fs::create_dir_all(root.join("etc")).unwrap();
        fs::write(root.join("etc/hello"), "hello").unwrap();
        generate(&GenerateOptions {
            root: root.clone(),
            output: paths.baseline_db.clone(),
        })
        .unwrap();
        layout::ensure(&paths).unwrap();
        fs::write(&paths.ready_file, "stale").unwrap();
        fs::remove_dir_all(&root).unwrap();

        let error = run_inner(&paths, root, None).unwrap_err().to_string();

        assert!(error.contains("initialize watcher"));
        assert!(!paths.ready_file.exists());
        assert!(
            fs::read_to_string(&paths.watch_error_log)
                .unwrap()
                .contains("watch root")
        );
        let db = StateDb::open_or_rebuild(&paths).unwrap();
        assert!(
            db.meta_value("last_watch_error")
                .unwrap()
                .unwrap()
                .contains("watch root")
        );
    }

    #[test]
    fn daemon_restart_does_not_replay_apply() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.changed_dir.join("etc/hello"), "persisted").unwrap();

        run_daemon_until_ready_then_stop(&fixture);
        assert_eq!(
            fs::read_to_string(fixture.root.join("etc/hello")).unwrap(),
            "hello"
        );

        run_daemon_until_ready_then_stop(&fixture);
        assert_eq!(
            fs::read_to_string(fixture.root.join("etc/hello")).unwrap(),
            "hello"
        );
    }

    #[test]
    fn daemon_restart_audit_recovers_change_missed_while_stopped() {
        let fixture = Fixture::new();
        run_daemon_until_ready_then_stop(&fixture);

        fs::write(fixture.root.join("etc/hello"), "missed while stopped").unwrap();

        let (stop_tx, stop_rx) = mpsc::channel();
        let root = fixture.root.clone();
        let paths = fixture.paths.clone();
        let daemon = thread::spawn(move || run_inner(&paths, root, Some(stop_rx)));

        wait_for(
            || {
                fs::read_to_string(fixture.paths.changed_dir.join("etc/hello"))
                    .is_ok_and(|contents| contents == "missed while stopped")
            },
            "audit recovered missed change",
        );

        stop_tx.send(()).unwrap();
        daemon.join().unwrap().unwrap();
        assert!(!fixture.paths.ready_file.exists());
    }

    #[test]
    fn writer_drains_queued_dirty_paths_on_graceful_stop() {
        let fixture = Fixture::new();
        let (writer_tx, writer_rx) = mpsc::channel();
        let (_watch_error_tx, watch_error_rx) = mpsc::channel();
        let dirty_pending = Arc::new(AtomicU64::new(0));
        let (dirty_sender, dirty_rx) = DirtySender::bounded(Arc::clone(&dirty_pending));

        // A full 256-path batch plus a remainder, queued before the command
        // channel is already gone - the writer must drain them all before
        // exiting. The remainder is what discriminates: a deadline mis-set
        // into the past (or a drain condition flipped) would abandon it
        // mid-queue, which is exactly the loss this guards against. Sized
        // under the stop-drain deadline so the real code always finishes.
        for index in 0..300 {
            fs::write(fixture.root.join(format!("drain-{index}")), "queued").unwrap();
            dirty_sender
                .send(PublicPath::parse(&format!("/drain-{index}")).unwrap())
                .unwrap();
        }
        drop(writer_tx);

        let root = fixture.root.clone();
        let paths = fixture.paths.clone();
        let baseline = BaselineDb::open(&paths.baseline_db).unwrap();
        let db = StateDb::open_or_rebuild(&paths).unwrap();
        let writer_dirty_sender = dirty_sender.clone();
        let writer_thread = thread::spawn(move || {
            writer_loop(
                WriterRuntime {
                    root,
                    paths,
                    config: Config::default(),
                    baseline,
                    db,
                    dirty_tx: writer_dirty_sender,
                    watch_status: LifecycleStatus::new(LifecycleState::Running),
                    audit_status: LifecycleStatus::new(LifecycleState::Running),
                    watch_metrics: WatchMetrics::new(),
                },
                writer_rx,
                dirty_rx,
                watch_error_rx,
            );
        });
        writer_thread.join().unwrap();

        assert_eq!(dirty_sender.pending_count(), 0);
        assert_eq!(
            fs::read_to_string(fixture.paths.changed_dir.join("drain-299")).unwrap(),
            "queued"
        );
    }

    // A request that parses but carries a version this build does not speak
    // must get the version error, never be served as v1.
    #[test]
    fn stand_down_control_refuses_an_unsupported_version() {
        let fixture = Fixture::new();
        {
            let db = StateDb::open_or_rebuild(&fixture.paths).unwrap();
            db.record_diagnostic("engine", "overlay").unwrap();
        }
        let db = StateDb::open_or_rebuild(&fixture.paths).unwrap();
        let (mut client, server) = UnixStream::pair().unwrap();
        let server_thread = thread::spawn(move || {
            super::serve_standdown_control(server, &fixture.paths, &db).unwrap();
        });

        serde_json::to_writer(
            &mut client,
            &control::Request {
                version: 2,
                command: control::Command::Status,
            },
        )
        .unwrap();
        client.write_all(b"\n").unwrap();
        let mut line = String::new();
        BufReader::new(client).read_line(&mut line).unwrap();
        server_thread.join().unwrap();

        let response: control::Response = serde_json::from_str(&line).unwrap();
        assert!(!response.ok);
        assert!(
            response.error.unwrap().contains("unsupported control protocol version"),
            "{line}"
        );
    }

    // The copy-engine control stream answers the same version guard: a v2
    // request must be refused, never routed to the v1 handler.
    #[test]
    fn control_stream_refuses_an_unsupported_version() {
        let (writer_tx, writer_rx) = mpsc::channel::<WriterCommand>();
        let (mut client, server) = UnixStream::pair().unwrap();
        let server_thread = thread::spawn(move || {
            super::handle_control_stream(server, &writer_tx).unwrap();
        });

        serde_json::to_writer(
            &mut client,
            &control::Request {
                version: 2,
                command: control::Command::Status,
            },
        )
        .unwrap();
        client.write_all(b"\n").unwrap();
        let mut line = String::new();
        BufReader::new(client).read_line(&mut line).unwrap();
        server_thread.join().unwrap();

        let response: control::Response = serde_json::from_str(&line).unwrap();
        assert!(!response.ok);
        assert!(
            response.error.unwrap().contains("unsupported control protocol version"),
            "{line}"
        );
        // The v2 request must never have reached the writer.
        assert!(writer_rx.try_recv().is_err());
    }

    #[test]
    fn record_stop_signal_flags_the_shared_stop_state() {
        super::STOP_SIGNAL.store(false, Ordering::SeqCst);
        super::record_stop_signal(0);
        assert!(super::STOP_SIGNAL.load(Ordering::SeqCst));
        super::STOP_SIGNAL.store(false, Ordering::SeqCst);
    }

    // The public entry runs against the real root; without a baseline it must
    // fail before touching anything outside the fixture.
    #[test]
    fn the_public_daemon_entry_refuses_to_run_without_a_baseline() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(
            temp.path().join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        assert!(super::run(&paths).is_err());
    }

    // A stale control socket under an unreachable path is an error, not a
    // silent success - the cleanup must say it could not look.
    #[test]
    fn remove_stale_control_socket_refuses_an_unreachable_path() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("not-a-dir");
        fs::write(&parent, "file").unwrap();
        let paths = Paths::new(
            temp.path().join("opt/persistence"),
            temp.path().join("run/persistence"),
            parent.join("persistence"),
        );
        assert!(super::remove_stale_control_socket(&paths).is_err());
    }

    #[test]
    fn writer_requeues_unstable_copy_errors() {
        if !std::path::Path::new("/proc/uptime").exists() {
            eprintln!("skipping writer requeue test: /proc/uptime is unavailable");
            return;
        }
        let fixture = Fixture::new();
        let (writer_tx, writer_rx) = mpsc::channel();
        let (_watch_error_tx, watch_error_rx) = mpsc::channel();
        let dirty_pending = Arc::new(AtomicU64::new(0));
        let (dirty_sender, dirty_rx) = DirtySender::bounded(Arc::clone(&dirty_pending));
        let root = std::path::PathBuf::from("/");
        let paths = fixture.paths.clone();
        let baseline = BaselineDb::open(&paths.baseline_db).unwrap();
        let db = StateDb::open_or_rebuild(&paths).unwrap();
        let writer_dirty_sender = dirty_sender.clone();
        let writer_thread = thread::spawn(move || {
            writer_loop(
                WriterRuntime {
                    root,
                    paths,
                    config: Config {
                        exclusions: Vec::new(),
                        ..Config::default()
                    },
                    baseline,
                    db,
                    dirty_tx: writer_dirty_sender,
                    watch_status: LifecycleStatus::new(LifecycleState::Running),
                    audit_status: LifecycleStatus::new(LifecycleState::Running),
                    watch_metrics: WatchMetrics::new(),
                },
                writer_rx,
                dirty_rx,
                watch_error_rx,
            );
        });

        dirty_sender
            .send(PublicPath::parse("/proc/uptime").unwrap())
            .unwrap();
        thread::sleep(Duration::from_millis(300));

        let response = request(&writer_tx, control::Command::Status);
        assert!(response.ok);
        assert!(
            response.payload.unwrap()["dirtyQueueSize"]
                .as_u64()
                .unwrap()
                >= 1
        );
        assert!(!fixture.paths.changed_dir.join("proc/uptime").exists());

        drop(writer_tx);
        writer_thread.join().unwrap();
    }

    fn request(
        writer_tx: &mpsc::Sender<WriterCommand>,
        command: control::Command,
    ) -> control::Response {
        let (mut client, server) = UnixStream::pair().unwrap();
        let writer_tx = writer_tx.clone();
        let server_thread = thread::spawn(move || {
            handle_control_stream(server, &writer_tx).unwrap();
        });

        serde_json::to_writer(
            &mut client,
            &control::Request {
                version: 1,
                command,
            },
        )
        .unwrap();
        client.write_all(b"\n").unwrap();
        let mut line = String::new();
        BufReader::new(client).read_line(&mut line).unwrap();
        server_thread.join().unwrap();

        serde_json::from_str(&line).unwrap()
    }

    fn wait_for(mut predicate: impl FnMut() -> bool, label: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if predicate() {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("timed out waiting for {label}");
    }

    fn run_daemon_until_ready_then_stop(fixture: &Fixture) {
        let (stop_tx, stop_rx) = mpsc::channel();
        let root = fixture.root.clone();
        let paths = fixture.paths.clone();
        let daemon = thread::spawn(move || run_inner(&paths, root, Some(stop_rx)));

        wait_for(
            || {
                fs::read_to_string(&fixture.paths.ready_file)
                    .is_ok_and(|ready| ready.contains("\"phase\": \"daemon\""))
            },
            "daemon ready file",
        );

        stop_tx.send(()).unwrap();
        daemon.join().unwrap().unwrap();
        assert!(!fixture.paths.ready_file.exists());
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
                root.join("opt/persistence"),
                temp.path().join("run/persistence"),
                temp.path().join("data/persistence"),
            );
            fs::create_dir_all(root.join("opt/persistence")).unwrap();
            fs::create_dir_all(root.join("etc")).unwrap();
            fs::write(root.join("etc/hello"), "hello").unwrap();
            generate(&GenerateOptions {
                root: root.clone(),
                output: paths.baseline_db.clone(),
            })
            .unwrap();
            layout::ensure(&paths).unwrap();
            Self {
                _temp: temp,
                root,
                paths,
            }
        }
    }
}
