import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../../support/overlay.ts";

// The HTTP surface that spawns real shells. An API key is the only thing in
// front of it, so what is under test here is everything that decides what a
// holder of one may ask for, and what a caller without one may reach.
//
// Two shapes of failure matter more than the rest. A bound that is not enforced
// - a terminal a thousand times the size of a screen, a timeout past the
// configured ceiling, an environment that is not strings - reaches the pty host
// as it was typed. And a concurrency slot taken but not given back is worse than
// a leak: the cap is per key, so an attacker who can make the stream fail after
// the slot is taken locks the owner out of their own terminals, permanently and
// silently.
//
// Most of what is asserted lives inside the module rather than on its exports,
// which is what `binding` is for - these are the module's own decisions, reached
// where they are made rather than paraphrased.

type Resolved = {
	command?: string;
	cwd: string;
	env?: Record<string, string>;
	cols: number;
	rows: number;
	title?: string;
	hidden: boolean;
	wait: boolean;
	timeoutSec: number;
};

type WebsocketRequest = {
	headers: Record<string, string | string[] | undefined>;
	params: Record<string, string>;
	url?: string;
	ws: { end: (chunk: string) => void; ended: string[] };
	head?: unknown;
};

type Options = {
	/** What `authenticate` answers - an id, or a refusal to relay. */
	auth?: { id?: string; status?: number; message?: string };
	/** Whether the editor's pty host has finished loading. */
	ready?: boolean;
	/** Terminal ids the pty host knows about. */
	terminals?: number[];
	slots?: number;
	/** Make the upgrade itself fail, the way a torn-down socket does. */
	upgradeThrows?: boolean;
	home?: string;
	terminalTimeoutSec?: number;
	maxTimeoutSec?: number;
};

const PROTOCOL = "composery-terminal-v1";

function api(options: Options = {}) {
	const {
		auth = { id: "key_one" },
		ready = true,
		terminals = [7],
		slots = 2,
		upgradeThrows = false,
		home = "/home/user",
		terminalTimeoutSec = 60,
		maxTimeoutSec = 24 * 60 * 60
	} = options;

	// The real slot limiter's arithmetic is tested next door in ratelimit.test.ts;
	// what matters here is that every path gives back what it took.
	const held = new Map<string, number>();
	const sessions = {
		tryAcquire(key = "global") {
			const current = held.get(key) ?? 0;
			if (current >= slots) return false;
			held.set(key, current + 1);
			return true;
		},
		release(key = "global") {
			const current = held.get(key) ?? 0;
			if (current <= 1) held.delete(key);
			else held.set(key, current - 1);
		}
	};

	const wsHandlers: ((req: WebsocketRequest) => Promise<void>)[] = [];
	const module = loadOverlayModule<{
		parseTerminalViewportMessage: (data: string) => unknown;
		TERMINAL_VIEWPORT_PROTOCOL: string;
	}>({
		source: new URL(
			"../../../../../../overlay/src/node/routes/api/terminals.ts",
			import.meta.url
		),
		dependencies: {
			"@coder/logger": {
				logger: {
					debug: () => undefined,
					error: () => undefined,
					info: () => undefined,
					warn: () => undefined
				}
			},
			express: {
				Router: () => ({
					use: () => undefined,
					get: () => undefined,
					post: () => undefined,
					patch: () => undefined,
					delete: () => undefined
				})
			},
			ws: {
				// Accepting the upgrade is where this test stops: what happens on a
				// live socket is the pty host's, and it is not reachable from here.
				// Not calling the callback leaves the connection admitted and the
				// slot held, which is exactly what the assertions below read.
				default: {
					Server: class {
						handleUpgrade() {
							if (upgradeThrows) throw new Error("socket gone");
						}
					}
				},
				Server: class {
					handleUpgrade() {
						if (upgradeThrows) throw new Error("socket gone");
					}
				}
			},
			"../../wsRouter": {
				Router: () => ({
					ws: (_path: string, ...handlers: unknown[]) => {
						const handler = handlers[handlers.length - 1];
						wsHandlers.push(
							handler as (req: WebsocketRequest) => Promise<void>
						);
					}
				})
			},
			"../vscode": {
				ensureVSCodeLoaded: () => undefined,
				ptyService: () =>
					ready
						? {
								listProcesses: () =>
									Promise.resolve(
										terminals.map((id) => ({
											id,
											title: `terminal ${id}`,
											cwd: home,
											pid: 100 + id,
											isOrphan: false
										}))
									)
							}
						: undefined
			},
			"./auth": { authenticate: () => Promise.resolve(auth) },
			"./config": {
				apiConfig: { home, terminalTimeoutSec },
				MAX_TERMINAL_TIMEOUT_SEC: maxTimeoutSec
			},
			"./constants": { apiBasePath: "/_composery/api/v1" },
			"./ratelimit": { sessions }
		},
		globals: {
			Buffer,
			JSON,
			Math,
			URL,
			console,
			process: { env: { PATH: "/usr/bin" }, cwd: () => "/proc/cwd" },
			setTimeout,
			clearTimeout
		}
	});

	function request(
		overrides: Partial<WebsocketRequest> = {}
	): WebsocketRequest {
		const ended: string[] = [];
		return {
			headers: { "sec-websocket-protocol": PROTOCOL },
			params: { id: "7" },
			url: "/_composery/api/v1/terminals/7",
			ws: {
				ended,
				end: (chunk: string) => {
					ended.push(chunk);
				}
			},
			...overrides
		};
	}

	return {
		...module.exports,
		bind: <T>(name: string) => module.binding<T>(name),
		request,
		heldBy: (key: string) => held.get(key) ?? 0,
		connect: async (overrides: Partial<WebsocketRequest> = {}) => {
			const req = request(overrides);
			const handler = wsHandlers[0];
			if (!handler) throw new Error("no websocket route registered");
			await handler(req);
			return req;
		}
	};
}

const status = (req: WebsocketRequest) =>
	Number(/HTTP\/1\.1 (\d+)/.exec(req.ws.ended[0] ?? "")?.[1] ?? 0);

describe("what a terminal may be asked for", () => {
	// A screen is not a thousand columns. The pty host allocates against these,
	// so an unbounded value is a resource ask dressed as a preference.
	test("bounds the size to something a terminal could be", () => {
		const resolve =
			api().bind<(value: unknown, fallback: number) => number>(
				"resolveDimension"
			);

		expect(resolve(undefined, 80)).toBe(80);
		expect(resolve(1, 80)).toBe(1);
		expect(resolve(1000, 80)).toBe(1000);
		for (const value of [0, -1, 1001, 1.5, "80", null, Number.NaN, Infinity]) {
			expect(() => resolve(value, 80), String(value)).toThrow(/1 to 1000/);
		}
	});

	// The ceiling belongs to the instance, not the caller: a request may ask for
	// less and never for more, so a held-open terminal cannot outlive it.
	test("never lets a caller ask for longer than the instance allows", () => {
		const box = api({ terminalTimeoutSec: 60, maxTimeoutSec: 3600 });
		const resolve = box.bind<(value: unknown) => number>("resolveTimeoutSec");

		expect(resolve(30)).toBe(30);
		expect(resolve(99_999)).toBe(3600);
		// Anything that is not a positive number is the configured default, not
		// zero - a timeout of zero would kill every terminal as it started.
		for (const value of [undefined, 0, -5, "30", null, Number.NaN]) {
			expect(resolve(value), String(value)).toBe(60);
		}
	});

	test("takes an environment only as strings", () => {
		const resolve =
			api().bind<(value: unknown) => Record<string, string> | undefined>(
				"resolveEnv"
			);

		expect(resolve(undefined)).toBeUndefined();
		expect(resolve({ FOO: "bar" })).toEqual({ FOO: "bar" });
		for (const value of [{ FOO: 1 }, { FOO: null }, [], "FOO=bar", 5]) {
			expect(() => resolve(value), JSON.stringify(value)).toThrow(
				/object with string values/
			);
		}
	});

	test("resolves a home-relative directory against the owner's home", () => {
		const resolve = api({ home: "/home/user" }).bind<
			(value: unknown) => string
		>("resolveCwd");

		expect(resolve("~")).toBe("/home/user");
		// Joined the way the module joins it: the box is Linux, but the test runs
		// wherever it runs, and `path.join` is what decides the separator.
		expect(resolve("~/projects")).toBe(join("/home/user", "projects"));
		expect(resolve("/srv/app")).toBe("/srv/app");
		// Nothing usable falls back to home rather than to wherever the server
		// happens to be running.
		for (const value of [undefined, "", "   ", 5, null]) {
			expect(resolve(value), String(value)).toBe("/home/user");
		}
	});

	test("refuses a body whose flags are not what they claim", () => {
		const resolve = api().bind<(body: unknown) => Resolved>("resolveCreate");

		expect(resolve({})).toMatchObject({
			cols: 80,
			rows: 24,
			hidden: false,
			wait: false
		});
		expect(() => resolve({ command: "" })).toThrow(/non-empty string/);
		expect(() => resolve({ command: 5 })).toThrow(/non-empty string/);
		expect(() => resolve({ title: 5 })).toThrow(/title must be a string/);
		expect(() => resolve({ hidden: "yes" })).toThrow(
			/hidden must be a boolean/
		);
		expect(() => resolve({ wait: "yes" })).toThrow(/wait must be a boolean/);
	});
});

// A terminal id arrives as a path segment, so it is a string until this says
// otherwise - and it addresses somebody's running shell.
describe("naming a terminal", () => {
	test("accepts only a plain positive integer", () => {
		const parse =
			api().bind<(value: unknown) => number | undefined>("parseTerminalId");

		expect(parse("7")).toBe(7);
		for (const value of [
			"0",
			"-1",
			"07",
			"1.0",
			"1e3",
			" 7",
			"7 ",
			"",
			"abc",
			"7abc",
			7,
			null,
			undefined
		]) {
			expect(parse(value), JSON.stringify(value)).toBeUndefined();
		}
	});
});

// The control channel a connected client uses to say the window changed. It is
// the one message the server takes from the socket, so it is parsed rather than
// trusted.
describe("the viewport control message", () => {
	test("takes a resize with dimensions that could be a terminal", () => {
		const box = api();

		expect(
			box.parseTerminalViewportMessage('{"type":"resize","cols":100,"rows":40}')
		).toEqual({ type: "resize", cols: 100, rows: 40 });
	});

	test("refuses anything else", () => {
		const box = api();

		expect(() => box.parseTerminalViewportMessage("not json")).toThrow(
			/valid JSON/
		);
		expect(() => box.parseTerminalViewportMessage("[]")).toThrow(
			/must be an object/
		);
		expect(() => box.parseTerminalViewportMessage("null")).toThrow(
			/must be an object/
		);
		expect(() => box.parseTerminalViewportMessage('{"type":"exec"}')).toThrow(
			/must be "resize"/
		);
		expect(() =>
			box.parseTerminalViewportMessage(
				'{"type":"resize","cols":99999,"rows":40}'
			)
		).toThrow(/1 to 1000/);
	});
});

// Retrying a create must not start a second shell, so a repeated key returns the
// first answer. The map that remembers them is reachable by anyone with a key,
// so its size is the thing to watch.
describe("remembering an answer for a retried create", () => {
	test("does not let the order keys were typed in change the request", () => {
		const fingerprint =
			api().bind<(create: unknown) => string>("requestFingerprint");
		const create = { command: "ls", cols: 80, rows: 24 };

		expect(fingerprint({ ...create, env: { A: "1", B: "2" } })).toBe(
			fingerprint({ ...create, env: { B: "2", A: "1" } })
		);
		expect(fingerprint({ ...create, env: { A: "1" } })).not.toBe(
			fingerprint({ ...create, env: { A: "2" } })
		);
	});

	test("keeps a bounded number of them", () => {
		const box = api();
		const remember =
			box.bind<(key: string, fingerprint: string, response: unknown) => void>(
				"rememberResponse"
			);
		const store = box.bind<Map<string, unknown>>("idempotency");
		const max = box.bind<number>("IDEMPOTENCY_MAX_RESULTS");

		for (let index = 0; index < max + 500; index += 1) {
			remember(`key-${index}`, "fingerprint", { status: 201 });
		}

		expect(store.size).toBe(max);
		// The oldest are what fall out, so a caller retrying a recent create still
		// gets its answer rather than a second shell.
		expect(store.has("key-0")).toBe(false);
		expect(store.has(`key-${max + 499}`)).toBe(true);
	});
});

// Opening the stream. Every refusal below happens before a shell is attached,
// and the order is the point: nothing about the terminal is revealed to someone
// who has not authenticated.
describe("admission to a terminal stream", () => {
	test("refuses an unauthenticated caller before anything else", async () => {
		const box = api({
			auth: { status: 401, message: "Invalid or missing API key" }
		});
		const req = await box.connect({ params: { id: "7" } });

		expect(status(req)).toBe(401);
		expect(box.heldBy("key_one")).toBe(0);
	});

	test("relays being rate limited rather than calling it unauthorized", async () => {
		const box = api({
			auth: { status: 429, message: "Too many failed attempts" }
		});

		expect(status(await box.connect())).toBe(429);
	});

	test("says the editor is not ready rather than that the terminal is missing", async () => {
		const box = api({ ready: false });

		expect(status(await box.connect())).toBe(503);
	});

	test("answers the same for a terminal that is not there and one that never could be", async () => {
		const box = api({ terminals: [7] });

		expect(status(await box.connect({ params: { id: "8" } }))).toBe(404);
		expect(status(await box.connect({ params: { id: "abc" } }))).toBe(404);
		expect(status(await box.connect({ params: { id: "-1" } }))).toBe(404);
	});

	// The subprotocol is what says the client speaks this control channel. A
	// browser that connects without it would otherwise be handed a live shell
	// and no way to tell the server its window size.
	test("requires the terminal subprotocol", async () => {
		const box = api();

		expect(status(await box.connect({ headers: {} }))).toBe(400);
		expect(
			status(
				await box.connect({ headers: { "sec-websocket-protocol": "chat" } })
			)
		).toBe(400);
		// ...and accepts it alongside others, which is how a browser offers a list.
		const box2 = api();
		const accepted = await box2.connect({
			headers: { "sec-websocket-protocol": `chat, ${PROTOCOL}` }
		});
		expect(accepted.ws.ended).toEqual([]);
		expect(box2.heldBy("key_one")).toBe(1);
	});

	test("refuses once a key is holding all the streams it may", async () => {
		const box = api({ slots: 1 });
		await box.connect();

		expect(status(await box.connect())).toBe(429);
	});

	// The one that would be permanent. The slot is taken before the query string
	// is parsed, so a refusal after that point has to give it back - otherwise
	// repeating a malformed request burns the owner's whole budget for good.
	test("gives the slot back when it refuses after taking one", async () => {
		const box = api({ slots: 2 });

		const req = await box.connect({
			url: "/_composery/api/v1/terminals/7?cols=80"
		});

		expect(status(req)).toBe(400);
		expect(box.heldBy("key_one")).toBe(0);
	});

	// The same rule one step later: the slot is taken, the upgrade fails, and it
	// still has to come back.
	test("gives the slot back when the upgrade itself fails", async () => {
		const box = api({ upgradeThrows: true });
		const req = await box.connect();

		expect(status(req)).toBe(500);
		expect(box.heldBy("key_one")).toBe(0);
	});

	test("still refuses a size no terminal could have", async () => {
		const box = api();
		const req = await box.connect({
			url: "/_composery/api/v1/terminals/7?cols=99999&rows=24"
		});

		expect(status(req)).toBe(400);
		expect(box.heldBy("key_one")).toBe(0);
	});
});
