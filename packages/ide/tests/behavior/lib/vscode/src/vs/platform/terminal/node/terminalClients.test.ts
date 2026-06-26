import { describe, expect, test, vi } from "vitest";

import { TerminalDataFlowControl } from "../../../../../../../../../overlay/lib/vscode/src/vs/platform/terminal/common/terminalDataFlowControl.ts";
import {
	type IViewportDimensions,
	TerminalClients
} from "../../../../../../../../../overlay/lib/vscode/src/vs/platform/terminal/node/terminalClients.ts";

function clients(
	initial: IViewportDimensions = { cols: 80, rows: 24 },
	resize = vi.fn<(dimensions: IViewportDimensions) => boolean>(() => true),
	acknowledge = vi.fn()
) {
	return {
		acknowledge,
		resize,
		subject: new TerminalClients(initial, acknowledge, resize)
	};
}

describe("terminal clients", () => {
	test("the active client resizes and leaving restores the last active client", () => {
		const { resize, subject } = clients();
		subject.register("tablet");
		subject.register("laptop");
		subject.register("desktop");
		subject.register("phone");
		subject.resizeViewport("phone", { cols: 40, rows: 20 });
		subject.resizeViewport("laptop", { cols: 160, rows: 50 });
		expect(resize).not.toHaveBeenCalled();

		subject.activateViewport("tablet", { cols: 100, rows: 30 });
		subject.activateViewport("desktop", { cols: 120, rows: 40 });
		subject.activateViewport("laptop", { cols: 160, rows: 50 });
		subject.activateViewport("phone", { cols: 40, rows: 20 });
		subject.resizeViewport("laptop", { cols: 150, rows: 45 });
		subject.resizeViewport("phone", { cols: 42, rows: 21 });
		expect(resize.mock.calls).toEqual([
			[{ cols: 100, rows: 30 }],
			[{ cols: 120, rows: 40 }],
			[{ cols: 160, rows: 50 }],
			[{ cols: 40, rows: 20 }],
			[{ cols: 42, rows: 21 }]
		]);

		subject.unregister("phone");
		expect(resize).toHaveBeenLastCalledWith({ cols: 150, rows: 45 });
	});

	test("leaving never promotes a client that only reported a layout", () => {
		const { resize, subject } = clients();
		subject.register("phone");
		subject.register("background");
		subject.resizeViewport("background", { cols: 200, rows: 60 });
		subject.activateViewport("phone", { cols: 40, rows: 20 });

		subject.unregister("phone");

		expect(resize).toHaveBeenCalledTimes(1);
	});

	test("registering twice preserves a client's earlier activation", () => {
		const { resize, subject } = clients();
		subject.register("laptop");
		subject.register("phone");
		subject.activateViewport("laptop", { cols: 160, rows: 50 });
		subject.activateViewport("phone", { cols: 40, rows: 20 });

		subject.register("laptop");
		subject.unregister("phone");

		expect(resize).toHaveBeenLastCalledWith({ cols: 160, rows: 50 });
	});

	test("an inactive client leaving does not resize the terminal", () => {
		const { resize, subject } = clients();
		subject.register("laptop");
		subject.register("background");
		subject.activateViewport("laptop", { cols: 160, rows: 50 });

		subject.unregister("background");

		expect(resize).toHaveBeenCalledOnce();
	});

	test("unknown clients fail instead of silently resizing", () => {
		const { subject } = clients();

		expect(() =>
			subject.resizeViewport("stranger", { cols: 80, rows: 24 })
		).toThrow('Terminal client "stranger" is not registered');
		expect(() =>
			subject.activateViewport("stranger", { cols: 80, rows: 24 })
		).toThrow('Terminal client "stranger" is not registered');
	});

	test("resizes only when the whole geometry changes and the resize applies", () => {
		const resize = vi
			.fn<(dimensions: IViewportDimensions) => boolean>()
			.mockReturnValueOnce(false)
			.mockReturnValue(true);
		const { subject } = clients(
			{ cols: 80, rows: 24, pixelWidth: 800, pixelHeight: 480 },
			resize
		);
		const dimensions = [
			{ cols: 81, rows: 24, pixelWidth: 800, pixelHeight: 480 },
			{ cols: 81, rows: 25, pixelWidth: 800, pixelHeight: 480 },
			{ cols: 81, rows: 25, pixelWidth: 801, pixelHeight: 480 },
			{ cols: 81, rows: 25, pixelWidth: 801, pixelHeight: 481 }
		];

		subject.resize(dimensions[0]!);
		for (const next of dimensions) subject.resize(next);
		subject.resize(dimensions.at(-1)!);

		expect(resize.mock.calls).toEqual(
			[dimensions[0], ...dimensions].map((next) => [next])
		);
	});

	test("flow control shares one byte sequence across registered clients", () => {
		const { acknowledge, subject } = clients();
		subject.register("browser");
		subject.register("api");
		subject.acceptData(8_192);

		subject.acknowledge("api", 8_192);
		subject.acknowledge("browser", 8_192);

		expect(acknowledge).toHaveBeenCalledOnce();
		expect(acknowledge).toHaveBeenCalledWith(8_192);
	});

	test("replay resets every client's live acknowledgement baseline", () => {
		const { acknowledge, subject } = clients();
		subject.register("browser");
		subject.register("api");
		subject.acceptData(10);
		subject.acknowledge("browser", 8);
		subject.resetAfterReplay();
		subject.acceptData(5);
		subject.acknowledge("api", 1);

		expect(acknowledge.mock.calls).toEqual([[8], [1]]);
	});
});

describe("terminal data flow control", () => {
	test("the furthest-ahead client drives the counter once per byte", () => {
		const acknowledge = vi.fn();
		const flow = new TerminalDataFlowControl(acknowledge);
		flow.register("browser");
		flow.register("api");
		flow.acceptData(8_192);

		flow.acknowledge("api", 8_192);
		flow.acknowledge("browser", 8_192);
		flow.acceptData(1_024);
		flow.acknowledge("browser", 1_024);
		flow.acknowledge("api", 1_024);

		expect(acknowledge.mock.calls).toEqual([[8_192], [1_024]]);
	});

	test("acknowledgements cannot exceed produced output", () => {
		const acknowledge = vi.fn();
		const flow = new TerminalDataFlowControl(acknowledge);
		flow.register("browser");
		flow.acceptData(10);

		flow.acknowledge("browser", 1_000);

		expect(acknowledge).toHaveBeenCalledWith(10);
	});

	test("invalid lengths and unknown clients fail", () => {
		const flow = new TerminalDataFlowControl(vi.fn());
		expect(() => flow.acknowledge("stranger", 10)).toThrow("is not registered");
		expect(() => flow.acceptData(-1)).toThrow("Invalid terminal data length");
		flow.register("browser");
		expect(() => flow.acknowledge("browser", -1)).toThrow(
			"Invalid terminal acknowledgement"
		);
	});

	test("the last client leaving drains output until another registers", () => {
		const acknowledge = vi.fn();
		const flow = new TerminalDataFlowControl(acknowledge);
		flow.register("api");
		flow.acceptData(8_192);
		flow.unregister("api");
		flow.acceptData(512);
		flow.register("api");
		flow.acceptData(256);
		flow.acknowledge("api", 256);

		expect(acknowledge.mock.calls).toEqual([[8_192], [512], [256]]);
	});

	test("replay establishes a new live-data baseline", () => {
		const acknowledge = vi.fn();
		const flow = new TerminalDataFlowControl(acknowledge);
		flow.register("browser");
		flow.acceptData(10);
		flow.resetAfterReplay();
		flow.acceptData(5);
		flow.acknowledge("browser", 5);

		expect(acknowledge).toHaveBeenCalledOnce();
		expect(acknowledge).toHaveBeenCalledWith(5);
	});
});
