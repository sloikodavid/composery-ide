import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const scratch: string[] = [];

function write(path: string, contents: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}

function json(path: string, value: unknown) {
	write(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "composery-rebrand-"));
	scratch.push(root);

	json(join(root, "package.json"), {
		name: "code-server",
		description: "Code Server",
		homepage: "https://coder.com"
	});
	json(join(root, "package-lock.json"), { name: "code-server" });
	json(join(root, "lib/vscode/resources/server/manifest.json"), {
		name: "Code Server",
		short_name: "code-server",
		description: "Coder"
	});
	json(join(root, "lib/vscode/product.json"), {
		ariaKey: "Code Server",
		nameShort: "Code Server",
		untouched: "vscode-server"
	});

	for (const path of [
		"ci/build/code-server.sh",
		"ci/build/code-server-nfpm.sh",
		"ci/build/build-code-server.sh",
		"ci/build/code-server-user.service",
		"ci/build/code-server@.service",
		"lib/vscode/resources/server/bin/code-server-linux.sh",
		"lib/vscode/resources/server/bin/code-server-darwin.sh",
		"lib/vscode/resources/server/bin/code-server.cmd"
	])
		write(join(root, path), "# code-server\n");
	write(join(root, "ci/build/ide.sh/stale"), "stale\n");

	write(
		join(root, "ci/build/build-vscode.sh"),
		"      fix-bin-script remote-cli/code-server\n"
	);
	write(
		join(root, "src/names.ts"),
		[
			"CODE_SERVER_SESSION_SOCKET CODE_SERVER_PARENT_PID CODE_SERVER_COOKIE_SUFFIX",
			"CODE_SERVER_RECONNECTION_GRACE_TIME CODE_SERVER_IDLE_TIMEOUT_SECONDS",
			"CODE_SERVER_APP_NAME CODE_SERVER_CONFIG CODE_SERVER_HOST CODE_SERVER_HOST",
			'"/^CODE_SERVER_.+$/"',
			"CS_DISABLE_FILE_DOWNLOADS CS_DISABLE_FILE_UPLOADS CS_DISABLE_GETTING_STARTED_OVERRIDE CS_DISABLE_PROXY CS_STATIC_BASE CS_TELEMETRY_URL",
			"process.env.PASSWORD process.env.HASHED_PASSWORD $PASSWORD $HASHED_PASSWORD",
			"EXTENSIONS_GALLERY GITHUB_TOKEN LOG_LEVEL",
			"code-server-ipc.sock code-server-session code-server-stdout.log code-server-stderr.log coder-logs coder.json .code-server /tmp/code-server",
			"codeServerVersion codeServer: version codeServerSocketPath aboutCodeServerDetail ensureCodeServerLoaded",
			"CodeServerClient codeServerClient CodeServerRouteWrapper runCodeServer CoderSettings",
			"IsEnabledCoderGettingStarted isEnabledCoderGettingStarted code-server.logout coder-options {{CS_STATIC_BASE}}",
			"bin/code-server code-server-linux.sh code-server-darwin.sh code-server.cmd code-server-current code-server@ code-server.service code-server-nfpm code-server.sh",
			'envPaths("code-server", { suffix: "" }) path.join(p, "code-server")',
			"coder/coder override code-server Code-server Code Server codeserver coder.code-server",
			"https://github.com/coder/Composery https://github.com/cdr/Composery https://cdr.co/Composery-to-coder",
			"https://coder.com https://www.coder.com test.coder.com coder.com security@coder.com",
			"Coder Technologies Inc. Coder Technologies Coder",
			'sed -i.bak "s/@@APPNAME@@/Composery/g"',
			'"applicationName": "Composery"',
			'"win32ShellNameShort": "c&ode-server"',
			'"darwinBundleIdentifier": "com.composery.code.server"',
			'"ariaKey": "Composery"',
			'import "@coder/logger";',
			"VSCODE_SERVER_PORT CODE_SERVER_ALLOWED_ENV",
			"VSCodeServer CODE_SERVER_ALLOWED_TYPE",
			"const codeServer = source; CODE_SERVER_ALLOWED_LOCAL",
			"buildfile.codeServer CODE_SERVER_ALLOWED_BUILD",
			"  codeServer,  ",
			"vscodeServer CODE_SERVER_ALLOWED_CAMEL",
			"vscode-server CODE_SERVER_ALLOWED_PATH"
		].join("\n")
	);

	for (const extension of [
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
	])
		write(join(root, "src/extensions", `fixture${extension}`), "code-server\n");
	for (const name of ["LICENSE", "NOTICE", "yarn.lock"])
		write(join(root, "src/text-files", name), "code-server\n");
	write(join(root, "src/extensions/fixture.bin"), "code-server\n");

	for (const path of [
		"lib/vscode/build/fixture.ts",
		"lib/vscode/src/fixture.ts",
		"typings/fixture.ts"
	])
		write(join(root, path), "code-server\n");

	for (const path of [
		"UPSTREAM.md",
		"patches/brand.diff",
		"src/.git/provenance.ts",
		"src/.pc/patch-coordinate.ts",
		"src/coverage/provenance.ts",
		"src/node_modules/provenance.ts",
		"src/out/vscode-internal.ts",
		"src/release/provenance.ts"
	])
		write(join(root, path), "code-server Coder coder.com CODE_SERVER_CONFIG\n");

	return root;
}

async function rebrand(root: string) {
	const argv = process.argv;
	process.argv = [
		argv[0]!,
		"packages/ide/scripts/rebrand.mjs",
		"--fixture-flag",
		root
	];
	vi.resetModules();
	const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
	try {
		// @ts-expect-error The behavior-tested JavaScript entry point has no declaration file.
		await import("../../../scripts/rebrand.mjs");
		return log.mock.calls;
	} finally {
		log.mockRestore();
		process.argv = argv;
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of scratch.splice(0)) {
		rmSync(root, { force: true, recursive: true });
	}
});

describe("IDE rebrand generator", () => {
	test("rewrites every owned naming category and preserves upstream-only names", async () => {
		const root = fixture();
		const logs = await rebrand(root);

		const transformed = readFileSync(join(root, "src/names.ts"), "utf8");
		expect(transformed)
			.toBe(`COMPOSERY_SESSION_SOCKET COMPOSERY_PARENT_PID COMPOSERY_COOKIE_SUFFIX
COMPOSERY_RECONNECTION_GRACE_TIME COMPOSERY_IDLE_TIMEOUT_SECONDS
COMPOSERY_APP_NAME COMPOSERY_CONFIG COMPOSERY_HOST COMPOSERY_HOST
"/^COMPOSERY_.+$/"
COMPOSERY_DISABLE_FILE_DOWNLOADS COMPOSERY_DISABLE_FILE_UPLOADS COMPOSERY_DISABLE_GETTING_STARTED_OVERRIDE COMPOSERY_DISABLE_PROXY COMPOSERY_STATIC_BASE COMPOSERY_TELEMETRY_URL
process.env.COMPOSERY_PASSWORD process.env.COMPOSERY_HASHED_PASSWORD $COMPOSERY_PASSWORD $COMPOSERY_HASHED_PASSWORD
COMPOSERY_EXTENSIONS_GALLERY COMPOSERY_GITHUB_TOKEN COMPOSERY_LOG_LEVEL
composery-ipc.sock composery-session composery-stdout.log composery-stderr.log composery-logs composery.json .composery /tmp/composery
composeryVersion composery: version composerySocketPath aboutComposeryDetail ensureVSCodeServerLoaded
ComposeryClient composeryClient ComposeryRouteWrapper runComposeryServer ComposerySettings
IsEnabledComposeryGettingStarted isEnabledComposeryGettingStarted composery.logout composery-options {{COMPOSERY_STATIC_BASE}}
bin/ide ide-linux.sh ide-darwin.sh ide.cmd composery-current ide@ ide.service ide-nfpm ide.sh
envPaths("composery", { suffix: "" }) path.join(p, "composery")
Composery override Composery Composery Composery composery io.composery.ide
https://github.com/sloikodavid/composery-ide https://github.com/sloikodavid/composery-ide https://www.composery.io
https://www.composery.io https://www.composery.io test.composery.io composery.io support@composery.io
Composery Composery Composery
sed -i.bak "s/@@APPNAME@@/ide/g"
"applicationName": "composery"
"win32ShellNameShort": "&Composery"
"darwinBundleIdentifier": "io.composery.ide"
"ariaKey": "composery"
import "@coder/logger";
VSCODE_SERVER_PORT CODE_SERVER_ALLOWED_ENV
VSCodeServer CODE_SERVER_ALLOWED_TYPE
const codeServer = source; CODE_SERVER_ALLOWED_LOCAL
buildfile.codeServer CODE_SERVER_ALLOWED_BUILD
  codeServer,  
vscodeServer CODE_SERVER_ALLOWED_CAMEL
vscode-server CODE_SERVER_ALLOWED_PATH`);

		for (const extension of [
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
		])
			expect(
				readFileSync(
					join(root, "src/extensions", `fixture${extension}`),
					"utf8"
				)
			).toBe("Composery\n");
		for (const name of ["LICENSE", "NOTICE", "yarn.lock"])
			expect(readFileSync(join(root, "src/text-files", name), "utf8")).toBe(
				"Composery\n"
			);
		expect(readFileSync(join(root, "src/extensions/fixture.bin"), "utf8")).toBe(
			"code-server\n"
		);
		for (const path of [
			"lib/vscode/build/fixture.ts",
			"lib/vscode/src/fixture.ts",
			"typings/fixture.ts"
		])
			expect(readFileSync(join(root, path), "utf8")).toBe("Composery\n");

		for (const path of [
			"UPSTREAM.md",
			"patches/brand.diff",
			"src/.git/provenance.ts",
			"src/.pc/patch-coordinate.ts",
			"src/coverage/provenance.ts",
			"src/node_modules/provenance.ts",
			"src/out/vscode-internal.ts",
			"src/release/provenance.ts"
		])
			expect(readFileSync(join(root, path), "utf8")).toBe(
				"code-server Coder coder.com CODE_SERVER_CONFIG\n"
			);
		expect(logs).toEqual([[`Rebranded IDE tree: ${root}`]]);
	});

	test("rewrites structured metadata, filenames, and the generated CLI discovery", async () => {
		const root = fixture();
		await rebrand(root);

		expect(
			JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
		).toEqual({
			name: "ide",
			description: "Run the Composery IDE on a remote server.",
			homepage: "https://github.com/sloikodavid/composery-ide",
			repository: {
				type: "git",
				url: "https://github.com/sloikodavid/composery-ide.git",
				directory: "packages/ide"
			},
			bugs: {
				url: "https://github.com/sloikodavid/composery-ide/issues"
			},
			bin: { ide: "out/node/entry.js" },
			keywords: ["composery", "ide", "vscode", "browser"]
		});
		expect(readFileSync(join(root, "package.json"), "utf8")).toContain(
			'\n\t"name": "ide",'
		);
		expect(
			JSON.parse(
				readFileSync(
					join(root, "lib/vscode/resources/server/manifest.json"),
					"utf8"
				)
			)
		).toEqual({
			name: "Composery",
			short_name: "Composery",
			description: "Composery"
		});
		const product: unknown = JSON.parse(
			readFileSync(join(root, "lib/vscode/product.json"), "utf8")
		);
		expect(product).toEqual({
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
			enableTelemetry: false,
			licenseUrl: "https://github.com/sloikodavid/composery-ide/blob/main/LICENSE",
			reportIssueUrl: "https://github.com/sloikodavid/composery-ide/issues/new",
			untouched: "vscode-server"
		});
		expect(product).not.toHaveProperty("ariaKey");

		for (const path of [
			"ci/build/ide.sh",
			"ci/build/ide-nfpm.sh",
			"ci/build/build-ide.sh",
			"ci/build/ide-user.service",
			"ci/build/ide@.service",
			"lib/vscode/resources/server/bin/ide-linux.sh",
			"lib/vscode/resources/server/bin/ide-darwin.sh",
			"lib/vscode/resources/server/bin/ide.cmd"
		])
			expect(readFileSync(join(root, path), "utf8")).toBe("# Composery\n");

		const build = readFileSync(join(root, "ci/build/build-vscode.sh"), "utf8");
		expect(build).toBe(`      remote_cli_script=
            for candidate in remote-cli/ide remote-cli/composery remote-cli/code-*; do
              if [ -f "lib/vscode-reh-web-$VSCODE_TARGET/bin/$candidate" ]; then
                remote_cli_script="$candidate"
                break
              fi
            done
            if [ -z "$remote_cli_script" ]; then
              echo "No remote CLI script found in lib/vscode-reh-web-$VSCODE_TARGET/bin/remote-cli" >&2
              ls -la "lib/vscode-reh-web-$VSCODE_TARGET/bin/remote-cli" >&2
              exit 1
            fi
            fix-bin-script "$remote_cli_script"
            if [ "$remote_cli_script" != "remote-cli/ide" ]; then
              mv "lib/vscode-reh-web-$VSCODE_TARGET/bin/$remote_cli_script" "lib/vscode-reh-web-$VSCODE_TARGET/bin/remote-cli/ide"
            fi
`);
	});

	test("rejects every unowned live name and bounds the diagnostic", async () => {
		const root = fixture();
		write(
			join(root, "src/names.ts"),
			[
				"  prefix codeServer,  ",
				"codeServer, suffix",
				"CS_A",
				...Array.from(
					{ length: 81 },
					(_, index) => `CODE_SERVER_UNHANDLED_${index}`
				)
			].join("\n")
		);
		const exit = vi.spyOn(process, "exit").mockImplementation(((
			code?: number
		) => {
			throw new Error(`exit ${code}`);
		}) as never);
		const error = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		await expect(rebrand(root)).rejects.toThrow("exit 1");

		expect(exit).toHaveBeenCalledWith(1);
		expect(error.mock.calls).toHaveLength(82);
		expect(error.mock.calls[0]).toEqual([
			"Rebrand left old live code-server/Coder names behind:"
		]);
		expect(error.mock.calls[1]).toEqual([
			"  src/names.ts:1: prefix codeServer,"
		]);
		expect(error.mock.calls[2]).toEqual([
			"  src/names.ts:2: codeServer, suffix"
		]);
		expect(error.mock.calls[3]).toEqual(["  src/names.ts:3: CS_A"]);
		expect(error.mock.calls[80]).toEqual([
			"  src/names.ts:80: CODE_SERVER_UNHANDLED_76"
		]);
		expect(error.mock.calls[81]).toEqual(["  ...and 4 more"]);
	});

	test("omits an overflow diagnostic at exactly eighty violations", async () => {
		const root = fixture();
		write(
			join(root, "src/names.ts"),
			Array.from(
				{ length: 80 },
				(_, index) => `CODE_SERVER_UNHANDLED_${index}`
			).join("\n")
		);
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("exit");
		});
		const error = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		await expect(rebrand(root)).rejects.toThrow("exit");

		expect(error.mock.calls).toHaveLength(81);
		expect(error.mock.calls.at(-1)).toEqual([
			"  src/names.ts:80: CODE_SERVER_UNHANDLED_79"
		]);
	});

	test("accepts omitted optional metadata, rename sources, and scanned roots", async () => {
		const root = fixture();
		rmSync(join(root, "lib/vscode/resources/server/manifest.json"));
		rmSync(join(root, "lib/vscode/product.json"));
		rmSync(join(root, "ci/build/code-server-nfpm.sh"));
		rmSync(join(root, "typings"), { recursive: true });

		await rebrand(root);

		expect(readFileSync(join(root, "package.json"), "utf8")).toContain(
			'"name": "ide"'
		);
	});

	test("rejects a target that is not an assembled package", async () => {
		const root = mkdtempSync(join(tmpdir(), "composery-rebrand-invalid-"));
		scratch.push(root);
		const exit = vi.spyOn(process, "exit").mockImplementation(((
			code?: number
		) => {
			throw new Error(`exit ${code}`);
		}) as never);
		const error = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		await expect(rebrand(root)).rejects.toThrow("exit 64");

		expect(exit).toHaveBeenCalledWith(64);
		expect(error).toHaveBeenCalledWith(
			"Usage: node packages/ide/scripts/rebrand.mjs <assembled-upstream-tree>\n" +
				"       node packages/ide/scripts/rebrand.mjs --check"
		);
	});
});
