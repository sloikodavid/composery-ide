import { describe, expect, test } from "vitest";

import { readRepoDir, readRepoFile } from "../../../../tests/support/repo.ts";
import { addedLines } from "../support/patch.ts";

// ---------------------------------------------------------------------------
// "Set to 1 or true" is one sentence in docs/configuration.md, so it has to be
// one reading in the product. It was four: upstream's inline
// `?.match(/^(1|true)$/)` on the inherited disable flags, a trimming and
// case-folding helper in the API config, a copy of that helper in the API
// extension, and a fourth in shell. COMPOSERY_DISABLE_API=TRUE turned the API
// off while COMPOSERY_DISABLE_AUTH=TRUE quietly left sign-in required.
//
// src/node/envFlag.ts is now that reading, and envFlag.test.ts exercises it.
// This suite only asserts what running code cannot: that no second reading has
// grown back. Two copies cannot be removed - the API extension compiles into
// the VS Code extension host, and remove-password.sh is shell - so those are
// the last rung of the ladder in AGENTS.md and are pinned here by text.
// ---------------------------------------------------------------------------

const PATCHES_DIR = "packages/ide/patches";
const OVERLAY_DIR = "packages/ide/overlay";

// The one spelling every duplicate used. Its absence outside envFlag.ts is what
// says the readings really did collapse into one.
const INLINE_READING = "/^(1|true)$/";

// Everything an operator can switch with 1/true, and where each is read.
const FLAGS = [
	["COMPOSERY_DISABLE_AUTH", "auth.diff"],
	["CS_DISABLE_FILE_DOWNLOADS", "env-config.diff"],
	["CS_DISABLE_FILE_UPLOADS", "env-config.diff"],
	["CS_DISABLE_GETTING_STARTED_OVERRIDE", "env-config.diff"],
	["CS_DISABLE_PROXY", "env-config.diff"]
] as const;

function overlayFiles(dir: string): string[] {
	return readRepoDir(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name))
		.map((entry) => `${entry.parentPath}/${entry.name}`.replace(/\\/g, "/"));
}

describe("one reading of a boolean environment variable", () => {
	test("there are flags and patches to constrain", () => {
		// Guards every list-driven test below: a rename of the patches directory
		// would otherwise report unanimous agreement over an empty list.
		expect(FLAGS.length).toBeGreaterThan(0);
		expect(readRepoDir(PATCHES_DIR).length).toBeGreaterThan(0);
	});

	test.each(FLAGS)("%s is read through envFlag", (flag, patch) => {
		expect(addedLines(readRepoFile(`${PATCHES_DIR}/${patch}`))).toContain(
			`envFlag("${flag}")`
		);
	});

	test("no patch carries its own reading", () => {
		// A patch is a call site, so a hunk may call envFlag but never restate
		// what it decides. This is the shape the stack actually had.
		const offenders = readRepoDir(PATCHES_DIR)
			.filter((name) => name.endsWith(".diff"))
			.filter((name) =>
				addedLines(readRepoFile(`${PATCHES_DIR}/${name}`)).includes(
					INLINE_READING
				)
			);

		expect(offenders).toEqual([]);
	});

	test("no overlay module carries its own reading", () => {
		// envFlag.ts is excluded because its own comment quotes the spelling it
		// replaced; nothing else in the overlay has a reason to name it.
		const offenders = overlayFiles(OVERLAY_DIR)
			.filter((file) => !file.endsWith("/envFlag.ts"))
			.filter((file) => readRepoFile(file).includes(INLINE_READING));

		expect(offenders).toEqual([]);
	});

	test("the API extension's copy still reads the same values", () => {
		// It ships into the VS Code extension host and compiles apart from the
		// server, so it cannot import envFlag.ts. Trim, case-fold, then accept
		// exactly 1 and true - drop any part of that and the extension starts
		// disagreeing with the server about whether the API is on.
		const extension = readRepoFile(
			`${OVERLAY_DIR}/lib/vscode/extensions/composery-api/extension.js`
		);
		const reading = extension.slice(extension.indexOf("COMPOSERY_DISABLE_API"));

		expect(reading).toContain(".trim()");
		expect(reading).toContain(".toLowerCase()");
		expect(reading).toContain('=== "1" || off === "true"');
		// Named so the next reader of this copy finds the original.
		expect(extension).toContain("src/node/envFlag.ts");
	});

	test("envFlag.ts is the only module that names the accepted values", () => {
		// Deliberately blunt: if a second file starts comparing against the pair
		// of literals, that is a fifth reading being born, whatever it is called.
		const offenders = overlayFiles(`${OVERLAY_DIR}/src`).filter(
			(file) =>
				!file.endsWith("/envFlag.ts") &&
				/=== *"(1|true)"/.test(readRepoFile(file))
		);

		expect(offenders).toEqual([]);
	});
});
