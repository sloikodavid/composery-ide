import { describe, expect, test } from "vitest";

import { readRepoFile, trackedFiles } from "../support/repo.ts";

// ---------------------------------------------------------------------------
// One spelling per concept, for the choices no compiler and no linter can see:
// which extension a file we own carries, and how the shipped Markdown is
// written. Nothing executes these decisions, so nothing else can hold them.
//
// The rule each one replaces was the same shape: a convention stated per
// directory, which is indistinguishable from no convention. `.yml` was pinned
// for `.github/workflows/` alone, beside a comment saying the extension
// "follows whichever tool reads the file" - and that comment named two files
// while covering four more that no tool spelled at all. A per-directory rule
// cannot be violated, because the next directory is always allowed to differ.
//
// The extension is `.yaml` rather than the `.yml` that was briefly the majority,
// because three files here are named by the tool that reads them - pnpm
// regenerates `pnpm-lock.yaml` and finds the workspace only at
// `pnpm-workspace.yaml`, Render reads a blueprint called exactly `render.yaml` -
// and every one of them is `.yaml`. Unifying on `.yml` meant two extensions and
// a permanent allowlist to explain them; unifying on `.yaml` costs a rename and
// leaves a rule with no exceptions at all. When one spelling is forced on you
// somewhere, adopt that one: the tie-break is which choice empties the list, not
// which is already more common.
// ---------------------------------------------------------------------------

const files = trackedFiles();

// This file, which quotes `.yml` throughout in order to forbid it. Named rather
// than derived from `import.meta` so the exemption is one visible path.
const RULE_FILE = "tests/invariants/conventions.test.ts";

// The files allowed to still say `.yml`, each because the name belongs to
// something other than this checkout. Shrink this list, never grow it without
// naming whose spelling it is.
const WRITES_YML_FOR_SOMEONE_ELSE = new Map([
	[
		"packages/ide/scripts/rebrand.mjs",
		"scans code-server and VS Code, where both spellings occur"
	],
	[
		"packages/ide/tests/behavior/scripts/rebrand.test.ts",
		"asserts the extension set that scan accepts"
	]
]);

// Markdown we ship or hand to a reader. `packages/ide/upstream` is someone
// else's tree, and the agent instructions are not published pages.
const MARKDOWN = files.filter(
	(file) =>
		/\.mdx?$/.test(file) &&
		(file.startsWith("docs/") ||
			file.startsWith("templates/") ||
			file.startsWith(".github/"))
);

describe("one extension per concept", () => {
	test("there are YAML files to constrain", () => {
		// Without this, a rename of the whole family reports unanimous agreement
		// over an empty list for as long as nobody looks.
		expect(
			files.filter((file) => /\.ya?ml$/.test(file)).length
		).toBeGreaterThan(10);
	});

	test("every YAML file is .yaml", () => {
		// No exceptions, and that is the point: `.yml` never appears, so there is
		// no second spelling for a new file to be talked into.
		expect(files.filter((file) => file.endsWith(".yml"))).toEqual([]);
	});

	test("nothing in the checkout still points at a .yml path", () => {
		// The rename is only done when no reference survives it. A stale one is
		// worse than the split it replaced: `readdir().filter(f =>
		// f.endsWith(".yml"))` in toolchain-pins.test.ts silently selected zero
		// workflows and went on reporting that every pin it never looked at was
		// fine.
		const offenders = files
			.filter(
				(file) =>
					!WRITES_YML_FOR_SOMEONE_ELSE.has(file) &&
					// The file stating the rule has to spell what it forbids.
					file !== RULE_FILE &&
					!file.startsWith("packages/ide/upstream") &&
					file !== "pnpm-lock.yaml" &&
					/\.(ts|tsx|mjs|mts|json|jsonc|md|mdx|yaml|sh)$|Dockerfile$/.test(file)
			)
			.filter((file) => readRepoFile(file).includes(".yml"));

		expect(offenders).toEqual([]);
	});

	test("every .yml exemption is still earning it", () => {
		// Same argument the rule itself makes: an exemption whose file is gone, or
		// which no longer says `.yml` at all, is a reason nobody can check that
		// silently re-permits the spelling the day that path comes back.
		const unused = [...WRITES_YML_FOR_SOMEONE_ELSE.keys()].filter(
			(file) => !files.includes(file) || !readRepoFile(file).includes(".yml")
		);

		expect(unused).toEqual([]);
	});
});

describe("one spelling of the entry-point guard", () => {
	// A script that is both a CLI target and a module has to know which it is
	// being used as, or importing it for one export runs the whole command -
	// `import { GIT_FILE_ARGS } from "scripts/tree.mjs"` would walk the checkout
	// and rewrite AGENTS.md as a side effect of reading one constant.
	//
	// Every script that needs the test had it, which is why nothing was broken;
	// they simply wrote it two ways. `tree` used a truthiness check plus a
	// comparison across three lines, the three `packages/shared` generators used
	// `?? ""` and bound a single-use `scriptPath` const. Same semantics, two
	// shapes, so neither reads as the house form and the next script had two
	// precedents to copy.
	const GUARD =
		'resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)';
	const scripts = files.filter(
		(file) => /(^|\/)scripts\//.test(file) && file.endsWith(".mjs")
	);

	test("there are scripts to constrain", () => {
		expect(scripts.length).toBeGreaterThan(5);
		expect(
			scripts.filter((file) => readRepoFile(file).includes(GUARD)).length
		).toBeGreaterThan(3);
	});

	test("no script tests argv against import.meta.url another way", () => {
		// Any other spelling is a second house form. This looks for the *idea* -
		// a comparison involving `process.argv[1]` - and requires that wherever it
		// appears, it appears as the one form above.
		const offenders = scripts.filter((file) => {
			const source = readRepoFile(file);
			if (!/process\.argv\[1\]/.test(source)) return false;
			return !source.includes(GUARD);
		});

		expect(offenders).toEqual([]);
	});
});

describe("one spelling per concept in shipped Markdown", () => {
	test("there is Markdown to constrain", () => {
		expect(MARKDOWN.length).toBeGreaterThan(20);
	});

	test("every fenced block declares a language", () => {
		// An unlabelled fence renders without highlighting on the website and
		// reads as an oversight next to the labelled block above it. Literal
		// output is `text`, which is a declaration too.
		const offenders: string[] = [];

		for (const file of MARKDOWN) {
			const lines = readRepoFile(file).split("\n");
			let inside = false;

			for (const [index, line] of lines.entries()) {
				if (!line.startsWith("```")) continue;
				if (inside) {
					inside = false;
					continue;
				}
				inside = true;
				if (!line.slice(3).trim()) offenders.push(`${file}:${index + 1}`);
			}
		}

		expect(offenders).toEqual([]);
	});

	test("shell blocks are labelled bash", () => {
		// `sh`, `shell` and `bash` all highlight the same way and all mean the
		// same shell, so the label carries no information and only records which
		// page was written first. `powershell` is a different shell and stays.
		const offenders = MARKDOWN.filter((file) =>
			/^```(sh|shell|console)\s*$/m.test(readRepoFile(file))
		);

		expect(offenders).toEqual([]);
	});

	test("relative links carry no ./ prefix", () => {
		// `./persistence.md` and `persistence.md` resolve identically on GitHub
		// and on the website, so one of them is decoration - and which one a page
		// used tracked nothing but the subtree it was written in.
		const offenders = MARKDOWN.filter((file) =>
			/\]\(\.\/(?!\.)/.test(readRepoFile(file))
		);

		expect(offenders).toEqual([]);
	});
});
