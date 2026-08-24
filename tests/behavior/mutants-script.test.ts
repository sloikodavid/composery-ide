import { afterEach, describe, expect, test, vi } from "vitest";

// `check:mutants` is the load-bearing check in this repository - the only one a
// test that merely runs cannot satisfy - so the way it fails matters as much as
// the way it passes. Reporting a Rust pass on a machine without cargo-mutants
// would be the exact shape of failure the script exists to prevent: green
// because nothing ran.
//
// The script has no exported entry point, so this drives it the way
// setup.test.ts drives setup.mjs - every side effect mocked, then imported.

const host = vi.hoisted(() => ({
	// `git <args>` -> stdout. Anything unlisted returns a failure, which is what
	// the real script sees for a ref that does not exist.
	git: new Map<string, string>(),
	cargoInstalled: true,
	// What the mutation config's globs resolve to in the checkout.
	mutable: [] as string[],
	spawns: [] as string[],
	exits: [] as number[],
	errors: [] as string[],
	logs: [] as string[],
	writes: [] as { path: string; contents: string }[]
}));

vi.mock("node:child_process", () => ({
	spawnSync: (command: string, args: string[]) => {
		host.spawns.push([command, ...args].join(" "));
		if (command === "git") {
			const stdout = host.git.get(args.join(" "));
			return stdout === undefined ? { status: 1 } : { status: 0, stdout };
		}
		if (command === "cargo" && args[0] === "mutants") {
			return { status: host.cargoInstalled ? 0 : 1 };
		}
		return { status: 0 };
	}
}));

vi.mock("node:fs", () => ({
	mkdirSync: () => undefined,
	writeFileSync: (path: string, contents: string) =>
		host.writes.push({ path: String(path), contents: String(contents) }),
	readFileSync: () =>
		JSON.stringify({
			mutate: ["packages/web/convex/**/*.ts", "!**/_generated/**"],
			thresholds: { high: 80, low: 60, break: 0 }
		}),
	// A glob is Node's to resolve. What this file constrains is the step after:
	// which of the changed files the run is allowed to mutate.
	globSync: () => host.mutable
}));

// One added hunk per mutable file unless a test supplies its own. The script
// asks git per file, so each key names one file and the diffs are keyed the same
// way rather than written out.
function arrange(changed: string[], diffs: Record<string, string> = {}) {
	host.git.clear();
	host.git.set("merge-base origin/main HEAD", "abc1234def\n");
	host.git.set(
		"diff --name-only --diff-filter=d abc1234def",
		`${changed.join("\n")}\n`
	);
	host.git.set("diff abc1234def -- packages/cli", "a diff\n");

	for (const file of changed.filter((f) => host.mutable.includes(f))) {
		host.git.set(
			`diff --unified=0 abc1234def -- ${file}`,
			diffs[file] ?? `--- a/${file}\n+++ b/${file}\n@@ -12,0 +12,3 @@\n`
		);
	}
	host.spawns = [];
	host.exits = [];
	host.errors = [];
	host.logs = [];
	host.writes = [];

	vi.spyOn(console, "error").mockImplementation((message: unknown) => {
		host.errors.push(String(message));
	});
	// Captured, not swallowed. A run that mutates nothing reports it by saying so
	// and in no other way - the exit code is 0 either way - so the sentence is the
	// result, and a test that ignores it is reading none.
	vi.spyOn(console, "log").mockImplementation((message: unknown) => {
		host.logs.push(String(message));
	});
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		host.exits.push(code ?? 0);
		// The real script stops here; the mock has to as well, or the lines after
		// the guard run and the test asserts about a state that cannot happen.
		throw new Exited();
	}) as never);
}

afterEach(() => {
	vi.restoreAllMocks();
});

// A distinct type rather than a message string: catching by message would also
// swallow a genuine failure that happened to say "exit".
class Exited extends Error {}

async function runScript() {
	vi.resetModules();
	try {
		// @ts-expect-error The behavior-tested JavaScript entry point has no declaration file.
		await import("../../scripts/mutants.mjs");
	} catch (error) {
		if (!(error instanceof Exited)) throw error;
	}
}

describe("check:mutants", () => {
	test("refuses to report a Rust pass when cargo-mutants is missing", async () => {
		host.cargoInstalled = false;
		arrange(["packages/cli/crates/persistence/src/apply.rs"]);

		await runScript();

		expect(host.exits).toEqual([1]);
		expect(host.errors.join("\n")).toContain("cargo-mutants is not installed");
		// The point of the guard: it must not have gone on to claim a result.
		expect(
			host.spawns.some((call) =>
				call.startsWith("cargo mutants --manifest-path")
			)
		).toBe(false);
	});

	test("runs cargo-mutants over the changed Rust when it is installed", async () => {
		host.cargoInstalled = true;
		arrange(["packages/cli/crates/persistence/src/apply.rs"]);

		await runScript();

		expect(host.exits).toEqual([]);
		expect(
			host.spawns.some((call) =>
				call.startsWith("cargo mutants --manifest-path")
			)
		).toBe(true);
		// Scoped to the diff, which is what keeps a per-change run affordable.
		expect(host.spawns.join("\n")).toContain("--in-diff");
	});

	test("mutates no Rust when the change touches none", async () => {
		host.cargoInstalled = true;
		arrange(["docs/configuration.md"]);

		await runScript();

		expect(host.spawns.some((call) => call.startsWith("cargo"))).toBe(false);
		expect(host.exits).toEqual([]);
	});

	test("mutates only the changed files the mutation config already claims", async () => {
		host.mutable = ["packages/web/convex/boxes/operation/record.ts"];
		arrange([
			"packages/web/convex/boxes/operation/record.ts",
			// Real source, changed, and deliberately outside the `mutate` set: no
			// test covers it, so every mutant would survive by construction and the
			// gate would fail on a list nobody could ever kill.
			"packages/web/app/(site)/page.tsx"
		]);

		await runScript();

		const written = host.writes.find((w) => w.path.endsWith(".json"));
		expect(JSON.parse(written?.contents ?? "{}")).toMatchObject({
			// Lines, not the file. `break: 100` holds only because the scope is what
			// this change introduced; the whole file asks a full score of code the
			// change never touched, which is how a small edit came to need tests for
			// 176 mutants it did not write.
			mutate: ["packages/web/convex/boxes/operation/record.ts:12-14"],
			// Raised for the diff run: a change may not introduce a survivor.
			thresholds: { break: 100 }
		});
	});

	test("mutates every added range, across files and hunks", async () => {
		const record = "packages/web/convex/boxes/operation/record.ts";
		const start = "packages/web/convex/boxes/operation/start.ts";
		host.mutable = [record, start];
		// Counts run past a single digit on both sides of the hunk header. With
		// `@@ -9,3 +9,5 @@` alone, a pattern reading one digit where it should read
		// several answers identically, and the test cannot tell them apart.
		arrange([record, start], {
			[record]: [
				`--- a/${record}`,
				`+++ b/${record}`,
				// No count at all means exactly one line - the spelling git uses most,
				// and the one an off-by-one reads straight past.
				"@@ -4 +4 @@",
				"@@ -20,14 +21,2 @@",
				""
			].join("\n"),
			[start]: [
				`--- a/${start}`,
				`+++ b/${start}`,
				"@@ -9,3 +9,12 @@",
				// An added line carrying a hunk header of its own. git writes it with a
				// `+` in front, so only the anchor keeps it from being read as one.
				"+@@ -777,7 +777,7 @@",
				""
			].join("\n")
		});

		await runScript();

		const written = host.writes.find((w) => w.path.endsWith(".json"));
		const config = JSON.parse(written?.contents ?? "{}") as {
			mutate?: string[];
		};
		expect(config.mutate).toEqual([
			`${record}:4-4`,
			`${record}:21-22`,
			`${start}:9-20`
		]);
	});

	test("contributes no range for a file git will not diff", async () => {
		const record = "packages/web/convex/boxes/operation/record.ts";
		host.mutable = [record];
		arrange([record]);
		// git named the file and then refuses to diff it. The pair cannot normally
		// disagree, which is the point: the answer has to stay "no lines added"
		// rather than become a crash on `undefined`.
		host.git.delete(`diff --unified=0 abc1234def -- ${record}`);

		await runScript();

		expect(host.spawns.some((call) => call.includes("stryker"))).toBe(false);
		expect(host.logs).toContain(
			"No added TypeScript lines; nothing to mutate."
		);
		expect(host.exits).toEqual([]);
	});

	test("mutates nothing when the change only deletes lines", async () => {
		const record = "packages/web/convex/boxes/operation/record.ts";
		host.mutable = [record];
		arrange([record], {
			[record]: [
				`--- a/${record}`,
				`+++ b/${record}`,
				// `+12,0` adds no line. Mutating `12-11` is a range Stryker rejects,
				// and a deleted line cannot hold a mutant anyway.
				"@@ -12,3 +12,0 @@",
				""
			].join("\n")
		});

		await runScript();

		expect(host.spawns.some((call) => call.includes("stryker"))).toBe(false);
		expect(host.logs).toContain(
			"No added TypeScript lines; nothing to mutate."
		);
		expect(host.exits).toEqual([]);
	});

	test("runs no mutation when every changed file is outside the mutate set", async () => {
		host.mutable = [];
		arrange(["packages/web/app/(site)/page.tsx"]);

		await runScript();

		expect(host.spawns.some((call) => call.includes("stryker"))).toBe(false);
		// A different sentence from the deletion-only case above, and the pair is
		// what separates them: "nothing to mutate" is the same exit code whether no
		// mutable file changed or one did and added no line. Only the wording says
		// which, so only the wording can be wrong.
		expect(host.logs).toContain(
			"No TypeScript source changed; nothing to mutate."
		);
		// Nothing to ask git about either, so it is never asked.
		expect(host.spawns.some((call) => call.includes("--unified=0"))).toBe(
			false
		);
		expect(host.exits).toEqual([]);
	});
});
