import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { CONVEX_ENV_NAMES } from "@/convex/env";

// The .env.example.convex.* files are the single documented list of Convex-plane
// environment variables (see packages/web/CLAUDE.md -> "Living setup docs").
// This pins that list to `CONVEX_ENV_NAMES`, which is the plane's environment
// surface rather than a description of one: `requiredEnv`/`optionalEnv` only
// accept a name from it and nothing else in convex/ touches `process.env`, so
// "the code reads it" and "the array lists it" are the same fact, checked by the
// type checker.
//
// This replaced a scanner that looked for `process.env.X` spellings across the
// source. Two things were wrong with that: it could only see names written as
// literals at the read - the four `POLAR_BOX_*` ids were on the checklist by
// accident, matched through a tolerant read rather than through the table that
// names them, and moving that read would have quietly dropped them - and it
// needed a hand-kept set of runtime-injected names to exclude. Neither survives.

const webDir = resolve(import.meta.dirname, "../../..");
const convexDir = join(webDir, "convex");

function envNamesInExample(fileName: string) {
	const names = new Set<string>();
	for (const line of readFileSync(join(webDir, fileName), "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(trimmed);
		if (match) names.add(match[1] as string);
	}
	return names;
}

const sorted = (names: Iterable<string>) => [...names].sort();

describe("Convex environment example checklist", () => {
	test.each([".env.example.convex.dev", ".env.example.convex.prod"])(
		"%s lists exactly the variables the Convex plane declares",
		(fileName) => {
			const listed = envNamesInExample(fileName);
			const missing = sorted(
				CONVEX_ENV_NAMES.filter((name) => !listed.has(name))
			);
			const unread = sorted(
				[...listed].filter(
					(name) => !(CONVEX_ENV_NAMES as readonly string[]).includes(name)
				)
			);
			expect(
				{ missing, unread },
				`${fileName}: 'missing' are declared in convex/env.ts but absent from the file; 'unread' are in the file but declared nowhere`
			).toEqual({ missing: [], unread: [] });
		}
	);

	// The registry is only the whole surface for as long as it is the only door.
	// A bare `process.env` read elsewhere in convex/ is a variable that can ship
	// undeclared and undocumented, which is exactly what this file exists to stop.
	test("convex/env.ts is the only module that touches process.env", () => {
		const offenders: string[] = [];
		for (const entry of readdirSync(convexDir, { recursive: true })) {
			const path = String(entry).replaceAll("\\", "/");
			if (!path.endsWith(".ts")) continue;
			if (path.startsWith("_generated/") || path === "env.ts") continue;
			const source = readFileSync(join(convexDir, path), "utf8");
			// Comments may name it; a read is an access.
			if (/process\.env\s*[.[]/.test(source)) offenders.push(path);
		}
		expect(offenders).toEqual([]);
	});

	// Convex performs the real declaration validation, but its config cannot be
	// imported outside the Convex analyzer: the component config entry points
	// throw when their runtime-only metadata is absent. This extraction is the
	// unavoidable pin between the registry and that external tool boundary.
	test("convex.config.ts gives the registry to the deploy validator", () => {
		const source = readFileSync(join(convexDir, "convex.config.ts"), "utf8");
		const imported =
			/import \{ (\w+) \} from "\.\/env";/.exec(source)?.[1] ?? null;
		const declared = /defineApp\(\{ env: (\w+) \}\)/.exec(source)?.[1] ?? null;

		expect({ imported, declared }).toEqual({
			imported: "CONVEX_ENV",
			declared: "CONVEX_ENV"
		});
	});
});
