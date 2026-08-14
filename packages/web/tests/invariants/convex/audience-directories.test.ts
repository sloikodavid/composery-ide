import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Every function reachable from outside this deployment lives in a directory
// named for who calls it.
//
// `owner/` is a signed-in customer, `staff/` is the console, `instance/` is a running
// instance authenticating with a grant, `site/` is a stranger with no identity
// at all. Everything else under `convex/` is internal and unreachable from a
// client.
//
// The point is that "what can be called from outside, and by whom" is a
// directory listing rather than a search. Four public functions used to sit
// among internal modules - the box's whole authorization flow in `boxes/`, the
// fleet version beside the release internals, the pricing query among the
// billing plumbing, and two account functions among twelve identity helpers -
// so answering that question meant a search for three keywords across ninety
// files, and no way to know the answer was complete.
//
// This cannot be derived or typed away: TypeScript has no way to say "a value of
// this type may only be exported from these directories", and Convex derives
// visibility from which builder you called, not from where the file sits. A test
// reading the checkout is the only thing that can hold it, which is why this
// directory exists.
// ---------------------------------------------------------------------------

const AUDIENCES = ["owner", "staff", "instance", "site"];

// `export const x = query({` - the three builders that produce something a
// client can call. Deliberately not `internalQuery`/`internalMutation`/
// `internalAction`: those are unreachable from outside and carry no audience.
const PUBLIC_FUNCTION = /^export const (\w+) = (?:query|mutation|action)\(/gm;

const root = fileURLToPath(new URL("../../..", import.meta.url));

// Tracked files, because the rule is about what gets committed rather than what
// happens to be on disk. Filtered to what still exists: a file moved with `mv`
// rather than `git mv` sits in the index until the next `git add`, and a working
// copy mid-refactor should not read as a rule violation.
const convexFiles = execFileSync("git", ["ls-files", "convex"], {
	cwd: root,
	encoding: "utf8"
})
	.split("\n")
	.filter((file) => file.endsWith(".ts") && !file.includes("_generated"))
	.filter((file) => existsSync(new URL(file, `file:///${root}/`)));

function publicFunctionsIn(file: string) {
	const source = readFileSync(new URL(file, `file:///${root}/`), "utf8");
	return [...source.matchAll(PUBLIC_FUNCTION)].map((match) => match[1]);
}

const withPublicFunctions = convexFiles
	.map((file) => ({ file, names: publicFunctionsIn(file) }))
	.filter((entry) => entry.names.length > 0);

describe("public functions live in an audience directory", () => {
	// A green run has to mean the files were read and the pattern still matches,
	// not that the glob quietly stopped finding anything.
	test("there are public functions to constrain", () => {
		expect(convexFiles.length).toBeGreaterThan(50);
		expect(withPublicFunctions.length).toBeGreaterThan(10);
		expect(
			withPublicFunctions.flatMap((entry) => entry.names).length
		).toBeGreaterThan(50);
	});

	test("no public function sits outside one", () => {
		const offenders = withPublicFunctions
			.filter(
				(entry) =>
					!AUDIENCES.some((name) => entry.file.startsWith(`convex/${name}/`))
			)
			.map((entry) => `${entry.file}: ${entry.names.join(", ")}`);

		expect(offenders).toEqual([]);
	});

	// The other half of the rule, and the one that goes stale quietly: an audience
	// directory whose files stopped being public is a name that no longer means
	// anything, and the next reader files an internal helper there.
	test("every audience directory still holds a public surface", () => {
		for (const audience of AUDIENCES) {
			const files = convexFiles.filter((file) =>
				file.startsWith(`convex/${audience}/`)
			);
			expect(files.length).toBeGreaterThan(0);
			expect(
				files.filter((file) => publicFunctionsIn(file).length > 0).length
			).toBeGreaterThan(0);
		}
	});
});
