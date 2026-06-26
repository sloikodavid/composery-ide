import { describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../../support/overlay.ts";

type Release = {
	html_url?: string;
	prerelease?: boolean;
	tag_name?: string;
};

type Harness = {
	commands: Map<string, () => void>;
	fetchCalls: string[];
	messages: string[];
	opened: string[];
};

function loadUpdatesExtension({
	action,
	cloudBoxId,
	cloudOrigin,
	fleet,
	release,
	source = "https://github.com/sloikodavid/composery-ide.git",
	version = "1.2.3"
}: {
	action?: string;
	cloudBoxId?: string;
	cloudOrigin?: string;
	fleet?: { version?: string | null };
	release?: Release;
	source?: string;
	version?: string;
}): {
	activate: (context: { subscriptions: unknown[] }) => void;
	harness: Harness;
} {
	const commands = new Map<string, () => void>();
	const harness: Harness = {
		commands,
		fetchCalls: [],
		messages: [],
		opened: []
	};
	const vscode = {
		Uri: {
			parse(value: string) {
				return { toString: () => value };
			}
		},
		commands: {
			registerCommand(name: string, callback: () => void) {
				commands.set(name, callback);
				return { dispose() {} };
			}
		},
		env: {
			openExternal(uri: { toString(): string }) {
				harness.opened.push(uri.toString());
				return Promise.resolve(true);
			}
		},
		window: {
			showInformationMessage(message: string) {
				harness.messages.push(message);
				return Promise.resolve(action);
			},
			showWarningMessage(message: string) {
				harness.messages.push(message);
				return Promise.resolve(undefined);
			}
		}
	};
	const { exports: extension } = loadOverlayModule<{
		activate: (context: { subscriptions: unknown[] }) => void;
	}>({
		source: new URL(
			"../../../../../../overlay/lib/vscode/extensions/composery-updates/extension.js",
			import.meta.url
		),
		dependencies: { vscode },
		globals: {
			AbortSignal: { timeout: () => ({}) },
			URL,
			fetch: (url: string) => {
				harness.fetchCalls.push(url);
				const body = url.includes("/api/cloud/") ? fleet : release;
				return Promise.resolve({
					ok: body !== undefined,
					json: () => Promise.resolve(body)
				});
			},
			process: {
				env: {
					COMPOSERY_BUILD_SOURCE: source,
					COMPOSERY_BUILD_VERSION: version,
					COMPOSERY_CLOUD_BOX_ID: cloudBoxId,
					COMPOSERY_CLOUD_ORIGIN: cloudOrigin
				}
			}
		}
	});

	return {
		activate: (context) => extension.activate(context),
		harness
	};
}

async function finishPromises(): Promise<void> {
	for (let pending = 0; pending < 16; pending++) {
		await Promise.resolve();
	}
}

describe("updates extension", () => {
	test("startup announces a newer stable release and opens it", async () => {
		const { activate, harness } = loadUpdatesExtension({
			action: "View Release",
			release: {
				html_url:
					"https://github.com/sloikodavid/composery-ide/releases/tag/v1.3.0",
				prerelease: false,
				tag_name: "v1.3.0"
			}
		});

		activate({ subscriptions: [] });
		await finishPromises();

		expect(harness.fetchCalls).toEqual([
			"https://api.github.com/repos/sloikodavid/composery/releases/latest"
		]);
		expect(harness.messages).toEqual([
			"Composery 1.3.0 is available. You have 1.2.3."
		]);
		expect(harness.opened).toEqual([
			"https://github.com/sloikodavid/composery-ide/releases/tag/v1.3.0"
		]);
	});

	test("manual checks stay local for preview and unversioned builds", async () => {
		for (const [version, message] of [
			[
				"preview-abc123",
				"You have development build preview-abc123. Updates are checked automatically in stable releases."
			],
			[
				"unknown",
				"This development build has no release version. Updates are checked automatically in stable releases."
			]
		] as const) {
			const { activate, harness } = loadUpdatesExtension({ version });
			activate({ subscriptions: [] });
			await finishPromises();
			harness.commands.get("composery.checkForUpdates")?.();
			await finishPromises();

			expect(harness.fetchCalls, version).toEqual([]);
			expect(harness.messages, version).toEqual([message]);
		}
	});

	test("a cloud instance asks the website and opens its own page", async () => {
		const { activate, harness } = loadUpdatesExtension({
			action: "View Instance",
			cloudBoxId: "k17abc",
			cloudOrigin: "https://www.composery.io",
			fleet: { version: "1.3.0" },
			release: {
				html_url:
					"https://github.com/sloikodavid/composery-ide/releases/tag/v9.9.9",
				prerelease: false,
				tag_name: "v9.9.9"
			}
		});

		activate({ subscriptions: [] });
		await finishPromises();

		expect(harness.fetchCalls).toEqual([
			"https://www.composery.io/api/cloud/runtime"
		]);
		expect(harness.messages).toEqual([
			"Composery 1.3.0 is available for this instance. You have 1.2.3. Update it from your instance's page on Composery Cloud."
		]);
		expect(harness.opened).toEqual(["https://www.composery.io/boxes/k17abc"]);
	});

	test("an incomplete cloud identity never falls back to GitHub", async () => {
		const { activate, harness } = loadUpdatesExtension({
			cloudBoxId: "k17abc",
			release: {
				html_url:
					"https://github.com/sloikodavid/composery-ide/releases/tag/v1.3.0",
				prerelease: false,
				tag_name: "v1.3.0"
			}
		});

		activate({ subscriptions: [] });
		await finishPromises();
		harness.commands.get("composery.checkForUpdates")?.();
		await finishPromises();

		expect(harness.fetchCalls).toEqual([]);
		expect(harness.messages).toEqual([
			"Couldn't check for updates. You have Composery 1.2.3. Try again later."
		]);
	});
});
