import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

import { repoRoot, readRepoFile } from "../support/repo.ts";

// Composery must be developable on Linux, Windows and macOS alike. `check`
// splits into the portable set (proven on every OS by ci.yaml's portable job)
// and the few targets that genuinely cannot leave Linux. The split is only
// worth anything if a newly added check:* target has to pick a side, so these
// tests fail on any target that belongs to neither.
const rootPackage = JSON.parse(readRepoFile("package.json")) as {
	scripts: Record<string, string>;
};
const scripts = rootPackage.scripts;
const ciWorkflow = readRepoFile(".github/workflows/ci.yaml");

type WorkflowJob = {
	if?: string;
	name?: string;
	needs?: string | string[];
	permissions?: Record<string, string>;
	steps?: Array<Record<string, unknown>>;
	uses?: string;
};

type Workflow = {
	jobs: Record<string, WorkflowJob>;
	on?: Record<string, unknown>;
};

function workflow(path: string): Workflow {
	return parse(readRepoFile(path)) as Workflow;
}

function dependsOn(
	jobs: Record<string, WorkflowJob>,
	jobName: string,
	required: string,
	seen = new Set<string>()
): boolean {
	if (jobName === required) return true;
	if (seen.has(jobName)) return false;
	seen.add(jobName);

	const value = jobs[jobName]?.needs;
	const needs = typeof value === "string" ? [value] : (value ?? []);
	return needs.some((name) => dependsOn(jobs, name, required, seen));
}

// Deliberately excluded from the cross-platform matrix:
// - check:cli  cargo builds the persistence crate, which needs inotify/xattr.
// - check:renovate  schema validation has no OS-specific behaviour to repeat.
// - check:knip  a whole-graph scan with no OS-specific behaviour, and slow
//   enough that repeating it on three runners buys nothing.
// - check:coverage  reads the report check:portable just produced and diffs it
//   against a base commit, so it needs fetched history rather than a second OS.
// - check:mutants  runs the suite once per mutant and needs cargo for the Rust
//   half; the same reasons as check:cli, plus runtime.
const PORTABLE_EXCLUSIONS = [
	"check:cli",
	"check:coverage",
	"check:knip",
	"check:mutants",
	"check:renovate"
];

// pnpm run targets named inside a script body, e.g. "pnpm check:types && ...".
function targetsOf(script: string): string[] {
	return [...script.matchAll(/pnpm (check:[a-z:-]+)/g)].flatMap(
		(match) => match[1] ?? []
	);
}

const checkTargets = Object.keys(scripts).filter(
	(name) => name.startsWith("check:") && name !== "check:portable"
);
const portableTargets = targetsOf(scripts["check:portable"] ?? "");

describe("cross-platform checks", () => {
	test("one fail-closed check separates validation from deployment", () => {
		const ci = workflow(".github/workflows/ci.yaml");
		const allChecks = ci.jobs["all-checks"];

		expect(allChecks?.if).toBe("always()");
		expect(new Set(allChecks?.needs)).toEqual(
			new Set(["windows-macos", "linux", "smoke", "templates"])
		);
		expect(allChecks?.name).toBe("all checks");
		expect(ci.jobs.linux?.name).toBe("checks / linux");
		expect(ci.jobs["windows-macos"]?.name).toBe("checks / ${{ matrix.os }}");

		// No job here may hold a write token, and now there is no workflow that
		// does either. Production used to be a `deploy` branch that a second
		// workflow fast-forwarded after watching ci finish - a pointer whose
		// only job was to answer "did this commit pass?" downstream of the merge.
		// The `Protect main` ruleset answers it upstream instead, by refusing the
		// merge, so every commit on main is a commit `all checks` passed and
		// Vercel can track main directly.
		//
		// The half of that guarantee this test cannot see: enforcement, strict
		// status checks and an empty bypass list are GitHub settings, not files.
		// `docs/developing/services/github.md` is where they are specified, and a
		// red run on main is what a bypass looks like from in here.
		const writable = Object.entries(ci.jobs)
			.filter(([, job]) => job.permissions?.contents === "write")
			.map(([name]) => name);
		expect(writable).toEqual([]);
		expect(
			readdirSync(resolve(repoRoot, ".github/workflows")).sort()
		).not.toContain("deploy.yaml");

		const drift = ci.jobs.linux?.steps?.find(
			(step) => step.name === "Check for source drift"
		);
		expect(drift?.run).toContain("pnpm fix");
		expect(drift?.run).toContain("git diff --exit-code");
		expect(drift?.run).toContain("--untracked-files=all");

		const vercel = JSON.parse(readRepoFile("packages/web/vercel.json")) as {
			buildCommand?: string;
			git?: { deploymentEnabled?: Record<string, boolean> };
			github?: { silent?: boolean };
		};
		expect(vercel.buildCommand).toBe(
			"pnpm env:deploy && npx convex deploy --cmd 'pnpm build' --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL"
		);
		expect(vercel.git?.deploymentEnabled).toEqual({
			"*": false,
			main: true
		});
		expect(vercel.github?.silent).toBe(true);

		const webPackage = JSON.parse(
			readRepoFile("packages/web/package.json")
		) as {
			scripts?: Record<string, string>;
		};
		expect(webPackage.scripts?.["env:deploy"]).toBe("node scripts/env.mjs");
	});

	test("every publication workflow depends on the complete CI tier", () => {
		const release = workflow(".github/workflows/release.yaml");
		expect(release.jobs.validate?.uses).toBe("./.github/workflows/ci.yaml");
		for (const job of ["plan", "build", "publish"])
			expect(dependsOn(release.jobs, job, "validate"), job).toBe(true);

		const smoke = workflow(".github/workflows/smoke.yaml");
		expect(smoke.on).not.toHaveProperty("push");
		expect(smoke.on).not.toHaveProperty("pull_request");
	});

	test("local smoke builds have no arbitrary wall-clock cutoff", () => {
		const smoke = readRepoFile("tests/system/smoke.mjs");

		expect(smoke).toContain(
			"buildTimeoutMs: parseOptionalTimeout(process.env.SMOKE_BUILD_TIMEOUT_MS)"
		);
		expect(smoke).toContain("options.timeoutMs === null");
		expect(smoke).toContain(": (options.timeoutMs ?? 120_000)");
		expect(smoke).not.toContain("45 * 60_000");
	});

	test("lint warnings fail every lint scope", () => {
		const packages = ["package.json", "packages/web/package.json"];
		for (const path of packages) {
			const pkg = JSON.parse(readRepoFile(path)) as {
				scripts?: Record<string, string>;
			};
			expect(pkg.scripts?.["check:lint"], path).toContain("--max-warnings 0");
		}
	});

	test("every check target is portable or explicitly excluded", () => {
		const unclassified = checkTargets.filter(
			(name) =>
				!portableTargets.includes(name) && !PORTABLE_EXCLUSIONS.includes(name)
		);

		expect(unclassified).toEqual([]);
	});

	test("portable exclusions are named, not merely left out", () => {
		// A target dropped from check:portable without being listed here would
		// otherwise read as "portable set shrank" instead of failing.
		expect(checkTargets).toEqual(
			expect.arrayContaining([...PORTABLE_EXCLUSIONS, ...portableTargets])
		);
		expect(portableTargets.length).toBeGreaterThan(0);
	});

	test("check still runs the portable set and every exclusion", () => {
		const umbrella = targetsOf(scripts.check ?? "");

		expect(umbrella).toContain("check:portable");
		for (const target of PORTABLE_EXCLUSIONS)
			expect(umbrella).toContain(target);
	});

	test("CI proves the portable set on both Windows and macOS", () => {
		// Without a non-Linux runner actually invoking it, check:portable is a
		// label rather than a guarantee.
		expect(ciWorkflow).toContain("pnpm check:portable");
		expect(ciWorkflow).toMatch(/os: \[windows-[\w.-]+, macos-[\w.-]+\]/);
	});

	// A CI timeout is a hang detector, not a performance budget. Sizing one from
	// how long a job happened to take on an idle runner is what cancelled the
	// android e2e job at exactly 60 minutes, mid-build - a healthy build
	// reported as a failed nightly, which is the same "failed for being busy"
	// trap the patch-stack test's timeout comment describes. Two rules keep them
	// honest: nothing below a floor far above the real work, and no step-level
	// budget at all, since nested inside a job timeout the tighter one simply
	// fires first and the job timeout it duplicates never gets a say.
	test("workflow timeouts are hang detectors, not budgets", () => {
		const FLOOR_MINUTES = 120;
		const tooTight: string[] = [];
		const stepLevel: string[] = [];

		for (const file of readdirSync(resolve(repoRoot, ".github/workflows"))) {
			const workflow = readRepoFile(`.github/workflows/${file}`);
			for (const match of workflow.matchAll(
				/^(?<indent>[ ]*)timeout-minutes: (?<minutes>\d+)$/gm
			)) {
				const indent = match.groups?.indent ?? "";
				const minutes = Number(match.groups?.minutes);
				// Jobs sit two levels in ("jobs:" -> name -> key); anything deeper
				// belongs to a step.
				if (indent.length > 4) stepLevel.push(`${file}: ${match[0].trim()}`);
				if (minutes < FLOOR_MINUTES) {
					tooTight.push(`${file}: ${minutes} < ${FLOOR_MINUTES}`);
				}
			}
		}

		expect(tooTight).toEqual([]);
		expect(stepLevel).toEqual([]);
	});

	// Both Trivy scans read the same image at CRITICAL,HIGH with unfixed
	// findings included, so either one blocking means a Debian CVE with no fix
	// available stops the pipeline - nothing a change here could clear. smoke.yaml
	// said as much while release.yaml quietly ran exit-code 1, which would have
	// failed the publish job on two unfixed perl-modules CRITICALs. They report;
	// they do not gate.
	test("neither image scan can block on a CVE with no fix", () => {
		for (const path of [
			".github/workflows/smoke.yaml",
			".github/workflows/release.yaml"
		]) {
			const workflow = readRepoFile(path);
			const scans = [...workflow.matchAll(/aquasecurity\/trivy-action/g)];

			expect(scans, path).toHaveLength(1);
			expect(workflow, path).toContain('exit-code: "0"');
			expect(workflow, path).not.toContain('exit-code: "1"');
		}
	});

	// A dependency shipping prebuilt binaries for only some platforms makes
	// `pnpm install --frozen-lockfile` unresolvable on the rest - the failure a
	// contributor on Apple Silicon hits first. Rather than exempt the families
	// that legitimately skip an OS (sharp vendors libvips into its win32
	// packages, so it has no win32 libvips build), require both architectures of
	// every OS a family does publish for. No allowlist to rot.
	test("native dependencies cover both architectures of every OS they ship", () => {
		const ARCHES = ["arm64", "x64"];
		const families = new Map<string, Set<string>>();

		for (const line of readRepoFile("pnpm-lock.yaml").split("\n")) {
			if (!/^ {2}\S+@/.test(line)) continue;
			// Lockfile keys are single-quoted when scoped: '@next/swc-darwin-arm64@16.2.6':
			const name = line
				.trim()
				.replace(/^'|':$|:$/g, "")
				.replace(/@[^@]*$/, "");
			const parts = /^(.*?)[@/-](darwin|linux|win32)[-/]?([a-z0-9]*)/.exec(
				name
			);
			if (!parts) continue;
			const family = (parts[1] ?? "").replace(/[@/-]$/, "");
			if (!families.has(family)) families.set(family, new Set());
			families.get(family)?.add(`${parts[2]}-${parts[3] || "?"}`);
		}

		expect(families.size).toBeGreaterThan(0);

		const gaps = [...families]
			.flatMap(([family, variants]) =>
				["darwin", "linux", "win32"]
					.filter((os) => [...variants].some((v) => v.startsWith(`${os}-`)))
					.flatMap((os) =>
						ARCHES.filter(
							(arch) =>
								![...variants].some((v) => v.startsWith(`${os}-${arch}`))
						).map((arch) => `${family} is missing ${os}-${arch}`)
					)
			)
			.sort();

		expect(gaps).toEqual([]);
	});
});
