import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const CONVEX_BIN = join(
	dirname(require.resolve("convex/package.json")),
	"bin",
	"main.js"
);

// The Vercel plane checks the blocking direction only: a required name that is
// not set. Vercel exposes project variables in the same process namespace as
// its system variables and the build container's own names, and no check can
// split that merged namespace without a separately authenticated Vercel API
// request - and the injected names cannot be configured away, so a reported
// extra would be noise nobody can act on. Every Convex name is set by hand in
// the dashboard, so there an extra name is actionable drift and is reported.
const TARGETS = [
	{
		name: "Vercel Production",
		example: ".env.example.next.prod",
		source: "process",
		reportExtra: false
	},
	{
		name: "Convex Production",
		example: ".env.example.convex.prod",
		source: "convex",
		reportExtra: true
	}
];

export function envNames(contents, source) {
	const names = new Set();
	for (const [index, line] of contents.split(/\r?\n/).entries()) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(trimmed);
		if (!match?.[1]) {
			throw new Error(`${source}:${index + 1} is not a NAME=value line.`);
		}
		if (names.has(match[1])) {
			throw new Error(`${source}:${index + 1} repeats ${match[1]}.`);
		}
		names.add(match[1]);
	}
	if (names.size === 0) throw new Error(`${source} contains no variables.`);
	return names;
}

export function nameLines(contents, source) {
	const names = new Set();
	for (const [index, line] of contents.split(/\r?\n/).entries()) {
		const name = line.trim();
		if (!name) continue;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			throw new Error(`${source}:${index + 1} is not an environment name.`);
		}
		if (names.has(name)) {
			throw new Error(`${source}:${index + 1} repeats ${name}.`);
		}
		names.add(name);
	}
	return names;
}

export function compareNames({ expected, actual }) {
	return {
		missing: [...expected].filter((name) => !actual.has(name)).sort(),
		extra: [...actual].filter((name) => !expected.has(name)).sort()
	};
}

export function listConvexNames({ run = spawnSync } = {}) {
	const result = run(
		process.execPath,
		[CONVEX_BIN, "env", "list", "--names-only"],
		{
			cwd: WEB_DIR,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"]
		}
	);
	if (
		result.error ||
		result.status !== 0 ||
		typeof result.stdout !== "string"
	) {
		throw new Error(
			"[env] Convex environment names could not be listed; deployment blocked."
		);
	}
	return nameLines(result.stdout, "convex env list --names-only");
}

export function checkDeployment({
	environment,
	convexNames,
	read = (file) => readFileSync(join(WEB_DIR, file), "utf8")
}) {
	return TARGETS.map((target) => {
		const actual =
			target.source === "convex"
				? convexNames
				: new Set(Object.keys(environment));
		const { missing, extra } = compareNames({
			expected: envNames(read(target.example), target.example),
			actual
		});
		return {
			name: target.name,
			example: target.example,
			missing,
			extra: target.reportExtra ? extra : []
		};
	});
}

export function formatResult(result) {
	const details = [];
	if (result.missing.length) {
		details.push(`missing required names: ${result.missing.join(", ")}`);
	}
	if (result.extra.length) {
		details.push(`additional names (drift): ${result.extra.join(", ")}`);
	}
	if (!details.length) {
		return `[env] ${result.name} matches ${result.example}. Values were not read.`;
	}
	const outcome = result.missing.length
		? "Deployment blocked."
		: "Deployment continues.";
	return `[env] ${result.name} — ${details.join("; ")}. ${outcome} Values were not read.`;
}

export function main({
	environment = process.env,
	convexNames = listConvexNames(),
	read,
	write = console.log,
	writeError = console.error
} = {}) {
	const results = checkDeployment({ environment, convexNames, read });
	for (const result of results) {
		(result.missing.length || result.extra.length ? writeError : write)(
			formatResult(result)
		);
	}
	return {
		blocked: results.some((result) => result.missing.length > 0),
		results
	};
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	try {
		const result = main();
		if (result.blocked) process.exitCode = 1;
	} catch (error) {
		console.error(
			error instanceof Error ? error.message : "[env] Check failed."
		);
		process.exitCode = 1;
	}
}
