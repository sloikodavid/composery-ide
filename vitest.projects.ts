import { fileURLToPath } from "node:url";

// What a vitest project is here, shared by the two configs that need one.
//
// A project is a (package, kind) pair, derived rather than listed: adding a kind
// or a package cannot leave a suite silently unscheduled. Kinds and what belongs
// in each are docs/developing/testing.md; `tests/invariants/tests.test.ts`
// enforces the layout this assumes.

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const SUITES = [
	// The repository as an artifact, plus the agreement between packages.
	{ name: "repo", root: "." },
	{ name: "ide", root: "packages/ide" },
	{ name: "shared", root: "packages/shared" },
	// `@` mirrors each package's tsconfig `paths`, so a test imports its subject
	// exactly as the package's own source does and never through a chain of `..`
	// that a move would invalidate.
	{ name: "web", root: "packages/web", alias: "packages/web" }
];

// Behaviour runs product code; invariants read the checkout. The timeout is a
// property of the kind rather than a global: repo-inspection copies trees, shells
// out and walks the upstream working copy, so its runtime tracks how busy the
// machine is more than what it asserts. Granting that budget to every test lets a
// slow behaviour test hide in it, so the two are sized apart and a test that
// needs the larger one has to move to the directory that admits why.
//
// Hang detectors, not budgets - sized against measured worst cases with the same
// margin smoke.yaml uses, because the failure mode of a tight one is a healthy run
// reported as broken and nobody trusts a suite that cries wolf. Today's slowest
// invariant is the fuzz=0 patch-stack apply at ~11.7s on an idle machine; a loaded
// runner is several times that. A single test that genuinely needs longer passes
// its own timeout as vitest's third argument rather than lifting the ceiling for
// all of them - there is always a way out, and it is per test.
export const KINDS = {
	behavior: 15_000,
	invariants: 120_000
};

export type Kind = keyof typeof KINDS;

// `slowdown` widens every timeout by a constant factor, for a run whose cost is
// structurally different rather than whose tests got slower. Mutation testing is
// the one such run: it needs file isolation (see vitest.mutation.config.ts), and
// paying to stand a Convex harness up per file puts an ordinary test well past a
// ceiling sized for the normal suite. The ratio between the two kinds is
// preserved, so this stays one decision rather than a second table of numbers.
export function projects(
	kinds: Kind[] = Object.keys(KINDS) as Kind[],
	{ slowdown = 1 }: { slowdown?: number } = {}
) {
	return SUITES.flatMap((suite) =>
		kinds.map((kind) => ({
			test: {
				name: `${suite.name}:${kind}`,
				root: path(suite.root),
				// `.tsx` too, because the layout enforcer accepts one and vitest's own
				// default include does: a glob narrower than both would leave a real
				// test file unscheduled and report zero failures forever.
				//
				// No `environment`: vitest's default is already `node`, and a file that
				// needs a DOM says so in a `// @vitest-environment jsdom` header,
				// which is the only place the choice is visible per test.
				include: [`tests/${kind}/**/*.test.{ts,tsx}`],
				testTimeout: KINDS[kind] * slowdown,
				// Setup is where a harness boots - a backend, a prebuild, a container
				// fixture - so a hook that inherited vitest's stock 10s while its tests
				// had longer would fail the whole file for being slow at the one step
				// that has most right to be.
				hookTimeout: KINDS[kind] * slowdown
			},
			...(suite.alias ? { resolve: { alias: { "@": path(suite.alias) } } } : {})
		}))
	);
}
