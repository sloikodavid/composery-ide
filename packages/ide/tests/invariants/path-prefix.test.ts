// The IDE's public path exists once, as `IDE_PATH` in `packages/shared`. It also
// has to appear in the Caddyfile, the systemd units and the shipped HTML, none
// of which can import TypeScript - the textbook case for the last rung of the
// duplication ladder, since an external tool is what reads each copy. This finds
// a literal that should have been the constant.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { IDE_PATH } from "../../../shared/index.ts";
import { repoRoot } from "../../../../tests/support/repo.ts";
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");
const textUnder = (path: string): string =>
	statSync(resolve(repoRoot, path)).isDirectory()
		? readdirSync(resolve(repoRoot, path))
				.map((name) => textUnder(`${path}/${name}`))
				.join("\n")
		: /\.(?:ico|png|woff2)$/.test(path)
			? ""
			: read(path);

describe("IDE public path boundary", () => {
	test("one mount owns browser-facing URL construction", () => {
		expect(IDE_PATH).toBe("/ide/");
		expect(
			new URL(".", `https://composery.example${IDE_PATH}manifest.json`).pathname
		).toBe(IDE_PATH);
		expect(new URL("./", `https://composery.example${IDE_PATH}`).pathname).toBe(
			IDE_PATH
		);

		const caddy = read("rootfs/etc/caddy/Caddyfile");
		const dockerfile = read("Dockerfile");
		const cloudAuth = read("packages/ide/overlay/src/node/routes/cloudAuth.ts");
		expect(caddy).toContain(`redir @root ${IDE_PATH} 308`);
		expect(caddy).toContain("handle_path /ide/*");
		expect(caddy).toContain(`header_down Service-Worker-Allowed ${IDE_PATH}`);
		expect(dockerfile).toContain('VSCODE_PROXY_URI="/proxy/{{port}}/"');
		expect(cloudAuth).toContain(
			`const CLOUD_CALLBACK_PATH = "${IDE_PATH}_composery/cloud/callback"`
		);
	});

	test("Caddy exposes only the intentional root routes", () => {
		const lines = new Set(
			read("rootfs/etc/caddy/Caddyfile")
				.split(/\r?\n/)
				.map((line) => line.trim())
		);
		for (const route of [
			"handle /proxy/* {",
			"handle /absproxy/* {",
			"handle /_composery/healthz* {",
			"handle /_composery/api/v1/* {",
			// SSH enrollment is its own namespace, not a corner of the API.
			"handle /_composery/ssh/* {"
		]) {
			expect(lines.has(route), route).toBe(true);
		}
		expect(
			lines.has(
				"@outside_ide path /ide/proxy /ide/proxy/* /ide/absproxy /ide/absproxy/* /ide/_composery/healthz* /ide/_composery/api/v1 /ide/_composery/api/v1/* /ide/_composery/ssh /ide/_composery/ssh/* /ide/robots.txt /ide/security.txt /ide/.well-known/security.txt"
			)
		).toBe(true);
		expect(
			lines.has(
				"@root_files path /robots.txt /security.txt /.well-known/security.txt"
			)
		).toBe(true);
		expect(lines.has("handle /_composery* {")).toBe(false);
	});

	test("cloud authorization receives its callback from the IDE", () => {
		const cloudAuth = read("packages/ide/overlay/src/node/routes/cloudAuth.ts");
		const authorize = read("packages/web/app/boxes/authorize/route.ts");
		const auth = read("packages/web/convex/instance/auth.ts");

		expect(cloudAuth).toContain(
			'authorization.searchParams.set("redirect_uri", callbackUrl(req))'
		);
		expect(authorize).toContain('url.searchParams.get("redirect_uri")');
		expect(auth).toContain("redirectUri: args.redirectUri");
		expect(auth).not.toContain("_composery/cloud/callback");
	});

	test("no deployment config enables the removed host-domain proxy", () => {
		for (const path of [
			"Dockerfile",
			"compose.dev.yaml",
			"docs",
			"rootfs",
			"scripts",
			"templates"
		]) {
			const source = textUnder(path);
			expect(source, path).not.toContain("proxy-domain");
		}
		const patch = read("packages/ide/patches/proxy-root.diff");
		expect(patch).toContain("--- a/src/node/routes/domainProxy.ts");
		expect(patch).toContain("+++ /dev/null");
	});
});
