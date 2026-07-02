//! Persistence engine selection.
//!
//! Two engines satisfy one contract (see `docs/persistence.md`):
//!
//! - **overlay** (preferred where available): the kernel maintains the rootfs
//!   delta via an overlayfs whose upper lives on the `/data` volume. Needs
//!   `CAP_SYS_ADMIN` (privileged containers: Composery Cloud, the systemd
//!   compose templates, VPS/self-hosted-on-your-own-host).
//! - **copy** (universal floor): the userspace watcher/audit/apply daemon. The
//!   only engine that works on managed PaaS that cannot grant privileges. Not
//!   legacy - first-class.
//!
//! Selection mirrors `COMPOSERY_INIT`: `auto` (default) probes by *doing* and
//! picks; `overlay`/`copy` pin explicitly; an unknown value is rejected by the
//! entrypoint with exit 64 before we are called.

use std::path::Path;

use anyhow::{Context, Result, bail};

use crate::{internal::StateDb, layout, paths::Paths};

/// Whether the overlay engine's boot path (mount / pivot / upper-hygiene in
/// `init/overlay.sh`, the daemon stand-down, the hygiene pass) is finished and
/// **proven end to end on a booted container**.
///
/// `true`: `tests/system/overlay/run.sh` boots real privileged containers on the
/// real `rootfs/` tree and a real `composery` binary, and shows systemd as PID 1
/// on an overlay root, files surviving a recreate, an image upgrade landing over
/// a live upper, the hygiene pass reconciling a stale whiteout while keeping a
/// valid one, DNS resolving after the pivot, and an unprivileged host falling
/// back to copy while an explicit `overlay` pin fails loudly.
///
/// That harness is what this constant answers to. Flipping it is the last step
/// of the verification, never a prerequisite for it: while it was `false`, `auto`
/// could not select overlay and an explicit pin refused, so no unproven mount
/// path could reach a real delta. Turn it back off if the harness ever goes red.
///
/// Conditions the harness does not cover, so `auto`'s probe is what decides
/// there rather than any claim made here: hosts with SELinux enforcing, Fly.io
/// microVMs, and a volume filesystem without xattr support. Each would fail the
/// probe and fall back to copy, which is the safe direction.
///
/// ponytail: single engine gate, deliberately a `const` not a config knob.
pub const OVERLAY_ENGINE_READY: bool = true;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Overlay,
    Copy,
}

impl Engine {
    pub fn as_str(self) -> &'static str {
        match self {
            Engine::Overlay => "overlay",
            Engine::Copy => "copy",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Request {
    Auto,
    Overlay,
    Copy,
}

impl Request {
    /// Parse `COMPOSERY_PERSISTENCE`. Empty/unset is `auto`. An unknown value is
    /// an error: the entrypoint rejects it with exit 64 before calling us, and
    /// we refuse it too rather than silently defaulting.
    pub fn parse(raw: Option<&str>) -> Result<Self> {
        match raw.map(str::trim).unwrap_or("") {
            "" | "auto" => Ok(Request::Auto),
            "overlay" => Ok(Request::Overlay),
            "copy" => Ok(Request::Copy),
            other => bail!(
                "unsupported COMPOSERY_PERSISTENCE {other:?} (expected \"auto\", \"overlay\", or \"copy\")"
            ),
        }
    }

    pub fn from_env() -> Result<Self> {
        Self::parse(std::env::var("COMPOSERY_PERSISTENCE").ok().as_deref())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    pub engine: Engine,
    pub reason: String,
}

/// Decide the engine. Pure and probe-injected so the whole matrix is testable
/// without a privileged mount: pass the readiness flag and the probe outcome
/// directly.
///
/// - `copy`: always honoured.
/// - `overlay`: fails loudly when the engine is not ready or the probe fails -
///   never a silent downgrade to copy.
/// - `auto`: overlay on a successful probe (once ready), otherwise copy, always
///   with the reason recorded so the choice is never ambiguous.
pub fn select(
    request: Request,
    overlay_ready: bool,
    probe: impl FnOnce() -> Result<()>,
) -> Result<Selection> {
    match request {
        Request::Copy => Ok(Selection {
            engine: Engine::Copy,
            reason: "COMPOSERY_PERSISTENCE=copy".into(),
        }),
        Request::Overlay => {
            if !overlay_ready {
                bail!(
                    "COMPOSERY_PERSISTENCE=overlay was requested but the overlay engine is not available in this build; unset COMPOSERY_PERSISTENCE (auto) or set it to copy"
                );
            }
            probe().context(
                "COMPOSERY_PERSISTENCE=overlay was requested but the overlay probe failed",
            )?;
            Ok(Selection {
                engine: Engine::Overlay,
                reason: "COMPOSERY_PERSISTENCE=overlay; overlay probe succeeded".into(),
            })
        }
        Request::Auto => {
            if !overlay_ready {
                return Ok(Selection {
                    engine: Engine::Copy,
                    reason: "auto: overlay engine not yet available in this build".into(),
                });
            }
            match probe() {
                Ok(()) => Ok(Selection {
                    engine: Engine::Overlay,
                    reason: "auto: overlay probe succeeded".into(),
                }),
                Err(error) => Ok(Selection {
                    engine: Engine::Copy,
                    reason: format!("auto: overlay probe failed ({error:#}); using copy"),
                }),
            }
        }
    }
}

/// Select the engine from the environment, probing the real `/data` volume,
/// then record the choice and reason where `persistence status` can report it
/// and return the selection for the entrypoint. Silent or ambiguous engine
/// selection is unacceptable, so the reason is always persisted and logged.
pub fn select_and_record(paths: &Paths) -> Result<Selection> {
    let request = Request::from_env()?;
    let selection = select(request, OVERLAY_ENGINE_READY, || {
        probe_overlay(&paths.data_dir)
    })?;
    layout::ensure(paths)?;
    let db = StateDb::open_or_rebuild(paths)?;
    db.record_diagnostic("engine", selection.engine.as_str())?;
    db.record_diagnostic("engine_reason", &selection.reason)?;
    tracing::info!(
        engine = selection.engine.as_str(),
        reason = %selection.reason,
        "persistence engine selected"
    );
    Ok(selection)
}

/// Probe overlay support by *doing* it: mount a throwaway overlayfs whose upper
/// and work dirs sit on the real `/data` volume (per the spike, a `/tmp` probe
/// would test the wrong filesystem's xattr support), then unmount and clean up.
/// Returns the real failure - `EPERM` at `mount()` when unprivileged - so an
/// explicit `overlay` pin can surface it. The full boot then rebuilds the same
/// overlay for real in `init/overlay.sh`; this only decides the engine.
///
/// Skipped by cargo-mutants: the outcome is a real `mount(2)` syscall whose
/// success depends on host privileges, so a unit test can only assert one
/// environment's verdict. The decision logic that calls it (`select`) is fully
/// covered; the mount itself is proven by `tests/system/overlay/run.sh` on real
/// privileged containers.
#[cfg_attr(test, mutants::skip)]
#[cfg(target_os = "linux")]
pub fn probe_overlay(volume_dir: &Path) -> Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let probe_root = volume_dir.join(".internal/overlay-probe");
    let _ = std::fs::remove_dir_all(&probe_root);
    for sub in ["lower", "upper", "work", "merged"] {
        let dir = probe_root.join(sub);
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("create overlay probe dir {}", dir.display()))?;
    }

    // ponytail: the volume root is ASCII (`/data`), so `display()` in the mount
    // options is fine here; the real engine builds these from bytes.
    let options = format!(
        "lowerdir={},upperdir={},workdir={}",
        probe_root.join("lower").display(),
        probe_root.join("upper").display(),
        probe_root.join("work").display()
    );
    let merged = probe_root.join("merged");
    let source = CString::new("overlay").expect("static string has no NUL");
    let fstype = CString::new("overlay").expect("static string has no NUL");
    let target = CString::new(merged.as_os_str().as_bytes()).context("probe path contains NUL")?;
    let data = CString::new(options).context("probe options contain NUL")?;

    let mounted = unsafe {
        libc::mount(
            source.as_ptr(),
            target.as_ptr(),
            fstype.as_ptr(),
            0,
            data.as_ptr() as *const libc::c_void,
        )
    };
    let result = if mounted == 0 {
        let unmounted = unsafe { libc::umount2(target.as_ptr(), libc::MNT_DETACH) };
        if unmounted == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error()).context("unmount overlay probe")
        }
    } else {
        Err(std::io::Error::last_os_error()).context("overlay mount probe on the data volume")
    };
    let _ = std::fs::remove_dir_all(&probe_root);
    result
}

#[cfg(not(target_os = "linux"))]
#[cfg_attr(test, mutants::skip)]
pub fn probe_overlay(_volume_dir: &Path) -> Result<()> {
    anyhow::bail!("the overlay engine is only supported on Linux");
}#[cfg(test)]
mod tests {
    use super::{Engine, OVERLAY_ENGINE_READY, Request, select};
    use std::cell::Cell;

    #[test]
    fn auto_uses_copy_and_skips_the_probe_until_overlay_is_ready() {
        let probed = Cell::new(false);
        let selection = select(Request::Auto, false, || {
            probed.set(true);
            Ok(())
        })
        .unwrap();
        assert_eq!(selection.engine, Engine::Copy);
        assert!(selection.reason.contains("not yet available"));
        assert!(
            !probed.get(),
            "auto must not probe while overlay is unready"
        );
    }

    #[test]
    fn auto_picks_overlay_on_a_successful_probe_and_copy_on_failure() {
        let overlay = select(Request::Auto, true, || Ok(())).unwrap();
        assert_eq!(overlay.engine, Engine::Overlay);
        assert!(overlay.reason.contains("probe succeeded"));

        let fallback = select(Request::Auto, true, || anyhow::bail!("EPERM at fsopen")).unwrap();
        assert_eq!(fallback.engine, Engine::Copy);
        assert!(fallback.reason.contains("EPERM at fsopen"));
        assert!(fallback.reason.contains("using copy"));
    }

    #[test]
    fn explicit_overlay_fails_loudly_when_unavailable_never_downgrades() {
        // Engine not ready in this build: refuse rather than silently use copy.
        let not_ready = select(Request::Overlay, false, || Ok(()))
            .unwrap_err()
            .to_string();
        assert!(not_ready.contains("not available in this build"));

        // Ready but the probe fails (unprivileged host): surface the real cause.
        // `{:#}` is how the CLI prints the error chain, so the probe's reason
        // reaches the operator rather than only the top-level context.
        let probe_failed = format!(
            "{:#}",
            select(Request::Overlay, true, || anyhow::bail!("EPERM at fsopen")).unwrap_err()
        );
        assert!(probe_failed.contains("overlay probe failed"));
        assert!(probe_failed.contains("EPERM at fsopen"));

        // Ready and probe succeeds: overlay.
        let ok = select(Request::Overlay, true, || Ok(())).unwrap();
        assert_eq!(ok.engine, Engine::Overlay);
    }

    #[test]
    fn engine_names_are_the_machine_readable_contract() {
        assert_eq!(Engine::Overlay.as_str(), "overlay");
        assert_eq!(Engine::Copy.as_str(), "copy");
    }

    #[test]
    fn this_build_ships_with_the_overlay_engine_ready() {        // `tests/system/overlay/run.sh` proves the engine on a booted container,
        // so the shipped constant is on: `auto` probes, a successful probe gives
        // overlay, a failing one still falls back to copy. Both run through the
        // real constant, so turning the gate back off flips both outcomes and
        // fails here rather than quietly changing which engine instances run.
        let overlay = select(Request::Auto, OVERLAY_ENGINE_READY, || Ok(())).unwrap();
        assert_eq!(overlay.engine, Engine::Overlay);
        assert!(overlay.reason.contains("probe succeeded"));

        let fallback = select(Request::Auto, OVERLAY_ENGINE_READY, || {
            anyhow::bail!("EPERM")
        })
        .unwrap();
        assert_eq!(fallback.engine, Engine::Copy);
        assert!(fallback.reason.contains("using copy"));
    }
}
