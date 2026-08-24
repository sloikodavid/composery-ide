import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { normalize, posix, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { readRepoFile, repoRoot } from "../support/repo.ts";

// ---------------------------------------------------------------------------
// A path named in prose is a claim, and it is the one kind of claim in this
// repository that nothing checks. Imports are resolved by the compiler and
// links between Markdown pages by docs-links.test.ts, but a path inside a
// comment, a doc sentence or a YAML header is read by a person, months later,
// who has no way to know it moved.
//
// They rot silently and they rot in the worst direction: a comment saying "the
// swap itself is driven in tests/favicon.test.ts" reads as proof that the swap
// is tested. There is no such file and never was. `docs/developing/ide.md`
// attributed the startup-page gate to an overlay module that does not exist,
// when the gate is installed by a patch. Four more pointed at test files that
// had moved under `tests/invariants/` when the three-kind layout landed.
//
// Duplication, and why it cannot be removed: the alternative to naming a file
// in prose is not naming it, which costs the reader the pointer. So the second
// copy stays and this walks it - the last rung of the ladder in AGENTS.md.
// ---------------------------------------------------------------------------

const tracked = execFileSync("git", ["ls-files"], {
	cwd: repoRoot,
	encoding: "utf8",
	maxBuffer: 64 * 1024 * 1024
})
	.split("\n")
	.filter(Boolean);

// Anything shaped like a path into this repository: at least one slash, and a
// first segment that is a real top-level directory here. That last condition is
// what keeps `node:fs`, `@clerk/nextjs` and `caddy:2.11.4-alpine` out.
const ROOTS = new Set([
	".github",
	"docs",
	"packages",
	"rootfs",
	"scripts",
	"templates",
	"tests"
]);

// `packages/web/` and the pages documenting it write their own paths the way
// that package's files do - `convex/schema.ts`, not
// `packages/web/convex/schema.ts` - so those roots are read there and only
// there. Everywhere else a bare `lib/…` means something different or nothing at
// all, and a file at the repository root has no package to resolve against.
//
// Reading them was what surfaced `convex/roles.ts` and `convex/authorization.ts`
// - two files long since folded into `convex/users.ts` - from behind a pile of
// package-relative paths that were all correct.
const WEB = /^(packages\/web|docs\/developing\/web)\//;
const WEB_ROOTS = new Set(["app", "components", "convex", "hooks", "lib"]);
const WEB_BASE = "packages/web/";

// `packages/ide/` speaks in the layout of the tree its build assembles, where
// `lib/vscode/…` and `src/…` are code-server's own directories rather than
// anything in this checkout. That vocabulary is the subject of the whole
// package, so those paths are not read here at all.
const IDE = /^packages\/ide\//;
const CANDIDATE =
	/(?<![\w./-])((?:[\w.-]+\/){1,6}[\w.-]+\.[a-z]{1,5})(?![\w/])/g;

const SEARCHED = /\.(ts|tsx|mjs|mts|rs|sh|md|mdx|yaml|json)$/;

// Paths that are correct without being in the checkout, each for a reason that
// is not "it moved". Nothing here may be a path this repository owns.
const NOT_IN_THE_CHECKOUT = new Set([
	// Written by cargo-mutants during the nightly run.
	"packages/cli/mutants.out",
	// Created by the operator from .env.example.next.dev; gitignored by design.
	"packages/web/.env.local",
	// A path on a running Composery, joined onto a temp directory by the
	// persistence crate's own tests. It names nothing in this checkout and never
	// will - `persistence` is a directory here as well, which is the only reason
	// the sweep looks at it at all.
	"persistence/config.json",
	// A module specifier handed to `require.resolve`, not a path: it resolves
	// through node_modules to whichever Convex the deployment installed. The
	// sweep sees a slash and a `.json` and cannot tell the two apart.
	"convex/package.json",
	// The body of `packages/web/package.json`'s `env:deploy` script, which runs
	// with that package as its working directory. Correct there, and nowhere
	// else - which is exactly what makes it look dangling from the root.
	"scripts/env.mjs"
]);

const files = tracked.filter(
	(file) =>
		SEARCHED.test(file) &&
		!file.startsWith("packages/ide/upstream") &&
		// Written by `convex dev`, and rewritten whole on the next run: nothing
		// here is a sentence anyone maintains.
		!file.includes("/_generated/") &&
		// This file, whose header quotes the dead paths it exists to catch -
		// `tests/favicon.test.ts` among them. A rule that documents its own
		// examples cannot also be held to them.
		file !== "tests/invariants/stale-references.test.ts"
);

const trackedSet = new Set(tracked);
const trackedDirs = new Set<string>();
for (const file of tracked) {
	let dir = posix.dirname(file);
	while (dir && dir !== ".") {
		trackedDirs.add(dir);
		dir = posix.dirname(dir);
	}
}

// A path in a comment is written relative to whatever root its author had in
// mind - the repository, the package, or the file's own directory. All three
// are legitimate, so a reference counts as live if it resolves against any of
// them, or against the submodule and node_modules that git does not track.
function resolves(path: string, from: string): boolean {
	return bases(from).some((base) => {
		const candidate = normalize(base + path)
			.split("\\")
			.join("/");
		if (trackedSet.has(candidate) || trackedDirs.has(candidate)) return true;
		try {
			// The upstream submodule and installed packages are real on disk and
			// invisible to `git ls-files`.
			return Boolean(statSync(resolve(repoRoot, candidate)));
		} catch {
			return false;
		}
	});
}

// Every directory a path could be written relative to: the repository root, the
// file's own directory and each of its ancestors, and - inside the web package -
// that package's root. The same list `resolves` walks, so "read" and "resolves"
// can never disagree about what a path was measured against.
function bases(file: string): string[] {
	const found = [""];
	let dir = posix.dirname(file);
	while (dir && dir !== ".") {
		found.push(`${dir}/`);
		dir = posix.dirname(dir);
	}
	if (WEB.test(file)) found.push(WEB_BASE);
	return found;
}

// Which roots a given file is allowed to name, which is the whole of what makes
// a bare `lib/openapi.ts` meaningful in one place and meaningless in another.
//
// The third clause is the one with a history. A comment in
// `convex/boxes/workflows/repairBox.ts` pointed at `workflows/changeBoxPlan.ts`,
// a file - and a feature - that has never existed, and this sweep did not read
// it: `workflows` is not a top-level root and not one of the web package's, so
// the path was discarded before anything tried to resolve it. Every directory
// name in the repository is a root somebody writes relative to, and enumerating
// them is the list that falls behind. So a first segment that names a real
// directory beside the file, or beside any of its ancestors, is read too - which
// is exactly the condition under which a reader would have followed it.
function reads(file: string, path: string): boolean {
	if (IDE.test(file)) return ROOTS.has(path.split("/")[0] ?? "");
	const root = path.split("/")[0] ?? "";
	if (ROOTS.has(root) || (WEB.test(file) && WEB_ROOTS.has(root))) return true;
	return bases(file).some((base) => trackedDirs.has(`${base}${root}`));
}

const dangling = files.flatMap((file) =>
	[...readRepoFile(file).matchAll(CANDIDATE)]
		.map((match) => match[1] ?? "")
		.filter((path) => reads(file, path))
		// An elision in prose ("overlay/.../narrow.css") names no single file.
		.filter((path) => !path.includes("..."))
		.filter((path) => !NOT_IN_THE_CHECKOUT.has(path))
		.filter((path) => !resolves(path, file))
		.map((path) => `${file}: ${path}`)
);

describe("every repository path named in prose exists", () => {
	test("the sweep reads the files it is meant to read", () => {
		// A green run has to mean the paths resolved, not that the regex stopped
		// finding any. Both numbers drop to zero the same way.
		expect(files.length).toBeGreaterThan(100);

		const found = files.flatMap((file) =>
			[...readRepoFile(file).matchAll(CANDIDATE)]
				.map((match) => match[1] ?? "")
				.filter((path) => reads(file, path))
		);
		expect(found.length).toBeGreaterThan(200);
	});

	test("no comment, doc or header points at a path that is not there", () => {
		expect([...new Set(dangling)].sort()).toEqual([]);
	});

	test("every exemption is still needed", () => {
		// An exemption for a path nobody writes any more is a rule with no
		// subject, and it silently re-permits that spelling later.
		const unused = [...NOT_IN_THE_CHECKOUT].filter(
			(path) =>
				!files.some((file) => readRepoFile(file).includes(path)) ||
				trackedSet.has(path)
		);

		expect(unused).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// A GitHub URL into this repository makes the same claim as a bare path, and
// the sweep above cannot see one: every segment of a URL path follows a slash,
// and CANDIDATE refuses to start a match there. So the links that carry a
// reader from a doc page to a file were the one set of paths here that nothing
// read at all.
//
// They also fail worse than a comment does. `templates/user-data/user-data.yaml`
// fetches three of them on a fresh server's first boot, so a moved template is
// not a dead link somebody eventually reports - it is a 404 in the middle of a
// stranger's install, on a machine nobody here can see.
//
// Duplication, and why it cannot be removed: a docs page cannot link to a file
// on GitHub without writing its path, and the URL is the point of the link. So
// the copy stays and this walks it, exactly as the sweep above does.
// ---------------------------------------------------------------------------

// `blob` and `raw` both name a file's contents; `tree` names a directory. The
// kind is checked, not only that something is there, because that is the half a
// browser accepts and `curl` does not.
const REPO_URL =
	/https:\/\/(?:github\.com\/sloikodavid\/composery\/(blob|raw|tree)|raw\.githubusercontent\.com\/sloikodavid\/composery())\/([\w.-]+)\/([\w./-]+)/g;

// This pattern names the repository outright, so unlike CANDIDATE it cannot
// mistake anything for a link and needs no list of extensions to stay honest.
// It reads every tracked file that is not an image, which is what keeps a link
// written in `Dockerfile`, a Cargo manifest or an overlay `.js` - none of them
// files SEARCHED reads - from being the one nobody checks. An allowlist here
// would have to grow with every file type somebody writes a link in, and the
// day it falls behind is the day it goes quiet rather than red.
// The three binary types this checkout holds, and no more. A fourth one added
// later costs one pointless read, never a wrong answer - no byte sequence spells
// this repository's own URL by accident - so guessing at types nobody has
// committed would buy nothing and would be one more list to keep current.
const BINARY = /\.(png|woff2|ico)$/;
const linked = tracked.filter(
	(file) =>
		!BINARY.test(file) &&
		!file.startsWith("packages/ide/upstream") &&
		file !== "tests/invariants/stale-references.test.ts" &&
		// Not every tracked entry is a file to open. `.claude/skills` is a symlink
		// to a directory and `git ls-files` reports it like any other path, so
		// reading it fails as a directory and takes this whole file down before a
		// single test runs. SEARCHED hid that by accident - the entry has no
		// extension, so no allowlist of extensions ever reached it.
		isFile(file)
);

// Deliberately without a catch. A tracked path that is not there at all is the
// sweep above's business and it throws for one; hiding that here would let this
// sweep report a clean result over a file it never opened.
function isFile(file: string): boolean {
	return statSync(resolve(repoRoot, file)).isFile();
}

const links = linked.flatMap((file) =>
	[...readRepoFile(file).matchAll(REPO_URL)].map((match) => ({
		file,
		// The empty capture on the raw host: that host serves file contents and
		// nothing else, so it names its own kind.
		kind: match[1] || "raw",
		ref: match[3] ?? "",
		// A URL ending a sentence takes the full stop with it. No path here ends
		// in a dot, so dropping trailing ones can only remove prose.
		path: (match[4] ?? "").replace(/\.+$/, "")
	}))
);

describe("every GitHub link into this repository resolves", () => {
	test("the sweep finds the links it is meant to find", () => {
		// Green has to mean the links resolved, not that the pattern stopped
		// matching. Both go to zero the same way.
		expect(links.length).toBeGreaterThan(10);
	});

	test("each one names a file or directory that is still here", () => {
		const dead = links
			.filter(({ kind, path }) =>
				kind === "tree" ? !trackedDirs.has(path) : !trackedSet.has(path)
			)
			.map(({ file, kind, path }) => `${file}: ${kind} ${path}`);

		expect([...new Set(dead)].sort()).toEqual([]);
	});

	test("each one reads the default branch", () => {
		// A link to any other ref is unreadable from this checkout: nothing here
		// can say whether that ref still holds the file. Keeping the rule absolute
		// is what keeps the check above meaningful for every link, rather than for
		// the ones somebody remembered to leave on `main`.
		const pinned = links
			.filter(({ ref }) => ref !== "main")
			.map(({ file, ref }) => `${file}: ${ref}`);

		expect([...new Set(pinned)].sort()).toEqual([]);
	});
});
