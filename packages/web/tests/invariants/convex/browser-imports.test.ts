import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Nothing the browser bundles may reach a module that registers Convex
// functions.
//
// `query`/`mutation`/`action` and their internal siblings call `assertNotBrowser`
// when they run. Import such a module from a client component and `convex` logs
// "Convex functions should not be imported in the browser", which it says will
// become a thrown error. The whole server module lands in the client bundle
// too - schema, secrets handling, every module it imports.
//
// It is easy to do by accident because the offending import is usually one
// constant: the console's cards wanted `DEFAULT_THRESHOLDS` and
// `MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER`, which happened to sit beside the
// mutations that write them. The fix is always the same - the shared value moves
// to `convex/model/`, which is already defined as the words both planes speak.
//
// This reads the checkout rather than loading the modules because that is the
// only way to see it: the import is legal TypeScript, the bundler is happy, and
// the warning appears at runtime in a real browser only - `typeof window` is
// undefined in Node and the test environment's `window` is not native code, so
// `assertNotBrowser` returns quietly in both. The duplication is the import
// graph, walked here a second time, and it cannot be removed for the same
// reason.
// ---------------------------------------------------------------------------

const root = fileURLToPath(new URL("../../..", import.meta.url));

// `app/` is the route tree, so it holds server-only files too (route handlers,
// server components). They are included on purpose: a route handler and a client
// component are the same file to this test, and the one import that matters -
// `_generated/server` - is wrong in both. A handler talks to Convex through
// `convex/nextjs` and `_generated/api`, neither of which registers anything.
const BROWSER_ROOTS = ["app", "components", "hooks", "lib"];

// Where the registration builders come from. `convex/server` itself is fine to
// import for `defineSchema`, `cronJobs` or a type; it is the generated module
// that hands out `query`/`mutation`/`action` bound to this deployment, and every
// module that defines a Convex function imports it.
const REGISTRATION_MODULE = "_generated/server";

function trackedFiles(directory: string) {
	return execFileSync("git", ["ls-files", directory], {
		cwd: root,
		encoding: "utf8"
	})
		.split("\n")
		.filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
		.filter((file) => existsSync(new URL(file, `file:///${root}/`)));
}

// Import statements, `export ... from` included: a re-export pulls the module in
// exactly as an import does.
const IMPORT =
	/(?:^|\n)\s*(?:import|export)\b([^;]*?) from\s*["']([^"']+)["']/g;

// A type-only import is erased before the bundler sees it, so it cannot make a
// module reachable. Both spellings count: the statement form (`import type {…}`)
// and one where every named specifier carries its own `type`.
function isTypeOnly(clause: string) {
	if (/^\s*type\s/.test(clause)) return true;
	const braces = clause.match(/\{([^}]*)\}/);
	if (!braces) return false;
	if (clause.replace(braces[0], "").trim().replace(/^,|,$/g, "").trim()) {
		return false;
	}
	const specifiers = braces[1]!
		.split(",")
		.map((specifier) => specifier.trim())
		.filter(Boolean);
	return (
		specifiers.length > 0 &&
		specifiers.every((specifier) => /^type\s/.test(specifier))
	);
}

function valueImports(file: string) {
	const source = readFileSync(new URL(file, `file:///${root}/`), "utf8");
	return [...source.matchAll(IMPORT)]
		.filter((match) => !isTypeOnly(match[1]!))
		.map((match) => match[2]!);
}

const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

// Resolves the two specifier shapes that can reach `convex/`: the `@/` alias
// from `tsconfig.json`, and a relative path from inside `convex/` itself. A
// package name resolves to nothing, which is the answer we want - node_modules
// is not ours to walk.
function resolve(specifier: string, fromFile: string) {
	let base: string;
	if (specifier.startsWith("@/")) {
		base = specifier.slice(2);
	} else if (specifier.startsWith(".")) {
		const directory = fromFile.split("/").slice(0, -1).join("/");
		base = new URL(specifier, `file:///${directory}/`).pathname.slice(1);
	} else {
		return null;
	}
	for (const extension of EXTENSIONS) {
		const candidate = `${base}${extension}`;
		if (existsSync(new URL(candidate, `file:///${root}/`))) return candidate;
	}
	return null;
}

// The first path from `file` to a module importing the registration builders, or
// null. The path is the message: "this component imports that module imports
// that one" is what tells you which value to move.
const walked = new Map<string, string[] | null>();

function pathToRegistration(file: string, seen = new Set<string>()): string[] {
	const cached = walked.get(file);
	if (cached !== undefined) return cached ?? [];
	if (seen.has(file)) return [];
	seen.add(file);

	for (const specifier of valueImports(file)) {
		if (specifier.includes(REGISTRATION_MODULE)) return [file, specifier];
		const target = resolve(specifier, file);
		if (!target) continue;
		const rest = pathToRegistration(target, seen);
		if (rest.length > 0) return [file, ...rest];
	}
	// Only cache a clean answer. A "no" found while an ancestor is still on the
	// stack is complete - every cycle back into the stack is a module already
	// being walked - but a partial "yes" is not, so misses alone are kept.
	walked.set(file, null);
	return [];
}

const offenders = BROWSER_ROOTS.flatMap(trackedFiles)
	.map((file) => ({ file, path: pathToRegistration(file) }))
	.filter((entry) => entry.path.length > 0);

describe("the browser plane never imports a Convex function module", () => {
	test("no file under app, components, hooks or lib reaches _generated/server", () => {
		expect(offenders.map((entry) => entry.path.join(" -> "))).toStrictEqual([]);
	});

	// The walk is what the rule rests on, so prove it can still see a chain
	// rather than trusting an empty result. `convex/settings.ts` imports the
	// builders directly; `convex/crons.ts` imports none of them and reaches them
	// through `convex/boxes/metrics.ts`, which is the shape that matters here.
	test("the walk finds a module that does import the builders", () => {
		expect(pathToRegistration("convex/settings.ts")).toStrictEqual([
			"convex/settings.ts",
			"./_generated/server"
		]);
		expect(pathToRegistration("convex/crons.ts")).toStrictEqual([
			"convex/crons.ts",
			"convex/boxes/metrics.ts",
			"../_generated/server"
		]);
	});

	// And that a type-only import does not count, which is the only reason the
	// console's pages pass at all.
	test("a type-only import does not make a module reachable", () => {
		expect(isTypeOnly(" type { RuntimeStanding } ")).toBe(true);
		expect(isTypeOnly(" { type BoxStatus, type SnapshotStatus } ")).toBe(true);
		expect(isTypeOnly(" { DEFAULT_THRESHOLDS, type ThresholdSetting } ")).toBe(
			false
		);
		expect(isTypeOnly(" { api } ")).toBe(false);
	});
});
