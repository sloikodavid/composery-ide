const vscode = require("vscode");

// The welcome page knows only the featured ids and logos. Everything else,
// including setup commands and optional editor integrations, lives here.
const AGENTS = [
	{
		id: "claude-code",
		name: "Claude Code",
		owner: "Anthropic",
		command: "curl -fsSL https://claude.ai/install.sh | bash",
		extension: { id: "anthropic.claude-code", name: "Claude Code" }
	},
	{
		id: "codex",
		name: "Codex",
		owner: "OpenAI",
		command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
		extension: { id: "openai.chatgpt", name: "Codex" }
	},
	{
		id: "opencode",
		name: "OpenCode",
		owner: "Anomaly",
		command: "curl -fsSL https://opencode.ai/install | bash",
		extension: { id: "sst-dev.opencode", name: "OpenCode" }
	},
	{
		id: "pi",
		name: "Pi",
		owner: "Earendil Works",
		command: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
	},
	{
		id: "hermes",
		name: "Hermes",
		owner: "Nous Research",
		command: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
	},
	{
		id: "openclaw",
		name: "OpenClaw",
		owner: "OpenClaw Foundation",
		command: "npm install -g openclaw@latest",
		additional: true
	},
	{
		id: "kimi",
		name: "Kimi Code CLI",
		owner: "Moonshot AI",
		command: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
		additional: true,
		extension: { id: "moonshot-ai.kimi-code", name: "Kimi Code" }
	},
	{
		id: "grok",
		name: "Grok Build",
		owner: "xAI",
		command: "curl -fsSL https://x.ai/cli/install.sh | bash",
		additional: true
	},
	{
		id: "aider",
		name: "Aider",
		owner: "Aider-AI",
		command: "curl -LsSf https://aider.chat/install.sh | sh",
		additional: true
	},
	{
		id: "droid",
		name: "Droid CLI",
		owner: "Factory",
		command: "curl -fsSL https://app.factory.ai/cli | sh",
		additional: true,
		extension: {
			id: "Factory.factory-vscode-extension",
			name: "Factory Droid"
		}
	},
	{
		id: "amp",
		name: "Amp",
		owner: "Sourcegraph",
		command: "curl -fsSL https://ampcode.com/install.sh | bash",
		additional: true,
		extension: {
			id: "sourcegraph.amp",
			name: "Amp",
			vsix: "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/sourcegraph/vsextensions/amp/latest/vspackage"
		}
	},
	{
		id: "antigravity",
		name: "Antigravity CLI",
		owner: "Google",
		command: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
		additional: true
	},
	{
		id: "copilot",
		name: "GitHub Copilot CLI",
		owner: "GitHub",
		command: "curl -fsSL https://gh.io/copilot-install | bash",
		additional: true,
		extension: { id: "GitHub.copilot-chat", name: "GitHub Copilot" }
	},
	{
		id: "cursor",
		name: "Cursor CLI",
		owner: "Cursor",
		command: "curl https://cursor.com/install -fsS | bash",
		additional: true
	},
	{
		id: "kilo",
		name: "Kilo Code CLI",
		owner: "Kilo Code",
		command: "npm install -g @kilocode/cli",
		additional: true,
		extension: {
			id: "kilocode.kilo-code",
			name: "Kilo Code"
		}
	}
];

async function installExtension(extension, context) {
	if (!extension.vsix) {
		await vscode.commands.executeCommand(
			"workbench.extensions.installExtension",
			extension.id
		);
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Installing the ${extension.name} extension`
		},
		async () => {
			const response = await fetch(extension.vsix);
			if (!response.ok) {
				throw new Error(`download returned HTTP ${response.status}`);
			}

			const contents = new Uint8Array(await response.arrayBuffer());
			if (contents.length < 2 || contents[0] !== 0x50 || contents[1] !== 0x4b) {
				throw new Error("download did not return a VSIX package");
			}

			await vscode.workspace.fs.createDirectory(context.globalStorageUri);
			const vsix = vscode.Uri.joinPath(
				context.globalStorageUri,
				`${extension.id}.vsix`
			);
			await vscode.workspace.fs.writeFile(vsix, contents);
			try {
				await vscode.commands.executeCommand(
					"workbench.extensions.installExtension",
					vsix
				);
			} finally {
				try {
					await vscode.workspace.fs.delete(vsix);
				} catch {
					// Installation succeeded or reported its own error; stale cache
					// cleanup must not replace that result.
				}
			}
		}
	);
}

async function run(agent, context) {
	const terminal = vscode.window.createTerminal(`Set up ${agent.name}`);
	terminal.show();
	terminal.sendText(agent.command);

	if (!agent.extension || vscode.extensions.getExtension(agent.extension.id)) {
		return;
	}

	const install = await vscode.window.showInformationMessage(
		`${agent.name} also has a VS Code extension. Install it?`,
		{
			modal: true,
			detail: `The CLI setup is already running in a terminal. The optional ${agent.extension.name} extension will only be installed if you choose Install.`
		},
		"Install"
	);
	if (install !== "Install") {
		return;
	}

	try {
		await installExtension(agent.extension, context);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(
			`Could not install the ${agent.extension.name} extension: ${message}`
		);
	}
}

async function pickAgent(agents = AGENTS) {
	const choice = await vscode.window.showQuickPick(
		agents.map((agent) => ({
			label: agent.name,
			description: agent.owner,
			detail: agent.command,
			id: agent.id
		})),
		{
			title: "Set up an AI coding agent",
			placeHolder: "Run an agent's official setup command in a new terminal"
		}
	);
	return choice && agents.find((agent) => agent.id === choice.id);
}

function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand("composery.installAgent", async (id) => {
			const agent =
				id === "additional"
					? await pickAgent(AGENTS.filter((candidate) => candidate.additional))
					: AGENTS.find((candidate) => candidate.id === id) ||
						(await pickAgent());
			if (agent) {
				await run(agent, context);
			}
		})
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
