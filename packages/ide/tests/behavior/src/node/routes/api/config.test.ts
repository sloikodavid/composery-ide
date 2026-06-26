import { describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../../support/overlay.ts";

type ApiConfig = {
	apiConfig: {
		enabled: boolean;
		shell: string;
		home: string | undefined;
		terminalTimeoutSec: number;
		terminalMaxOutput: number;
		rateRps: number;
		rateBurst: number;
		maxSessions: number;
		authFailPerMin: number;
	};
	keysPath: () => string;
	MAX_TERMINAL_TIMEOUT_SEC: number;
};

// What the box's HTTP API is allowed to do, read from the environment its owner
// controls.
//
// A cloud box's owner is root on their own host, so every one of these can be
// set to anything - which is exactly why each is clamped rather than trusted.
// The interesting cases are all the ones where the value is not a plausible
// number: nothing may turn a bound off, and nothing may silently become zero.
//
// Loaded through the overlay loader rather than imported directly, which
// `session.ts` can be. Vitest resolves this module fine; a direct import is
// refused by the *type* checker, and the whole reasoning lives once beside the
// coverage exclusion it causes, in vitest.config.ts.
function load(env: Record<string, string | undefined> = {}) {
	const globals = { process: { env, platform: process.platform } };
	// The real `envFlag`, not a stand-in: what "disabled" means is the whole
	// point of the case below, and that module is the one that decides it. The
	// loader resolves bare specifiers through Node, which cannot find a `.ts`
	// sibling by extensionless path, so it is loaded here and injected.
	const envFlag = loadOverlayModule<{ envFlag: (name: string) => boolean }>({
		source: new URL(
			"../../../../../../overlay/src/node/envFlag.ts",
			import.meta.url
		),
		globals
	}).exports;

	return loadOverlayModule<ApiConfig>({
		source: new URL(
			"../../../../../../overlay/src/node/routes/api/config.ts",
			import.meta.url
		),
		// Both are `.ts` siblings the loader's Node resolution cannot find by
		// extensionless path, so both are injected. `volume` is the module the API
		// and the SSH surface now share for the data root.
		dependencies: {
			"../../envFlag": envFlag,
			"../../volume": {
				volumeRoot: () =>
					globals.process?.env?.COMPOSERY_DOCKER_VOLUME_PATH?.trim() || "/data"
			}
		},
		globals
	}).exports;
}

describe("the API's own limits", () => {
	test("ships usable defaults with nothing configured", () => {
		const { apiConfig } = load();

		expect(apiConfig).toMatchObject({
			enabled: true,
			shell: "/bin/bash",
			terminalTimeoutSec: 60,
			rateRps: 50,
			rateBurst: 200,
			maxSessions: 50,
			authFailPerMin: 20
		});
	});

	test("takes a configured value", () => {
		const { apiConfig } = load({ COMPOSERY_API_RATE_RPS: "10" });

		expect(apiConfig.rateRps).toBe(10);
	});

	// The ceiling is the point: an owner may lower a limit but never raise it
	// past what the box can survive.
	test("clamps a value above its ceiling instead of accepting it", () => {
		const { apiConfig, MAX_TERMINAL_TIMEOUT_SEC } = load({
			COMPOSERY_API_TERMINAL_TIMEOUT: "999999999",
			COMPOSERY_API_RATE_RPS: "999999"
		});

		expect(apiConfig.terminalTimeoutSec).toBe(MAX_TERMINAL_TIMEOUT_SEC);
		expect(apiConfig.rateRps).toBe(1000);
	});

	// Zero, negative and nonsense all fall back to the default rather than
	// becoming a limit of nothing - a rate of 0 would refuse every request, and a
	// terminal timeout of 0 would kill every session immediately.
	test("falls back to the default on any value that is not a positive number", () => {
		for (const raw of ["0", "-1", "abc", "   ", "NaN"]) {
			const { apiConfig } = load({
				COMPOSERY_API_RATE_RPS: raw,
				COMPOSERY_API_MAX_SESSIONS: raw
			});
			expect(apiConfig.rateRps, raw).toBe(50);
			expect(apiConfig.maxSessions, raw).toBe(50);
		}
	});

	// A fraction is a legitimate rate but not a legitimate count, so counts floor
	// - and one that floors away takes the default rather than becoming a cap of
	// none.
	test("floors a count, and refuses one that floors to nothing", () => {
		expect(
			load({ COMPOSERY_API_MAX_SESSIONS: "7.9" }).apiConfig.maxSessions
		).toBe(7);
		expect(
			load({ COMPOSERY_API_MAX_SESSIONS: "0.4" }).apiConfig.maxSessions
		).toBe(50);
		expect(load({ COMPOSERY_API_RATE_RPS: "2.5" }).apiConfig.rateRps).toBe(2.5);
	});

	// Off on an explicit opt-in only, which fails towards leaving the API up
	// rather than disabling it on a value nobody meant.
	test("disables the API only on a value envFlag accepts", () => {
		expect(load({ COMPOSERY_DISABLE_API: "1" }).apiConfig.enabled).toBe(false);
		expect(load({ COMPOSERY_DISABLE_API: "TRUE" }).apiConfig.enabled).toBe(
			false
		);
		expect(load({ COMPOSERY_DISABLE_API: "yes" }).apiConfig.enabled).toBe(true);
		expect(load({ COMPOSERY_DISABLE_API: "0" }).apiConfig.enabled).toBe(true);
	});

	test("caps the terminal output buffer as well as the timeout", () => {
		const { apiConfig } = load({
			COMPOSERY_API_TERMINAL_MAX_OUTPUT: "999999999999"
		});

		expect(apiConfig.terminalMaxOutput).toBe(64 * 1024 * 1024);
	});

	test("follows the owner's shell when they have one", () => {
		const { apiConfig } = load({ SHELL: "/usr/bin/fish" });

		expect(apiConfig.shell).toBe("/usr/bin/fish");
	});
});

// Cross-language contract: the Rust keystore reads the same file.
describe("where the API keys live", () => {
	test("defaults to the box's data volume", () => {
		const { keysPath } = load();

		expect(posix(keysPath())).toBe("/data/api/keys.json");
	});

	test("follows a relocated volume", () => {
		const { keysPath } = load({
			COMPOSERY_DOCKER_VOLUME_PATH: "/mnt/box"
		});

		expect(posix(keysPath())).toBe("/mnt/box/api/keys.json");
	});
});

// The box is Linux; the separator here is whatever ran the test.
function posix(value: string) {
	return value.split(String.fromCharCode(92)).join("/");
}
