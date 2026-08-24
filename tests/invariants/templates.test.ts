import { execFileSync } from "node:child_process";

import { describe, expect, test } from "vitest";

import { CONTAINER_IMAGE } from "../../packages/shared/index.ts";
import { readRepoFile, repoRoot } from "../support/repo.ts";

// Provider manifests have to repeat environment names because Fly, Kubernetes,
// Render, Railway, and Compose consume those files directly; none can derive its
// keys from Composery's Markdown configuration reference. Pin every exact name in
// either active config or a copyable commented example so a rename cannot leave a
// template accepting an environment variable the product no longer documents.

const tracked = (path: string): string[] =>
	execFileSync("git", ["ls-files", path], { cwd: repoRoot, encoding: "utf8" })
		.split("\n")
		.filter(Boolean);

const templateFiles = tracked("templates");
// The platforms with no file to commit are documented instead of foldered, so
// their recipe is prose. It carries the same values and breaks the same way.
const recipeFiles = [...templateFiles, ...tracked("docs/self-hosting")];

describe("deployment templates", () => {
	test("documents every Composery environment variable they name", () => {
		const variables = new Set(
			templateFiles.flatMap((path) =>
				[
					...readRepoFile(path).matchAll(
						/(?<![A-Z0-9_])(COMPOSERY_[A-Z0-9_]+)(?![A-Z0-9_])/g
					)
				].flatMap((match) => match[1] ?? [])
			)
		);
		const documented = new Set(
			[
				...readRepoFile("docs/configuration.md").matchAll(
					/`(COMPOSERY_[A-Z0-9_]+)`/g
				)
			].flatMap((match) => match[1] ?? [])
		);

		expect(variables.size).toBeGreaterThan(0);
		expect(
			[...variables].filter((variable) => !documented.has(variable))
		).toEqual([]);
	});

	test("pull the image `CONTAINER_IMAGE` names", () => {
		// Same reason as the variables above: Fly, Kubernetes and Render read these
		// files directly and cannot import a constant. The Compose four are held to
		// the name another way - `system:compose` tags its build over exactly
		// this reference and boots with `--pull never`, so a renamed image leaves
		// no local image to start. The other three are booted by nothing, so a
		// rename would leave them pointing at a registry path that stopped
		// existing, and the first person to learn it would be the one deploying.
		//
		// Any image a registry host qualifies, never the word `composery`: a
		// pattern that looks for the name being renamed goes quiet on exactly the
		// rename it exists to catch, and reports the remaining files as clean. The
		// first version of this test did that and passed `composery-cloud`.
		//
		// The tag has to be attached, which is the whole difference between an
		// image and a YAML key that reads like one - `cert-manager.io/cluster-issuer`
		// in `ingress.yaml` puts a space after its colon and an image never does.
		// Third-party images stay out on their own: `caddy:2.11.4-alpine` carries
		// no registry host, so no rule has to name it.
		const referenced = templateFiles.flatMap((path) =>
			[
				...readRepoFile(path).matchAll(
					/(?<![\w/.-])([a-z0-9-]+(?:\.[a-z0-9-]+)+\/[\w./-]+)[:@][\w.-]/g
				)
			].map((match) => `${path}: ${match[1]}`)
		);

		expect(
			referenced.filter((image) => !image.endsWith(`: ${CONTAINER_IMAGE}`))
		).toEqual([]);

		// Green has to mean the images matched, not that the pattern stopped
		// finding any. Every Compose recipe is held to naming one, which is a rule
		// with no exception to remember: Compose has no other way to say which
		// image a service runs. It is deliberately not "every recipe" - Railway
		// takes the image in its own dashboard, so `railway.json` names none, and
		// a rule needing that exception would be the wrong rule.
		const naming = new Set(referenced.map((image) => image.split(": ")[0]));
		const recipes = templateFiles.filter((path) =>
			path.endsWith("/compose.yaml")
		);

		expect(recipes.length).toBeGreaterThan(1);
		expect(recipes.filter((path) => !naming.has(path))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Three values decide whether a deployment works at all, and the image states
// all three itself: the port it listens on, the path its health check answers,
// and the volume root it keeps state under. Every recipe repeats them because
// the platform reads the recipe and can never ask the image.
//
// They fail differently, and the quiet one is the one that matters. A wrong port
// or health path is loud - the platform cannot route, or restarts the instance
// for ever. A wrong volume root is silent: the instance boots, serves, passes
// its health check, and loses every file the moment it restarts.
//
// Duplication, and why it cannot be removed: the same reason as the environment
// names above, so these read the value out of the artifact that sets it rather
// than writing it down again. `paths.rs` calls `/data` the deployment
// contract; this is what makes that sentence true.
// ---------------------------------------------------------------------------

const dockerfile = readRepoFile("Dockerfile");

// Taken by position, never by name. Reading the path out of the health check's
// own URL means a prefix somebody moves is picked up here instead of quietly
// leaving every recipe behind.
const PORT = /^EXPOSE (\d+)$/m.exec(dockerfile)?.[1] ?? "";
const HEALTH_PATH = /HEALTHCHECK[\s\S]*?localhost:\$\{PORT[^}]*\}(\S*?)"/.exec(
	dockerfile
)?.[1];
const DATA_PATH = /COMPOSERY_DOCKER_VOLUME_PATH:-([^}]+)/.exec(
	readRepoFile("rootfs/opt/composery/entrypoint.sh")
)?.[1];

// A value read out of an artifact is only as good as the read. Each of the three
// below is a pattern over a file somebody else edits, and a pattern that stops
// matching hands the tests an empty string to compare everything against - which
// every recipe would then satisfy. Shape them here, once, so that failure is
// this test rather than three silent passes.
describe("the contract the image states", () => {
	test("is readable from the artifacts that set it", () => {
		expect(PORT).toMatch(/^\d+$/);
		expect(HEALTH_PATH).toMatch(/^\/[\w./-]+$/);
		expect(DATA_PATH).toMatch(/^\/[\w./-]+$/);
	});

	test("is what every recipe running the image says about its data", () => {
		// The set is derived, not listed: a file that names the image is a file
		// telling somebody how to run it, and running it without the volume is the
		// loss nobody sees. A recipe added later joins the set the day it names
		// the image.
		const running = recipeFiles.filter((path) =>
			readRepoFile(path).includes(CONTAINER_IMAGE)
		);
		// Bounded on both sides. A right edge alone accepts `/var/data`, which ends
		// in the contract path without being it - the recipe would mount the wrong
		// directory and read as correct here. The first version of this did that.
		//
		// Comments do not count where a machine reads the file. `composery.yaml`
		// names `/data` in a note above the volume, so a mount moved to
		// `/var/data` left the note behind and the check went on passing. In a
		// documented recipe the prose is the recipe, so there it all counts.
		const active = (path: string): string =>
			path.endsWith(".md")
				? readRepoFile(path)
				: readRepoFile(path).replace(/(^|\s)#.*$/gm, "");
		const holds = (path: string, value: string): boolean =>
			new RegExp(`(?<![\\w/-])${value}(?![\\w/-])`).test(active(path));

		expect(running.length).toBeGreaterThan(1);
		expect(running.filter((path) => !holds(path, DATA_PATH ?? ""))).toEqual([]);
		expect(running.filter((path) => !holds(path, PORT))).toEqual([]);
	});

	test("is what every health check in a recipe names", () => {
		const read = (pattern: RegExp): string[] =>
			recipeFiles.flatMap((path) =>
				[...readRepoFile(path).matchAll(pattern)].map(
					(match) => `${path}: ${match[0]}`
				)
			);

		// Two reads, because one cannot tell a moved endpoint from a moved prefix.
		// The first says the recipes still name the live path; the second says none
		// of them kept an old one. Rename the prefix everywhere and both stay
		// happy; rename it in one place and one of them says so.
		expect(
			read(new RegExp(`${HEALTH_PATH}(?![\\w/-])`, "g")).length
		).toBeGreaterThan(3);
		expect(
			read(/\/_composery\/[\w./-]+/g).filter(
				(found) => !found.endsWith(`: ${HEALTH_PATH}`)
			)
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// `user-data/user-data.yaml` is the one template that reaches into another one.
// It avoids duplicating the Compose recipe by fetching that folder at a server's
// first boot and editing a placeholder in place. That removes the content copy
// and leaves two copies nobody reads: the list of files it fetches, and the
// string it expects to find in one of them.
//
// Both fail without saying so, and on a machine nobody here can see. A file
// added to the recipe is a file the installer does not fetch, so `docker compose
// up` stops on a stranger's new server. A moved placeholder makes `sed` match
// nothing and exit 0, so the install finishes and Caddy asks Let's Encrypt for a
// certificate for `example.com`.
//
// Duplication, and why it cannot be removed: cloud-init runs before this
// repository exists on that machine, so the installer cannot read the recipe to
// learn what it holds - it can only name it. So the copies stay and this pins
// them, the last rung of the ladder in AGENTS.md.
// ---------------------------------------------------------------------------

const INSTALLER = "templates/user-data/user-data.yaml";
const installer = readRepoFile(INSTALLER);

// `curl … https://raw.githubusercontent.com/<owner>/<repo>/<ref>/templates/<folder>/<file> -o <destination>`
const FETCH =
	/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/[\w.-]+\/templates\/([\w.-]+)\/([\w.-]+)\s+-o\s+(\S+)/g;
const fetched = [...installer.matchAll(FETCH)].map((match) => ({
	folder: match[1] ?? "",
	name: match[2] ?? "",
	destination: match[3] ?? ""
}));

describe("the one-paste installer", () => {
	test("fetches a recipe this repository still ships", () => {
		// Green has to mean the files matched, not that the pattern stopped
		// finding any: an installer whose shape moved reports the same empty set
		// as an installer that fetches nothing.
		expect(fetched.length).toBeGreaterThan(0);
		expect([...new Set(fetched.map((file) => file.folder))]).toHaveLength(1);
	});

	test("fetches every file that recipe needs, under the name it needs", () => {
		const folder = fetched[0]?.folder ?? "";
		// Everything the recipe holds except its own prose. Reading the folder is
		// what makes a fifth file fail here rather than on somebody's server.
		const shipped = templateFiles
			.filter((path) => path.startsWith(`templates/${folder}/`))
			.map((path) => path.slice(`templates/${folder}/`.length))
			.filter((name) => !name.endsWith(".md"))
			.sort();

		expect(fetched.map((file) => file.name).sort()).toEqual(shipped);
		// Compose mounts `./Caddyfile` and reads `./composery.env` by name, so a
		// file saved under any other one is a file it does not find.
		expect(
			fetched.filter((file) => !file.destination.endsWith(`/${file.name}`))
		).toEqual([]);
	});

	test("replaces a placeholder the fetched file still holds", () => {
		// `sed -i 's/<pattern>/<replacement>/' <destination>`, the one edit the
		// installer makes to a file it did not write.
		const edits = [
			...installer.matchAll(/sed -i\s+'s\/(.+?)\/(.+?)\/'\s+(\S+)/g)
		].map((match) => ({
			pattern: (match[1] ?? "").replace(/\\(.)/g, "$1"),
			destination: match[3] ?? ""
		}));
		expect(edits.length).toBeGreaterThan(0);

		const missing = edits.flatMap((edit) => {
			const target = fetched.find((file) =>
				edit.destination.endsWith(`/${file.name}`)
			);
			if (!target) return `${edit.destination} is edited but never fetched`;
			const lines = readRepoFile(`templates/${target.folder}/${target.name}`)
				.split("\n")
				.filter((line) => line.includes(edit.pattern));
			// Exactly one line, because the command carries no `g`: a second
			// occurrence would survive the edit and keep the old host.
			return lines.length === 1
				? []
				: `${target.name} holds ${edit.pattern} on ${lines.length} lines`;
		});

		expect(missing).toEqual([]);
	});
});
