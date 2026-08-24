import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRuntimeArtifacts } from "../../../packages/web/convex/boxes/infra/artifacts.ts";
// Reached through the namespace rather than by name, so the guard below can ask
// the module what it exports instead of comparing it to a second list here.
import * as hostScripts from "../../../packages/web/convex/boxes/infra/hostScripts.ts";

const artifacts = renderRuntimeArtifacts({
	cloudBoxId: "box_123",
	cloudOrigin: "https://www.composery.io",
	config: { COMPOSERY_DISABLE_FILE_UPLOADS: "1" },
	domain: "box.composery.cloud",
	runtimeAuthHash: "$argon2id$hash",
	runtimeImage: `ghcr.io/example/composery@sha256:${"a".repeat(64)}`,
	runtimePort: 8080
});

// Every script this deployment can send to a host, keyed by the export it comes
// from and called the way its caller calls it. One export can produce more than
// one shape, so each holds a list: `bash -n` only ever sees the text it is
// handed, and a branch nobody rendered is a branch nobody parsed.
const scripts = {
	DISK_SCRIPT: [hostScripts.DISK_SCRIPT],
	INSPECT_SCRIPT: [hostScripts.INSPECT_SCRIPT],
	applyRuntimeConfigScript: [
		hostScripts.applyRuntimeConfigScript(artifacts.env)
	],
	bootstrapScript: [hostScripts.bootstrapScript(artifacts)],
	copyFromParkingScript: [hostScripts.copyFromParkingScript(artifacts, 42)],
	copyToParkingFromRescueScript: [
		hostScripts.copyToParkingFromRescueScript(42)
	],
	reloadCaddyfileScript: [
		hostScripts.reloadCaddyfileScript(artifacts.caddyfile)
	],
	repairScript: [hostScripts.repairScript(artifacts)],
	rewritePasswordScript: [
		hostScripts.rewritePasswordScript(artifacts.env, "$argon2id$hash")
	],
	runtimeLogsScript: [hostScripts.runtimeLogsScript(100)],
	// A name is the owner's own text, so the one with a quote in it is the shape
	// worth parsing: the quoting it goes through is what makes it one word.
	sshEnrollScript: [hostScripts.sshEnrollScript("a phone's name")],
	sshListScript: [hostScripts.sshListScript()],
	sshRevokeScript: [hostScripts.sshRevokeScript(42)],
	unmountParkingScript: [hostScripts.unmountParkingScript()],
	unmountRescueScript: [hostScripts.unmountRescueScript()],
	updateScript: [hostScripts.updateScript(artifacts)],
	verifyParkingScript: [
		hostScripts.verifyParkingScript("out", 42),
		hostScripts.verifyParkingScript("back", 42)
	]
};

// `bash -n` proves only what it is handed, so a script nobody added above is a
// script nothing checks - and it fails silently, by passing. The module's own
// exports are the list: anything named for a script has to appear here.
const unchecked = Object.keys(hostScripts).filter(
	(name) => /(?:Script|_SCRIPT)$/.test(name) && !(name in scripts)
);
if (unchecked.length > 0) {
	throw new Error(
		`hostScripts exports scripts this check never parses: ${unchecked.join(", ")}.`
	);
}

let parsed = 0;
for (const [name, shapes] of Object.entries(scripts)) {
	for (const [index, script] of shapes.entries()) {
		const checked = spawnSync("bash", ["-n"], {
			encoding: "utf8",
			input: script
		});
		if (checked.status !== 0) {
			throw new Error(
				`${name}${shapes.length > 1 ? ` (shape ${index + 1})` : ""} is not valid Bash:\n${checked.stderr}`
			);
		}
		parsed += 1;
	}
}

const directory = await mkdtemp(join(tmpdir(), "composery-artifacts-"));
try {
	await Promise.all([
		writeFile(join(directory, "Caddyfile"), artifacts.caddyfile),
		writeFile(join(directory, "compose.yaml"), artifacts.compose),
		writeFile(join(directory, "composery.env"), artifacts.env)
	]);
	const checked = spawnSync(
		"docker",
		["compose", "-f", "compose.yaml", "config", "--quiet"],
		{ cwd: directory, encoding: "utf8" }
	);
	if (checked.status !== 0) {
		throw new Error(
			`The runtime Compose artifact is invalid:\n${checked.stderr}`
		);
	}
} finally {
	await rm(directory, { force: true, recursive: true });
}

console.log(`validated ${parsed} Bash scripts and Compose`);
