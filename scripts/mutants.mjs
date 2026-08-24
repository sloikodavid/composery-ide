import { spawnSync } from "node:child_process";
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Mutation testing over the current change. Coverage says a line ran; this says
// whether anything would have noticed if the line were wrong. It changes the
// code - flips a comparison, drops a call, empties a block - and reports which
// mutants no test killed.
//
// Every line in this repository is written by an agent, and usually the same
// agent writes the test, so this is the load-bearing check rather than a nicety:
// it is the only one that cannot be satisfied by a test that merely runs.
//
// Scoped to the diff on purpose. A full sweep is a nightly job (mutants.yaml);
// per-change it has to be fast enough that nobody is tempted to skip it.
//
// A surviving mutant is killed by a test or annotated as equivalent with a
// reason - `// Stryker disable next-line <mutator>: <why>` for TypeScript,
// `#[mutants::skip]` with a comment for Rust. An untriaged survivor list is a
// coverage percentage wearing a different hat.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIFF = resolve(REPO_ROOT, "tmp/mutants/changed.diff");
const STRYKER_CONFIG = resolve(REPO_ROOT, "tmp/mutants/stryker.diff.json");

const git = (args) => {
	const out = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
	return out.status === 0 ? out.stdout : undefined;
};

function baseRef() {
	for (const candidate of ["origin/main", "main"]) {
		const merged = git(["merge-base", candidate, "HEAD"]);
		if (merged) return merged.trim();
	}
	const parent = git(["rev-parse", "HEAD~1"]);
	if (parent) return parent.trim();
	console.error(
		"No base commit to diff against. Fetch history (actions/checkout needs\n" +
			"fetch-depth: 0) - a mutation run over nothing reports success forever."
	);
	process.exit(1);
}

const base = baseRef();
const changed = (git(["diff", "--name-only", "--diff-filter=d", base]) ?? "")
	.split("\n")
	.filter(Boolean);

// What counts as mutable source is decided once, in stryker.config.json, and
// read back here rather than restated - the diff run and the nightly sweep have
// to mean the same thing by it. The two copies had already drifted: a
// hand-written filter here admitted every `.tsx` under `app/` and `components/`,
// which the config excludes and no test covers, so a change touching one page
// handed Stryker files whose every mutant survives by construction and failed
// the gate with a list nobody was ever going to kill.
const stryker = JSON.parse(
	readFileSync(resolve(REPO_ROOT, "stryker.config.json"), "utf8")
);
const mutable = new Set(
	globSync(
		stryker.mutate.filter((p) => !p.startsWith("!")),
		{
			cwd: REPO_ROOT,
			exclude: stryker.mutate
				.filter((p) => p.startsWith("!"))
				.map((p) => p.slice(1))
		}
	).map((f) => f.split("\\").join("/"))
);

const ts = changed.filter((f) => mutable.has(f));
const rust = changed.filter(
	(f) => f.startsWith("packages/cli/") && f.endsWith(".rs")
);

// The lines this change introduced, as `path:start-end`, which is the form
// Stryker's `mutate` takes to scope a run below file level.
//
// Whole files are what the threshold below could not survive. `break: 100` says
// nothing may survive on a line this change introduced; a whole file asks that
// of every line the file already had, so a small change to hetznerVps.ts
// needed tests for 176 mutants in code that change never saw -
// and the answer to those is the nightly sweep, not a gate on whoever edited
// something else in the same file. The Rust half was always scoped this way
// (`--in-diff`); this is the same rule in the form Stryker reads it.
// One diff per file, so which file a hunk belongs to is the loop variable rather
// than something parsed back out of a `+++ b/` header. With `--unified=0` the
// output still carries the added lines, and an added line is written with a `+`
// in front of it - so a source line reading `++ b/x` reaches this as `+++ b/x`
// and is not distinguishable from a header by any pattern. Asking git one file
// at a time removes the question instead of answering it badly.
function addedLineRanges(files) {
	const ranges = [];
	for (const file of files) {
		const diff = git(["diff", "--unified=0", base, "--", file]);
		// A file git will not diff contributes no range. `?? ""` would do the same
		// and cannot be tested: every string that is not a diff yields no hunks, so
		// no test can tell one fallback value from another. A guard says the same
		// thing in a form that fails when it is wrong.
		if (!diff) continue;
		for (const line of diff.split("\n")) {
			// Anchored, because an added line holding a hunk header of its own
			// arrives as `+@@ -1 +1 @@` and would otherwise be read as one.
			const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (!hunk) continue;
			const start = Number(hunk[1]);
			// A hunk with no count covers exactly one line; one with `,0` only
			// deletes, and a deleted line cannot hold a mutant.
			const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
			if (count > 0) ranges.push(`${file}:${start}-${start + count - 1}`);
		}
	}
	return ranges;
}

const tsRanges = addedLineRanges(ts);

let failed = false;

function run(label, command, args, options = {}) {
	console.log(`\n=== ${label} ===\n$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: REPO_ROOT,
		stdio: "inherit",
		shell: process.platform === "win32",
		...options
	});
	if (result.status !== 0) failed = true;
}

if (tsRanges.length) {
	// Stryker has no CLI flag for the break threshold, so the run gets a generated
	// config that is the committed one plus this run's scope. Writing it out beats
	// mutating stryker.config.json in place: nothing here can leave the checked-in
	// config holding a diff-shaped `mutate` list.
	mkdirSync(dirname(STRYKER_CONFIG), { recursive: true });
	writeFileSync(
		STRYKER_CONFIG,
		JSON.stringify(
			{
				...stryker,
				mutate: tsRanges,
				// Nothing may survive on a line this change introduced. Equivalent
				// mutants are real, so the escape is a disable comment carrying its
				// reason - a decision in the diff rather than a threshold lowered.
				thresholds: { ...stryker.thresholds, break: 100 }
			},
			null,
			"	"
		)
	);
	run("TypeScript mutants", "pnpm", ["exec", "stryker", "run", STRYKER_CONFIG]);
} else if (ts.length) {
	// Mutable files changed and not one added line among them - a pure deletion,
	// or a move. Said out loud, because a run that mutates nothing and a run that
	// found nothing to mutate look identical from the exit code.
	console.log("No added TypeScript lines; nothing to mutate.");
} else {
	console.log("No TypeScript source changed; nothing to mutate.");
}

if (rust.length) {
	const diff = git(["diff", base, "--", "packages/cli"]) ?? "";
	mkdirSync(dirname(DIFF), { recursive: true });
	writeFileSync(DIFF, diff);
	const installed =
		spawnSync("cargo", ["mutants", "--version"], { stdio: "ignore" }).status ===
		0;
	if (!installed) {
		console.error(
			"cargo-mutants is not installed. `cargo install cargo-mutants` (CI does\n" +
				"this in mutants.yaml). Refusing to report a Rust pass without running."
		);
		process.exit(1);
	}
	run("Rust mutants", "cargo", [
		"mutants",
		"--manifest-path",
		"packages/cli/Cargo.toml",
		"--in-diff",
		DIFF,
		"--no-times"
	]);
} else {
	console.log("No Rust source changed; nothing to mutate.");
}

if (!ts.length && !rust.length) {
	console.log(
		`\nThis change touches no mutable source (base ${base.slice(0, 8)}).`
	);
}

if (failed) {
	console.error(
		"\nMutants survived. Kill them with a test, or annotate the equivalent ones\n" +
			"with the reason they cannot be killed. Do not widen the exclusion set."
	);
	process.exit(1);
}
console.log("\nNo surviving mutants in the changed source.");
