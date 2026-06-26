import { describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../../support/overlay.ts";

type Item = {
	buttons?: Array<{ iconPath: { id: string }; tooltip: string }>;
	kind?: number;
	label: string;
};

type Pick = string | { button: string };

type Harness = {
	clipboard: string[];
	commands: Map<string, () => Promise<void>>;
	errors: string[];
	execCalls: string[][];
	shown: Array<{ items: Item[]; placeholder: string | undefined }>;
	warnings: string[];
};

function loadApiExtension({
	env = {},
	inputText,
	modalAction,
	picks = [],
	responses = []
}: {
	env?: Record<string, string>;
	inputText?: string;
	modalAction?: string;
	picks?: Pick[];
	responses?: unknown[];
}): { run: () => Promise<void>; harness: Harness } {
	const harness: Harness = {
		clipboard: [],
		commands: new Map(),
		errors: [],
		execCalls: [],
		shown: [],
		warnings: []
	};
	const vscode = {
		commands: {
			registerCommand(name: string, callback: () => Promise<void>) {
				harness.commands.set(name, callback);
				return { dispose() {} };
			}
		},
		env: {
			clipboard: {
				writeText(text: string) {
					harness.clipboard.push(text);
					return Promise.resolve();
				}
			}
		},
		QuickPickItemKind: { Default: 0, Separator: -1 },
		ThemeIcon: class {
			id: string;
			constructor(id: string) {
				this.id = id;
			}
		},
		window: {
			createQuickPick() {
				const handlers: {
					accept?: () => void;
					button?: (event: { button: unknown; item: Item }) => void;
					hide?: () => void;
				} = {};
				const picker = {
					items: [] as Item[],
					placeholder: undefined as string | undefined,
					selectedItems: [] as Item[],
					title: undefined as string | undefined,
					dispose() {},
					hide() {
						handlers.hide?.();
					},
					onDidAccept(callback: () => void) {
						handlers.accept = callback;
						return { dispose() {} };
					},
					onDidHide(callback: () => void) {
						handlers.hide = callback;
						return { dispose() {} };
					},
					onDidTriggerItemButton(
						callback: (event: { button: unknown; item: Item }) => void
					) {
						handlers.button = callback;
						return { dispose() {} };
					},
					show() {
						harness.shown.push({
							items: picker.items,
							placeholder: picker.placeholder
						});
						const pick = picks.shift();
						if (pick === undefined) {
							picker.hide();
							return;
						}
						const label = typeof pick === "string" ? pick : pick.button;
						const item = picker.items.find((entry) => entry.label === label);
						if (!item) throw new Error(`No item labelled "${label}"`);
						if (typeof pick === "string") {
							picker.selectedItems = [item];
							handlers.accept?.();
							return;
						}
						const [button] = item.buttons ?? [];
						if (!button) throw new Error(`No item button on "${label}"`);
						handlers.button?.({ button, item });
					}
				};
				return picker;
			},
			showErrorMessage(message: string) {
				harness.errors.push(message);
				return Promise.resolve(undefined);
			},
			showInformationMessage() {
				return Promise.resolve(modalAction);
			},
			showInputBox() {
				return Promise.resolve(inputText);
			},
			showWarningMessage(message: string) {
				harness.warnings.push(message);
				return Promise.resolve(modalAction);
			}
		}
	};
	const { exports: extension } = loadOverlayModule<{
		activate: (context: { subscriptions: unknown[] }) => void;
	}>({
		source: new URL(
			"../../../../../../overlay/lib/vscode/extensions/composery-api/extension.js",
			import.meta.url
		),
		dependencies: {
			child_process: {
				execFile(
					command: string,
					args: string[],
					_options: unknown,
					callback: (error: null, stdout: string, stderr: string) => void
				) {
					harness.execCalls.push([command, ...args]);
					callback(null, JSON.stringify(responses.shift()), "");
				}
			},
			vscode
		},
		globals: { process: { env } }
	});

	extension.activate({ subscriptions: [] });
	const command = harness.commands.get("composery.manageApiKeys");
	if (!command) throw new Error("Manage API keys command was not registered");
	return { harness, run: () => command() };
}

function listedKeys() {
	return {
		keys: [
			{
				created_at: 1_752_710_400,
				id: "k1",
				name: "ci",
				prefix: "composery_abcd1234"
			},
			{
				created_at: 1_752_710_400,
				id: "k2",
				name: "deploy",
				prefix: "composery_efgh5678"
			}
		]
	};
}

describe("API keys extension", () => {
	test("creating a key runs the CLI and copies the one-time secret", async () => {
		const { harness, run } = loadApiExtension({
			inputText: "ci",
			modalAction: "Copy Key",
			picks: ["$(add) Create API Key"],
			responses: [
				{ keys: [] },
				{
					created_at: 1_752_710_400,
					id: "k1",
					name: "ci",
					prefix: "composery_abcd1234",
					secret: "composery_secret"
				},
				listedKeys()
			]
		});

		await run();

		expect(harness.execCalls).toEqual([
			["composery", "api", "key", "list", "--json"],
			["composery", "api", "key", "create", "--name", "ci", "--json"],
			["composery", "api", "key", "list", "--json"]
		]);
		expect(harness.clipboard).toEqual(["composery_secret"]);
		expect(harness.errors).toEqual([]);
	});

	test("a key's revoke button revokes that key's id", async () => {
		const { harness, run } = loadApiExtension({
			modalAction: "Revoke",
			picks: [{ button: "deploy" }],
			responses: [listedKeys(), { id: "k2", revoked: true }, { keys: [] }]
		});

		await run();

		expect(harness.warnings[0]).toBe('Revoke API key "deploy"?');
		expect(harness.execCalls[1]).toEqual([
			"composery",
			"api",
			"key",
			"revoke",
			"k2",
			"--json"
		]);
	});

	test("an empty list omits the separator and explains the next action", async () => {
		const { harness, run } = loadApiExtension({
			responses: [{ keys: [] }]
		});

		await run();

		expect(harness.shown[0]).toEqual({
			items: [expect.objectContaining({ label: "$(add) Create API Key" })],
			placeholder: "No API keys yet - create one to enable the API"
		});
	});

	test("only explicit disabling values warn that requests return 404", async () => {
		const disabled = loadApiExtension({
			env: { COMPOSERY_DISABLE_API: "true" },
			responses: [{ keys: [] }]
		});
		await disabled.run();
		expect(disabled.harness.warnings).toEqual([
			"The API is disabled (COMPOSERY_DISABLE_API=true). Keys can be managed, but every API request will return 404."
		]);

		const misspelled = loadApiExtension({
			env: { COMPOSERY_DISABLE_API: "yes" },
			responses: [{ keys: [] }]
		});
		await misspelled.run();
		expect(misspelled.harness.warnings).toEqual([]);
	});
});
