import { defineConfig } from "vitest/config";

import { projects } from "./vitest.projects.ts";

// The suite mutation testing runs: behaviour only.
//
// Two reasons, and either alone would be enough.
//
// An invariants test cannot kill a mutant. It reads the checkout and asserts a
// fact about it; it never executes the code Stryker mutated, so including it
// adds runtime to every mutant and can only ever report "survived" for reasons
// that have nothing to do with the mutant.
//
// Worse, it actively breaks the run. Stryker copies the project into a sandbox
// and instruments every mutated file, so a test that reads a source file reads
// the *instrumented* one - and two of ours did exactly that. One greps
// `purgeBox` for each box-keyed table it must handle; one asserts that
// `packages/web/convex/env.ts` is the only module touching `process.env`, which every
// instrumented file now appears to do. Both failed the initial test run, which
// aborts mutation testing entirely: the repo's own doctrine calls this the
// load-bearing check, and it had been unable to start.
//
// The first of those has since become a behaviour test, because greping source
// that could have run is the one shape `docs/developing/testing.md` forbids. The
// second is a legitimate invariant - it is a fact about the checkout, which is
// what that kind is for - and it belongs in the ordinary suite, not this one.
//
// Coverage is off here: `check:coverage` owns that question, and instrumenting
// twice only slows the thousands of runs a mutation sweep performs.
// No shuffle either. The ordinary suite is where order dependence is found, and
// a run that executes the same tests thousands of times wants the same order
// every time: a survivor you cannot reproduce is a survivor nobody can triage.
export default defineConfig({
	test: {
		projects: projects(["behavior"], { slowdown: 6 })
	}
});
