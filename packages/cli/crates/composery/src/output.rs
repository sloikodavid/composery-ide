use anyhow::Result;
use serde::Serialize;

pub fn render<T: Serialize>(report: &T, json: bool, human: impl FnOnce(&T)) -> Result<()> {
    if json {
        serde_json::to_writer_pretty(std::io::stdout(), report)?;
        println!();
    } else {
        human(report);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;

    #[derive(Serialize)]
    struct Report {
        value: u32,
    }

    // The branch decision is what is unit-testable here; the actual printing
    // happens on the process's stdout, which the test harness intercepts
    // before any test runs, so the print side is proven by the subprocess
    // integration tests in tests/cli.rs.
    #[test]
    fn json_mode_never_calls_the_human_printer() {
        let mut called = false;
        render(&Report { value: 7 }, true, |_| called = true).unwrap();
        assert!(!called);
    }

    #[test]
    fn human_mode_calls_the_printer() {
        let mut called = false;
        render(&Report { value: 7 }, false, |_| called = true).unwrap();
        assert!(called);
    }
}
