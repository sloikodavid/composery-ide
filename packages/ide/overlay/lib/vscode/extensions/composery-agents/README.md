# Composery Agents

Builtin extension that registers `composery.installAgent`, the command behind the
"Set up an AI coding agent" cards on the Composery welcome page.

Given an agent id it opens a dedicated, visible terminal and runs that agent's
official, documented setup command; the user then handles any login or onboarding
the agent prompts for. The setup command installs the CLI only. If its owner also
ships a VS Code extension, a separate modal asks whether to install it; dismissing
that modal leaves the editor unchanged. Run with no id (the
`Composery: Set Up an AI Coding Agent` palette entry) to pick from the full list,
or with `additional` to pick from the agents behind the welcome page's
**More agents…** card.

`AGENTS` in `extension.js` is the single source of truth for the setup commands.
The welcome card in `packages/ide/patches/defaults.diff` references only the six
featured agent ids and ships their logos under
`overlay/src/browser/media/agents/`.

## Vendor check

Rechecked against vendor documentation and Marketplace publisher records on
2026-07-27:

| Entry              | Owner               | CLI source                                                                                               | Owner-provided VS Code extension                                                                                     |
| ------------------ | ------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Claude Code        | Anthropic           | [install](https://docs.anthropic.com/en/docs/claude-code/getting-started)                                | `anthropic.claude-code`                                                                                              |
| Codex              | OpenAI              | [install](https://developers.openai.com/codex/cli/)                                                      | `openai.chatgpt`                                                                                                     |
| OpenCode           | Anomaly             | [install](https://opencode.ai/docs/)                                                                     | `sst-dev.opencode`                                                                                                   |
| Pi                 | Earendil Works      | [install](https://pi.dev/docs/latest)                                                                    | None; Marketplace results are community projects                                                                     |
| OpenClaw           | OpenClaw Foundation | [install](https://docs.openclaw.ai/install)                                                              | None                                                                                                                 |
| Hermes             | Nous Research       | [install](https://hermes-agent.nousresearch.com/docs/)                                                   | None; IDE support is through ACP                                                                                     |
| Kimi Code CLI      | Moonshot AI         | [install](https://moonshotai.github.io/kimi-code/)                                                       | `moonshot-ai.kimi-code`                                                                                              |
| Grok Build         | xAI                 | [install](https://docs.x.ai/build/overview)                                                              | None; current Marketplace results are unofficial launchers                                                           |
| aider              | Aider-AI            | [install](https://aider.chat/docs/install.html)                                                          | None; its docs describe the VS Code plugins as third-party                                                           |
| Droid CLI          | Factory             | [install](https://docs.factory.ai/reference/cli-reference)                                               | `Factory.factory-vscode-extension`                                                                                   |
| Amp                | Sourcegraph         | [install](https://ampcode.com/manual)                                                                    | `sourcegraph.amp`; installed from Sourcegraph's official Marketplace package because it is not published to Open VSX |
| Antigravity CLI    | Google              | [install](https://antigravity.google/docs/cli-getting-started)                                           | None; Google ships a separate VS Code-based Antigravity IDE                                                          |
| GitHub Copilot CLI | GitHub              | [install](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) | `GitHub.copilot-chat`; already bundled by upstream, so no redundant install prompt                                   |
| Cursor CLI         | Cursor              | [install](https://docs.cursor.com/en/cli/installation)                                                   | None; Cursor ships its own editor                                                                                    |
| Kilo Code CLI      | Kilo Code           | [install](https://kilo.ai/docs/code-with-ai/platforms/cli)                                               | `kilocode.kilo-code`                                                                                                 |

The current installer artifacts were downloaded and inspected, not executed.
None of the CLI setup commands invokes an editor-extension install. Droid's
documented auto-install begins only when `droid` is subsequently launched inside
an integrated terminal. Pi disables npm lifecycle scripts; Kilo's current
postinstall was also inspected and only downloads its platform CLI package.
