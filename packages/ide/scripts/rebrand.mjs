import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	OWNER,
	REPO,
	WEBSITE_DOMAIN,
	WEBSITE_ORIGIN
} from "../../shared/index.ts";

// The Composery-side coordinates the upstream (coder) strings rewrite to. All
// derive from the shared identity constants so a fork repoints in one place.
const GITHUB_URL = `https://github.com/${REPO.owner}/${REPO.name}`;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Stryker disable next-line StringLiteral: PACKAGE_ROOT is used only by the external --check archive harness, which behavior tests intentionally do not shell out to exercise.
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
// Stryker disable next-line StringLiteral: REPO_ROOT is used only as the working directory of external --check commands.
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
// Stryker disable next-line StringLiteral: argument parsing is CLI wiring exercised by the package check command; behavior tests run assembled fixture trees directly.
const check = process.argv.includes("--check");
const targetArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
let target = targetArg ? resolve(targetArg) : undefined;
// The unique scratch path is external --check wiring, not generator behavior.
// Stryker disable all
if (check)
	target = join(
		REPO_ROOT,
		"tmp",
		`ide-rebrand-check-${Date.now()}-${process.pid}`
	);
// Stryker restore all

const textExtensions = new Set([
	".cmd",
	".css",
	".html",
	".js",
	".json",
	".md",
	".mjs",
	".service",
	".sh",
	".ts",
	".tsx",
	".txt",
	".xml",
	".yaml",
	".yml"
]);

const textFiles = new Set(["LICENSE", "NOTICE", "yarn.lock"]);

const skippedDirs = new Set([
	".git",
	".pc",
	"coverage",
	"node_modules",
	"out",
	"release"
]);

const roots = [
	"ci/build",
	"lib/vscode/build",
	"lib/vscode/resources/server",
	"lib/vscode/src",
	"src",
	"typings",
	"package.json",
	"package-lock.json"
];

const replacements = [
	["CODE_SERVER_SESSION_SOCKET", "COMPOSERY_SESSION_SOCKET"],
	["CODE_SERVER_PARENT_PID", "COMPOSERY_PARENT_PID"],
	["CODE_SERVER_COOKIE_SUFFIX", "COMPOSERY_COOKIE_SUFFIX"],
	["CODE_SERVER_RECONNECTION_GRACE_TIME", "COMPOSERY_RECONNECTION_GRACE_TIME"],
	["CODE_SERVER_IDLE_TIMEOUT_SECONDS", "COMPOSERY_IDLE_TIMEOUT_SECONDS"],
	["CODE_SERVER_APP_NAME", "COMPOSERY_APP_NAME"],
	["CODE_SERVER_CONFIG", "COMPOSERY_CONFIG"],
	["CODE_SERVER_HOST", "COMPOSERY_HOST"],
	["/^CODE_SERVER_.+$/", "/^COMPOSERY_.+$/"],
	["CS_DISABLE_FILE_DOWNLOADS", "COMPOSERY_DISABLE_FILE_DOWNLOADS"],
	["CS_DISABLE_FILE_UPLOADS", "COMPOSERY_DISABLE_FILE_UPLOADS"],
	[
		"CS_DISABLE_GETTING_STARTED_OVERRIDE",
		"COMPOSERY_DISABLE_GETTING_STARTED_OVERRIDE"
	],
	["CS_DISABLE_PROXY", "COMPOSERY_DISABLE_PROXY"],
	["CS_STATIC_BASE", "COMPOSERY_STATIC_BASE"],
	["CS_TELEMETRY_URL", "COMPOSERY_TELEMETRY_URL"],
	["process.env.PASSWORD", "process.env.COMPOSERY_PASSWORD"],
	["process.env.HASHED_PASSWORD", "process.env.COMPOSERY_HASHED_PASSWORD"],
	["$PASSWORD", "$COMPOSERY_PASSWORD"],
	["$HASHED_PASSWORD", "$COMPOSERY_HASHED_PASSWORD"],
	["EXTENSIONS_GALLERY", "COMPOSERY_EXTENSIONS_GALLERY"],
	["GITHUB_TOKEN", "COMPOSERY_GITHUB_TOKEN"],
	["LOG_LEVEL", "COMPOSERY_LOG_LEVEL"],
	["code-server-ipc.sock", "composery-ipc.sock"],
	["code-server-session", "composery-session"],
	["code-server-stdout.log", "composery-stdout.log"],
	["code-server-stderr.log", "composery-stderr.log"],
	["coder-logs", "composery-logs"],
	["coder.json", "composery.json"],
	["coder.code-server", "io.composery.ide"],
	[".code-server", ".composery"],
	["/tmp/code-server", "/tmp/composery"],
	["codeServerVersion", "composeryVersion"],
	["codeServer: version", "composery: version"],
	["codeServerSocketPath", "composerySocketPath"],
	["aboutCodeServerDetail", "aboutComposeryDetail"],
	["ensureCodeServerLoaded", "ensureVSCodeServerLoaded"],
	["CodeServerClient", "ComposeryClient"],
	["codeServerClient", "composeryClient"],
	["CodeServerRouteWrapper", "ComposeryRouteWrapper"],
	["runCodeServer", "runComposeryServer"],
	["CoderSettings", "ComposerySettings"],
	["IsEnabledCoderGettingStarted", "IsEnabledComposeryGettingStarted"],
	["isEnabledCoderGettingStarted", "isEnabledComposeryGettingStarted"],
	["code-server.logout", "composery.logout"],
	["coder-options", "composery-options"],
	[
		"fix-bin-script remote-cli/code-server",
		[
			"remote_cli_script=",
			"      for candidate in remote-cli/ide remote-cli/composery remote-cli/code-*; do",
			'        if [ -f "lib/vscode-reh-web-$VSCODE_TARGET/bin/$candidate" ]; then',
			'          remote_cli_script="$candidate"',
			"          break",
			"        fi",
			"      done",
			'      if [ -z "$remote_cli_script" ]; then',
			'        echo "No remote CLI script found in lib/vscode-reh-web-$VSCODE_TARGET/bin/remote-cli" >&2',
			'        ls -la "lib/vscode-reh-web-$VSCODE_TARGET/bin/remote-cli" >&2',
			"        exit 1",
			"      fi",
			'      fix-bin-script "$remote_cli_script"',
			'      if [ "$remote_cli_script" != "remote-cli/ide" ]; then',
			'        mv "lib/vscode-reh-web-$VSCODE_TARGET/bin/$remote_cli_script" "lib/vscode-reh-web-$VSCODE_TARGET/bin/remote-cli/ide"',
			"      fi"
		].join("\n      ")
	],
	["bin/code-server", "bin/ide"],
	["code-server-linux.sh", "ide-linux.sh"],
	["code-server-darwin.sh", "ide-darwin.sh"],
	["code-server.cmd", "ide.cmd"],
	["code-server-current", "composery-current"],
	["code-server@", "ide@"],
	["code-server.service", "ide.service"],
	["code-server-nfpm", "ide-nfpm"],
	["code-server.sh", "ide.sh"],
	// Values the generic rule below would get wrong. It renders "Composery",
	// which is right for prose and wrong for a path segment: these two decide
	// ~/.config/composery and ~/.local/share/composery, and a capitalised
	// directory is a different directory. Scoped to their whole call so no
	// other "code-server" is caught by the casing.
	[
		'envPaths("code-server", { suffix: "" })',
		'envPaths("composery", { suffix: "" })'
	],
	['path.join(p, "code-server")', 'path.join(p, "composery")'],
	// Lowercase "coder/coder" survives every rule here: a bare `coder` rule is
	// forbidden as too broad (assertRebrandRulesAreScoped), and `Coder` is
	// case-sensitive. Name the one help string it appears in instead.
	["coder/coder override", "Composery override"],
	[/(?<!vs)code-server/g, "Composery"],
	["Code-server", "Composery"],
	["Code Server", "Composery"],
	["codeserver", "composery"],
	["https://github.com/coder/Composery", GITHUB_URL],
	["https://github.com/cdr/Composery", GITHUB_URL],
	["https://cdr.co/Composery-to-coder", WEBSITE_ORIGIN],
	["https://coder.com", WEBSITE_ORIGIN],
	["https://www.coder.com", WEBSITE_ORIGIN],
	["test.coder.com", `test.${WEBSITE_DOMAIN}`],
	["security@coder.com", OWNER.email],
	["coder.com", WEBSITE_DOMAIN],
	["Coder Technologies Inc.", "Composery"],
	["Coder Technologies", "Composery"],
	["Coder", "Composery"],
	[
		'sed -i.bak "s/@@APPNAME@@/Composery/g"',
		'sed -i.bak "s/@@APPNAME@@/ide/g"'
	],
	['"applicationName": "Composery"', '"applicationName": "composery"'],
	[
		'"win32ShellNameShort": "c&ode-server"',
		'"win32ShellNameShort": "&Composery"'
	],
	[
		'"darwinBundleIdentifier": "com.composery.code.server"',
		'"darwinBundleIdentifier": "io.composery.ide"'
	],
	['"ariaKey": "Composery"', '"ariaKey": "composery"']
];

const productJsonReplacements = {
	nameShort: "Composery",
	nameLong: "Composery",
	applicationName: "composery",
	dataFolderName: ".composery",
	serverDataFolderName: ".composery-server",
	win32MutexName: "composery",
	win32DirName: "Composery",
	win32NameVersion: "Composery",
	win32RegValueName: "Composery",
	win32AppUserModelId: "io.composery.ide",
	win32x64AppId: "{{EAE146CF-271E-49B4-B312-21EBA98D3CB8}",
	win32arm64AppId: "{{03BC8655-6AA6-46D7-BCEF-65B0530A95EF}",
	win32UserAppId: "{{15381C3C-193D-43F9-94A9-E52401AF5EB4}",
	win32x64UserAppId: "{{39755874-4029-4760-A8D4-D04E5FD79219}",
	win32arm64UserAppId: "{{F5BD8295-9BEE-4FC0-B26C-E95876E9F3B1}",
	win32AppId: "{{B1B83327-44A6-41DA-8AD9-811763DCA6AE}",
	darwinBundleIdentifier: "io.composery.ide",
	linuxIconName: "io.composery.ide",
	// Composery ships no telemetry: product-level off keeps VS Code's telemetry
	// machinery inert even where a client setting allows it, and build.sh never
	// applies code-server's own telemetry.diff either.
	enableTelemetry: false,
	licenseUrl: `${GITHUB_URL}/blob/${REPO.branch}/LICENSE`,
	reportIssueUrl: `${GITHUB_URL}/issues/new`
};

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAll(content) {
	let next = content;
	for (const [from, to] of replacements) {
		const pattern =
			from instanceof RegExp ? from : new RegExp(escapeRegExp(from), "g");
		next = next.replace(pattern, to);
	}
	return next;
}

function isTextFile(path) {
	const name = path.split(/[\\/]/).pop();
	// Stryker disable next-line StringLiteral: for a dotless name, the mutated last character cannot equal any extension (all start with a dot), while textFiles still decides the named exceptions.
	const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
	return textFiles.has(name) || textExtensions.has(ext);
}

function walk(path, files = []) {
	const stat = statSync(path);
	if (stat.isDirectory()) {
		const name = path.split(/[\\/]/).pop();
		if (skippedDirs.has(name)) return files;
		for (const entry of readdirSync(path)) {
			walk(join(path, entry), files);
		}
	} else if (stat.isFile() && isTextFile(path)) {
		files.push(path);
	}
	return files;
}

function rewriteJson(path, mutate) {
	if (!existsSync(path)) return;
	// Stryker disable next-line StringLiteral: JSON.parse accepts the Buffer returned for an empty encoding through string coercion, producing the same object.
	const json = JSON.parse(readFileSync(path, "utf8"));
	mutate(json);
	writeFileSync(path, `${JSON.stringify(json, null, "\t")}\n`);
}

function renameIfExists(from, to) {
	const absoluteFrom = join(target, from);
	const absoluteTo = join(target, to);
	if (!existsSync(absoluteFrom)) return;
	mkdirSync(dirname(absoluteTo), { recursive: true });
	rmSync(absoluteTo, { force: true, recursive: true });
	renameSync(absoluteFrom, absoluteTo);
}

// The --check harness shells out to Git and tar and validates a real assembled
// upstream artifact. That is deliberately the generated-output check, not an
// in-process behavior test; mutating its stand-in commands would only test mocks.
// Stryker disable all
function run(command, args, options = {}) {
	execFileSync(command, args, {
		cwd: REPO_ROOT,
		stdio: "inherit",
		...options
	});
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertRebrandRulesAreScoped() {
	const forbiddenRules = new Set(["coder.", "coder"]);

	for (const [from] of replacements) {
		assert(
			!forbiddenRules.has(from),
			`Unsafe broad rebrand rule found in rebrand.mjs: ${from}`
		);
	}
}

function archive(sourceRepo, archivePath, paths) {
	run("git", [
		"-C",
		sourceRepo,
		"-c",
		"core.autocrlf=false",
		"archive",
		"HEAD",
		...paths,
		"-o",
		archivePath
	]);
}

function extract(archivePath, destination) {
	// Colon-free relative paths keep both tars happy: MSYS/GNU tar (git-bash)
	// reads the ":" in an absolute C:\ path as a remote-host prefix.
	run(
		"tar",
		["-xf", relative(destination, archivePath).replaceAll("\\", "/")],
		{
			cwd: destination
		}
	);
	rmSync(archivePath, { force: true });
}

// Stryker disable next-line StringLiteral: the sentinel belongs to the external --check artifact harness and is validated after a real upstream archive is transformed.
const sentinelPath =
	"lib/vscode/src/vs/composery-rebrand-identifier-sentinel.ts";
// Stryker disable next-line StringLiteral: the sentinel belongs to the external --check artifact harness and is validated after a real upstream archive is transformed.
const sentinelSource = `
const encoder = new TextEncoder();
encoder.encode("coder.com");
const textEncoder = new TextEncoder();
textEncoder.encode("coder.com");
const decoder = new TextDecoder();
decoder.decode(new Uint8Array());
const textDecoder = new TextDecoder();
textDecoder.decode(new Uint8Array());
const stdoutDecoder = new TextDecoder();
stdoutDecoder.decode(new Uint8Array());
const stderrDecoder = new TextDecoder();
stderrDecoder.decode(new Uint8Array());
`;

function prepareCheckTarget() {
	const upstream = join(PACKAGE_ROOT, "upstream");
	const vscode = join(upstream, "lib/vscode");

	if (!existsSync(join(upstream, "package.json"))) {
		console.error("packages/ide/upstream is empty; run pnpm setup.");
		process.exit(1);
	}

	if (!existsSync(join(vscode, "package.json"))) {
		console.error("packages/ide/upstream/lib/vscode is empty; run pnpm setup.");
		process.exit(1);
	}

	assertRebrandRulesAreScoped();
	rmSync(target, { force: true, recursive: true });
	mkdirSync(join(target, "lib/vscode/src/vs"), { recursive: true });

	const upstreamArchive = join(target, "upstream.tar");
	archive(upstream, upstreamArchive, [
		"package.json",
		"package-lock.json",
		"ci",
		"src",
		"typings"
	]);
	extract(upstreamArchive, target);

	const vscodeArchive = join(target, "vscode.tar");
	archive(vscode, vscodeArchive, [
		"src",
		"build/buildfile.ts",
		"build/gulpfile.reh.ts",
		"resources/server"
	]);
	extract(vscodeArchive, join(target, "lib/vscode"));

	writeFileSync(join(target, sentinelPath), sentinelSource);
}

function assertSentinelSurvived() {
	const transformed = readFileSync(join(target, sentinelPath), "utf8");
	const required = [
		"encoder.encode",
		"textEncoder.encode",
		"decoder.decode",
		"textDecoder.decode",
		"stdoutDecoder.decode",
		"stderrDecoder.decode",
		WEBSITE_DOMAIN
	];
	const forbidden = ["encomposery", "decomposery"];

	for (const value of required) {
		assert(
			transformed.includes(value),
			`Rebrand damaged or missed sentinel token: ${value}`
		);
	}

	for (const value of forbidden) {
		assert(
			!transformed.toLowerCase().includes(value),
			`Rebrand created broken identifier: ${value}`
		);
	}
}

function assertBuildScriptSurvived() {
	const buildScript = readFileSync(
		join(target, "ci/build/build-vscode.sh"),
		"utf8"
	);

	assert(
		buildScript.includes("remote_cli_script="),
		"Rebrand must discover the generated remote CLI script before renaming it."
	);
	assert(
		!buildScript.includes("fix-bin-script remote-cli/ide"),
		"Rebrand must not assume VS Code generated remote-cli/ide before the rename."
	);
}

function finishCheck() {
	assertSentinelSurvived();
	assertBuildScriptSurvived();
	console.log(
		"Rebrand check passed against upstream server and VS Code trees."
	);
	rmSync(target, { force: true, recursive: true });
}
// Stryker restore all

// Stryker disable next-line ConditionalExpression: the external --check branch is exercised by pnpm check:rebrand; behavior fixtures exercise the assembled-tree branch.
if (check) prepareCheckTarget();
else if (!target || !existsSync(join(target, "package.json"))) {
	console.error(
		"Usage: node packages/ide/scripts/rebrand.mjs <assembled-upstream-tree>\n" +
			"       node packages/ide/scripts/rebrand.mjs --check"
	);
	process.exit(64);
}

rewriteJson(join(target, "package.json"), (json) => {
	json.name = "ide";
	json.description = "Run the Composery IDE on a remote server.";
	json.homepage = GITHUB_URL;
	json.repository = {
		type: "git",
		url: `${GITHUB_URL}.git`,
		directory: "packages/ide"
	};
	json.bugs = {
		url: `${GITHUB_URL}/issues`
	};
	json.bin = {
		ide: "out/node/entry.js"
	};
	json.keywords = ["composery", "ide", "vscode", "browser"];
});

renameIfExists("ci/build/code-server.sh", "ci/build/ide.sh");
renameIfExists("ci/build/code-server-nfpm.sh", "ci/build/ide-nfpm.sh");
renameIfExists("ci/build/build-code-server.sh", "ci/build/build-ide.sh");
renameIfExists(
	"ci/build/code-server-user.service",
	"ci/build/ide-user.service"
);
renameIfExists("ci/build/code-server@.service", "ci/build/ide@.service");
renameIfExists(
	"lib/vscode/resources/server/bin/code-server-linux.sh",
	"lib/vscode/resources/server/bin/ide-linux.sh"
);
renameIfExists(
	"lib/vscode/resources/server/bin/code-server-darwin.sh",
	"lib/vscode/resources/server/bin/ide-darwin.sh"
);
renameIfExists(
	"lib/vscode/resources/server/bin/code-server.cmd",
	"lib/vscode/resources/server/bin/ide.cmd"
);

for (const root of roots) {
	const absolute = join(target, root);
	if (!existsSync(absolute)) continue;
	for (const file of walk(absolute)) {
		const before = readFileSync(file, "utf8");
		const after = replaceAll(before);
		// Stryker disable next-line ConditionalExpression: writing byte-identical contents changes no generated artifact; the branch only avoids needless filesystem churn.
		if (after !== before) writeFileSync(file, after);
	}
}

rewriteJson(join(target, "lib/vscode/product.json"), (json) => {
	Object.assign(json, productJsonReplacements);
	delete json.ariaKey;
});

const scannedRoots = roots
	.map((root) => join(target, root))
	.filter((root) => existsSync(root));
const forbidden = [
	/CODE_SERVER/,
	/\bCS_[A-Z0-9_]/,
	/code-server/i,
	/codeserver/i,
	/codeServer/,
	/CodeServer/,
	/\.code-server/,
	/coder\.com/i,
	/cdr\.co/i,
	/coder-options/,
	/coder-logs/,
	/coder\.code-server/,
	/encomposery/i,
	/decomposery/i
];
const allowed = [
	/VSCODE_SERVER_/,
	/VSCodeServer/,
	/const codeServer =/,
	/buildfile\.codeServer/,
	/^\s*codeServer,\s*$/,
	/vscodeServer/,
	/vscode-server/
];
const violations = [];

for (const root of scannedRoots) {
	for (const file of walk(root)) {
		const relativeFile = relative(target, file).replaceAll("\\", "/");
		const lines = readFileSync(file, "utf8").split(/\r?\n/);
		lines.forEach((line, index) => {
			if (allowed.some((pattern) => pattern.test(line))) return;
			for (const pattern of forbidden) {
				if (pattern.test(line)) {
					violations.push(`${relativeFile}:${index + 1}: ${line.trim()}`);
					return;
				}
			}
		});
	}
}

if (violations.length > 0) {
	console.error("Rebrand left old live code-server/Coder names behind:");
	for (const line of violations.slice(0, 80)) console.error(`  ${line}`);
	if (violations.length > 80) {
		console.error(`  ...and ${violations.length - 80} more`);
	}
	process.exit(1);
}

// Stryker disable next-line ConditionalExpression: check cleanup is covered by the external artifact check while normal generation asserts its message.
if (!check) console.log(`Rebranded IDE tree: ${target}`);
else finishCheck();
