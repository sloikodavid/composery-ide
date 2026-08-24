import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

run("git", ["submodule", "update", "--init", "--recursive"]);

if (!existsSync(join(REPO_ROOT, "packages/ide/upstream/package.json"))) {
	console.error(
		"packages/ide/upstream is still empty after submodule init; check git output above."
	);
	process.exit(1);
}

run("pnpm", ["install"], { shell: process.platform === "win32" });

linkThemeExtension();

// build.sh runs inside the image, so the host command is the same everywhere;
// naming it kept sending Windows and macOS contributors after a Linux script.
console.log(
	"\nSetup complete. Check with: pnpm check  Build the image with: pnpm build:image"
);

// Symlinks the Composery theme extension into the real VS Code extensions
// folder (not just the F5 debug host), so editing the theme JSON and
// reloading the window previews it in your everyday editor.
function linkThemeExtension() {
	const extensionDir = join(
		REPO_ROOT,
		"packages/ide/overlay/lib/vscode/extensions/composery-themes"
	);
	const { name, publisher, version } = JSON.parse(
		readFileSync(join(extensionDir, "package.json"), "utf8")
	);
	const vscodeExtensions = join(homedir(), ".vscode", "extensions");
	if (!existsSync(vscodeExtensions)) return;

	const folderName = `${publisher}.${name}-${version}`;
	const link = join(vscodeExtensions, folderName);
	const alreadyLinked =
		existsSync(link) &&
		lstatSync(link).isSymbolicLink() &&
		readlinkSync(link) === extensionDir;
	if (!alreadyLinked) {
		if (existsSync(link)) rmSync(link, { recursive: true, force: true });
		symlinkSync(extensionDir, link, "dir");
		console.log(`\nLinked ${link} -> ${extensionDir}`);
	}

	// VS Code treats extensions.json as ground truth for what's installed: a
	// folder on disk it can't find listed there gets marked obsolete and
	// skipped on every startup scan, symlink or not. Register it for real.
	const extensionId = `${publisher}.${name}`;
	const manifestPath = join(vscodeExtensions, "extensions.json");
	const manifest = existsSync(manifestPath)
		? JSON.parse(readFileSync(manifestPath, "utf8"))
		: [];
	const withoutStaleEntries = manifest.filter(
		(entry) => entry.identifier.id !== extensionId
	);
	// Windows entries use a lowercase-drive-letter, leading-slash path
	// ("/c:/Users/...") to match how VS Code itself serializes file URIs.
	const uriPath = pathToFileURL(link).pathname.replace(
		/^\/([A-Z]):/,
		(_, d) => `/${d.toLowerCase()}:`
	);
	writeFileSync(
		manifestPath,
		JSON.stringify([
			...withoutStaleEntries,
			{
				identifier: { id: extensionId },
				version,
				location: { $mid: 1, path: uriPath, scheme: "file" },
				relativeLocation: folderName,
				metadata: {
					installedTimestamp: Date.now(),
					pinned: true,
					source: "resource"
				}
			}
		])
	);

	const obsolete = join(vscodeExtensions, ".obsolete");
	if (existsSync(obsolete)) {
		const marks = JSON.parse(readFileSync(obsolete, "utf8"));
		if (marks[folderName]) {
			delete marks[folderName];
			writeFileSync(obsolete, JSON.stringify(marks));
		}
	}
}
