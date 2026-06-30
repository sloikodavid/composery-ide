import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const tool = dirname(fileURLToPath(import.meta.url));
const root = resolve(tool, "../../../..");
const pagePath = resolve(tool, "index.html");
const themePath = resolve(root, "packages/shared/theme.json");
const iconPath = resolve(root, "packages/web/app/icon.svg");
const lucidePath = resolve(
	root,
	"packages/shared/node_modules/lucide-static/sprite.svg"
);
const codiconRoot = resolve(
	root,
	"packages/shared/node_modules/@vscode/codicons/dist"
);
const port = Number(process.env.PORT ?? 7331);
const origins = new Set([
	`http://127.0.0.1:${port}`,
	`http://localhost:${port}`
]);

function buildAssets() {
	return process.platform === "win32"
		? run(
				process.env.ComSpec ?? "cmd.exe",
				["/d", "/s", "/c", "pnpm.cmd fix:assets"],
				{ cwd: root }
			)
		: run("pnpm", ["fix:assets"], { cwd: root });
}

function validTheme(value, shape) {
	const sameKeys = (first, second) =>
		first &&
		second &&
		Object.keys(first).length === Object.keys(second).length &&
		Object.keys(first).every((key) => Object.hasOwn(second, key));
	if (!value || typeof value !== "object" || !sameKeys(value, shape))
		return false;
	if (
		!sameKeys(value.web, shape.web) ||
		!sameKeys(value.ide, shape.ide) ||
		!sameKeys(value.ide.features, shape.ide.features) ||
		!Object.values(value.ide.features).every(
			(feature) => typeof feature === "boolean"
		)
	)
		return false;
	for (const area of ["web", "ide"]) {
		for (const scheme of ["light", "dark"]) {
			if (
				!value[area][scheme] ||
				!sameKeys(value[area][scheme], shape[area][scheme])
			)
				return false;
			if (
				!Object.values(value[area][scheme]).every(
					(color) =>
						typeof color === "string" &&
						/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color)
				)
			)
				return false;
		}
	}
	return true;
}

async function readBody(request) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of request) {
		bytes += chunk.length;
		if (bytes > 64 * 1024) throw new Error("request is too large");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function saveTheme(next) {
	const before = await readFile(themePath, "utf8");
	const shape = JSON.parse(before);
	if (!validTheme(next, shape)) throw new Error("invalid theme");
	const temporary = `${themePath}.${process.pid}.tmp`;
	const write = async (contents) => {
		await writeFile(temporary, contents, "utf8");
		await rename(temporary, themePath);
	};
	await write(`${JSON.stringify(next, null, "\t")}\n`);
	try {
		await buildAssets();
	} catch (error) {
		await write(before);
		await buildAssets().catch(() => {});
		throw error;
	}
}

const server = createServer(async (request, response) => {
	try {
		if (request.method === "GET" && request.url === "/") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			return response.end(await readFile(pagePath));
		}
		if (request.method === "GET" && request.url === "/theme") {
			response.writeHead(200, {
				"content-type": "application/json",
				"cache-control": "no-store"
			});
			return response.end(await readFile(themePath));
		}
		if (request.method === "GET" && request.url === "/icon.svg") {
			response.writeHead(200, {
				"content-type": "image/svg+xml; charset=utf-8",
				"cache-control": "no-store"
			});
			return response.end(await readFile(iconPath));
		}
		if (request.method === "GET" && request.url === "/lucide.svg") {
			response.writeHead(200, {
				"content-type": "image/svg+xml; charset=utf-8",
				"cache-control": "public, max-age=31536000, immutable"
			});
			return response.end(await readFile(lucidePath));
		}
		if (request.method === "GET" && request.url === "/codicon.css") {
			response.writeHead(200, {
				"content-type": "text/css; charset=utf-8",
				"cache-control": "public, max-age=31536000, immutable"
			});
			return response.end(await readFile(resolve(codiconRoot, "codicon.css")));
		}
		if (request.method === "GET" && request.url?.startsWith("/codicon.ttf")) {
			response.writeHead(200, {
				"content-type": "font/ttf",
				"cache-control": "public, max-age=31536000, immutable"
			});
			return response.end(await readFile(resolve(codiconRoot, "codicon.ttf")));
		}
		if (request.method === "PUT" && request.url === "/theme") {
			if (!origins.has(request.headers.origin))
				throw new Error("request did not come from this colors editor");
			await saveTheme(await readBody(request));
			response.writeHead(204);
			return response.end();
		}
		response.writeHead(404);
		response.end("not found");
	} catch (error) {
		response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
		response.end(String(error?.message ?? error));
	}
});

server.listen(port, "127.0.0.1", () =>
	console.log(`colors: http://127.0.0.1:${port}`)
);
