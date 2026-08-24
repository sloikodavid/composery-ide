import { describe, expect, test } from "vitest";
import { parse } from "yaml";

import { readRepoFile } from "../support/repo.ts";

// A hand-written spec is a second copy of the routes, and a second copy drifts
// silently: it still renders, still validates, still reads as authoritative, and
// only a caller finds out. Everything here reads the real thing back out of the
// route source rather than restating it.

const ROUTES = "packages/ide/overlay/src/node/routes/api";
const terminals = readRepoFile(`${ROUTES}/terminals.ts`);
const auth = readRepoFile(`${ROUTES}/auth.ts`);
const index = readRepoFile(`${ROUTES}/index.ts`);
const config = readRepoFile(`${ROUTES}/config.ts`);
const rateLimit = readRepoFile(`${ROUTES}/ratelimit.ts`);
const docs = readRepoFile("docs/api.mdx");

interface Operation {
	parameters?: { name: string; in: string }[];
	responses: Record<string, unknown>;
}

const spec = parse(readRepoFile("docs/openapi.yaml")) as {
	paths: Record<string, Record<string, Operation>>;
	components: {
		securitySchemes: Record<
			string,
			{ type: string; scheme?: string; name?: string }
		>;
		schemas: Record<
			string,
			{ properties: Record<string, unknown>; required?: string[] }
		>;
	};
};

const basePath = /apiBasePath = "([^"]+)"/.exec(
	readRepoFile(`${ROUTES}/constants.ts`)
)?.[1];
const collection = `${basePath}/terminals`;
const member = `${collection}/{id}`;

function operations(path: string): Record<string, Operation> {
	const item = spec.paths[path];
	expect(item, `${path} is missing from the spec`).toBeDefined();
	return Object.fromEntries(
		Object.entries(item ?? {}).filter(([method]) => method !== "parameters")
	);
}

function schema(name: string): {
	properties: Record<string, unknown>;
	required?: string[];
} {
	const found = spec.components.schemas[name];
	expect(found, `${name} is missing from the spec`).toBeDefined();
	return found ?? { properties: {} };
}

function interfaceFields(source: string, name: string): string[] {
	const body = new RegExp(`interface ${name} \\{([^}]*)\\}`).exec(source)?.[1];
	if (body === undefined) throw new Error(`No interface ${name}`);
	return [...body.matchAll(/^\s*(\w+)\??:/gm)].map((match) => match[1] ?? "");
}

describe("the spec is where the website looks for it", () => {
	test("packages/web/lib/docs/openapi.ts points at the file this suite reads", () => {
		// `createOpenAPI` takes the path as a plain string, so nothing type-checks
		// it and nothing fails loudly when it goes stale: fumadocs resolves it at
		// build time, and a miss renders the API pages without any operations
		// rather than erroring. The path is also cwd-relative, so a test cannot
		// simply load it from here - which leaves pinning the pair, the last rung
		// of the ladder in AGENTS.md, as the only thing that can catch a rename
		// that updates one spelling and not the other.
		expect(readRepoFile("packages/web/lib/docs/openapi.ts")).toContain(
			'instance: "../../docs/openapi.yaml"'
		);
	});
});

describe("the terminal API spec matches the routes that serve it", () => {
	test("documents the complete HTTP surface and no compatibility route", () => {
		expect(
			Object.fromEntries(
				Object.keys(spec.paths).map((path) => [
					path,
					Object.keys(operations(path)).sort()
				])
			)
		).toEqual({
			[collection]: ["get", "post"],
			[member]: ["delete", "get", "patch"],
			[`${member}/buffer`]: ["get"],
			[`${member}/clear`]: ["post"],
			[`${member}/input`]: ["post"],
			[`${member}/signal`]: ["post"]
		});
		expect(terminals).not.toContain('"/exec"');
		expect(docs).not.toContain("/api/v1/exec");
	});

	test("documents every status the routes can answer with, and no others", () => {
		// Explicit `res.status(N)` plus the two the create route carries on a
		// resolved response object. A status the routes gained and the spec never
		// learned is the drift this exists to catch, so it reads both directions.
		const returned = new Set<string>();
		for (const match of `${terminals}\n${auth}\n${index}`.matchAll(
			/res\.status\((\d{3})\)|status:\s*(\d{3})/g
		)) {
			returned.add(match[1] ?? match[2] ?? "");
		}

		const documented = new Set(
			Object.keys(spec.paths).flatMap((path) =>
				Object.values(operations(path)).flatMap((operation) =>
					Object.keys(operation.responses)
				)
			)
		);

		expect([...documented].sort()).toEqual([...returned].sort());
	});

	test("each route documents the status it answers with when it succeeds", () => {
		const success = Object.fromEntries(
			Object.keys(spec.paths).map((path) => [
				path,
				Object.entries(operations(path))
					.map(
						([method, operation]) =>
							`${method}:${Object.keys(operation.responses)
								.filter((status) => status.startsWith("2"))
								.sort()
								.join(",")}`
					)
					.sort()
			])
		);

		expect(success).toEqual({
			[collection]: ["get:200", "post:200,201"],
			[member]: ["delete:204", "get:200", "patch:200"],
			[`${member}/buffer`]: ["get:200"],
			[`${member}/clear`]: ["post:204"],
			[`${member}/input`]: ["post:204"],
			[`${member}/signal`]: ["post:204"]
		});
	});

	test("the create body is the body the handler resolves", () => {
		expect(Object.keys(schema("TerminalCreate").properties)).toEqual(
			interfaceFields(terminals, "CreateTerminalBody")
		);
		expect(terminals).toContain("hidden: body.hidden ?? false");
		expect(terminals).toContain("hideFromUser: create.hidden");
	});

	test("one-shot output is the raw merged pty stream", () => {
		const fields = interfaceFields(terminals, "WaitResult");
		expect(Object.keys(schema("WaitResult").properties)).toEqual(fields);
		expect(schema("WaitResult").required).toEqual(fields);
		expect(fields).toEqual(["output", "exit_code", "timed_out", "truncated"]);
		// A pty merges the streams; separate ones cannot be reported honestly.
		expect(terminals).not.toMatch(/\bstdout\b|\bstderr\b/);
	});

	test("terminal details and patch fields match their schemas", () => {
		const detailFields = interfaceFields(terminals, "TerminalDetails");
		expect(Object.keys(schema("Terminal").properties)).toEqual(detailFields);
		expect(schema("Terminal").required).toEqual(detailFields);
		expect(Object.keys(schema("TerminalPatch").properties)).toEqual(
			interfaceFields(terminals, "PatchTerminalBody")
		);
	});

	test("the page renders every operation the spec defines", () => {
		// The spec is only documentation once something renders it. An operation
		// added here and never placed on the page is documented to nobody, and the
		// page cannot say so - it just quietly lacks a section.
		const rendered = [
			// Whitespace-tolerant because prettier wraps a long tag across lines, and
			// a single-line pattern would then report the operation as unrendered.
			...docs.matchAll(/<APIOperation\s+path="([^"]+)"\s+method="(\w+)"\s*\/>/g)
		]
			.map((match) => `${match[2]} ${match[1]}`)
			.sort();
		const defined = Object.keys(spec.paths)
			.flatMap((path) =>
				Object.keys(operations(path)).map((method) => `${method} ${path}`)
			)
			.sort();

		expect(rendered).toEqual(defined);
		// OpenAPI cannot describe the websocket, so prose carries it instead.
		expect(docs).toContain(`WS ${collection}/{id}`);
	});

	test("the idempotency header is read by the create route", () => {
		const header = operations(collection).post?.parameters?.find(
			(parameter) => parameter.in === "header"
		);
		expect(header?.name).toBe("Idempotency-Key");
		expect(terminals).toContain(`req.headers["${header?.name.toLowerCase()}"]`);
	});

	test("the documented auth headers are the headers that authenticate", () => {
		const schemes = spec.components.securitySchemes;
		const bearer = Object.values(schemes).find(
			(scheme) => scheme.type === "http"
		);
		const apiKey = Object.values(schemes).find(
			(scheme) => scheme.type === "apiKey"
		);
		expect(auth.toLowerCase()).toContain(`startswith("${bearer?.scheme} ")`);
		expect(auth).toContain(`headers["${apiKey?.name?.toLowerCase()}"]`);
	});

	test("one limiter covers waited and websocket terminal streams", () => {
		expect(config).toContain('maxSessions: int("COMPOSERY_API_MAX_SESSIONS"');
		expect(config).toContain("COMPOSERY_API_TERMINAL_TIMEOUT");
		expect(config).toContain("COMPOSERY_API_TERMINAL_MAX_OUTPUT");
		expect(config).not.toContain("API_EXEC");
		expect(rateLimit).toContain(
			"export const sessions = new SlotLimiter(apiConfig.maxSessions)"
		);
		expect(terminals.match(/sessions\.tryAcquire/g)).toHaveLength(2);
	});

	test("every COMPOSERY_API_ variable the routes read is documented", () => {
		// docs/configuration.md is the canonical list. A variable the code reads
		// and the table never names is one nobody can discover.
		const read = new Set(
			[...`${config}\n${terminals}`.matchAll(/"(COMPOSERY_API_[A-Z_]+)"/g)].map(
				(match) => match[1] ?? ""
			)
		);
		const documented = readRepoFile("docs/configuration.md");
		expect(read.size).toBeGreaterThan(0);
		for (const name of read) {
			expect(documented, `configuration.md is missing ${name}`).toContain(
				`\`${name}\``
			);
		}
	});
});

// A number in a table is a promise. The test above only asks whether the
// variable is *named* there, which was enough for a name to go missing and not
// enough for a value to go wrong: every default and every guardrail cap in
// docs/configuration.md was a hand-copied literal that nothing compared to
// config.ts. An operator sizing a deployment reads those numbers, and a cap that
// reads lower than it is describes a protection the instance does not have.
describe("the documented API numbers are the numbers the code uses", () => {
	// `24 * 60 * 60`, `10 * 1024 * 1024`, `10_000` - the spellings config.ts uses
	// to keep a magnitude readable. Multiplication only, so this stays a reader
	// rather than an evaluator.
	function value(expression: string): number {
		const parts = expression.trim().replaceAll("_", "").split("*");
		expect(
			parts.every((part) => /^\s*\d+\s*$/.test(part)),
			expression
		).toBe(true);
		return parts.reduce((total, part) => total * Number(part.trim()), 1);
	}

	const caps = new Map(
		[...config.matchAll(/const (MAX_[A-Z_]+) = ([^\n]+)/g)].map((match) => [
			match[1] ?? "",
			value(match[2] ?? "")
		])
	);

	const defaults = new Map(
		[...config.matchAll(/\b(?:num|int)\(\s*"([A-Z_]+)",\s*([^,]+),/g)].map(
			(match) => [match[1] ?? "", value(match[2] ?? "")]
		)
	);

	const documented = readRepoFile("docs/configuration.md");

	test("the sweep read the code it is meant to read", () => {
		// Both maps are built by regex over one file. Empty, every assertion
		// below passes without comparing anything.
		expect(caps.size).toBe(6);
		expect(defaults.size).toBe(6);
	});

	test("every default in the table is the default in config.ts", () => {
		const rows = new Map(
			[
				...documented.matchAll(
					/^\|\s*`(COMPOSERY_API_[A-Z_]+)`\s*\|\s*`(\d+)`\s*\|/gm
				)
			].map((match) => [match[1] ?? "", Number(match[2])])
		);

		expect(rows.size).toBe(defaults.size);
		expect(Object.fromEntries(rows)).toEqual(Object.fromEntries(defaults));
	});

	test("every guardrail cap is stated as the code enforces it", () => {
		// The prose gives each cap in the unit an operator thinks in, so the
		// rendering is derived here rather than the number restated.
		const hours = (caps.get("MAX_TERMINAL_TIMEOUT_SEC") ?? 0) / 60 / 60;
		const mib = (caps.get("MAX_TERMINAL_OUTPUT_BYTES") ?? 0) / 1024 / 1024;

		for (const phrase of [
			`${hours}h one-shot timeout`,
			`${mib} MiB one-shot output`,
			`${caps.get("MAX_RATE_RPS")} RPS`,
			`${caps.get("MAX_RATE_BURST")} burst`,
			`${caps.get("MAX_SESSIONS")} concurrent terminal streams`,
			`${caps.get("MAX_AUTH_FAIL_PER_MIN")}\nfailed-auth attempts/min/IP`
		]) {
			expect(
				documented,
				`configuration.md does not state the cap "${phrase}"`
			).toContain(phrase);
		}
	});
});
