import { describe, expect, test } from "vitest";

import { readRepoFile } from "../../../../tests/support/repo.ts";

// ---------------------------------------------------------------------------
// The layout types terminalLayoutMerge.ts restates.
//
// The merge is an overlay module so it can be run by a behaviour test, and an
// overlay module that imports VS Code cannot be compiled by anything short of the
// image build - so it declares the layout shapes it works on instead of importing
// upstream's. That is a second copy of a type, and it cannot be removed (the
// import is the thing being avoided) or derived (nothing here parses TypeScript),
// which leaves the last rung of the ladder: pin the pair.
//
// What goes wrong without this is quiet. Structural typing means the merge keeps
// compiling against a renamed or re-typed upstream field for as long as the pty
// host's call site happens to line up, and the failure surfaces as terminals that
// silently stop appearing in a second window - the exact bug the merge exists to
// fix.
// ---------------------------------------------------------------------------

// A Windows checkout holds upstream with CRLF endings; the declarations below are
// read line by line, so normalise before matching rather than per pattern.
const read = (path: string) => readRepoFile(path).replaceAll("\r\n", "\n");

const UPSTREAM = "packages/ide/upstream/lib/vscode/src/vs/platform/terminal";
const OVERLAY =
	"packages/ide/overlay/lib/vscode/src/vs/platform/terminal/node/terminalLayoutMerge.ts";

// The fields an interface declares, as written. Deliberately literal: it reads
// one-field-per-line declarations and nothing else, so a shape it cannot parse
// comes back empty and the caller's emptiness check fails rather than passing.
function fields(source: string, name: string): Record<string, string> {
	const body = new RegExp(
		`^export interface ${name}(?:<[^>]*>)? \\{\\n([\\s\\S]*?)\\n\\}`,
		"m"
	).exec(source)?.[1];
	return Object.fromEntries(
		[...(body ?? "").matchAll(/^\t(\w+)(\??): (.+?);$/gm)].map((field) => [
			`${field[1]}${field[2]}`,
			field[3]!
		])
	);
}

// Upstream's names for what the overlay calls its own, plus the generic parameter
// the pty host always instantiates at number.
const AS_OVERLAY: Record<string, string> = {
	"IRawTerminalInstanceLayoutInfo<T>": "ITerminalLayoutInstance",
	ITerminalTabLayoutInfoById: "ITerminalLayoutTab",
	T: "number"
};

// Whole type names only. Substring replacement cannot do this: renaming T inside
// the result of renaming IRawTerminalInstanceLayoutInfo<T> produced
// "InumbererminalLayoutInstance", which would have compared unequal forever.
const translate = (type: string): string =>
	type.replace(
		/[A-Za-z_$][\w$]*(?:<[^>]*>)?/g,
		(name) => AS_OVERLAY[name] ?? name
	);

describe("terminal layout types", () => {
	const overlay = read(OVERLAY);

	test.each([
		[
			"common/terminalProcess.ts",
			"ISetTerminalLayoutInfoArgs",
			"ITerminalLayout"
		],
		["common/terminal.ts", "IRawTerminalTabLayoutInfo", "ITerminalLayoutTab"],
		[
			"common/terminal.ts",
			"IRawTerminalInstanceLayoutInfo",
			"ITerminalLayoutInstance"
		]
	])("%s's %s is what the overlay calls %s", (file, upstreamName, ourName) => {
		const upstream = fields(read(`${UPSTREAM}/${file}`), upstreamName);
		const ours = fields(overlay, ourName);

		// Neither side may be empty: two unparsed shapes compare equal.
		expect(Object.keys(upstream).length).toBeGreaterThan(0);
		expect(Object.keys(ours).length).toBe(Object.keys(upstream).length);
		expect(
			Object.fromEntries(
				Object.entries(upstream).map(([field, type]) => [
					field,
					translate(type)
				])
			)
		).toEqual(ours);
	});

	// The one field the merge reads off a process. A rename upstream leaves the
	// gate reading undefined, which is falsy - so every hidden terminal would come
	// back as a visible tab of its own in every window.
	test("hideFromUser is still what marks a terminal hidden", () => {
		const launchConfig = fields(
			read(`${UPSTREAM}/common/terminal.ts`),
			"IShellLaunchConfig"
		);

		expect(launchConfig["hideFromUser?"]).toBe("boolean");
		expect(overlay).toContain("readonly hideFromUser?: boolean");
	});
});
