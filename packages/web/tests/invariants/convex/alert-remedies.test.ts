import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// A staff alert that tells somebody to set a variable names one that exists.
//
// These messages are read at the worst moment - a customer has not been told
// something they were owed, and the person reading has to fix the deployment.
// The alert's whole value is naming the dial to turn, so a name that has since
// been renamed is worse than no name at all: it sends the reader looking through
// a dashboard for a variable nothing reads, and the obvious conclusion from not
// finding it ("this is already unset, so that is not the problem") is wrong.
//
// Found by one being wrong: `notice/owner.ts` told staff to check
// `BOXES_EMAIL_FROM` long after the variable became `RESEND_BOXES_FROM`. Nothing
// caught it, because prose inside a template literal is invisible to every other
// check here - `envExample.test.ts` compares the example files against the reads,
// and a name nothing reads is exactly what this failure looks like.
//
// Deliberately narrow. Every module-level constant in this package is
// SCREAMING_SNAKE too, so shape alone cannot separate a variable from a local -
// the discriminator used here is the instruction ("set", "check", "unset",
// "configure"), which is what only an environment variable receives.
// ---------------------------------------------------------------------------

const url = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const read = (path: string) => readFileSync(path, "utf8");

function convexSources(directory = url("../../../convex")): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const full = `${directory}/${entry.name}`;
		if (entry.isDirectory()) {
			return entry.name === "_generated" ? [] : convexSources(full);
		}
		return entry.name.endsWith(".ts") ? [full] : [];
	});
}

// What this deployment actually reads, taken from the two places that decide it:
// the environment schema, and the per-plane example files that document it.
function declaredVariables() {
	const names = new Set<string>();
	for (const match of read(url("../../../convex/env.ts")).matchAll(
		/^\t([A-Z][A-Z0-9_]+):/gm
	)) {
		names.add(match[1] as string);
	}
	for (const plane of ["prod", "dev"]) {
		for (const match of read(
			url(`../../../.env.example.convex.${plane}`)
		).matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)) {
			names.add(match[1] as string);
		}
	}
	return names;
}

// One instruction can name several variables ("Check RESEND_API_KEY and the
// RESEND_BOXES_FROM sender"), so the run of them is captured and then split.
// Matching only the first was this test's own first version, and it passed with
// the bug that prompted it put back - the second name in the sentence was never
// read.
const INSTRUCTION =
	/\b(?:[Ss]et|[Cc]heck|[Uu]nset|[Cc]onfigure|[Cc]onfigured)\s+((?:(?:the|and|or|,)\s+)*`?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+`?(?:\s+(?:and|or|,)\s+(?:the\s+)?`?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+`?)*)/g;
const NAME = /[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/g;

function instructedVariables() {
	return convexSources().flatMap((file) =>
		[...read(file).matchAll(INSTRUCTION)].flatMap((match) =>
			[...(match[1] as string).matchAll(NAME)].map((name) => ({
				file: file.slice(file.indexOf("packages")),
				name: name[0]
			}))
		)
	);
}

describe("an alert that names a variable names one that exists", () => {
	// A green run has to mean the names matched, not that the pattern stopped
	// finding any. Both sides are read from the tree, so either could silently
	// empty out.
	test("there are instructions to check, and variables to check them against", () => {
		expect(instructedVariables().length).toBeGreaterThan(3);
		expect(declaredVariables().size).toBeGreaterThan(10);
	});

	test("every variable an alert tells somebody to set is declared", () => {
		const declared = declaredVariables();

		expect(
			instructedVariables().filter(({ name }) => !declared.has(name))
		).toEqual([]);
	});
});
