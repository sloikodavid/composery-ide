import { describe, expect, test, vi } from "vitest";

import { loadOverlayModule } from "../../../../../support/overlay.ts";

describe("agent setup extension", () => {
	test("the requested agent runs its official setup in a named terminal", async () => {
		const sendText = vi.fn();
		const show = vi.fn();
		let installAgent: ((id: string) => Promise<void>) | undefined;
		const vscode = {
			commands: {
				registerCommand(name: string, command: (id: string) => Promise<void>) {
					expect(name).toBe("composery.installAgent");
					installAgent = command;
					return { dispose() {} };
				}
			},
			extensions: { getExtension: () => ({}) },
			window: {
				createTerminal(name: string) {
					expect(name).toBe("Set up Codex");
					return { sendText, show };
				}
			}
		};
		const { exports: extension } = loadOverlayModule<{
			activate(context: { subscriptions: unknown[] }): void;
		}>({
			source: new URL(
				"../../../../../../overlay/lib/vscode/extensions/composery-agents/extension.js",
				import.meta.url
			),
			dependencies: { vscode }
		});

		extension.activate({ subscriptions: [] });
		if (!installAgent) throw new Error("Install command was not registered");
		await installAgent("codex");

		expect(show).toHaveBeenCalledOnce();
		expect(sendText).toHaveBeenCalledWith(
			"curl -fsSL https://chatgpt.com/codex/install.sh | sh"
		);
	});

	test("the additional entry offers only the additional agents", async () => {
		let installAgent: ((id: string) => Promise<void>) | undefined;
		let offered: Array<{ id: string }> = [];
		const vscode = {
			commands: {
				registerCommand(_name: string, command: (id: string) => Promise<void>) {
					installAgent = command;
					return { dispose() {} };
				}
			},
			window: {
				showQuickPick(items: Array<{ id: string }>) {
					offered = items;
					return Promise.resolve(undefined);
				}
			}
		};
		const { exports: extension } = loadOverlayModule<{
			activate(context: { subscriptions: unknown[] }): void;
		}>({
			source: new URL(
				"../../../../../../overlay/lib/vscode/extensions/composery-agents/extension.js",
				import.meta.url
			),
			dependencies: { vscode }
		});

		extension.activate({ subscriptions: [] });
		if (!installAgent) throw new Error("Install command was not registered");
		await installAgent("additional");

		expect(offered.map((agent) => agent.id)).toEqual([
			"openclaw",
			"kimi",
			"grok",
			"aider",
			"droid",
			"amp",
			"antigravity",
			"copilot",
			"cursor",
			"kilo"
		]);
	});
});
