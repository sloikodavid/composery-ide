import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// The harness has to install the same components the deployment does.
//
// `convex/convex.config.ts` is what the real deployment runs; `tests/support/
// convex.ts` registers the same set into `convexTest`. Neither can be derived
// from the other - one takes `convex.config` entry points and the other takes
// each package's `/test` registrar, and they are different modules with
// different shapes - so the list exists twice and this is the rung that pins it.
//
// What a drift costs: a component the app installs but the harness does not is
// absent only at the moment some test reaches it, and it surfaces as whatever
// that component says when it is missing rather than as "the harness is wrong".
// `startOperation` starts a real workflow and a staff alert really queues an
// email, so the tests that would break are the ones furthest from the cause.
// ---------------------------------------------------------------------------

const read = (path: string) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

// `app.use(polar)` -> "polar", in the order the deployment installs them.
function installedComponents() {
	const source = read("../../../convex/convex.config.ts");
	return [...source.matchAll(/app\.use\((\w+)\)/g)].map((match) => match[1]);
}

// `import polar from "@convex-dev/polar/test"` -> "polar", restricted to the
// ones the harness actually registers rather than everything it imports.
function registeredComponents() {
	const source = read("../../support/convex.ts");
	const list = /const COMPONENTS = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
	return list
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
}

describe("the test harness installs the deployment's components", () => {
	// A green run has to mean the lists matched, not that a regex stopped
	// finding either of them.
	test("both lists are still being read", () => {
		expect(installedComponents().length).toBeGreaterThan(0);
		expect(registeredComponents().length).toBeGreaterThan(0);
	});

	test("registers exactly what convex.config.ts installs", () => {
		expect([...registeredComponents()].sort()).toEqual(
			[...installedComponents()].sort()
		);
	});

	// Each name has to be an import of that package's own `/test` registrar - a
	// component registered from its `convex.config` entry point is the wrong
	// module and fails at registration rather than here.
	test("registers each one through its own test entry point", () => {
		const source = read("../../support/convex.ts");

		for (const name of registeredComponents()) {
			expect(source).toMatch(new RegExp(`import ${name} from "[^"]+/test"`));
		}
	});
});
