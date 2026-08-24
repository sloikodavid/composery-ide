import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Run a command from the repo root, streaming output; exit on failure.
function run(command, args, options = {}) {
	console.log(`\n$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: REPO_ROOT,
		stdio: "inherit",
		...options
	});
	if (result.error) {
		console.error(result.error.message);
		process.exit(1);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
}

// Check (fmt --check + clippy + test) or, with --fix, format (cargo fmt) the one
// Rust workspace (packages/cli). Native cargo on Linux; elsewhere the same
// commands run in the Dockerfile's Rust image so the toolchain matches CI and
// the shipped binary.
const MANIFEST = "packages/cli/Cargo.toml";
const fix = process.argv.includes("--fix");
const COMMANDS = fix
	? [["cargo", ["fmt", "--all", "--manifest-path", MANIFEST]]]
	: [
			["cargo", ["fmt", "--all", "--manifest-path", MANIFEST, "--check"]],
			[
				"cargo",
				[
					"clippy",
					"--manifest-path",
					MANIFEST,
					"--workspace",
					"--all-targets",
					"--all-features",
					"--",
					"-D",
					"warnings"
				]
			],
			[
				"cargo",
				[
					"test",
					"--manifest-path",
					MANIFEST,
					"--workspace",
					"--all-targets",
					"--all-features"
				]
			]
		];

function canRun(command, args) {
	const result = spawnSync(command, args, {
		cwd: REPO_ROOT,
		stdio: "ignore",
		timeout: 20_000
	});
	return result.status === 0;
}

function rustImage() {
	const dockerfile = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");
	const match = /^FROM\s+(rust:\S+)\s+AS\s+cli-chef\s*$/m.exec(dockerfile);
	if (!match) {
		console.error("Could not find the cli-chef Rust image in Dockerfile.");
		process.exit(1);
	}
	return match[1];
}

if (process.platform === "linux" && canRun("cargo", ["--version"])) {
	for (const [command, args] of COMMANDS) run(command, args);
	process.exit(0);
}

if (!canRun("docker", ["version", "--format", "{{.Server.Version}}"])) {
	console.error(
		"Rust tooling needs Linux. Install Rust on Linux or start Docker so pnpm can run cargo in a Linux container."
	);
	process.exit(1);
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const script = [
	"set -e",
	'export PATH="/usr/local/cargo/bin:${PATH}"',
	"export CARGO_TARGET_DIR=/tmp/composery-cargo-target",
	"rustup component add rustfmt clippy >/dev/null",
	...COMMANDS.map(([command, args]) =>
		[command, ...args.map(shellQuote)].join(" ")
	)
].join(" && ");

run("docker", [
	"run",
	"--rm",
	"-v",
	`${REPO_ROOT}:/work`,
	"-w",
	"/work",
	rustImage(),
	"sh",
	"-lc",
	script
]);
