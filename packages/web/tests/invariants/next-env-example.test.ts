import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { NEXT_ENV_NAMES } from "@/lib/env";

// The other half of the rule in packages/web/CLAUDE.md -> "Living setup docs":
// each plane's `.env.example.*` files are the single documented list of that
// plane's variables. `convex/envExample.test.ts` has held the Convex plane to
// it since the registry in `convex/env.ts` made the surface checkable. The Next
// plane had nothing, so its two files could list a variable no code reads, or
// miss one every render needs, and stay green - the rule was stated for two
// planes and enforced for one.
//
// Duplication, and why it cannot be removed: `ui/lib/env.ts` is the plane's
// surface rather than a description of one - it is keyed by each variable's own
// name, so `NEXT_ENV_NAMES` is derived from the reads instead of restating
// them, exactly as `CONVEX_ENV_NAMES` is. What no registry can hold is the
// handful of names an SDK reads straight out of the environment without any
// file of ours mentioning them; those are listed below with the SDK that reads
// each. Both planes are now checked the same way.
//
// This replaced a scan of every `.ts`/`.tsx` under `app/` and `ui/`
// for `process.env.X` spellings - which could only ever see
// a read written as a literal, and went stale the moment one moved.

const WEB_DIR = resolve(import.meta.dirname, "../..");

// Everything Next builds and serves. `convex/` is the other plane and has its
// own checklist; `tests/` is not shipped.
const PLANE = ["app", "components", "hooks", "lib"];
const PLANE_FILES = ["next.config.ts", "proxy.ts", "source.config.ts"];
const DOOR = "lib/env.ts";

const DEV = ".env.example.next.dev";
const PROD = ".env.example.next.prod";

// Names no file of ours reads, because the SDK reads them straight out of the
// environment. Each entry names the reader; an entry that cannot is a variable
// nothing consumes and belongs deleted rather than listed.
const READ_BY_AN_SDK = new Map([
	[
		"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
		"@clerk/nextjs, on both server and client"
	],
	["NEXT_PUBLIC_CLERK_SIGN_IN_URL", "@clerk/nextjs, to route <SignIn />"],
	["CLERK_SECRET_KEY", "@clerk/nextjs on the server"],
	[
		"CONVEX_DEPLOYMENT",
		"the convex CLI, to pick the deployment `convex dev` runs against"
	],
	["CONVEX_DEPLOY_KEY", "`convex deploy`, to authenticate the production build"]
]);

// Where the two files legitimately differ, and why. Anything not listed here
// has to appear in both: a variable that only one environment sets is a
// deployment that only half works.
const ONLY_IN = new Map([
	["CONVEX_DEPLOYMENT", DEV],
	["CONVEX_DEPLOY_KEY", PROD],
	// `convex deploy` injects it into the production build, so Vercel never
	// stores it even though providers.tsx reads it on every render.
	["NEXT_PUBLIC_CONVEX_URL", DEV]
]);

function listed(file: string): Set<string> {
	const names = new Set<string>();
	for (const line of readFileSync(join(WEB_DIR, file), "utf8").split("\n")) {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
		if (match?.[1]) names.add(match[1]);
	}
	return names;
}

function sourceFiles(): string[] {
	const found = [...PLANE_FILES];
	for (const dir of PLANE) {
		for (const entry of readdirSync(join(WEB_DIR, dir), { recursive: true })) {
			const path = `${dir}/${String(entry).split("\\").join("/")}`;
			if (/\.tsx?$/.test(path)) found.push(path);
		}
	}
	return found;
}

const read = new Set<string>(NEXT_ENV_NAMES);

const sorted = (names: Iterable<string>) => [...names].sort();

describe("Next environment example checklist", () => {
	test("the registry is populated and the plane is walked", () => {
		// Every assertion below is a set difference, and all of them pass on an
		// empty set. If either side empties out, this is what says so.
		expect(read.size).toBeGreaterThan(3);
		expect(sourceFiles().length).toBeGreaterThan(50);
	});

	// The registry is the whole surface only for as long as it is the only door.
	// A bare `process.env` read in a component is a variable that can ship
	// undeclared and undocumented, which is what this file exists to stop - the
	// same test `convex/envExample.test.ts` carries for the other plane.
	test("lib/env.ts is the only module that touches process.env", () => {
		const offenders = sourceFiles().filter(
			(file) =>
				file !== DOOR &&
				/process\.env\s*[.[]/.test(readFileSync(join(WEB_DIR, file), "utf8"))
		);

		expect(offenders).toEqual([]);
	});

	test.each([DEV, PROD])("%s lists every variable the plane reads", (file) => {
		const names = listed(file);
		// Absent is only allowed when ONLY_IN assigns the name to the other file.
		const missing = sorted(
			[...read].filter(
				(name) => !names.has(name) && (ONLY_IN.get(name) ?? file) === file
			)
		);

		expect(
			missing,
			`${file} is missing variables that Next code reads through process.env`
		).toEqual([]);
	});

	test.each([DEV, PROD])("%s lists nothing that nobody reads", (file) => {
		const unread = sorted(
			[...listed(file)].filter(
				(name) => !read.has(name) && !READ_BY_AN_SDK.has(name)
			)
		);

		expect(
			unread,
			`${file} lists variables that no Next code reads and no SDK is recorded as reading`
		).toEqual([]);
	});

	test("the two files differ only where a reason is recorded", () => {
		const dev = listed(DEV);
		const prod = listed(PROD);
		const asymmetric = sorted(
			[...new Set([...dev, ...prod])].filter(
				(name) => dev.has(name) !== prod.has(name)
			)
		);

		expect(asymmetric).toEqual(sorted(ONLY_IN.keys()));
		for (const [name, file] of ONLY_IN) {
			expect(listed(file).has(name), `${name} should be in ${file}`).toBe(true);
		}
	});

	test("every SDK-read name is still listed somewhere", () => {
		// An entry for a variable no file lists any more is a reason with no
		// subject, and it silently permits that name back into a checklist.
		const orphans = [...READ_BY_AN_SDK.keys()].filter(
			(name) => !listed(DEV).has(name) && !listed(PROD).has(name)
		);

		expect(orphans).toEqual([]);
	});
});
