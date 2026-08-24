import { beforeEach, describe, expect, test, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const host = vi.hoisted(() => ({
	exists: new Set<string>(),
	removed: [] as string[],
	spawns: [] as Array<{
		command: string;
		args: string[];
		options: Record<string, unknown>;
	}>,
	symlinks: [] as Array<{ target: string; path: string; type: string }>,
	writes: [] as Array<{ path: string; contents: string }>
}));

const slash = (path: string) => path.replaceAll("\\", "/");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// The home directory is the one fixture the running OS decides. `join` and
// `pathToFileURL` read a path with that OS's rules, so `C:\Fixture` off Windows
// is not a drive letter at all - it is one relative filename with backslashes in
// it, which `pathToFileURL` then resolves against the working directory. Each
// platform states its own spelling and its own expected URI, which is what keeps
// the lowercase-drive-letter rule asserted on the platform that has drives.
const WINDOWS = process.platform === "win32";
const HOME = WINDOWS ? "C:\\Fixture" : "/fixture";
const EXTENSIONS = `${WINDOWS ? "C:/Fixture" : "/fixture"}/.vscode/extensions`;
const URI_EXTENSIONS = `${WINDOWS ? "/c:/Fixture" : "/fixture"}/.vscode/extensions`;

vi.mock("node:child_process", () => ({
	spawnSync: (
		command: string,
		args: string[],
		options: Record<string, unknown>
	) => {
		host.spawns.push({ command, args, options });
		return { status: 0 };
	}
}));

vi.mock("node:os", () => ({
	homedir: () => HOME
}));

vi.mock("node:fs", () => ({
	existsSync: (path: string) => host.exists.has(slash(path)),
	lstatSync: () => ({ isSymbolicLink: () => false }),
	readFileSync: (path: string) => {
		const normalized = slash(path);
		if (normalized.endsWith("/composery-themes/package.json"))
			return JSON.stringify({
				name: "composery-themes",
				publisher: "composery",
				version: "1.2.3"
			});
		if (normalized.endsWith("/extensions/extensions.json"))
			return JSON.stringify([
				{
					identifier: { id: "composery.composery-themes" },
					version: "old"
				},
				{ identifier: { id: "someone.else" }, version: "9.9.9" }
			]);
		if (normalized.endsWith("/extensions/.obsolete"))
			return JSON.stringify({
				"composery.composery-themes-1.2.3": true,
				"someone.else-9.9.9": true
			});
		throw new Error(`Unexpected read: ${normalized}`);
	},
	readlinkSync: () => "",
	rmSync: (path: string) => {
		host.removed.push(path);
	},
	symlinkSync: (target: string, path: string, type: string) => {
		host.symlinks.push({ target, path, type });
	},
	writeFileSync: (path: string, contents: string) => {
		host.writes.push({ path, contents });
	}
}));

beforeEach(() => {
	host.exists = new Set([
		slash(resolve(repoRoot, "packages/ide/upstream/package.json")),
		EXTENSIONS,
		`${EXTENSIONS}/extensions.json`,
		`${EXTENSIONS}/.obsolete`
	]);
	host.removed.length = 0;
	host.spawns.length = 0;
	host.symlinks.length = 0;
	host.writes.length = 0;
	vi.resetModules();
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
});

describe("repository setup", () => {
	test("installs dependencies and registers the live theme extension with VS Code", async () => {
		// @ts-expect-error The behavior-tested JavaScript entry point has no declaration file.
		await import("../../scripts/setup.mjs");

		expect(
			host.spawns.map(({ command, args, options }) => ({
				command,
				args,
				cwd: slash(options.cwd as string),
				shell: options.shell
			}))
		).toEqual([
			{
				command: "git",
				args: ["submodule", "update", "--init", "--recursive"],
				cwd: slash(repoRoot),
				shell: undefined
			},
			{
				command: "pnpm",
				args: ["install"],
				cwd: slash(repoRoot),
				shell: process.platform === "win32"
			}
		]);
		expect(
			host.symlinks.map(({ target, path, type }) => ({
				target: slash(target),
				path: slash(path),
				type
			}))
		).toEqual([
			{
				target: `${slash(
					repoRoot
				)}/packages/ide/overlay/lib/vscode/extensions/composery-themes`,
				path: `${EXTENSIONS}/composery.composery-themes-1.2.3`,
				type: "dir"
			}
		]);

		const manifestWrite = host.writes.find(({ path }) =>
			slash(path).endsWith("/extensions/extensions.json")
		);
		expect(JSON.parse(manifestWrite?.contents ?? "null")).toEqual([
			{ identifier: { id: "someone.else" }, version: "9.9.9" },
			{
				identifier: { id: "composery.composery-themes" },
				version: "1.2.3",
				location: {
					$mid: 1,
					path: `${URI_EXTENSIONS}/composery.composery-themes-1.2.3`,
					scheme: "file"
				},
				relativeLocation: "composery.composery-themes-1.2.3",
				metadata: {
					installedTimestamp: 1767323045000,
					pinned: true,
					source: "resource"
				}
			}
		]);

		const obsoleteWrite = host.writes.find(({ path }) =>
			slash(path).endsWith("/extensions/.obsolete")
		);
		expect(JSON.parse(obsoleteWrite?.contents ?? "null")).toEqual({
			"someone.else-9.9.9": true
		});
	});

	test("leaves the user profile untouched when VS Code has no extension store", async () => {
		host.exists.delete(EXTENSIONS);

		// @ts-expect-error The behavior-tested JavaScript entry point has no declaration file.
		await import("../../scripts/setup.mjs");

		expect(host.symlinks).toEqual([]);
		expect(host.writes).toEqual([]);
	});
});
