const vscode = require("vscode");
const { execFile } = require("child_process");
const { sshSetupPrompt } = require("./prompt.js");

// A guided front for `composery ssh enroll` (docs/ssh.md). The CLI stays the
// single writer of the enrollment store, and anyone who can run this command can
// also open the editor terminal, so the authorization boundary is unchanged.
//
// What it produces is a prompt to paste into an AI agent. The agent does the part
// neither this editor nor the website can: it runs on the user's own machine, and
// writing `~/.ssh/config` there is the thing that actually makes an instance
// usable afterwards.
const COMMAND = "composery.connectOverSsh";

// sshd listens here inside the container. What a deployment publishes it as is
// the operator's choice, so the address is asked for rather than guessed.
const CONTAINER_SSH_PORT = 22;

function cli(args) {
	return new Promise((resolve, reject) => {
		execFile(
			"composery",
			[...args, "--json"],
			{ timeout: 15000 },
			(error, stdout, stderr) => {
				if (error) {
					reject(
						new Error(
							error.code === "ENOENT"
								? "The composery CLI is not available on this instance."
								: String(stderr || error.message).trim()
						)
					);
					return;
				}
				try {
					resolve(JSON.parse(stdout));
				} catch (parseError) {
					reject(parseError);
				}
			}
		);
	});
}

// The address is the one thing this side cannot know. The editor is reached
// through whatever proxy, port mapping or domain the deployment put in front of
// it, and none of that is visible from inside the container - so it is asked for,
// with the cloud's own name as the default when there is one.
async function askForAddress() {
	const cloudDomain = process.env.COMPOSERY_CLOUD_ORIGIN
		? String(process.env.COMPOSERY_CLOUD_ORIGIN).replace(/^https?:\/\//, "")
		: undefined;
	return await vscode.window.showInputBox({
		title: "Connect Over SSH",
		prompt: "The address this instance is reached at",
		placeHolder: "composery.example.com",
		value: cloudDomain,
		validateInput: (value) =>
			value.trim() ? undefined : "Enter a hostname or address"
	});
}

async function connectOverSsh() {
	const name = await vscode.window.showInputBox({
		title: "Connect Over SSH",
		prompt: "What is connecting? Revoke it later by this name",
		placeHolder: "my laptop",
		validateInput: (value) => (value.trim() ? undefined : "Enter a name")
	});
	if (name === undefined) return;

	const host = await askForAddress();
	if (host === undefined) return;

	const port = await vscode.window.showInputBox({
		title: "Connect Over SSH",
		prompt: "The port that reaches this instance's SSH service",
		value: String(CONTAINER_SSH_PORT),
		validateInput: (value) =>
			/^\d+$/.test(value.trim()) && Number(value) > 0 && Number(value) <= 65535
				? undefined
				: "Enter a port number"
	});
	if (port === undefined) return;

	const enrollment = await cli(["ssh", "enroll", "--name", name.trim()]);
	const trimmedHost = host.trim();
	const prompt = sshSetupPrompt({
		alias: `composery-${trimmedHost.split(".")[0] || "instance"}`,
		enrollUrl: `https://${trimmedHost}/_composery/ssh/enroll`,
		host: trimmedHost,
		port: Number(port),
		token: enrollment.token,
		user: "user"
	});

	// Opened as a document rather than a message: it is long, it is meant to be
	// read before it is used, and a document can be copied in one keystroke.
	const document = await vscode.workspace.openTextDocument({
		content: prompt,
		language: "markdown"
	});
	await vscode.window.showTextDocument(document, { preview: false });

	const copy = "Copy Prompt";
	const choice = await vscode.window.showInformationMessage(
		"Paste this into an AI agent to connect it to this instance.",
		{
			modal: true,
			detail:
				"The token in it works once and expires shortly. Run this command again for a fresh one.\n\nThe agent generates its own key and only sends the public half; nothing here asks for a private key."
		},
		copy
	);
	if (choice === copy) {
		await vscode.env.clipboard.writeText(prompt);
	}
}

function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND, async () => {
			try {
				await connectOverSsh();
			} catch (error) {
				await vscode.window.showErrorMessage(
					`Could not set up SSH access: ${error.message}`
				);
			}
		})
	);
}

module.exports = { activate, deactivate: () => {} };
