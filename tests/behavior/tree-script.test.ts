import {
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
	vi,
	type MockInstance
} from "vitest";

import {
	compareEntries,
	entryLabel,
	GIT_FILE_ARGS,
	linkTarget,
	MODES,
	syncTick
} from "../../scripts/tree.mjs";

// The watch reads this file, renders the tree into it and writes it back, and
// both halves of that have failed on a real machine. The file system is stubbed
// so a test can put either failure under the tick.
const fs = vi.hoisted(() => ({
	contents: "",
	rename: vi.fn(),
	write: vi.fn()
}));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	readFileSync: () => fs.contents,
	renameSync: fs.rename,
	writeFileSync: fs.write
}));

describe("tree watch", () => {
	let warn: MockInstance<typeof console.warn>;

	// `mockReset`, not `mockClear`: a refused write set in one test is an
	// implementation, and tests here run in a seeded order, so a cleared-but-kept
	// one refuses in whichever test runs next.
	beforeEach(() => {
		fs.rename.mockReset();
		fs.write.mockReset();
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warn.mockRestore();
	});

	// A read of nothing is a file another process is part way through writing -
	// `git checkout`, a rebase, an editor, a rewrite script. Rendered into, it takes
	// every convention above the markers with it and leaves the tree alone in the
	// file. That happened, and the watch reported success while doing it.
	//
	// The silent return is the whole of it: a tick that throws on the empty read
	// also writes nothing, so the warning has to stay unused for this to be the
	// guard rather than the accident.
	test("writes nothing when the file reads as empty", () => {
		fs.contents = "";

		expect(syncTick()).toBe(false);
		expect(fs.write).not.toHaveBeenCalled();
		expect(fs.rename).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	// Windows refuses about one write in ten here, because something always holds
	// this file open. Uncaught, that ended the watch and took `pnpm dev` with it.
	test("survives a write the operating system refuses", () => {
		fs.contents = "# Conventions\n";
		fs.write.mockImplementation(() => {
			throw Object.assign(new Error("UNKNOWN: unknown error, open"), {
				code: "UNKNOWN"
			});
		});

		expect(syncTick()).toBe(false);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("UNKNOWN"));
		expect(fs.rename).not.toHaveBeenCalled();
	});

	// The staged file is renamed over the target, so no reader can catch this
	// file empty - the watch itself is one of those readers.
	test("replaces the file by renaming a staged copy over it", () => {
		fs.contents = "# Conventions\n";

		expect(syncTick()).toBe(true);
		expect(fs.write).toHaveBeenCalledWith(
			expect.stringContaining("tmp"),
			expect.stringContaining("<!-- tree:start -->")
		);
		expect(fs.rename).toHaveBeenCalledWith(
			expect.stringContaining("tmp"),
			expect.stringContaining("AGENTS.md")
		);
	});
});

describe("tree path discovery", () => {
	test("includes unstaged new files but not ignored scratch", () => {
		expect(GIT_FILE_ARGS).toEqual([
			"ls-files",
			"--cached",
			"--others",
			"--exclude-standard",
			"--stage",
			"-z"
		]);
	});
});

// The listing goes into every agent's context as the map of the repository, so
// a path that is not what it looks like has to say so on its own line. Without
// the mode every one of these renders as an ordinary file: an agent edits
// `CLAUDE.md` rather than the `AGENTS.md` it points at, or a submodule's
// contents rather than a patch.
describe("tree entry labels", () => {
	test("names what a symlink points at", () => {
		expect(
			entryLabel({
				mode: MODES.symlink,
				name: "CLAUDE.md",
				target: "AGENTS.md",
				type: "file"
			})
		).toBe("CLAUDE.md -> AGENTS.md");
	});

	test("marks a submodule as a directory this repository does not own", () => {
		expect(
			entryLabel({ mode: MODES.submodule, name: "upstream", type: "directory" })
		).toBe("upstream/ (submodule)");
	});

	test("marks an executable file", () => {
		expect(
			entryLabel({ mode: MODES.executable, name: "run.sh", type: "file" })
		).toBe("run.sh*");
	});

	test("leaves an ordinary file and directory as they were", () => {
		expect(
			entryLabel({ mode: MODES.file, name: "index.ts", type: "file" })
		).toBe("index.ts");
		expect(
			entryLabel({ mode: MODES.file, name: "scripts", type: "directory" })
		).toBe("scripts/");
	});
});

// The target is stored relative to the link, and the tree is rooted, so a
// target reprinted verbatim points somewhere the reader has to work out - and
// one that leaves the repository points at whatever the checkout sits next to,
// which is a fact about a machine rather than about this repository.
describe("tree symlink targets", () => {
	const paths = new Set([
		"AGENTS.md",
		"packages/web/AGENTS.md",
		".agents/skills/nugget/SKILL.md"
	]);

	test("resolves the target against the tree's root", () => {
		expect(linkTarget("packages/web/CLAUDE.md", "AGENTS.md", paths)).toBe(
			"packages/web/AGENTS.md"
		);
	});

	test("marks a target that holds other paths as a directory", () => {
		expect(linkTarget(".claude/skills", "../.agents/skills", paths)).toBe(
			".agents/skills/"
		);
	});

	test("names a target outside the repository rather than printing it", () => {
		expect(linkTarget(".claude/skills", "../../elsewhere", paths)).toBe(
			"(outside this repository)"
		);
	});

	// Nothing in the index means nothing to point at, whichever side of the root
	// it fell on - a dangling link is not describable either.
	test("names a target the index does not hold", () => {
		expect(linkTarget("CLAUDE.md", "GONE.md", paths)).toBe(
			"(outside this repository)"
		);
	});
});

describe("tree entry ordering", () => {
	const dir = (name: string) => ({ name, type: "directory" as const });
	const file = (name: string) => ({ name, type: "file" as const });

	// "_components" vs "[id]" flips between en-US and en-US-POSIX collation. A
	// runtime-default locale (undefined) resolves to en-US locally but POSIX on a
	// LANG=C.UTF-8 CI runner, so the committed tree could never match on CI. The
	// pin must keep en-US order everywhere; this fails on CI if it regresses.
	test("sorts underscore before bracket regardless of environment locale", () => {
		expect(compareEntries(dir("_components"), dir("[id]"))).toBeLessThan(0);
	});

	test("directories sort before files", () => {
		expect(compareEntries(file("aaa.ts"), dir("zzz"))).toBeGreaterThan(0);
	});
});
