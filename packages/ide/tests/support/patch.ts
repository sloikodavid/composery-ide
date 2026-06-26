import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Text handling for the patch stack: applying it, and lifting code back out of
// a diff so it can be exercised.
//
// Importable only from `packages/ide/tests/invariants/`, plus the shrinking
// allowlist in the enforcer suite. Extraction is the tooling that makes
// `expect(source).toContain(...)` possible, and confining the tool is the exact
// form of a rule that trying to recognise the assertion could only approximate.
// A behaviour test loads the module instead - see `overlay.ts`, and the patch
// rule in docs/developing/testing.md.

// "Whatever is called patch" was not a usable rule. The Windows runner resolves
// PATH to Strawberry Perl's patch 2.5.9 (C:\Strawberry\c\bin), which aborts on
// brand.diff's theme section - "Assertation failed!", patch.c:354, expression
// `hunk` - after writing a partial file. Nor is a version string: 2.5.9 predates
// the "GNU patch" banner and announces itself as plain "patch 2.5.9", which is
// the same shape as Apple's "patch 2.0-12u11-Apple" - and that one applies the
// whole stack correctly, so a numeric floor rejects the working tool and keeps
// the broken one.
//
// So prefer a build we can locate and know to be good over one we can only
// interrogate. Git for Windows bundles 2.7.6 in <git>/usr/bin, off PATH, and
// git is already a hard requirement here. Delete the win32 branch when no
// supported runner ships a pre-2.6 patch on PATH.
function runnable(binary: string): boolean {
	return spawnSync(binary, ["--version"], { stdio: "ignore" }).status === 0;
}

function gitBundledPatch(): string | undefined {
	if (process.platform !== "win32") return undefined;
	const gitCore = execFileSync("git", ["--exec-path"], {
		encoding: "utf8"
	}).trim();
	// <git>/mingw64/libexec/git-core -> <git>/usr/bin
	const bundled = resolve(gitCore, "..", "..", "..", "usr", "bin", "patch.exe");
	return existsSync(bundled) ? bundled : undefined;
}

const patchBin = (() => {
	for (const candidate of [gitBundledPatch(), "patch"]) {
		if (candidate && runnable(candidate)) return candidate;
	}
	throw new Error("No usable patch(1) found; the patch-stack tests need one.");
})();

export function applyPatch(patchFile: string, cwd: string): void {
	// BSD patch keeps a successfully emptied file unless -E is explicit, while
	// GNU patch removes a file whose new path is /dev/null by default. Require
	// the shared semantic instead of letting the rehearsal depend on its host.
	execFileSync(patchBin, ["-p1", "-E", "--fuzz=0", "-i", patchFile], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"]
	});
}

// All lines a patch adds, with the leading "+" stripped.
export function addedLines(patch: string): string {
	return patch
		.split(/\r?\n/)
		.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
		.map((line) => line.slice(1))
		.join("\n");
}

// Every line a patch leaves behind inside its hunks - added and context both,
// with the leading marker stripped. This is what the file reads like after the
// patch applies, so constructs that open on an added line and close on a context
// line (a case block whose trailing brace was already there) stay balanced.
// Hunks are not contiguous with each other, so only use this within one hunk.
export function postImageLines(patch: string): string {
	return patch
		.split(/\r?\n/)
		.filter(
			(line) =>
				(line.startsWith("+") && !line.startsWith("+++")) ||
				line.startsWith(" ")
		)
		.map((line) => line.slice(1))
		.join("\n");
}
