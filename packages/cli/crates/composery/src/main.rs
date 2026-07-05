use std::process::ExitCode;

use clap::Parser as _;

use composery::cli::Cli;

// The process entry: parses real argv and installs the global tracing
// subscriber, neither of which a unit test can construct (argv is the
// process's own; installing a second subscriber panics). Its only decision is
// delegated to exit_code, which is fully tested below, so no mutant here is
// anything but the wiring itself. The attribute is gated to test builds so a
// normal build never needs the dev-only mutants crate; cargo-mutants reads it
// because it parses the source, not the expanded macros.
#[cfg_attr(test, mutants::skip)]
fn main() -> ExitCode {
    composery::cli::init_tracing();
    exit_code(composery::cli::run(Cli::parse()))
}

fn exit_code(result: anyhow::Result<()>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) if is_broken_pipe(&error) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("composery: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn is_broken_pipe(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::BrokenPipe)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_reports_success() {
        assert_eq!(exit_code(Ok(())), ExitCode::SUCCESS);
    }

    #[test]
    fn a_broken_pipe_anywhere_in_the_chain_is_silent_success() {
        let error = anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
            .context("downstream");
        assert_eq!(exit_code(Err(error)), ExitCode::SUCCESS);
    }

    #[test]
    fn any_other_error_reports_failure() {
        let error = anyhow::anyhow!("boom");
        assert_eq!(exit_code(Err(error)), ExitCode::FAILURE);
    }

    #[test]
    fn is_broken_pipe_sees_through_the_chain() {
        let nested = anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
            .context("outer");
        assert!(is_broken_pipe(&nested));
        let plain = anyhow::anyhow!("plain");
        assert!(!is_broken_pipe(&plain));
    }

    #[test]
    fn a_non_pipe_io_error_is_not_a_broken_pipe() {
        let error = anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
        assert!(!is_broken_pipe(&error));
    }
}
