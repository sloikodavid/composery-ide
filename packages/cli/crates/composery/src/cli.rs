use anyhow::Result;
use clap::Parser;
use std::sync::OnceLock;

use crate::commands;

/// What `composery --version` reports.
///
/// Read from the environment at runtime, not from `CARGO_PKG_VERSION`. The
/// product version lives in the repository's root `package.json`; the release
/// workflow derives the image tags and this variable from it, and the image sets
/// it for every process in the container. Taking it from Cargo instead would put
/// a second copy of the release number in `Cargo.toml` where nothing updates it,
/// which is how an instance came to announce one version in its editor and
/// a different one here.
///
/// Compile-time (`option_env!`) would need the version plumbed into the Rust
/// build stage, and that stage is cached by cargo-chef precisely so a source
/// change does not rebuild every dependency; feeding it a value that changes
/// every release would throw that cache away for nothing.
///
/// Outside the image there is no release, so "unknown" is the honest answer -
/// the same word the editor's update notifier uses for a build with no release
/// version, and for the same reason.
fn version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION.get_or_init(|| {
        std::env::var("COMPOSERY_BUILD_VERSION")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "unknown".to_string())
    })
}

#[derive(Debug, Parser)]
#[command(
    name = "composery",
    version = version(),
    about = "Composery control CLI",
    subcommand_required = true,
    arg_required_else_help = true,
    propagate_version = true
)]
pub struct Cli {
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    command: commands::Command,
}

pub fn run(cli: Cli) -> Result<()> {
    commands::run(cli.command, cli.json)
}

// Logs to stderr so stdout stays clean for machine-readable JSON output.
// Installing the process-global tracing subscriber is wiring: a second install
// panics, so no test can run it twice, and observing it would mean capturing
// the process's stderr around the subscriber. Every real `composery` call runs
// it. Gated to test builds: a normal build must not need the dev-only mutants
// crate.
#[cfg_attr(test, mutants::skip)]
pub fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "composery=info,persistence=info".into()),
        )
        .with_ansi(false)
        .with_writer(std::io::stderr)
        .init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands;

    // version() reads the environment once per process (OnceLock), so this one
    // test owns COMPOSERY_BUILD_VERSION and the first evaluation happens here.
    // An empty value is the discriminating case: the real code treats it as
    // missing (a blank version would be a lie), while removing the non-empty
    // filter or returning a fixed string would produce the blank or a bogus
    // value. No other test in the crate reads the variable.
    #[test]
    fn version_treats_a_blank_value_as_missing() {
        unsafe { std::env::set_var("COMPOSERY_BUILD_VERSION", "") };
        assert_eq!(version(), "unknown");
    }

    // A run that fails is the dispatch contract: run() must return the failure
    // rather than swallow it. The empty-name refusal is deterministic - it bails
    // before touching any filesystem state.
    #[test]
    fn run_propagates_command_failures() {
        let cli = Cli {
            json: false,
            command: commands::Command::Api(commands::api::ApiCommand::Key(
                commands::api::KeyCommand::Create { name: String::new() },
            )),
        };
        assert!(run(cli).is_err());
    }
}
