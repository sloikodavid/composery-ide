use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::{
    baseline::BaselineDb, capabilities::CapabilityReport, internal::StateDb, paths::Paths,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub ready: bool,
    pub phase: String,
    /// The persistence engine this boot selected (`overlay` | `copy`), and why.
    /// Recorded at boot by `engine::select_and_record` so an operator can always
    /// see which engine is live and the probe outcome that chose it - never
    /// ambiguous. `unknown` means selection has not run yet.
    pub engine: String,
    pub engine_reason: Option<String>,
    pub last_apply_success_at: Option<String>,
    pub last_apply_failure_at: Option<String>,
    pub last_apply_error: Option<String>,
    pub last_daemon_success_at: Option<String>,
    pub last_daemon_failure_at: Option<String>,
    pub last_daemon_error: Option<String>,
    pub watch_status: String,
    pub audit_status: String,
    /// Live inotify directory watches, the configured budget, cumulative
    /// budget evictions, and whether the watcher has shed to audit-only under
    /// dirty-queue pressure. When `watches_shed` is true or `watch_status` is
    /// `degraded`, `last_error` carries the reason.
    pub watch_count: u64,
    pub watch_budget: u64,
    pub watch_evictions: u64,
    pub watches_shed: bool,
    pub last_error: Option<String>,
    pub baseline_present: bool,
    pub baseline_valid: bool,
    pub capabilities: Option<CapabilityReport>,
    pub dirty_queue_size: u64,
    pub public_counts: PublicCounts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicCounts {
    pub changed: u64,
    pub removed: u64,
    pub metadata: u64,
}

pub fn build(paths: &Paths, db: &StateDb) -> Result<StatusReport> {
    build_with_runtime(paths, db, RuntimeStatus::default())
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeStatus {
    pub dirty_queue_size: u64,
    pub watch_status: Option<String>,
    pub audit_status: Option<String>,
    pub watch_count: u64,
    pub watch_budget: u64,
    pub watch_evictions: u64,
    pub watches_shed: bool,
}

pub fn build_with_runtime(
    paths: &Paths,
    db: &StateDb,
    runtime: RuntimeStatus,
) -> Result<StatusReport> {
    let ready = ready_file_exists(paths);
    let baseline_present = paths.baseline_db.exists();
    let baseline_valid = baseline_present && BaselineDb::open(&paths.baseline_db).is_ok();
    let last_error = db
        .meta_value("last_error")?
        .filter(|value| !value.is_empty());
    let capabilities = db
        .meta_value("diagnostic_capabilities")?
        .and_then(|value| serde_json::from_str(&value).ok());
    let watch_status = match runtime.watch_status {
        Some(status) => status,
        None => db
            .meta_value("diagnostic_watch_status")?
            .unwrap_or_else(|| "unknown".into()),
    };
    let audit_status = match runtime.audit_status {
        Some(status) => status,
        None => db
            .meta_value("diagnostic_audit_status")?
            .unwrap_or_else(|| "unknown".into()),
    };
    let engine = db
        .meta_value("diagnostic_engine")?
        .unwrap_or_else(|| "unknown".into());
    let engine_reason = db
        .meta_value("diagnostic_engine_reason")?
        .filter(|value| !value.is_empty());
    Ok(StatusReport {
        ready,
        phase: if ready {
            "ready".into()
        } else {
            "starting".into()
        },
        engine,
        engine_reason,
        last_apply_success_at: db.meta_value("last_apply_success_at")?,
        last_apply_failure_at: db.meta_value("last_apply_failure_at")?,
        last_apply_error: db
            .meta_value("last_apply_error")?
            .filter(|value| !value.is_empty()),
        last_daemon_success_at: db.meta_value("last_daemon_success_at")?,
        last_daemon_failure_at: db.meta_value("last_daemon_failure_at")?,
        last_daemon_error: db
            .meta_value("last_daemon_error")?
            .filter(|value| !value.is_empty()),
        watch_status,
        audit_status,
        watch_count: runtime.watch_count,
        watch_budget: runtime.watch_budget,
        watch_evictions: runtime.watch_evictions,
        watches_shed: runtime.watches_shed,
        last_error,
        baseline_present,
        baseline_valid,
        capabilities,
        dirty_queue_size: runtime.dirty_queue_size,
        public_counts: PublicCounts {
            changed: db.public_count("changed")?,
            removed: db.public_count("removed")?,
            metadata: db.metadata_record_count()?,
        },
    })
}

/// Status for a daemon standing down under the overlay engine: the kernel owns
/// the delta, so the copy watcher/audit/apply machinery never ran and its
/// counters do not apply. The copy-only fields stay zero in the struct but are
/// rendered as `n/a` (see `print_human`) so they can never read as a healthy
/// idle daemon; the machine-readable discriminator is `engine == "overlay"`
/// with `watchStatus`/`auditStatus` == `"n/a"`.
pub fn build_standing_down(paths: &Paths, db: &StateDb) -> Result<StatusReport> {
    let ready = ready_file_exists(paths);
    let baseline_present = paths.baseline_db.exists();
    let baseline_valid = baseline_present && BaselineDb::open(&paths.baseline_db).is_ok();
    let engine = db
        .meta_value("diagnostic_engine")?
        .unwrap_or_else(|| "unknown".into());
    let engine_reason = db
        .meta_value("diagnostic_engine_reason")?
        .filter(|value| !value.is_empty());
    Ok(StatusReport {
        ready,
        phase: if ready {
            "standing-down".into()
        } else {
            "starting".into()
        },
        engine,
        engine_reason,
        last_apply_success_at: None,
        last_apply_failure_at: None,
        last_apply_error: None,
        last_daemon_success_at: db.meta_value("last_daemon_success_at")?,
        last_daemon_failure_at: db.meta_value("last_daemon_failure_at")?,
        last_daemon_error: db
            .meta_value("last_daemon_error")?
            .filter(|value| !value.is_empty()),
        watch_status: "n/a".into(),
        audit_status: "n/a".into(),
        watch_count: 0,
        watch_budget: 0,
        watch_evictions: 0,
        watches_shed: false,
        last_error: None,
        baseline_present,
        baseline_valid,
        capabilities: None,
        dirty_queue_size: 0,
        public_counts: PublicCounts {
            changed: 0,
            removed: 0,
            metadata: 0,
        },
    })
}

fn ready_file_exists(paths: &Paths) -> bool {
    std::fs::symlink_metadata(&paths.ready_file)
        .is_ok_and(|metadata| metadata.file_type().is_file())
}

// The human render is `human_report`, covered by tests and the doc example;
// this wrapper only pushes it to the process's stdout, which the test harness
// intercepts before any test runs.
#[cfg_attr(test, mutants::skip)]
pub fn print_human(report: &StatusReport) {
    print!("{}", human_report(report));
}


/// Build the human status text. Split out from `print_human` so tests assert on
/// the real rendering (and the overlay stand-down branch in particular) rather
/// than a copy of the logic.
///
/// ```
/// use persistence::status::{PublicCounts, StatusReport, human_report};
///
/// let report = StatusReport {
///     ready: true,
///     phase: "ready".into(),
///     engine: "copy".into(),
///     engine_reason: Some("overlay probe unavailable".into()),
///     last_apply_success_at: None,
///     last_apply_failure_at: None,
///     last_apply_error: None,
///     last_daemon_success_at: None,
///     last_daemon_failure_at: None,
///     last_daemon_error: None,
///     watch_status: "active".into(),
///     audit_status: "idle".into(),
///     watch_count: 12,
///     watch_budget: 64,
///     watch_evictions: 2,
///     watches_shed: false,
///     last_error: None,
///     baseline_present: true,
///     baseline_valid: true,
///     capabilities: None,
///     dirty_queue_size: 3,
///     public_counts: PublicCounts {
///         changed: 4,
///         removed: 1,
///         metadata: 2,
///     },
/// };
///
/// assert_eq!(
///     human_report(&report),
///     concat!(
///         "persistence status:\n",
///         "  ready: true\n",
///         "  phase: ready\n",
///         "  engine: copy\n",
///         "  engineReason: overlay probe unavailable\n",
///         "  baseline: true\n",
///         "  baselineValid: true\n",
///         "  watch: active\n",
///         "  audit: idle\n",
///         "  watches: 12 / 64\n",
///         "  watchEvictions: 2\n",
///         "  watchesShed: false\n",
///         "  dirtyQueueSize: 3\n",
///         "  changed: 4\n",
///         "  removed: 1\n",
///         "  metadata: 2\n",
///     )
/// );
/// ```
pub fn human_report(report: &StatusReport) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    let _ = writeln!(out, "persistence status:");
    let _ = writeln!(out, "  ready: {}", report.ready);
    let _ = writeln!(out, "  phase: {}", report.phase);
    let _ = writeln!(out, "  engine: {}", report.engine);
    if let Some(reason) = &report.engine_reason {
        let _ = writeln!(out, "  engineReason: {reason}");
    }
    let _ = writeln!(out, "  baseline: {}", report.baseline_present);
    let _ = writeln!(out, "  baselineValid: {}", report.baseline_valid);
    let daemon_lines = |out: &mut String| {
        if let Some(last_daemon) = &report.last_daemon_success_at {
            let _ = writeln!(out, "  lastDaemonSuccessAt: {last_daemon}");
        }
        if let Some(last_daemon_failure) = &report.last_daemon_failure_at {
            let _ = writeln!(out, "  lastDaemonFailureAt: {last_daemon_failure}");
        }
        if let Some(last_daemon_error) = &report.last_daemon_error {
            let _ = writeln!(out, "  lastDaemonError: {last_daemon_error}");
        }
    };
    if report.engine == "overlay" {
        // The kernel maintains the delta under overlay, so the copy daemon's
        // watcher/audit/apply counters do not apply. Render them as `n/a`, never
        // as zeros that would read like a healthy idle daemon.
        let _ = writeln!(
            out,
            "  copyDaemon: standing down (overlay engine; the kernel maintains the delta)"
        );
        let _ = writeln!(out, "  watch: n/a");
        let _ = writeln!(out, "  audit: n/a");
        let _ = writeln!(out, "  changed: n/a");
        let _ = writeln!(out, "  removed: n/a");
        let _ = writeln!(out, "  metadata: n/a");
        daemon_lines(&mut out);
        return out;
    }
    let _ = writeln!(out, "  watch: {}", report.watch_status);
    let _ = writeln!(out, "  audit: {}", report.audit_status);
    let _ = writeln!(
        out,
        "  watches: {} / {}",
        report.watch_count, report.watch_budget
    );
    let _ = writeln!(out, "  watchEvictions: {}", report.watch_evictions);
    let _ = writeln!(out, "  watchesShed: {}", report.watches_shed);
    let _ = writeln!(out, "  dirtyQueueSize: {}", report.dirty_queue_size);
    let _ = writeln!(out, "  changed: {}", report.public_counts.changed);
    let _ = writeln!(out, "  removed: {}", report.public_counts.removed);
    let _ = writeln!(out, "  metadata: {}", report.public_counts.metadata);
    if let Some(last_apply) = &report.last_apply_success_at {
        let _ = writeln!(out, "  lastApplySuccessAt: {last_apply}");
    }
    if let Some(last_apply_failure) = &report.last_apply_failure_at {
        let _ = writeln!(out, "  lastApplyFailureAt: {last_apply_failure}");
    }
    if let Some(last_apply_error) = &report.last_apply_error {
        let _ = writeln!(out, "  lastApplyError: {last_apply_error}");
    }
    daemon_lines(&mut out);
    out
}

#[cfg(all(test, unix))]
mod tests {
    use super::{RuntimeStatus, build_standing_down, build_with_runtime};
    use crate::{
        baseline::{GenerateOptions, generate},
        capabilities, internal, layout,
        paths::Paths,
        readiness,
    };
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn status_reports_runtime_diagnostics_errors_and_cached_counts() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.changed_dir.join("etc/hello"), "changed").unwrap();
        readiness::write_ready(&fixture.paths, "daemon").unwrap();
        let db = internal::StateDb::open_or_rebuild(&fixture.paths).unwrap();
        db.record_phase_failure("apply", "boom").unwrap();
        let capabilities = capabilities::probe(&fixture.paths.data_dir).unwrap();
        db.record_diagnostic(
            "capabilities",
            &serde_json::to_string(&capabilities).unwrap(),
        )
        .unwrap();
        db.record_diagnostic("engine", "overlay").unwrap();
        db.record_diagnostic("engine_reason", "auto: overlay probe succeeded")
            .unwrap();
        db.rebuild_public_index(&fixture.paths).unwrap();

        let report = build_with_runtime(
            &fixture.paths,
            &db,
            RuntimeStatus {
                dirty_queue_size: 7,
                watch_status: Some("degraded".into()),
                audit_status: Some("running".into()),
                watch_count: 5,
                watch_budget: 8192,
                watch_evictions: 3,
                watches_shed: true,
            },
        )
        .unwrap();

        assert!(report.ready);
        assert_eq!(report.phase, "ready");
        assert_eq!(report.last_error.as_deref(), Some("boom"));
        assert!(report.last_apply_failure_at.is_some());
        assert_eq!(report.last_apply_error.as_deref(), Some("boom"));
        assert_eq!(report.watch_status, "degraded");
        assert_eq!(report.audit_status, "running");
        assert_eq!(report.watch_count, 5);
        assert_eq!(report.watch_budget, 8192);
        assert_eq!(report.watch_evictions, 3);
        assert!(report.watches_shed);
        assert_eq!(report.dirty_queue_size, 7);
        assert_eq!(report.public_counts.changed, 2);
        assert!(report.baseline_valid);
        assert_eq!(report.capabilities, Some(capabilities));
        assert_eq!(report.engine, "overlay");
        assert_eq!(
            report.engine_reason.as_deref(),
            Some("auto: overlay probe succeeded")
        );
    }

    #[test]
    fn status_does_not_treat_ready_symlink_as_ready() {
        let fixture = Fixture::new();
        let outside = fixture._temp.path().join("outside-ready");
        fs::write(&outside, "ready").unwrap();
        symlink(&outside, &fixture.paths.ready_file).unwrap();
        let db = internal::StateDb::open_or_rebuild(&fixture.paths).unwrap();

        let report = build_with_runtime(&fixture.paths, &db, RuntimeStatus::default()).unwrap();

        assert!(!report.ready);
        assert_eq!(report.phase, "starting");
        // Selection has not run in this fixture, so the engine is honestly
        // unknown rather than a silent default.
        assert_eq!(report.engine, "unknown");
        assert_eq!(report.engine_reason, None);
    }

    #[test]
    fn standing_down_marks_copy_only_fields_not_applicable() {
        let fixture = Fixture::new();
        readiness::write_ready(&fixture.paths, "overlay").unwrap();
        let db = internal::StateDb::open_or_rebuild(&fixture.paths).unwrap();
        db.record_diagnostic("engine", "overlay").unwrap();
        db.record_diagnostic("engine_reason", "auto: overlay probe succeeded")
            .unwrap();
        db.record_phase_success("daemon").unwrap();

        let report = build_standing_down(&fixture.paths, &db).unwrap();

        assert_eq!(report.engine, "overlay");
        assert_eq!(report.phase, "standing-down");
        // Copy-only status is honestly n/a, never "running".
        assert_eq!(report.watch_status, "n/a");
        assert_eq!(report.audit_status, "n/a");
        assert!(report.last_daemon_success_at.is_some());

        // The real human render never prints copy counters as zeros here.
        let rendered = super::human_report(&report);
        assert!(rendered.contains("engine: overlay"));
        assert!(rendered.contains("standing down"));
        assert!(rendered.contains("changed: n/a"));
        assert!(!rendered.contains("changed: 0"));
        assert!(!rendered.contains("watch: running"));
    }

    // A baseline that exists but cannot be opened is present-but-invalid, and
    // must never read as valid - that state is what a repair looks for.
    #[test]
    fn an_unreadable_baseline_is_present_but_invalid() {
        let fixture = Fixture::new();
        fs::write(&fixture.paths.baseline_db, "garbage").unwrap();
        let db = internal::StateDb::open_or_rebuild(&fixture.paths).unwrap();

        let report = build_with_runtime(&fixture.paths, &db, RuntimeStatus::default()).unwrap();
        assert!(report.baseline_present);
        assert!(!report.baseline_valid);

        let standing = build_standing_down(&fixture.paths, &db).unwrap();
        assert!(standing.baseline_present);
        assert!(!standing.baseline_valid);
    }

    // An empty stored marker is the same as no marker: an empty error string
    // would otherwise render as an error with nothing to say.
    #[test]
    fn empty_markers_render_as_absent() {
        let fixture = Fixture::new();
        let db = internal::StateDb::open_or_rebuild(&fixture.paths).unwrap();
        db.record_diagnostic("last_error", "").unwrap();
        db.record_diagnostic("last_daemon_error", "").unwrap();
        db.record_diagnostic("engine_reason", "").unwrap();

        let report = build_with_runtime(&fixture.paths, &db, RuntimeStatus::default()).unwrap();
        assert_eq!(report.last_error, None);
        assert_eq!(report.last_daemon_error, None);

        let standing = build_standing_down(&fixture.paths, &db).unwrap();
        assert_eq!(standing.engine_reason, None);
        assert_eq!(standing.last_daemon_error, None);
    }

    struct Fixture {
        _temp: tempfile::TempDir,
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
                root,
                output: paths.baseline_db.clone(),
            })
            .unwrap();
            layout::ensure(&paths).unwrap();
            Self { _temp: temp, paths }
        }
    }
}
