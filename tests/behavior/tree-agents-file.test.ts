import { describe, expect, test } from "vitest";

import {
	dropStrayTrees,
	renderAgentsFile,
	renderTree
} from "../../scripts/tree.mjs";

// Splicing the generated tree into AGENTS.md.
//
// This file is loaded into every agent's context, so a stale listing in it is
// handed out as fact. Two failure modes matter and neither is visible from
// reading the function: prose around the block must survive regeneration, and a
// second, unmanaged copy of the tree must not.

const START = "<!-- tree:start -->";
const FINISH = "<!-- tree:finish -->";
const NOTE =
	"> Live-updated by `scripts/tree.mjs` when `pnpm dev` or `pnpm dev:tree` is running. Manually update with `pnpm fix:tree`.";

const block = (body: string) =>
	[START, "", NOTE, "", "```text", body, "```", "", FINISH, ""].join("\n");

describe("regenerating the tree block", () => {
	test("replaces the managed block and keeps the prose around it", () => {
		const current = `# Conventions\n\nBefore.\n\n${block("old")}\nAfter.\n`;

		const next = renderAgentsFile(current, block("new"));

		expect(next).toContain("# Conventions");
		expect(next).toContain("Before.");
		expect(next).toContain("After.");
		expect(next).toContain("new");
		expect(next).not.toContain("old");
	});

	// A file that has never carried one gets it appended rather than losing what
	// was already there.
	test("appends the block to a file that has none", () => {
		const next = renderAgentsFile("# Conventions\n\nJust prose.\n", block("x"));

		expect(next).toContain("Just prose.");
		expect(next).toContain(START);
		expect(next).toContain(FINISH);
	});

	// Markers in the wrong order are not a block to splice into; treating them as
	// one would slice the file at a negative length and eat its contents.
	test("appends rather than splicing when the markers are inverted", () => {
		const current = `${FINISH}\nprose\n${START}\n`;

		const next = renderAgentsFile(current, block("x"));

		expect(next).toContain("prose");
		expect(next.endsWith("\n")).toBe(true);
	});

	test("ends with exactly one trailing newline", () => {
		const next = renderAgentsFile(`Before.\n\n${block("old")}\n`, block("new"));

		expect(next.endsWith("\n")).toBe(true);
		expect(next.endsWith("\n\n")).toBe(false);
	});
});

// A second copy of the tree is the dangerous one: the check only ever compared
// the managed block, so a stray copy could name deleted files for ever and
// nothing would say so.
describe("stray copies of the tree", () => {
	test("removes a copy that sits outside the markers", () => {
		const stray = `${NOTE}\n\n\`\`\`text\nstale\n\`\`\`\n\n`;
		const current = `# Conventions\n\n${stray}${block("current")}`;

		const cleaned = dropStrayTrees(current);

		expect(cleaned).not.toContain("stale");
		expect(cleaned).toContain("current");
		expect(cleaned).toContain("# Conventions");
	});

	test("removes every stray copy, not just the first", () => {
		const stray = `${NOTE}\n\n\`\`\`text\nstale\n\`\`\`\n\n`;
		const cleaned = dropStrayTrees(`${stray}middle\n${stray}${block("keep")}`);

		expect(cleaned).not.toContain("stale");
		expect(cleaned).toContain("middle");
		expect(cleaned).toContain("keep");
	});

	// The managed block carries the same note, so a scan that did not stop at the
	// start marker would delete the block it exists to maintain.
	test("leaves the managed block alone", () => {
		const current = `# Conventions\n\n${block("current")}`;

		expect(dropStrayTrees(current)).toBe(current);
	});

	test("leaves a file with no tree at all untouched", () => {
		expect(dropStrayTrees("# Conventions\n\nprose\n")).toBe(
			"# Conventions\n\nprose\n"
		);
	});

	// Through the function `--write` and the check actually call. Every case
	// above reaches past it into the helper, and would stay green with that
	// helper unwired - the one shape a guard must never have.
	test("are gone from what the generator writes", () => {
		const stray = `${NOTE}\n\n\`\`\`text\nstale\n\`\`\`\n\n`;

		expect(
			renderAgentsFile(`# Conventions\n\n${stray}${block("old")}`, block("new"))
		).not.toContain("stale");
	});
});

// What goes between the markers. Nothing else asserts it, so the note the stray
// detector recognises a copy by, and the markers that make the block replaceable
// at all, would only be checked by the file they are written into.
describe("the generated block", () => {
	const tree = renderTree();

	test("is wrapped in the markers that make it replaceable", () => {
		// Without both, `renderAgentsFile` appends instead of replacing, and the
		// file grows a second tree every time the generator runs.
		expect(tree.startsWith(START)).toBe(true);
		expect(tree.trimEnd().endsWith(FINISH)).toBe(true);
	});

	test("carries the note a stray copy is recognised by", () => {
		// One constant on both sides, so a reworded note cannot leave the detector
		// hunting for the old wording while the generator writes the new one.
		expect(tree).toContain(NOTE);
	});

	test("lists this repository's own files", () => {
		expect(tree).toContain("scripts/");
		expect(tree).toContain("tree.mjs");
	});
});
