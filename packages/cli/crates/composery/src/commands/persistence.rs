use anyhow::Result;
use clap::Subcommand;

use persistence::paths::Paths;
use persistence::{boot, control, daemon, doctor, engine, prune, status};

#[cfg(unix)]
use std::path::PathBuf;

use crate::output;

#[derive(Debug, Subcommand)]
pub enum PersistenceCommand {
    /// Apply persisted public truth to the live filesystem during boot.
    Apply,
    /// Select the persistence engine for this boot (from COMPOSERY_PERSISTENCE),
    /// record it for `status`, and print it (`overlay` or `copy`). Internal boot
    /// command invoked by the entrypoint.
    #[command(name = "select-engine", hide = true)]
    SelectEngine,
    /// Prepare the overlay reserved subtree, run the boot-time upper-hygiene
    /// pass, and print the `upperdir=`/`workdir=` to mount. Internal overlay
    /// boot command invoked by `init/overlay.sh` before it mounts the overlay.
    #[cfg(unix)]
    #[command(name = "overlay-hygiene", hide = true)]
    OverlayHygiene,
    /// Run the long-lived persistence daemon.
    Daemon,
    /// Print operational daemon status.
    Status,
    /// Ask the daemon to validate and safely repair persistence state.
    Doctor,
    /// Ask the daemon to remove stale public persistence data.
    Prune,
    /// Internal image-build command. Not part of the runtime command surface.
    #[cfg(unix)]
    #[command(name = "__generate-baseline", hide = true)]
    GenerateBaseline {
        #[arg(long, default_value = "/")]
        root: PathBuf,
        #[arg(long, default_value = "/opt/persistence/baseline.sqlite")]
        output: PathBuf,
    },
}

pub fn run(command: PersistenceCommand, json: bool) -> Result<()> {
    let paths = Paths::default();
    match command {
        PersistenceCommand::Apply => boot::apply(&paths),
        PersistenceCommand::SelectEngine => {
            let selection = engine::select_and_record(&paths)?;
            println!("{}", selection.engine.as_str());
            Ok(())
        }
        #[cfg(unix)]
        PersistenceCommand::OverlayHygiene => persistence::overlay::run_hygiene_command(&paths),
        PersistenceCommand::Daemon => daemon::run(&paths),
        PersistenceCommand::Status => output::render(
            &control::query::<status::StatusReport>(&paths, control::Command::Status)?,
            json,
            status::print_human,
        ),
        PersistenceCommand::Doctor => output::render(
            &control::query::<doctor::DoctorReport>(&paths, control::Command::Doctor)?,
            json,
            doctor::print_human,
        ),
        PersistenceCommand::Prune => output::render(
            &control::query::<prune::PruneReport>(&paths, control::Command::Prune)?,
            json,
            prune::print_human,
        ),
        #[cfg(unix)]
        PersistenceCommand::GenerateBaseline { root, output } => {
            persistence::baseline::generate(&persistence::baseline::GenerateOptions {
                root,
                output,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Status talks to the running daemon over its control socket; with no
    // daemon, the query must fail rather than report a healthy state. The
    // socket path is the default, which no test daemon occupies.
    #[test]
    fn status_fails_loudly_without_a_daemon() {
        assert!(run(PersistenceCommand::Status, false).is_err());
    }
}
