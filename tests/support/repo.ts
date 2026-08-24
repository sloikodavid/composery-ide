import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { resolve } from "node:path";

// Locating and reading the checkout. Available to any test: loading a module a
// bundler would otherwise hide is legitimate everywhere, and reading a file to
// assert about its text is confined by which support module a test may import,
// not by whether it can find the repository. See docs/developing/testing.md.
//
// Every reader here anchors on `repoRoot`, which comes from this file's own
// location rather than from `process.cwd()`. That is not tidiness: vitest sets a
// project's `root` but leaves the working directory wherever it was invoked, so
// a relative `readdirSync("packages/ide/patches")` or a `git ls-files` with
// `cwd: process.cwd()` reads a different tree depending on which directory
// somebody typed the command in. `pnpm vitest` inside `packages/web` used to
// fail six unrelated repository invariants for that reason alone.
export const repoRoot = resolve(import.meta.dirname, "..", "..");

export function readRepoFile(path: string): string {
	return readFileSync(resolve(repoRoot, path), "utf8");
}

// A directory listing anchored the same way. `options` is passed straight to
// `readdirSync`, so a caller still chooses recursion and entry objects.
export function readRepoDir(path: string): string[];
export function readRepoDir(
	path: string,
	options: { recursive?: boolean; withFileTypes: true }
): Dirent[];
// The implementation's return type is written out rather than inferred. `options
// as never` makes TypeScript resolve `readdirSync` to its string[] overload, so
// an inferred signature is narrower than the Dirent[] overload above and the two
// stop being compatible - which is a type error about this file, not about any
// caller, and so goes unnoticed until a full typecheck runs.
export function readRepoDir(
	path: string,
	options?: { recursive?: boolean; withFileTypes?: true }
): string[] | Dirent[] {
	return readdirSync(resolve(repoRoot, path), options as never);
}

// The tracked files, as git sees them from the root of the checkout.
export function trackedFiles(...pathspec: string[]): string[] {
	return execFileSync("git", ["ls-files", ...pathspec], {
		cwd: repoRoot,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024
	})
		.split("\n")
		.filter(Boolean);
}
