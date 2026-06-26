import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { readRepoFile, repoRoot } from "../../../../tests/support/repo.ts";

// ---------------------------------------------------------------------------
// A patch is a call site.
//
// AGENTS.md says logic lives in an overlay module the patch calls, because code
// written inside a diff can only be reached by evaluating its added lines: no
// coverage tool instruments a patch, no test can import one, and every assertion
// about it degrades to a grep over its own text. Until this test existed the rule
// was an honour system, and the honour system lost - loopback-callback.diff
// carried 110 lines of URL parsing that decided whether a sign-in link was safe
// to open, and nothing had ever run a line of it.
//
// So: a patch may not introduce a top-level declaration. Anything a patch would
// declare at module scope is a thing that could have been a module.
//
// This is deliberately blunt. It says nothing about logic inside an upstream
// class's methods, which is most of what the stack does and is genuinely
// call-site work - a guard on a capability, a listener installed at the point
// upstream builds the object. That logic cannot be lifted without dragging the
// object with it, and pretending otherwise would produce modules that take a
// Layout and call it separation.
// ---------------------------------------------------------------------------

const PATCHES_DIR = "packages/ide/patches";

// Declarations a patch is allowed to introduce, with the reason each one cannot
// be an overlay module. Every entry is a thing that would be better as a module
// if it could be - shrink this list, never grow it without a reason of the same
// kind.
const ALLOWED = new Map<string, string>([
	[
		"api.diff:isForWorkspace",
		"takes PersistentTerminalProcess, which ptyService.ts does not export - an overlay module could not name the type"
	],
	[
		"api.diff:ptyService",
		"a one-line accessor over this module's own state; there is nothing here to run"
	],
	[
		"defaults.diff:COMPOSERY_DEFAULT_HIDDEN_CONTAINER_IDS",
		"a list of ids, not logic; patches.test.ts pins how it is read"
	],
	[
		"defaults.diff:COMPOSERY_DEFAULT_HIDDEN_VIEW_IDS",
		"a list of ids, not logic; patches.test.ts pins how it is read"
	],
	[
		"api.diff:API_TERMINAL_WORKSPACE_ID",
		"a sentinel the API routes carry a second copy of; the two trees compile apart and cannot share a symbol, so patches.test.ts pins them instead"
	],
	[
		"terminal-sharing.diff:getRemoteTerminalWorkspaceId",
		"one line binding upstream's hash to terminalWorkspaceId.ts - the rule itself is the module"
	],
	[
		"touch.diff:PAN_THRESHOLD",
		"a number exported so the editor and Gesture classify one pan the same way; a second copy is the bug it exists to prevent"
	],
	[
		"touch.diff:CURSOR_ON_LINK",
		"a RawContextKey registration - constructing it is the whole of it, and it must happen in upstream's module"
	]
]);

// A top-level declaration, from a line with no leading indentation. Indented
// declarations are class members and method bodies, which this rule is not about.
const DECLARATION =
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;

// What a patch adds and what it removes, by declaration name. A patch that
// changes an upstream function's signature necessarily writes the whole line
// again; that is a modification, not a new declaration, and the removed side is
// how they are told apart.
function declarations(patch: string, marker: "+" | "-"): Set<string> {
	const names = new Set<string>();
	for (const line of patch.split("\n")) {
		if (!line.startsWith(marker) || line.startsWith(`${marker}${marker}`)) {
			continue;
		}
		const name = DECLARATION.exec(line.slice(1))?.[1];
		if (name) names.add(name);
	}
	return names;
}

const patches = readdirSync(resolve(repoRoot, PATCHES_DIR))
	.filter((name) => name.endsWith(".diff"))
	.sort();

describe("a patch is a call site", () => {
	test("the patch stack introduces no top-level declaration of its own", () => {
		const introduced: string[] = [];
		for (const name of patches) {
			const patch = readRepoFile(`${PATCHES_DIR}/${name}`);
			const removed = declarations(patch, "-");
			for (const declaration of declarations(patch, "+")) {
				if (removed.has(declaration)) continue;
				const key = `${name}:${declaration}`;
				if (!ALLOWED.has(key)) introduced.push(key);
			}
		}

		expect(introduced).toEqual([]);
	});

	// An allowlist nobody prunes is a second honour system. Each entry has to name
	// something the stack still contains, so deleting a patch or lifting the
	// declaration it excused also deletes its excuse.
	test("every allowance is still needed", () => {
		const stale: string[] = [];
		for (const [key, reason] of ALLOWED) {
			const [name, declaration] = key.split(":");
			expect(reason.length, `${key} has no reason`).toBeGreaterThan(30);
			if (
				!patches.includes(name!) ||
				!declarations(readRepoFile(`${PATCHES_DIR}/${name}`), "+").has(
					declaration!
				)
			) {
				stale.push(key);
			}
		}

		expect(stale).toEqual([]);
	});

	// A green run must mean the sweep ran. If the declaration pattern ever stops
	// matching - a syntax the stack starts using, a refactor of the regex - every
	// patch reads as declaring nothing and the check passes on an empty sweep.
	test("the sweep can see the declarations it allows", () => {
		const seen = patches.flatMap((name) =>
			[...declarations(readRepoFile(`${PATCHES_DIR}/${name}`), "+")].map(
				(declaration) => `${name}:${declaration}`
			)
		);

		expect(seen).toEqual(expect.arrayContaining([...ALLOWED.keys()]));
	});
});
