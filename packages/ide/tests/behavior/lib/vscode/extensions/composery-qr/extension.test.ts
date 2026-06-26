import { describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../../support/overlay.ts";

type QrExtension = {
	activate: (context: {
		subscriptions: { push(disposable: unknown): void };
	}) => void;
};

function loadQrExtension(vscode: unknown = { commands: {}, window: {} }) {
	const loaded = loadOverlayModule<QrExtension>({
		source: new URL(
			"../../../../../../overlay/lib/vscode/extensions/composery-qr/extension.js",
			import.meta.url
		),
		dependencies: { vscode },
		globals: { URL }
	});

	return {
		activate: (context: {
			subscriptions: { push(disposable: unknown): void };
		}) => loaded.exports.activate(context),
		isReachableFromAnotherDevice: loaded.binding<(url: URL) => boolean>(
			"isReachableFromAnotherDevice"
		),
		render: loaded.binding<(url: string) => string>("render")
	};
}

describe("QR extension", () => {
	test("refuses addresses another device cannot reach", () => {
		const { isReachableFromAnotherDevice } = loadQrExtension();

		for (const reachable of [
			"https://composery.test/",
			"http://192.168.1.192:8080/",
			"http://127.example.com/"
		]) {
			expect(isReachableFromAnotherDevice(new URL(reachable)), reachable).toBe(
				true
			);
		}

		for (const unreachable of [
			"http://localhost:8080/",
			"http://composery.localhost/",
			"http://localhost./",
			"http://127.0.0.1:8080/",
			"http://127.1:8080/",
			"http://2130706433:8080/",
			"http://0.0.0.0:8080/",
			"http://[::1]/",
			"http://[::]/",
			"http://[::ffff:127.0.0.1]/",
			"ftp://composery.test/"
		]) {
			expect(
				isReachableFromAnotherDevice(new URL(unreachable)),
				unreachable
			).toBe(false);
		}
	});

	test("says an unreachable address has no QR code, and offers nothing", () => {
		let command: ((value: string) => void) | undefined;
		let warning: unknown[] | undefined;
		let panels = 0;
		const { activate } = loadQrExtension({
			commands: {
				registerCommand(_id: string, handler: (value: string) => void) {
					command = handler;
					return { dispose() {} };
				}
			},
			window: {
				createWebviewPanel() {
					panels += 1;
					return { onDidDispose() {}, webview: {} };
				},
				showWarningMessage(...items: unknown[]) {
					warning = items;
				}
			}
		});

		activate({ subscriptions: { push() {} } });
		if (!command) throw new Error("QR command was not registered");
		command("http://localhost:8080/");

		// One argument, and no second sentence: an item here would be a button
		// offering an address this process cannot know is reachable, which is the
		// dead link this message replaced.
		expect(warning).toEqual([
			"This address only works on this device, so Composery cannot make a QR code for it."
		]);
		expect(panels).toBe(0);
	});

	test("carries the specification's four-module quiet zone at every version", () => {
		const { render } = loadQrExtension();

		for (const url of [
			"http://192.168.1.192:8080/",
			"https://a-much-longer-name.boxes.composery.app/?folder=/home/user/src"
		]) {
			const svg = render(url);
			const size = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1]);
			const quietZone = Number(/<path d="M(\d+),/.exec(svg)?.[1]);

			expect(quietZone / 8, url).toBe(4);
			expect(size, url).toBeGreaterThan(quietZone * 2);
		}
	});
});
