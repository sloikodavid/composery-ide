import { afterEach, describe, expect, test, vi } from "vitest";

type ViewportRun = {
	properties: Map<string, string>;
	fireVisualViewportResize(): void;
	setVisualViewportHeight(height: number): void;
};

async function runViewport(
	innerHeight: number,
	visualViewport: { height: number; offsetTop: number; width: number }
): Promise<ViewportRun> {
	const properties = new Map<string, string>();
	const viewportListeners: Array<{ type: string; listener: () => void }> = [];
	const viewport = {
		...visualViewport,
		addEventListener(type: string, listener: () => void) {
			viewportListeners.push({ type, listener });
		}
	};
	const documentElement = {
		style: {
			setProperty(name: string, value: string) {
				properties.set(name, value);
			}
		}
	};
	const window = {
		addEventListener() {},
		innerHeight,
		innerWidth: visualViewport.width,
		matchMedia: () => ({
			addEventListener() {},
			matches: false
		}),
		requestAnimationFrame() {},
		setTimeout: vi.fn(),
		visualViewport: viewport
	};

	vi.stubGlobal("HTMLElement", class HTMLElement {});
	vi.stubGlobal("KeyboardEvent", class KeyboardEvent {});
	vi.stubGlobal(
		"MutationObserver",
		class MutationObserver {
			observe() {}
		}
	);
	vi.stubGlobal("document", {
		documentElement,
		querySelectorAll: () => [],
		addEventListener() {}
	});
	vi.stubGlobal("getComputedStyle", () => ({
		display: "none",
		visibility: "hidden"
	}));
	vi.stubGlobal("history", { back() {}, pushState() {}, state: undefined });
	vi.stubGlobal("location", { href: "https://example.test/" });
	vi.stubGlobal("navigator", {});
	vi.stubGlobal("window", window);
	vi.resetModules();
	await import("../../../../../../../../../overlay/lib/vscode/src/vs/code/browser/workbench/shell.ts");

	return {
		properties,
		setVisualViewportHeight(height: number) {
			viewport.height = height;
		},
		fireVisualViewportResize() {
			for (const { type, listener } of viewportListeners) {
				if (type === "resize") listener();
			}
		}
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("small-surface shell viewport", () => {
	test("publishes the keyboard verdict from the tallest viewport at this width", async () => {
		const run = await runViewport(800, {
			height: 800,
			offsetTop: 0,
			width: 390
		});
		expect(run.properties.get("--composery-touch-keyboard-open")).toBe("0");

		run.setVisualViewportHeight(520);
		run.fireVisualViewportResize();
		expect(run.properties.get("--composery-touch-keyboard-open")).toBe("1");

		run.setVisualViewportHeight(800);
		run.fireVisualViewportResize();
		expect(run.properties.get("--composery-touch-keyboard-open")).toBe("0");

		run.setVisualViewportHeight(720);
		run.fireVisualViewportResize();
		expect(run.properties.get("--composery-touch-keyboard-open")).toBe("0");
	});

	test("publishes viewport height within the resize delivery", async () => {
		const run = await runViewport(800, {
			height: 800,
			offsetTop: 0,
			width: 390
		});
		expect(run.properties.get("--composery-viewport-height")).toBe("800px");

		run.setVisualViewportHeight(520);
		run.fireVisualViewportResize();
		expect(run.properties.get("--composery-viewport-height")).toBe("520px");
	});
});
