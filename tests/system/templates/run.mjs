import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { parse, parseAllDocuments } from "yaml";

const REPO_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	".."
);
const TEMPLATE_IMAGE = "ghcr.io/sloikodavid/composery:latest";
const COMPOSE_VARIANTS = [
	"supervisor-compose",
	"systemd-compose",
	"supervisor-caddy-compose",
	"systemd-caddy-compose"
];
const SCHEMA_URLS = {
	railway: "https://railway.com/railway.schema.json",
	render: "https://render.com/schema/render.yaml.json",
	// renovate: datasource=github-releases depName=kubernetes/kubernetes
	kubernetes:
		"https://raw.githubusercontent.com/kubernetes/kubernetes/v1.36.3/api/openapi-spec/swagger.json",
	// renovate: datasource=github-releases depName=canonical/cloud-init
	cloudConfig:
		"https://raw.githubusercontent.com/canonical/cloud-init/26.2/cloudinit/config/schemas/schema-cloud-config-v1.json"
};
const RUN_ID = `${Date.now()}-${process.pid}`;

let activeCompose;
let originalTemplateImage;
let replacementTemplateImage;
let failureDumped = false;

process.once("SIGINT", () => stopFromSignal("SIGINT", 130));
process.once("SIGTERM", () => stopFromSignal("SIGTERM", 143));

try {
	const command = process.argv[2];
	if (command === "schemas") {
		await validateProviderSchemas();
	} else if (command === "compose") {
		await bootComposeTemplates();
	} else {
		throw new Error(
			"Usage: node tests/system/templates/run.mjs <schemas|compose>"
		);
	}
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	dumpComposeLogs();
	process.exitCode = 1;
} finally {
	cleanupCompose();
	restoreTemplateImage();
}

async function validateProviderSchemas() {
	validateFly();

	log(`validating Render Blueprint against ${SCHEMA_URLS.render}`);
	validateJsonSchema(
		parse(readTemplate("render/render.yaml")),
		await fetchJson(SCHEMA_URLS.render),
		"Render Blueprint",
		Ajv2020
	);

	const railway = JSON.parse(readTemplate("railway/railway.json"));
	if (railway.$schema !== SCHEMA_URLS.railway) {
		throw new Error(
			`railway.json must name its provider schema as ${SCHEMA_URLS.railway}.`
		);
	}
	log(`validating Railway config against ${railway.$schema}`);
	validateJsonSchema(
		railway,
		await fetchJson(railway.$schema),
		"Railway config",
		Ajv
	);

	log(`validating Kubernetes resources against ${SCHEMA_URLS.kubernetes}`);
	validateKubernetes(await fetchJson(SCHEMA_URLS.kubernetes));

	log(`validating cloud-config against ${SCHEMA_URLS.cloudConfig}`);
	validateCloudConfig(await fetchJson(SCHEMA_URLS.cloudConfig));
}

// What `--strict` gives is a type check, not a schema: it rejects broken TOML, a
// value of the wrong type and a missing app name, and it accepts an unknown key,
// an unknown VM size and a mount with no destination. So the warning text does
// the rest of the work here - flyctl exits 0 on a config it only warns about -
// and that makes one word load bearing, which is a weak thing to depend on.
//
// So the reading is proved on every run. A `[[services]]` block with no ports of
// its own is a shape flyctl warns about and still calls valid. If that copy
// comes back clean and accepted, the warning went unread, and the clean result
// for the shipped config means nothing.
function validateFly() {
	log("validating Fly config with flyctl");
	const shipped = runFly(templatePath("fly/fly.toml"), true);
	if (!shipped.output.includes("Configuration is valid")) {
		throw new Error("flyctl did not report the Fly config as valid.");
	}
	if (shipped.output.includes("WARN")) {
		throw new Error("flyctl reported a configuration warning.");
	}

	const control = resolve(REPO_ROOT, "tmp", "fly-warning-control.toml");
	mkdirSync(dirname(control), { recursive: true });
	writeFileSync(
		control,
		`${readTemplate("fly/fly.toml")}
[[services]]
  internal_port = 8080
  protocol = "tcp"
`
	);
	const warned = runFly(control, false);
	if (warned.status === 0 && !warned.output.includes("WARN")) {
		throw new Error(
			"flyctl accepts a service with no ports and says nothing, so the warning check above cannot fail."
		);
	}
	log(
		"flyctl accepts the Fly config, and still reports a warning when there is one"
	);
}

function runFly(config, echo) {
	const result = run(
		process.env.FLYCTL_PATH ?? "flyctl",
		["config", "validate", "--strict", "--config", config],
		{
			capture: true,
			// A validation error has to fail the run, but the control config is
			// asked whether flyctl objects at all - either answer is one to read.
			check: echo,
			// The command requires a syntactically valid token before doing its
			// entirely local validation. This documented test value grants no
			// access and keeps schema validation independent of a repository secret.
			env: { FLY_API_TOKEN: process.env.FLY_API_TOKEN ?? "fm2_test" }
		}
	);
	if (echo) {
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
	}
	return {
		output: `${result.stdout}\n${result.stderr}`,
		status: result.status
	};
}

// Deliberately not `async`. Every failure here is a throw, and a promise nobody
// waits for turns a throw into a rejection nothing reads - the validator would
// report a pass it never performed.
function validateJsonSchema(value, schema, label, AjvClass) {
	const ajv = new AjvClass({
		allErrors: true,
		strict: false,
		validateFormats: false
	});
	const validate = ajv.compile(schema);
	if (!validate(value)) {
		throw new Error(
			`${label} is invalid:\n${ajv.errorsText(validate.errors, {
				separator: "\n"
			})}`
		);
	}
}

function validateKubernetes(openApi) {
	if (openApi.swagger !== "2.0" || !openApi.definitions) {
		throw new Error(
			"Kubernetes did not return its published OpenAPI v2 schema."
		);
	}

	const schema = {
		$id: SCHEMA_URLS.kubernetes,
		definitions: makeObjectsStrict(openApi.definitions)
	};
	const ajv = new Ajv({
		allErrors: true,
		strict: false,
		validateFormats: false
	});
	ajv.addSchema(schema);

	const definitionsByType = new Map();
	for (const [name, definition] of Object.entries(openApi.definitions)) {
		for (const type of definition["x-kubernetes-group-version-kind"] ?? []) {
			const apiVersion = type.group
				? `${type.group}/${type.version}`
				: type.version;
			definitionsByType.set(`${apiVersion}:${type.kind}`, name);
		}
	}

	// Every manifest in the folder, read from the folder. Naming them here is how
	// `ingress.yaml` sat unchecked beside a validated `composery.yaml`: the list
	// said what somebody remembered to add, and a manifest nobody adds to it is
	// one nothing reads until a cluster rejects it.
	//
	// Everything that is not documentation counts as a manifest. Selecting by
	// extension instead would rebuild the same hole one extension down: a file
	// somebody spells another way is then skipped without a word, which is how
	// the list-shaped version failed in the first place.
	const manifests = readdirSync(templatePath("kubernetes"))
		.filter((entry) => !entry.endsWith(".md"))
		.sort();
	if (manifests.length === 0) {
		throw new Error("The Kubernetes template folder holds no manifest.");
	}

	for (const manifest of manifests) {
		const resources = parseAllDocuments(
			readTemplate(`kubernetes/${manifest}`)
		).map((document) => {
			if (document.errors.length > 0) {
				throw document.errors[0];
			}
			return document.toJS();
		});
		if (resources.length === 0) {
			throw new Error(`${manifest} contains no resource.`);
		}

		for (const resource of resources) {
			const type = `${resource?.apiVersion}:${resource?.kind}`;
			const definition = definitionsByType.get(type);
			if (!definition) {
				throw new Error(
					`The Kubernetes schema has no definition for ${type} (${manifest}).`
				);
			}
			const validate = ajv.getSchema(
				`${SCHEMA_URLS.kubernetes}#/definitions/${definition}`
			);
			if (!validate) {
				throw new Error(`Could not compile the Kubernetes schema for ${type}.`);
			}
			if (!validate(resource)) {
				throw new Error(
					`${manifest} ${type} is invalid:\n${ajv.errorsText(validate.errors, {
						separator: "\n"
					})}`
				);
			}
		}
		log(`${manifest} matches the Kubernetes schema`);
	}
}

// The one-paste installer has no reader at all between the paste and the boot,
// and a key cloud-init does not know is skipped in silence on somebody else's
// new server.
function validateCloudConfig(schema) {
	// cloud-init publishes draft-04 and Ajv 8 reads draft-07 onward, so the draft
	// is dropped and the schema read as the default one. Exactly one keyword pair
	// means different things across that gap -
	// `exclusiveMinimum`/`exclusiveMaximum` carry a boolean in draft-04 and a
	// number after it - and this schema uses neither, which is what makes the two
	// readings accept and reject the same documents. Refuse the schema, never the
	// template, if a later cloud-init adds one: a keyword read as the wrong draft
	// validates something nobody asked for and still passes.
	const draft04 = findDraft04Bounds(schema);
	if (draft04.length > 0) {
		throw new Error(
			`The cloud-config schema now uses draft-04 ${draft04.join(", ")}; Ajv would read it as a later draft.`
		);
	}
	delete schema.$schema;

	validateJsonSchema(
		parse(readTemplate("user-data/user-data.yaml")),
		schema,
		"cloud-config",
		Ajv
	);
	log("user-data.yaml matches the cloud-config schema");
}

// A draft-04 bound is the boolean form; a property a user config happens to call
// `exclusiveMinimum` holds a schema object and is not one.
function findDraft04Bounds(value) {
	if (Array.isArray(value)) return value.flatMap(findDraft04Bounds);
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, child]) =>
		(key === "exclusiveMinimum" || key === "exclusiveMaximum") &&
		typeof child === "boolean"
			? [key]
			: findDraft04Bounds(child)
	);
}

function makeObjectsStrict(value) {
	if (Array.isArray(value)) return value.map(makeObjectsStrict);
	if (!value || typeof value !== "object") return value;

	const strict = Object.fromEntries(
		Object.entries(value).map(([key, child]) => [key, makeObjectsStrict(child)])
	);
	if (
		strict["x-kubernetes-int-or-string"] === true ||
		strict.format === "int-or-string"
	) {
		delete strict.type;
		delete strict.format;
		strict.anyOf = [{ type: "integer" }, { type: "string" }];
	}
	if (
		strict.properties &&
		strict.additionalProperties === undefined &&
		strict["x-kubernetes-preserve-unknown-fields"] !== true
	) {
		strict.additionalProperties = false;
	}
	return strict;
}

async function fetchJson(url) {
	let response;
	try {
		response = await fetch(url, {
			signal: globalThis.AbortSignal.timeout(30_000)
		});
	} catch (error) {
		throw new Error(`Could not fetch ${url}: ${error}`, { cause: error });
	}
	if (!response.ok) {
		throw new Error(`Could not fetch ${url}: HTTP ${response.status}.`);
	}
	return response.json();
}

async function bootComposeTemplates() {
	requireDocker();
	const variants = requestedComposeVariants();
	const imageTag = process.env.TEMPLATE_IMAGE_TAG ?? "composery:templates";

	if (!parseBoolean(process.env.TEMPLATE_SKIP_BUILD)) {
		log(`building ${imageTag}`);
		const args = ["build", "-t", imageTag];
		if (parseBoolean(process.env.TEMPLATE_NO_CACHE)) args.push("--no-cache");
		args.push(".");
		run("docker", args, { timeoutMs: null });
	}
	requireImage(imageTag);
	replaceTemplateImage(imageTag);

	for (const variant of variants) {
		await bootComposeTemplate(variant);
	}
}

function requestedComposeVariants() {
	const requested = (process.env.TEMPLATE_VARIANTS ?? "all")
		.split(",")
		.map((variant) => variant.trim())
		.filter(Boolean);
	const variants = requested.includes("all") ? COMPOSE_VARIANTS : requested;
	if (variants.length === 0) {
		throw new Error("TEMPLATE_VARIANTS names no Compose template.");
	}
	for (const variant of variants) {
		if (!COMPOSE_VARIANTS.includes(variant)) {
			throw new Error(
				`Unknown Compose template ${variant}; expected ${COMPOSE_VARIANTS.join(", ")}.`
			);
		}
	}
	return variants;
}

async function bootComposeTemplate(variant) {
	const project = `composery-template-${variant}-${RUN_ID}`.toLowerCase();
	activeCompose = {
		cwd: templatePath(variant),
		project,
		variant
	};
	failureDumped = false;
	cleanupCompose();
	activeCompose = {
		cwd: templatePath(variant),
		project,
		variant
	};

	log(`booting templates/${variant}/compose.yaml`);
	compose(["config", "--quiet"]);
	const expected = variant.includes("caddy")
		? ["caddy", "composery"]
		: ["composery"];
	if (expected.includes("caddy")) compose(["pull", "caddy"]);
	compose(["up", "--detach", "--no-build", "--pull", "never"]);

	await retry(`${variant} services`, 60, () => {
		for (const service of expected) {
			const id = compose(["ps", "--quiet", service], {
				capture: true,
				quiet: true
			}).stdout.trim();
			if (!id) throw new Error(`${service} has no container.`);
			const running = run(
				"docker",
				["inspect", "--format", "{{.State.Running}}", id],
				{ capture: true, quiet: true }
			).stdout.trim();
			if (running !== "true") throw new Error(`${service} is not running.`);
		}
	});
	const composeryId = compose(["ps", "--quiet", "composery"], {
		capture: true,
		quiet: true
	}).stdout.trim();
	const runningImage = run(
		"docker",
		["inspect", "--format", "{{.Image}}", composeryId],
		{ capture: true, quiet: true }
	).stdout.trim();
	if (runningImage !== replacementTemplateImage) {
		throw new Error(
			`${variant} booted image ${runningImage}, not built image ${replacementTemplateImage}.`
		);
	}

	await retry(`${variant} IDE`, 180, () => {
		compose(
			[
				"exec",
				"--no-TTY",
				"composery",
				"node",
				"--input-type=module",
				"--eval",
				[
					'const health = await fetch("http://127.0.0.1:8080/_composery/healthz");',
					"if (health.status !== 200) throw new Error(`health returned ${health.status}`);",
					'const ide = await fetch("http://127.0.0.1:8080/ide/", { redirect: "manual" });',
					"if (ide.status < 200 || ide.status >= 400) {",
					"  throw new Error(`IDE returned ${ide.status}`);",
					"}",
					'if (ide.status >= 300 && !ide.headers.get("location")) {',
					'  throw new Error("IDE redirected without a location");',
					"}"
				].join("\n")
			],
			{ capture: true, quiet: true }
		);
	});

	if (variant.startsWith("systemd-")) {
		compose(
			[
				"exec",
				"--no-TTY",
				"composery",
				"sh",
				"-lc",
				'test "$(cat /proc/1/comm)" = systemd && systemctl is-active ide'
			],
			{ capture: true, quiet: true }
		);
	}
	log(`${variant} is healthy and its IDE answers`);
	cleanupCompose();
}

function requireDocker() {
	run("docker", ["version", "--format", "{{.Server.Version}}"], {
		capture: true,
		quiet: true,
		timeoutMs: 20_000
	});
	run("docker", ["compose", "version"], {
		capture: true,
		quiet: true,
		timeoutMs: 20_000
	});
}

function requireImage(tag) {
	const result = run("docker", ["image", "inspect", tag], {
		capture: true,
		check: false,
		quiet: true
	});
	if (result.status !== 0) {
		throw new Error(`Built image ${tag} does not exist.`);
	}
}

function replaceTemplateImage(source) {
	originalTemplateImage = imageId(TEMPLATE_IMAGE);
	replacementTemplateImage = imageId(source);
	if (!replacementTemplateImage) {
		throw new Error(`Could not resolve built image ${source}.`);
	}
	run("docker", ["tag", source, TEMPLATE_IMAGE], { quiet: true });
}

function restoreTemplateImage() {
	if (originalTemplateImage === undefined) return;
	if (originalTemplateImage) {
		run("docker", ["tag", originalTemplateImage, TEMPLATE_IMAGE], {
			check: false,
			quiet: true
		});
	} else {
		run("docker", ["image", "rm", TEMPLATE_IMAGE], {
			capture: true,
			check: false,
			quiet: true
		});
	}
	originalTemplateImage = undefined;
	replacementTemplateImage = undefined;
}

function imageId(tag) {
	const result = run(
		"docker",
		["image", "inspect", "--format", "{{.Id}}", tag],
		{ capture: true, check: false, quiet: true }
	);
	return result.status === 0 ? result.stdout.trim() : "";
}

function compose(args, options = {}) {
	if (!activeCompose) throw new Error("No Compose project is active.");
	return run(
		"docker",
		[
			"compose",
			"--project-name",
			activeCompose.project,
			"--file",
			"compose.yaml",
			...args
		],
		{ ...options, cwd: activeCompose.cwd }
	);
}

function cleanupCompose() {
	if (!activeCompose) return;
	compose(["down", "--volumes", "--remove-orphans", "--timeout", "30"], {
		capture: true,
		check: false,
		quiet: true
	});
	activeCompose = undefined;
}

function dumpComposeLogs() {
	if (!activeCompose || failureDumped) return;
	failureDumped = true;
	try {
		compose(["ps", "--all"], { check: false });
		compose(["logs", "--no-color"], { check: false });
	} catch {
		// Keep the original failure if Docker itself is unavailable.
	}
}

async function retry(label, attempts, fn) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			return fn();
		} catch (error) {
			lastError = error;
			await sleep(1000);
		}
	}
	throw new Error(
		`Timed out waiting for ${label}: ${
			lastError instanceof Error ? lastError.message : lastError
		}`
	);
}

function readTemplate(path) {
	return readFileSync(templatePath(path), "utf8");
}

function templatePath(path) {
	return resolve(REPO_ROOT, "templates", path);
}

function run(command, args, options = {}) {
	if (!options.quiet) logCommand(command, args);
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? REPO_ROOT,
		encoding: "utf8",
		env: options.env ? { ...process.env, ...options.env } : process.env,
		stdio: options.capture ? "pipe" : "inherit",
		timeout:
			options.timeoutMs === null ? undefined : (options.timeoutMs ?? 120_000)
	});
	if (result.error) throw result.error;
	if (options.check !== false && result.status !== 0) {
		const details = [result.stdout?.trim(), result.stderr?.trim()]
			.filter(Boolean)
			.join("\n");
		throw new Error(
			`${command} ${args.join(" ")} failed with exit code ${
				result.status ?? "unknown"
			}${details ? `:\n${details}` : "."}`
		);
	}
	return {
		status: result.status ?? 1,
		stderr: result.stderr ?? "",
		stdout: result.stdout ?? ""
	};
}

function stopFromSignal(signal, exitCode) {
	console.error(`Received ${signal}; cleaning up template resources.`);
	dumpComposeLogs();
	cleanupCompose();
	restoreTemplateImage();
	process.exit(exitCode);
}

function parseBoolean(value) {
	return value === "1" || value === "true";
}

function log(message) {
	console.log(`[templates] ${message}`);
}

function logCommand(command, args) {
	console.log(`\n$ ${[command, ...args].map(formatArg).join(" ")}`);
}

function formatArg(arg) {
	if (/^[A-Za-z0-9_./:@=-]+$/.test(arg)) return arg;
	return JSON.stringify(arg);
}
