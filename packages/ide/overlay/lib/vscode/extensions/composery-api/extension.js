const vscode = require("vscode");
const { execFile } = require("child_process");

// A guided front for `composery api key ...` (docs/api.mdx). The CLI stays the
// single writer of the key store; anyone who can run this command can also open
// the editor terminal, so the authorization boundary is unchanged.
const COMMAND = "composery.manageApiKeys";

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

async function createKey() {
	const name = await vscode.window.showInputBox({
		title: "Create API Key",
		prompt: "A label for what will use this key",
		placeHolder: "ci",
		validateInput: (value) => (value.trim() ? undefined : "Enter a name")
	});
	if (name === undefined) {
		return;
	}
	const created = await cli(["api", "key", "create", "--name", name.trim()]);
	const copy = "Copy Key";
	const choice = await vscode.window.showInformationMessage(
		`Created API key "${created.name}"`,
		{
			modal: true,
			detail: `${created.secret}\n\nThis key is shown only once and cannot be recovered. Callers send it in an Authorization: Bearer header.`
		},
		copy
	);
	if (choice === copy) {
		await vscode.env.clipboard.writeText(created.secret);
	}
}

async function revokeKey(key) {
	const revoke = "Revoke";
	const choice = await vscode.window.showWarningMessage(
		`Revoke API key "${key.name}"?`,
		{
			modal: true,
			detail: "Anything still using this key stops working immediately."
		},
		revoke
	);
	if (choice === revoke) {
		await cli(["api", "key", "revoke", key.id]);
	}
}

// Revoking is the only thing a listed key can do, so it rides a per-item trash
// button the way upstream pickers carry theirs (prompt files, MCP servers): the
// row shows what selecting it does before it is selected. touch.css keeps those
// buttons visible where there is no hover, so the affordance survives on a phone.
function pickKey(keys) {
	return new Promise((resolve) => {
		const picker = vscode.window.createQuickPick();
		const create = { alwaysShow: true, label: "$(add) Create API Key" };
		const revoke = {
			iconPath: new vscode.ThemeIcon("trash"),
			tooltip: "Revoke Key"
		};
		picker.title = "API Keys";
		picker.placeholder = keys.length
			? "Create a key, or revoke one"
			: "No API keys yet - create one to enable the API";
		picker.items = [
			create,
			// Unlabelled: it only separates the action from the list it acts on.
			...(keys.length
				? [{ kind: vscode.QuickPickItemKind.Separator, label: "" }]
				: []),
			...keys.map((key) => ({
				buttons: [revoke],
				description: `${key.prefix}...`,
				detail: `Created ${new Date(key.created_at * 1000).toISOString().slice(0, 10)}`,
				key,
				label: key.name
			}))
		];

		let result;
		picker.onDidAccept(() => {
			const [item] = picker.selectedItems;
			if (item) {
				result = item === create ? { create: true } : { key: item.key };
			}
			picker.hide();
		});
		picker.onDidTriggerItemButton((event) => {
			result = { key: event.item.key };
			picker.hide();
		});
		picker.onDidHide(() => {
			picker.dispose();
			resolve(result);
		});
		picker.show();
	});
}

async function manageKeys() {
	for (;;) {
		const { keys } = await cli(["api", "key", "list"]);
		const choice = await pickKey(keys);
		if (!choice) {
			return;
		}
		if (choice.create) {
			await createKey();
		} else {
			await revokeKey(choice.key);
		}
	}
}

function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND, async () => {
			// The same reading as src/node/envFlag.ts, which this cannot import:
			// the extension ships into the VS Code extension host and compiles
			// apart from the server. An invariant test pins the pair.
			const off = (process.env.COMPOSERY_DISABLE_API || "")
				.trim()
				.toLowerCase();
			if (off === "1" || off === "true") {
				vscode.window.showWarningMessage(
					"The API is disabled (COMPOSERY_DISABLE_API=true). Keys can be managed, but every API request will return 404."
				);
			}
			try {
				await manageKeys();
			} catch (error) {
				vscode.window.showErrorMessage(`API keys: ${error.message}`);
			}
		})
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
