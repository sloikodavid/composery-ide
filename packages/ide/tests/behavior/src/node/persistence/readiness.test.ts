import { describe, expect, test, vi } from "vitest";

import { loadOverlayModule } from "../../../../support/overlay.ts";

type Readiness = {
	checkPersistenceReadiness: () => Promise<{
		ready: boolean;
		message: string;
		updatedAt?: string;
	}>;
	healthHttpStatus: (alive: boolean, persistenceReady: boolean) => 200 | 503;
	renderStartupPage: (healthUrl: string) => string;
};

// Whether the box may serve yet.
//
// Persistence is what makes a box's files survive; until it says it is ready,
// the editor must not be reachable, because a session started before it is up
// writes into a filesystem that will be replaced. Every branch below therefore
// fails *closed* - anything unreadable, unparseable or incomplete is "not
// ready", never "probably fine".

type FileStub = {
	content?: string;
	isFile?: boolean;
	error?: { code?: string };
};

function load(file: FileStub, now: () => number = () => 0) {
	const close = vi.fn(() => Promise.resolve(undefined));
	const open = vi.fn(() => {
		if (file.error) {
			// A real Error carrying the errno, because that is what the module
			// branches on and what `fs` would actually throw.
			const error = Object.assign(new Error("open failed"), file.error);
			return Promise.reject(error);
		}
		return Promise.resolve({
			stat: () => Promise.resolve({ isFile: () => file.isFile ?? true }),
			readFile: () => Promise.resolve(file.content ?? ""),
			close
		});
	});
	const module = loadOverlayModule<Readiness>({
		source: new URL(
			"../../../../../overlay/src/node/persistence/readiness.ts",
			import.meta.url
		),
		dependencies: {
			fs: { constants: { O_RDONLY: 0, O_NOFOLLOW: 0 }, promises: { open } }
		},
		globals: { performance: { now } }
	});
	return { close, open, ...module.exports };
}

describe("reading the persistence ready file", () => {
	test("reports ready only on a complete, affirmative file", async () => {
		const { checkPersistenceReadiness } = load({
			content: JSON.stringify({
				ready: true,
				updatedAt: "2026-07-30T00:00:00Z"
			})
		});

		expect(await checkPersistenceReadiness()).toEqual({
			ready: true,
			message: "persistence is ready",
			updatedAt: "2026-07-30T00:00:00Z"
		});
	});

	// The ordinary case during boot: the file is not there yet. It is not an
	// error, and saying so is what keeps the startup page from looking broken.
	test("reads a missing file as still starting", async () => {
		const { checkPersistenceReadiness } = load({ error: { code: "ENOENT" } });

		expect(await checkPersistenceReadiness()).toEqual({
			ready: false,
			message: "persistence is starting"
		});
	});

	test("reads any other open failure as unreadable, not as starting", async () => {
		const { checkPersistenceReadiness } = load({ error: { code: "EACCES" } });

		expect(await checkPersistenceReadiness()).toMatchObject({
			ready: false,
			message: "persistence ready file cannot be read"
		});
	});

	// The owner is root inside their own box, so the path could be swapped for a
	// directory or a symlink. It is opened O_NOFOLLOW and checked to be a regular
	// file, and anything else is refused rather than read.
	test("refuses a path that is not a regular file", async () => {
		const { checkPersistenceReadiness } = load({ isFile: false });

		expect(await checkPersistenceReadiness()).toMatchObject({
			ready: false,
			message: "persistence ready file cannot be read"
		});
	});

	test("closes the file even when it turns out to be unusable", async () => {
		const { checkPersistenceReadiness, close } = load({ isFile: false });

		await checkPersistenceReadiness();

		expect(close).toHaveBeenCalled();
	});

	test("refuses a file that is not JSON", async () => {
		const { checkPersistenceReadiness } = load({ content: "not json" });

		expect(await checkPersistenceReadiness()).toMatchObject({
			message: "persistence ready file is invalid"
		});
	});

	// `ready` has to be exactly true. A truthy string or a 1 is a file written by
	// something other than the daemon, and guessing its intent is how a box comes
	// up before its files do.
	test("requires ready to be exactly true", async () => {
		for (const ready of ["true", 1, {}, null]) {
			const { checkPersistenceReadiness } = load({
				content: JSON.stringify({ ready, updatedAt: "2026-07-30T00:00:00Z" })
			});
			expect(await checkPersistenceReadiness()).toMatchObject({
				ready: false,
				message: "persistence is starting"
			});
		}
	});

	test("refuses a ready file with no usable timestamp", async () => {
		for (const updatedAt of [undefined, "", 12345]) {
			const { checkPersistenceReadiness } = load({
				content: JSON.stringify({ ready: true, updatedAt })
			});
			expect(await checkPersistenceReadiness()).toMatchObject({
				ready: false,
				message: "persistence ready file is invalid"
			});
		}
	});
});

describe("the health route status", () => {
	test("reports healthy only when persistence and the IDE heartbeat are ready", () => {
		const { healthHttpStatus } = load({ error: { code: "ENOENT" } });

		expect(healthHttpStatus(true, true)).toBe(200);
		expect(healthHttpStatus(false, true)).toBe(503);
		expect(healthHttpStatus(true, false)).toBe(503);
		expect(healthHttpStatus(false, false)).toBe(503);
	});
});

// Every request while the box is starting asks this, so the answer is cached -
// but the cache is aged on a monotonic clock, deliberately. Civil time moves
// backwards after an NTP correction, and a cache aged on it would then never
// expire, leaving a box that is ready reporting "starting" for ever. The stub
// below drives that clock directly, which is why this file pins no timers.
describe("caching the answer", () => {
	test("reads the file once inside the cache window", async () => {
		let now = 0;
		const { checkPersistenceReadiness, open } = load(
			{ error: { code: "ENOENT" } },
			() => now
		);

		await checkPersistenceReadiness();
		now = 999;
		await checkPersistenceReadiness();

		expect(open).toHaveBeenCalledTimes(1);
	});

	test("reads again once the window has elapsed", async () => {
		let now = 0;
		const { checkPersistenceReadiness, open } = load(
			{ error: { code: "ENOENT" } },
			() => now
		);

		await checkPersistenceReadiness();
		now = 1000;
		await checkPersistenceReadiness();

		expect(open).toHaveBeenCalledTimes(2);
	});
});

describe("the startup page", () => {
	// The page is served in place of the editor, so its only job is to come back
	// on its own once the box is ready.
	test("polls the health URL it was given and reloads", () => {
		const page = renderStartup("/healthz?probe=1");

		expect(page).toContain('"/healthz?probe=1"');
		expect(page).toContain("location.reload()");
		// The retry interval, without writing a timer call this file does not make.
		expect(page).toContain("waitUntilReady, 1000)");
		expect(page).toContain('cache: "no-store"');
	});

	// The URL is interpolated into a script, so it is JSON-encoded rather than
	// pasted: a quote in it would otherwise end the string and run whatever
	// followed.
	test("encodes the URL rather than pasting it into the script", () => {
		expect(renderStartup('/a"+alert(1)+"')).toContain(
			JSON.stringify('/a"+alert(1)+"')
		);
	});
});

function renderStartup(healthUrl: string) {
	return load({ error: { code: "ENOENT" } }).renderStartupPage(healthUrl);
}
