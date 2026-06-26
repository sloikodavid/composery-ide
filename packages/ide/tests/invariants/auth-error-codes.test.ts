import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { readRepoFile, repoRoot } from "../../../../tests/support/repo.ts";

// ---------------------------------------------------------------------------
// Auth error codes: every one that is sent can be rendered.
//
// The auth pages redirect to each other with a code in the query string, and the
// page that renders it is often not the page that sent it - register bounces an
// owner who already has a password to login, change-password sends an instance
// with no password to register. A code with no message on the receiving page shows the
// user a bare form and no reason at all, and nothing else would ever say so: the
// redirect succeeds, the page renders, the error is simply missing.
//
// Producers are `redirect(req, res, "<page>", { ..., error: "<code>" })` call
// sites, which live in the overlay routes and in the patch stack; consumers are
// the table in authErrors.ts. Neither side can import the other (they compile
// into different trees), so this reads both as text - the last rung of the
// duplication ladder, and the reason it earns its place is that the two sides
// genuinely cannot be one.
// ---------------------------------------------------------------------------

const ROUTES = "packages/ide/overlay/src/node/routes";
const PATCHES_DIR = "packages/ide/patches";
const TABLE = `${ROUTES}/authErrors.ts`;

// redirect(req, res, "<page>", { ... error: "<code>" ... }), across line breaks,
// and only when a literal code is passed - `error: undefined` clears one and
// `error: someVariable` is not a literal anything.
const REDIRECTS = /redirect\(\s*req,\s*res,\s*"([^"]+)"\s*,\s*\{([^}]*)\}/gs;
const LITERAL_ERROR = /\berror:\s*"([^"]+)"/;

function sent(source: string): { page: string; code: string }[] {
	return [...source.matchAll(REDIRECTS)].flatMap((redirect) => {
		const code = LITERAL_ERROR.exec(redirect[2]!)?.[1];
		return code ? [{ page: redirect[1]!, code }] : [];
	});
}

// The codes a page can render, read off the table's own nesting: a page opens a
// block, and the keys inside it up to the closing brace are its codes.
//
// Indentation is read from the opening line rather than assumed. This file is
// formatted by upstream code-server's prettier config (two spaces), not this
// repo's (tabs), and a parser that hardcoded one of them reported every page as
// rendering nothing the day that changed - a silent pass on the "no message for
// a code nothing sends" direction, which is why the sweep guard above exists.
function rendered(page: string): string[] {
	const table = readRepoFile(TABLE);
	const start = new RegExp(`^([ \t]+)(?:"${page}"|${page}): \\{$`, "m").exec(
		table
	);
	if (!start) return [];
	const indent = start[1]!;
	const body = table.slice(start.index + start[0].length);
	const end = body.indexOf(`\n${indent}}`);
	return [
		...body
			.slice(0, end === -1 ? undefined : end)
			.matchAll(new RegExp(`^${indent}[ \t]+"?([\\w-]+)"?:`, "gm"))
	].map((key) => key[1]!);
}

const sources = [
	...readdirSync(resolve(repoRoot, ROUTES))
		.filter((name) => name.endsWith(".ts"))
		.map((name) => `${ROUTES}/${name}`),
	...readdirSync(resolve(repoRoot, PATCHES_DIR))
		.filter((name) => name.endsWith(".diff"))
		.map((name) => `${PATCHES_DIR}/${name}`)
];

describe("auth error codes", () => {
	const produced = sources.flatMap((path) =>
		sent(readRepoFile(path)).map((redirect) => ({ ...redirect, path }))
	);

	// A green run has to mean the sweep found the redirects, not that a regex
	// stopped matching them.
	test("the sweep finds the redirects it is meant to read", () => {
		expect(produced.length).toBeGreaterThan(4);
		expect(
			new Set(produced.map((redirect) => redirect.page)).size
		).toBeGreaterThan(1);
	});

	test("every page named by a redirect has a table of its own", () => {
		const pages = [...new Set(produced.map((redirect) => redirect.page))];

		expect(pages.filter((page) => rendered(page).length === 0)).toEqual([]);
	});

	test("every code that is sent can be rendered by the page it is sent to", () => {
		const unrenderable = produced
			.filter((redirect) => !rendered(redirect.page).includes(redirect.code))
			.map(
				(redirect) =>
					`${redirect.path}: ${redirect.page}?error=${redirect.code}`
			);

		expect(unrenderable).toEqual([]);
	});

	// The other direction is a warning, not a failure: a code kept for a route
	// that has not been written yet is fine, a code kept for a route that was
	// deleted is dead text nobody will ever see. Listing them keeps the table
	// honest without failing on work in progress.
	test("no page carries a message for a code nothing sends", () => {
		const sentCodes = new Set(
			produced.map((redirect) => `${redirect.page}:${redirect.code}`)
		);
		const orphans = ["login", "register", "change-password"].flatMap((page) =>
			rendered(page)
				.filter((code) => !sentCodes.has(`${page}:${code}`))
				.map((code) => `${page}:${code}`)
		);

		expect(orphans).toEqual([]);
	});
});
