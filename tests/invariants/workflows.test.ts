import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

import { readRepoFile, repoRoot } from "../support/repo.ts";

// House style for `.github/workflows/`, made mechanical.
//
// Duplication, and why it cannot be removed: nothing in the running system reads
// these files, so no behaviour test can reach them - GitHub does, weeks later,
// and the only place a drifted one shows up is the Actions UI of a run that has
// already happened. actionlint (ci.yaml's "Validate workflows" step) settles
// whether a file is valid; it has no opinion about whether it looks like its
// neighbours, which is the whole of what is asserted here.
//
// The convention each test pins was already unanimous across the eight files
// when it was written, so every one of these starts green and can only be
// broken by a new file that ignores the others.

const WORKFLOWS = ".github/workflows";

// The order every file already declares them in. `on` before `permissions`
// before `concurrency` reads as "when it runs, what it may touch, how runs
// overlap"; a file that shuffles them costs a reader the shape they learned
// from the last one. Any subset is fine - not every workflow needs all five.
const TOP_LEVEL_ORDER = ["name", "on", "permissions", "concurrency", "jobs"];

type Step = { id?: string; name?: string; uses?: string };
type Job = { name?: string; steps?: Step[] };
type Workflow = {
	jobs?: Record<string, Job>;
	name?: string;
	permissions?: unknown;
};

const files = readdirSync(resolve(repoRoot, WORKFLOWS)).sort();

const workflows = files.map((file) => {
	const parsed = parse(readRepoFile(`${WORKFLOWS}/${file}`)) as Workflow;
	return { file, parsed, keys: Object.keys(parsed) };
});

function steps(workflow: Workflow): Array<[string, Step]> {
	return Object.entries(workflow.jobs ?? {}).flatMap(([job, value]) =>
		(value.steps ?? []).map((step): [string, Step] => [job, step])
	);
}

describe("workflow house style", () => {
	test("there are workflows to constrain", () => {
		// Guards every list-driven test below: an empty directory, or a rename of
		// the one it reads, would otherwise report unanimous agreement forever.
		expect(files.length).toBeGreaterThan(0);
	});

	test("every workflow file carries the .yaml extension", () => {
		// The extension is a repository-wide rule in conventions.test.ts. This
		// stays because the tests below read `basename(file, ".yaml")`, which on a
		// file named otherwise strips nothing and compares a name against a name
		// with an extension still on it - passing or failing for the wrong reason.
		expect(files.filter((file) => !file.endsWith(".yaml"))).toEqual([]);
	});

	test("every workflow is named after its file", () => {
		// Pinned rather than derived because the name is load-bearing: deploy.yaml
		// selects its trigger with `workflow_run: workflows: [ci]`, and GitHub
		// matches that against the declared name. Dropping the key to remove the
		// duplication would leave that filter matching a path instead, so the two
		// spellings have to agree.
		const mismatched = workflows
			.filter(({ file, parsed }) => parsed.name !== basename(file, ".yaml"))
			.map(({ file, parsed }) => `${file}: ${String(parsed.name)}`);

		expect(mismatched).toEqual([]);
	});

	test("every workflow declares its permissions at the top level", () => {
		// Left out, a workflow takes the repository default, which is a setting
		// nobody reviewing this diff can see.
		const silent = workflows
			.filter(({ parsed }) => parsed.permissions === undefined)
			.map(({ file }) => file);

		expect(silent).toEqual([]);
	});

	test("top-level keys are declared in one order", () => {
		const misordered = workflows
			.filter(({ keys }) => {
				const known = keys.filter((key) => TOP_LEVEL_ORDER.includes(key));
				const sorted = [...known].sort(
					(a, b) => TOP_LEVEL_ORDER.indexOf(a) - TOP_LEVEL_ORDER.indexOf(b)
				);
				return known.join() !== sorted.join();
			})
			.map(({ file, keys }) => `${file}: ${keys.join(", ")}`);

		expect(misordered).toEqual([]);
	});

	test("no job name merely repeats its key", () => {
		// GitHub already displays the key. A `name` that restates it is a second
		// copy of the same string; one that reads differently - "checks / linux",
		// "all checks" - is a display decision worth keeping.
		const echoed = workflows.flatMap(({ file, parsed }) =>
			Object.entries(parsed.jobs ?? {})
				.filter(([key, job]) => job.name === key)
				.map(([key]) => `${file}: ${key}`)
		);

		expect(echoed).toEqual([]);
	});

	test("every step is named", () => {
		// An unnamed step is labelled with its `uses:` ref in the log, so a run
		// reads as a column of action slugs and SHAs. release.yaml was ten such
		// steps while every other file named all of them.
		const unnamed = workflows.flatMap(({ file, parsed }) =>
			steps(parsed)
				.filter(([, step]) => !step.name)
				.map(([job, step]) => `${file}: ${job}: ${step.uses ?? "run"}`)
		);

		expect(unnamed).toEqual([]);
	});

	test("step ids are kebab-case, like the job keys around them", () => {
		const offenders = workflows.flatMap(({ file, parsed }) =>
			steps(parsed)
				.filter(
					([, step]) => step.id && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(step.id)
				)
				.map(([job, step]) => `${file}: ${job}: ${String(step.id)}`)
		);

		expect(offenders).toEqual([]);
	});
});
