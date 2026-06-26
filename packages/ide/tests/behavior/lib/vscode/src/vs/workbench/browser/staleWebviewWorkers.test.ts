import { describe, expect, test } from "vitest";

import { isStaleWebviewWorkerScope } from "../../../../../../../../overlay/lib/vscode/src/vs/workbench/browser/staleWebviewWorkers.ts";

// What a webview actually registers: service-worker.js relative to the pre page,
// which the server hands out below the stamped static route.
const webviewScope = (stamp: string, base = "") =>
	`https://composery.example.com${base}/stable-${stamp}/static/out/vs/workbench/contrib/webview/browser/pre/`;

const STAMP = "9f2c1ab4d7e0";

describe("stale webview workers", () => {
	test("a webview worker left under an older stamp is stale", () => {
		expect(isStaleWebviewWorkerScope(webviewScope("0000deadbeef"), STAMP)).toBe(
			true
		);
	});

	test("this build's own webview worker is kept", () => {
		expect(isStaleWebviewWorkerScope(webviewScope(STAMP), STAMP)).toBe(false);
	});

	// The workbench's own worker is scoped to the site root and carries no stamp.
	// Unregistering it would take out the running workbench's offline support.
	test.each([
		"https://composery.example.com/",
		"https://composery.example.com/prefix/",
		"https://composery.example.com/static/out/"
	])("%s carries no stamp and is left alone", (scope) => {
		expect(isStaleWebviewWorkerScope(scope, STAMP)).toBe(false);
	});

	test("a stamped scope behind a path prefix is still read", () => {
		expect(
			isStaleWebviewWorkerScope(
				webviewScope("0000deadbeef", "/boxes/mine"),
				STAMP
			)
		).toBe(true);
	});

	// The two failures a substring test makes, both ending in unregister():
	// keeping a stale worker whose stamp merely contains ours, and deleting a
	// registration that only happens to have those characters in its path.
	test("a stamp this one is a prefix of is a different stamp", () => {
		expect(isStaleWebviewWorkerScope(webviewScope(`${STAMP}00`), STAMP)).toBe(
			true
		);
	});

	test.each([
		"https://composery.example.com/my-stable-notes/",
		"https://composery.example.com/unstable-9f2c1ab4d7e0/",
		"https://composery.example.com/docs/stable-releases.html"
	])("%s is not a stamped scope", (scope) => {
		expect(isStaleWebviewWorkerScope(scope, STAMP)).toBe(false);
	});

	// Fail towards keeping: everything here ends in unregister(), so a scope this
	// cannot read is left registered rather than guessed at.
	test.each([
		["", "an empty scope"],
		["not a url", "unparseable text"],
		["/stable-0000deadbeef/static/", "a relative path"]
	])("%s is left alone (%s)", (scope) => {
		expect(isStaleWebviewWorkerScope(scope, STAMP)).toBe(false);
	});

	test("a build with no stamp purges nothing", () => {
		expect(isStaleWebviewWorkerScope(webviewScope("0000deadbeef"), "")).toBe(
			false
		);
		expect(
			isStaleWebviewWorkerScope(webviewScope("0000deadbeef"), undefined)
		).toBe(false);
	});

	// "stable-" alone names no build, so there is nothing to compare it against.
	test("a bare stable- segment is not a stamp", () => {
		expect(
			isStaleWebviewWorkerScope(
				"https://composery.example.com/stable-/static/",
				STAMP
			)
		).toBe(false);
	});
});
