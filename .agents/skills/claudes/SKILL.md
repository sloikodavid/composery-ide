---
name: claudes
description: Operate non-standard Claude CLI subagents via the `claude -p` method reliably. Use when dealing with non-standard `claude -p` agents or recovering a previous non-standard Claude subagent run.
---

# Run Claude CLI subagents

Delegate work to Claude CLI subagents without assuming a particular operating system, shell, installation path, account layout, model default, or process supervisor.

## Discover the environment

1. Locate the `claude` executable using the host's normal command-discovery mechanism.
2. Inspect `claude --help` before relying on flags that may vary by version.
3. Check authentication for the active profile. If multiple profiles are configured, discover them from user-provided configuration or environment variables; never invent profile names or paths.
4. Run a cheap probe before committing a profile to a long task.

Treat an authentication failure across every profile as a possible invocation, quoting, or environment problem before concluding that every account is logged out.

## Launch

- Pin the model and effort explicitly when the installed CLI supports those options. Do not rely on profile defaults for important work.
- Avoid silent fallback models unless the user explicitly accepts downgrades.
- Deliver substantial prompts through standard input or a prompt file. This avoids platform-specific argument parsing and quoting corruption.
- Request structured output when available and inspect the reported model usage after completion.
- Run long jobs through a host-native detached process mechanism that survives the orchestrator turn. Capture standard output, standard error, and a stable process identifier.
- Use non-interactive execution only within the permissions the user granted.

Do not hard-code one shell's redirection or process syntax into a cross-platform workflow. Select the mechanism appropriate to the detected host and shell.

## Monitor

- Track the exact process identifier or supervisor handle, not a process-name search that can match the orchestrator itself.
- Record the process identifier, working directory, profile, prompt artifact, result path, and error path together.
- Treat process exit with an empty result as inconclusive for a short grace period because buffered output may flush during shutdown.
- Report process disappearance, malformed structured output, and nonzero exit status explicitly. Silence is not success.

## Handle limits and resume

- Read structured error fields when available; do not classify failures from a friendly message alone.
- Distinguish authentication errors, rate limits, spending limits, transport failures, and launcher termination.
- Resume an interrupted session instead of restarting when the CLI exposes a session identifier and the worktree still contains useful progress.
- Discover transcript storage from the installed CLI and active profile. Do not assume a fixed directory layout.
- Move a transcript between profiles only when the formats are known to be compatible and the user has authorized access to both profiles.
- When resuming, state why the prior run stopped, confirm that uncommitted work remains, and restate the finish conditions.

## Isolate work

Use one Git worktree per subagent. Before launch:

1. Create or select a dedicated worktree and branch.
2. Record its absolute path and starting revision.
3. Tell the subagent to preserve unrelated changes, stage only explicit paths if staging is authorized, and never use broad destructive Git commands.
4. Account for dependencies, generated files, and submodules that may be absent from a new worktree.

Never run concurrent edit-producing agents in the same worktree.

## Write the brief

- Point to source artifacts that define the task instead of duplicating them inaccurately.
- Explain why load-bearing constraints exist.
- State concrete finish conditions, validation commands, and required final reporting.
- Say what partial completion is acceptable and how incomplete work should be left safe.
- Include repository-specific correctness rules that the subagent must follow.
- Keep the brief self-contained without embedding secrets, credentials, or machine-specific paths that can be discovered safely at runtime.

## Review the result

Do not accept the subagent's summary as proof:

1. Inspect its diff and repository state.
2. Check that it used the intended model when that matters.
3. Run relevant validation in an environment with the required dependencies and submodules.
4. Look for accidental staging, unrelated edits, partial implementations, inert checks, and claims unsupported by artifacts.
5. Report what was checked, what failed, and what could not be checked.
