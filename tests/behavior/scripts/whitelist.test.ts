import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
	checkRepository,
	checkWhitelist,
	createWhitelist,
	writeRepositoryWhitelist
} from "../../../scripts/whitelist.mjs";

import { repoRoot } from "../../support/repo.ts";

const text = (path: string, contents = "") => ({
	path,
	contents: Buffer.from(contents)
});

describe("source whitelist", () => {
	test("checks every filename character without interpreting extensions", () => {
		expect(createWhitelist({ sources: [text("123.test.ts")] })).toEqual([
			".",
			"1",
			"2",
			"3",
			"test",
			"ts"
		]);
	});

	test("uses deterministic identifier boundaries", () => {
		const entries = createWhitelist({
			sources: [
				text(
					"source",
					"ApiOperation APIOperation api_operation win32AppId 100px"
				)
			]
		});

		expect(entries).toEqual([
			" ",
			"0",
			"1",
			"2",
			"3",
			"_",
			"api",
			"app",
			"id",
			"operation",
			"px",
			"source",
			"win"
		]);
	});

	test("lets an existing exact run override generic splitting", () => {
		const entries = createWhitelist({
			existing: ["iPhone"],
			sources: [text("source", "iPhone ApiOperation")]
		});

		expect(entries).toContain("iPhone");
		expect(entries).not.toContain("i");
		expect(entries).not.toContain("phone");
		expect(entries).toContain("api");
		expect(entries).toContain("operation");
	});

	test("one lowercase entry accepts regular lowercase, Titlecase, and uppercase forms", () => {
		const entries = createWhitelist({
			sources: [text("source", "API Api api Kubernetes")]
		});

		expect(entries).toContain("api");
		expect(entries).toContain("kubernetes");
		expect(entries).not.toContain("API");
		expect(
			checkWhitelist({
				entries: [" ", "api", "source"],
				sources: [text("source", "api Api API")]
			})
		).toEqual([]);
	});

	test("keeps irregular casing exact", () => {
		const result = checkWhitelist({
			entries: ["source", " ", "iPhone"],
			sources: [text("source", "iPhone iphone Iphone IPHONE")]
		});

		expect(result).toContain('  "iphone"');
	});

	test("records whitespace and complete Unicode grapheme clusters", () => {
		const entries = createWhitelist({
			sources: [text("source", " \t\n→1️⃣👩‍💻👨‍👩‍👧‍👦🇮🇪é")]
		});

		expect(entries).toEqual([
			"\t",
			"\n",
			" ",
			"1️⃣",
			"é",
			"source",
			"→",
			"🇮🇪",
			"👨‍👩‍👧‍👦",
			"👩‍💻"
		]);
	});

	test("accepts standard CSS colors structurally without listing them", () => {
		expect(
			createWhitelist({
				sources: [text("source", "#fff #ffffff #12AbEf80")]
			})
		).toEqual([" ", "source"]);
	});

	// Every pinned digest in the repository used to donate a handful of fragments
	// like "ddec" to the vocabulary, and a bump orphaned those and proposed more.
	// The second half is the one that can fail: the rule is bounded to the three
	// digest lengths, so a run one character short is still read as an identifier
	// and still asks its question. Without that bound this would quietly stop
	// reading every lowercase hexadecimal name in the repository.
	test("accepts content-addressed digests structurally without listing them", () => {
		const commit = "3d3c42e5aac5ba805825da76410c181273ba90b1";
		const image =
			"ac39e4b5fcb2b1b34b20364fd58b2e898f3bb80731ee6f62a7536f9df3d6aadc";

		expect(
			createWhitelist({ sources: [text("source", `${commit} ${image}`)] })
		).toEqual([" ", "source"]);

		expect(
			createWhitelist({ sources: [text("source", commit.slice(0, 39))] })
		).not.toEqual(["source"]);
	});

	test("does not scan ignored text contents but still scans the filename", () => {
		const entries = createWhitelist({
			patterns: ["**/*.svg"],
			sources: [text("art/logo.svg", '<path d="M0 1z"/>')]
		});

		expect(entries).toEqual([".", "/", "art", "logo", "svg"]);
	});

	test("does not scan non-text contents but still scans the filename", () => {
		const entries = createWhitelist({
			sources: [{ path: "asset.bin", contents: Buffer.from([0, 255, 17]) }]
		});

		expect(entries).toEqual([".", "asset", "bin"]);
	});

	test("rejects stale ignore patterns", () => {
		expect(() =>
			createWhitelist({ patterns: ["**/*.svg"], sources: [text("source")] })
		).toThrow(".whitelistignore patterns match no files");
	});

	test("reports additions and removals", () => {
		const entries = createWhitelist({ sources: [text("source", "before")] });
		entries.push("unused");

		const result = checkWhitelist({
			entries,
			sources: [text("source", "after")]
		});

		expect(result).toEqual([
			"whitelist.jsonc is out of date.",
			"",
			"New entries (1):",
			'  "after"',
			"    source:1:1",
			"",
			"Removed entries (2):",
			'  "before"',
			'  "unused"',
			"",
			"Every new entry is a word this repository keeps. Change the source first:",
			"correct the typo or the name, or use a word the list already has.",
			"Only a word that carries a meaning no listed word carries is accepted with:",
			"  node scripts/whitelist.mjs --write --accept-new"
		]);
	});

	test("offers the plain write only when nothing is added", () => {
		const entries = createWhitelist({ sources: [text("source", "kept gone")] });

		expect(
			checkWhitelist({ entries, sources: [text("source", "kept kept")] })
		).toEqual([
			"whitelist.jsonc is out of date.",
			"",
			"Removed entries (1):",
			'  "gone"',
			"",
			"Accept the removals with:",
			"  pnpm fix:whitelist"
		]);
	});

	test("reports the first exact location in each affected file", () => {
		const entries = createWhitelist({
			sources: [text("first.ts", "known"), text("second.ts", "known")]
		});

		const result = checkWhitelist({
			entries,
			sources: [
				text("first.ts", "known\n  strangeentry"),
				text("second.ts", "strangeentry repeated strangeentry")
			]
		});

		expect(result).toContain('  "strangeentry"');
		expect(result).toContain("    first.ts:2:3");
		expect(result).toContain("    second.ts:1:1");
		expect(result).not.toContain("second.ts:1:23");
	});

	test("marks entries that come from filenames", () => {
		const result = checkWhitelist({
			entries: [],
			sources: [text("folder/newfilename.ts")]
		});

		expect(result).toContain('  "newfilename"');
		expect(result).toContain("    folder/newfilename.ts:1:1 (filename)");
	});

	test("scans a Git-link path but not its object ID or contents", () => {
		const entries = createWhitelist({
			sources: [
				{
					path: "upstream",
					gitlink: "0123456789abcdef0123456789abcdef01234567"
				}
			]
		});

		expect(entries).toEqual(["upstream"]);
	});

	test("discovers repository files and writes the ruling with a canonical dump", () => {
		mkdirSync(resolve(repoRoot, "tmp"), { recursive: true });
		const root = mkdtempSync(resolve(repoRoot, "tmp/whitelist-"));
		try {
			execFileSync("git", ["init", "--quiet"], { cwd: root });
			execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
			writeFileSync(resolve(root, ".gitignore"), "git-ignored.txt\n");
			writeFileSync(resolve(root, ".whitelistignore"), "**/*.opaque\n");
			writeFileSync(resolve(root, "tracked.txt"), "trackedword\n");
			writeFileSync(resolve(root, "visible.txt"), "visibleword\n");
			writeFileSync(resolve(root, "data.opaque"), "random fixture bytes\n");
			writeFileSync(resolve(root, "git-ignored.txt"), "invisibleword\n");
			execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: root });

			const refused = writeRepositoryWhitelist(root);

			expect(refused).toMatchObject({ changed: false, blocked: true });
			expect(refused.additions).toContain("trackedword");
			expect(
				readFileSync(resolve(root, "whitelist.jsonc"), "utf8")
			).not.toContain("trackedword");

			const initialWrite = writeRepositoryWhitelist(root, { acceptNew: true });
			const written = readFileSync(resolve(root, "whitelist.jsonc"), "utf8");

			expect(initialWrite.changed).toBe(true);
			expect(initialWrite.additions).toContain("trackedword");
			expect(initialWrite.removals).toEqual([]);
			expect(written).toMatch(/^\/\*\nRuling:/);
			expect(written).toContain("trackedword");
			expect(written).toContain("visibleword");
			expect(written).not.toContain("invisibleword");
			expect(written).not.toContain("random fixture bytes");
			expect(checkRepository(root)).toEqual([]);
			expect(writeRepositoryWhitelist(root)).toEqual({
				changed: false,
				blocked: false,
				additions: [],
				removals: []
			});
			writeFileSync(
				resolve(root, "whitelist.jsonc"),
				written.replace("Ruling:", "Old ruling:")
			);
			expect(writeRepositoryWhitelist(root)).toEqual({
				changed: true,
				blocked: false,
				additions: [],
				removals: []
			});
			writeFileSync(resolve(root, "tracked.txt"), "changedword\n");
			expect(checkRepository(root).join("\n")).toContain(
				'New entries (1):\n  "changedword"\n    tracked.txt:1:1'
			);
			expect(writeRepositoryWhitelist(root)).toMatchObject({
				changed: false,
				blocked: true,
				additions: ["changedword"]
			});
			expect(readFileSync(resolve(root, "whitelist.jsonc"), "utf8")).toContain(
				"trackedword"
			);
			expect(writeRepositoryWhitelist(root, { acceptNew: true })).toMatchObject(
				{
					changed: true,
					blocked: false,
					additions: ["changedword"],
					removals: ["trackedword"]
				}
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
