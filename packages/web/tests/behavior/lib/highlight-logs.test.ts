import { describe, expect, test } from "vitest";

import { highlightLogs } from "@/lib/highlight-logs";

// The box log panel's colouring. It renders ANSI escapes as markup for both
// themes at once, and it holds one highlighter for the process: building a shiki
// highlighter loads grammars and themes, so one per poll of a live log panel
// would be a new one every few seconds.

// A real ANSI sequence, written by escape code rather than pasted, so the file
// stays free of control characters.
const RED = `${String.fromCharCode(27)}[31merror${String.fromCharCode(27)}[0m`;

describe("colouring a box's logs", () => {
	test("renders plain output as markup the panel can show", async () => {
		const html = await highlightLogs("editor listening on 8080");

		expect(html).toContain("editor listening on 8080");
		expect(html).toMatch(/<pre[\s>]/);
	});

	// Both themes in one pass, because the panel switches without re-fetching:
	// `defaultColor: false` emits each token's light and dark colour together.
	test("carries a colour for each theme rather than picking one", async () => {
		const html = await highlightLogs(RED);

		expect(html).toContain("--shiki-light");
		expect(html).toContain("--shiki-dark");
	});

	// The escape codes themselves are markup once rendered, never text the reader
	// has to look at.
	test("turns the escape codes into markup rather than showing them", async () => {
		const html = await highlightLogs(RED);

		expect(html).toContain("error");
		expect(html).not.toContain(String.fromCharCode(27));
	});

	// A box that has printed nothing yet is the normal state of one still
	// booting, and it has to render rather than throw.
	test("renders an empty log", async () => {
		await expect(highlightLogs("")).resolves.toMatch(/<pre[\s>]/);
	});

	// The second call reuses the highlighter the first built. Measured by timing
	// rather than by reaching inside: building one loads grammars and themes and
	// is slower by orders of magnitude, so a rebuild could not come back this
	// fast.
	test("builds its highlighter once and keeps it", async () => {
		await highlightLogs("warm");

		const started = performance.now();
		await highlightLogs("again");

		expect(performance.now() - started).toBeLessThan(250);
	});
});
