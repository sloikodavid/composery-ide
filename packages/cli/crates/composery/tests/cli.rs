//! The binary's process contract, proven by running it.
//!
//! The unit tests in src/ cannot observe what a command prints: the test
//! harness intercepts the process's stdout and stderr before any test runs,
//! so a printer could be broken and every unit test would still pass. Spawning
//! the real binary gives it a real stdout, which is the only honest place to
//! assert the human tables, the JSON mode, and the failing exit path.

use std::path::PathBuf;
use std::process::Command;

fn composery(volume: &PathBuf) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_composery"));
    command.env("COMPOSERY_DOCKER_VOLUME_PATH", volume);
    command
}

#[test]
fn api_key_list_of_nothing_prints_guidance() {
    let volume = tempfile::tempdir().unwrap().into_path();
    let output = composery(&volume)
        .args(["api", "key", "list"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output.status);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("No API keys"),
        "stdout was: {stdout}"
    );
}

#[test]
fn api_key_list_prints_the_table_after_a_create() {
    let volume = tempfile::tempdir().unwrap().into_path();
    let created = composery(&volume)
        .args(["api", "key", "create", "--name", "ci"])
        .output()
        .unwrap();
    assert!(created.status.success(), "{:?}", created.status);

    let listed = composery(&volume)
        .args(["api", "key", "list"])
        .output()
        .unwrap();
    assert!(listed.status.success(), "{:?}", listed.status);
    let stdout = String::from_utf8_lossy(&listed.stdout);
    assert!(stdout.contains("ID"), "table header missing: {stdout}");
    assert!(stdout.contains("ci"), "key name missing: {stdout}");
    assert!(
        stdout.contains("2026-"),
        "the creation date should render in the table: {stdout}"
    );
}

#[test]
fn json_mode_emits_the_report_as_json() {
    let volume = tempfile::tempdir().unwrap().into_path();
    let created = composery(&volume)
        .args(["api", "key", "create", "--name", "ci", "--json"])
        .output()
        .unwrap();
    assert!(created.status.success(), "{:?}", created.status);
    let stdout = String::from_utf8_lossy(&created.stdout);
    let report: serde_json::Value = serde_json::from_str(stdout.trim()).expect("valid JSON");
    assert_eq!(report["name"], "ci");
    assert!(report["secret"].as_str().unwrap().starts_with("composery_"));
}

#[test]
fn a_failing_command_reports_on_stderr_and_exits_nonzero() {
    let volume = tempfile::tempdir().unwrap().into_path();
    let output = composery(&volume)
        .args(["api", "key", "create", "--name", ""])
        .output()
        .unwrap();
    assert!(!output.status.success(), "empty name must fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("composery:"),
        "the error prefix is missing from stderr: {stderr}"
    );
    assert!(
        stderr.contains("key name must not be empty"),
        "the cause is missing from stderr: {stderr}"
    );
}
