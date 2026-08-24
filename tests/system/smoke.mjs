import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { URL, URLSearchParams, fileURLToPath } from "node:url";

// tests/system/ -> the checkout. Every docker command below runs from here, so
// getting this wrong builds nothing and reports it as a failing image.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUN_ID = `${Date.now()}-${process.pid}`;
const DEFAULT_ATTEMPTS = {
	exec: 120,
	health: 120,
	readiness: 180
};

const config = {
	buildTimeoutMs: parseOptionalTimeout(process.env.SMOKE_BUILD_TIMEOUT_MS),
	containerName:
		process.env.SMOKE_CONTAINER_NAME ?? `composery-smoke-${RUN_ID}`,
	imageTag: process.env.SMOKE_IMAGE_TAG ?? "composery:smoke",
	noCache: parseBoolean(process.env.SMOKE_NO_CACHE),
	password: process.env.SMOKE_PASSWORD ?? "smoke-password",
	port: parsePort(process.env.SMOKE_PORT ?? "18080"),
	// SMOKE_SKIP_SYSTEMD=true skips the systemd path where host cgroups are unavailable (e.g. Docker Desktop).
	skipSystemd: parseBoolean(process.env.SMOKE_SKIP_SYSTEMD),
	volumeName: process.env.SMOKE_VOLUME_NAME ?? `composery-smoke-${RUN_ID}`
};

let failureDumped = false;

process.once("SIGINT", () => stopFromSignal("SIGINT", 130));
process.once("SIGTERM", () => stopFromSignal("SIGTERM", 143));

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	dumpContainerLogs();
	process.exitCode = 1;
} finally {
	cleanupResources();
}

async function main() {
	requireDocker();
	cleanupResources();
	buildImage();
	docker(["volume", "create", config.volumeName], { quiet: true });
	runDefaultContainer();
	await assertWebAppSmoke();
	await assertApiSmoke();
	await assertPersistenceAppliesChanges();
	assertVolumeMountWarning();
	await assertPasswordRemoval();
	await assertSystemdEnvBridge();
}

function requireDocker() {
	run("docker", ["version", "--format", "{{.Server.Version}}"], {
		capture: true,
		quiet: true,
		timeoutMs: 20_000
	});
}

function buildImage() {
	log(`building ${config.imageTag}`);
	const args = ["build", "-t", config.imageTag];
	if (config.noCache) args.push("--no-cache");
	args.push(".");
	docker(args, { timeoutMs: config.buildTimeoutMs });
}

function runDefaultContainer() {
	log("starting default container");
	docker(
		[
			"run",
			"-d",
			"--name",
			config.containerName,
			"-p",
			`127.0.0.1:${config.port}:${config.port}`,
			"-e",
			`PORT=${config.port}`,
			"-e",
			`COMPOSERY_PASSWORD=${config.password}`,
			"-v",
			`${config.volumeName}:/data`,
			config.imageTag
		],
		{ capture: true, quiet: true }
	);
}

function runSystemdContainer() {
	log("starting systemd container");
	docker(
		[
			"run",
			"-d",
			"--name",
			config.containerName,
			"--privileged",
			"--cgroupns=host",
			"--stop-signal",
			"SIGRTMIN+3",
			"--tmpfs",
			"/run",
			"--tmpfs",
			"/run/lock",
			"--tmpfs",
			"/tmp",
			"-v",
			"/sys/fs/cgroup:/sys/fs/cgroup:rw",
			"-p",
			`127.0.0.1:${config.port}:${config.port}`,
			"-e",
			"COMPOSERY_INIT=systemd",
			"-e",
			`PORT=${config.port}`,
			"-e",
			`COMPOSERY_PASSWORD=${config.password}`,
			"-e",
			"COMPOSERY_DISABLE_FILE_DOWNLOADS=true",
			"-v",
			`${config.volumeName}:/data`,
			config.imageTag
		],
		{ capture: true, quiet: true }
	);
}

async function assertSystemdEnvBridge() {
	if (config.skipSystemd) {
		log("skipping systemd init check (SMOKE_SKIP_SYSTEMD set)");
		return;
	}

	log("checking systemd init bridges deployment env to the IDE");

	// systemd (PID 1) gives services a clean env, so env reaches the IDE only via /run/composery.env + the unit's EnvironmentFile.
	cleanupResources();
	docker(["volume", "create", config.volumeName], { quiet: true });
	runSystemdContainer();

	await waitForExec('test "$(cat /proc/1/comm)" = systemd');
	await waitForHttp("/_composery/healthz", DEFAULT_ATTEMPTS.readiness);

	await waitForContainerFile("/run/composery.env");
	execSh("grep -q '^COMPOSERY_PASSWORD=' /run/composery.env");
	execSh(
		"grep -q '^COMPOSERY_DISABLE_FILE_DOWNLOADS=true$' /run/composery.env"
	);

	const cookies = new Map();
	await login(cookies);
	const idePage = await fetchAuthedText("/ide/", cookies);
	assertContains("systemd IDE page", idePage, "Composery");

	execSh("systemctl is-active ide");

	execSh("systemctl is-active cron");
	execSh("test -d /run/user/1000");
}

async function assertWebAppSmoke() {
	log("checking web app startup, auth, and Composery");
	await waitForHttp("/_composery/healthz", DEFAULT_ATTEMPTS.health);

	const root = await request("/");
	if (root.statusCode !== 308 || root.headers.location !== "/ide/") {
		throw new Error(
			`Expected / to redirect to /ide/ with HTTP 308, got ${root.statusCode} ${root.headers.location ?? ""}.`
		);
	}

	const cookies = new Map();
	await login(cookies);
	const idePage = await fetchAuthedText("/ide/", cookies);
	assertContains("default IDE page", idePage, "Composery");
	await assertIdeScope(idePage, cookies);
	await assertPortProxyAcceptsTheSession(cookies);
	await assertSignOutClearsTheSession(cookies);

	await assertWebsocketUpgrade(cookies);
	await assertIdeGatesWhenPersistenceNotReady(cookies);
	dockerExec(["sudo", "-u", "user", "sudo", "-n", "true"]);
	dockerExec(["sudo", "-u", "user", "code", "--version"], {
		capture: true,
		quiet: true
	});
	assertUserEnvironment();
	await assertClipboardBridge();
}

function assertUserEnvironment() {
	log("checking the user's shell environment behaves like a real VPS");

	const hasLocalBin =
		'case ":$PATH:" in *:/home/user/.local/bin:*) ;; *) exit 1 ;; esac';

	userBash(false, hasLocalBin);

	userBash(true, hasLocalBin);

	userBash(
		false,
		"test -w /usr/local/bin && test -w /usr/local/lib/node_modules"
	);

	userBash(
		false,
		'test "$XDG_RUNTIME_DIR" = /run/user/1000 && [ "$(stat -c "%U %a" "$XDG_RUNTIME_DIR")" = "user 700" ]'
	);

	userBash(false, "command -v crontab >/dev/null");
	execSh("pgrep -x cron >/dev/null");

	execSh("test -s /etc/machine-id");

	assertDeveloperToolchain();
}

// Each of these is a capability an owner reaches for on day one, and each fails
// quietly enough to survive a release: a compiler nobody invokes until an install
// script does, LFS filters that report success while writing pointer files, a
// Python that refuses to install anything. Exercise them, never just look them up.
function assertDeveloperToolchain() {
	log(
		"checking the developer toolchain works, not merely that it is installed"
	);

	userBash(
		false,
		'echo "int main(void){return 0;}" | cc -x c - -o /tmp/cc-probe'
	);

	// The apt package registers the LFS filters itself. Assert the filters, not the
	// binary: a git-lfs whose filters are missing checks out pointer files and
	// reports success.
	userBash(false, 'test -n "$(git config --system --get filter.lfs.smudge)"');

	userBash(
		false,
		"python3 -m venv /tmp/venv-probe && /tmp/venv-probe/bin/pip --version >/dev/null"
	);

	// Offline on purpose: pip refuses an externally managed environment before it
	// reaches the network, so this check needs no package index.
	userBash(false, "python3 -m pip --version >/dev/null");
	userBash(
		false,
		"! python3 -m pip install --user --no-index --no-deps composery-probe 2>&1 | grep -q externally-managed"
	);

	userBash(false, "command -v gpg rsync file lsof pipx vim >/dev/null");
}

function userBash(loginShell, script) {
	return docker(
		[
			"exec",
			"--user",
			"user",
			config.containerName,
			"bash",
			loginShell ? "-lc" : "-c",
			script
		],
		{ capture: true, quiet: true }
	);
}

async function assertClipboardBridge() {
	log("checking clipboard bridge shims and pipe commands");

	execSh(
		"for s in xclip xsel wl-paste wl-copy; do test -x /usr/local/bin/$s || exit 1; done"
	);

	execSh(
		"grep -q _remoteCLI.getClipboardImage /opt/composery/ide/current/lib/vscode/out/server-main.js && grep -q _remoteCLI.setClipboardImage /opt/composery/ide/current/lib/vscode/out/server-main.js"
	);

	const shimResult = execSh(
		"xclip -selection clipboard -t image/png -o; echo rc=$?",
		{ capture: true, quiet: true }
	).stdout.trim();
	if (shimResult !== "rc=1") {
		throw new Error(
			`Expected clipboard shim to degrade cleanly without a terminal pipe; got ${JSON.stringify(shimResult)}.`
		);
	}
}

async function assertIdeGatesWhenPersistenceNotReady(cookies) {
	log("checking IDE gates requests while persistence is not ready");
	const readyFile = execSh("cat /run/persistence/ready", {
		capture: true,
		quiet: true
	}).stdout;

	try {
		execSh("rm -f /run/persistence/ready");

		// Readiness gate caches state ~1s, so poll for the 503 instead of racing a still-warm cache.
		const health = await retry(
			"/_composery/healthz reports persistence not ready",
			15,
			async () => {
				const response = await request("/_composery/healthz", { cookies });
				if (response.statusCode !== 503) {
					throw new Error(
						`/_composery/healthz still HTTP ${response.statusCode}`
					);
				}
				return response;
			}
		);
		const healthJson = JSON.parse(health.body);
		if (healthJson.persistence?.ready !== false) {
			throw new Error(
				"Expected /_composery/healthz to report persistence.ready=false."
			);
		}

		const startup = await request("/ide/", {
			cookies,
			headers: { accept: "text/html" }
		});
		if (startup.statusCode !== 503) {
			throw new Error(
				`Expected HTML requests to return 503 without persistence ready; got HTTP ${startup.statusCode}.`
			);
		}
		assertContains("startup page", startup.body, "Preparing workspace");

		await assertWebsocketServiceUnavailable(cookies);
	} finally {
		execSh('printf "%s" "$1" > /run/persistence/ready', {
			args: [readyFile],
			quiet: true
		});
	}

	await waitForHttp("/_composery/healthz", DEFAULT_ATTEMPTS.health, {
		cookies
	});
	await assertWebsocketUpgrade(cookies);
}

async function assertApiSmoke() {
	log("checking the automation API: mint key, terminals, headers, revoke");

	const created = JSON.parse(
		execSh("composery api key create --name smoke --json", {
			capture: true,
			user: "user"
		}).stdout
	);
	if (
		typeof created.secret !== "string" ||
		!created.secret.startsWith("composery_")
	) {
		throw new Error(
			"composery api key create did not return a composery_ secret."
		);
	}
	const key = created.secret;

	const unauthorized = await request("/_composery/api/v1/terminals", {
		body: JSON.stringify({ command: "echo nope", wait: true }),
		headers: { "content-type": "application/json" },
		method: "POST"
	});
	if (unauthorized.statusCode !== 401) {
		throw new Error(
			`Expected 401 without a key, got ${unauthorized.statusCode}.`
		);
	}

	const marker = `composery-api-smoke-${RUN_ID}`;
	const terminalResponse = await request("/_composery/api/v1/terminals", {
		body: JSON.stringify({ command: `echo ${marker}`, wait: true }),
		headers: {
			authorization: `Bearer ${key}`,
			"content-type": "application/json"
		},
		method: "POST"
	});
	if (terminalResponse.statusCode !== 200) {
		throw new Error(
			`Expected 200 from a waited terminal, got ${terminalResponse.statusCode}.`
		);
	}
	const result = JSON.parse(terminalResponse.body);
	assertContains("terminal output", result.output, marker);
	if (result.exit_code !== 0) {
		throw new Error(`Expected exit_code 0, got ${result.exit_code}.`);
	}

	const viaApiKeyHeader = await request("/_composery/api/v1/terminals", {
		body: JSON.stringify({ command: "true", wait: true }),
		headers: { "content-type": "application/json", "x-api-key": key },
		method: "POST"
	});
	if (viaApiKeyHeader.statusCode !== 200) {
		throw new Error(
			`Expected 200 via X-API-Key, got ${viaApiKeyHeader.statusCode}.`
		);
	}

	const ptyMarker = `composery-pty-${RUN_ID}`;
	const ptyOutput = await runPtyOverWebsocket(
		key,
		`sleep 1 && echo ${ptyMarker}`
	);
	assertContains("PTY websocket output", ptyOutput, ptyMarker);

	const badKeyTerminal = await createApiTerminal(key, "sleep 5");
	const badKeyUpgrade = await ptyWebsocket(
		"composery_not-a-real-key",
		badKeyTerminal
	);
	if (badKeyUpgrade.status === 101) {
		throw new Error("PTY websocket upgraded with an invalid key.");
	}
	await request(`/_composery/api/v1/terminals/${badKeyTerminal}`, {
		headers: { authorization: `Bearer ${key}` },
		method: "DELETE"
	});

	// The socket streams an ordinary editor terminal; it does not own it. Dropping
	// the connection must stop the streaming and nothing else, or a command
	// started over HTTP could never be picked up in the editor afterwards. Prove
	// it from outside: detach while the command is still running and watch it
	// finish anyway. (docs/api.mdx makes this promise; nothing else checks it.)
	// The output volume is the point. The pty pauses once it is more than
	// FlowControlConstants.HighWatermarkChars (100,000) ahead of what has been
	// acknowledged, and with the socket gone there is no consumer left to do the
	// acknowledging - so a quiet command finishes whether or not that is handled
	// and proves nothing. `seq 1 50000` is a little under 300,000 characters.
	const detachedMarker = `/tmp/composery-detached-${RUN_ID}`;
	const detachedTerminal = await createApiTerminal(
		key,
		`sleep 3 && seq 1 50000 && touch ${detachedMarker}`
	);
	const detached = await ptyWebsocket(key, detachedTerminal, {
		detachOnUpgrade: true
	});
	if (detached.status !== 101) {
		throw new Error(
			`Expected the detached terminal to upgrade (101), got ${detached.status}.`
		);
	}
	await waitForContainerFile(detachedMarker);

	execSh(`composery api key revoke ${created.id}`, { user: "user" });
	const afterRevoke = await request("/_composery/api/v1/terminals", {
		body: JSON.stringify({ command: "true", wait: true }),
		headers: {
			authorization: `Bearer ${key}`,
			"content-type": "application/json"
		},
		method: "POST"
	});
	if (afterRevoke.statusCode !== 401) {
		throw new Error(
			`Expected 401 after revoke, got ${afterRevoke.statusCode}.`
		);
	}

	let throttled = false;
	for (let attempt = 0; attempt < 40 && !throttled; attempt += 1) {
		const response = await request("/_composery/api/v1/terminals", {
			body: JSON.stringify({ command: "true", wait: true }),
			headers: {
				authorization: "Bearer composery_definitely-not-a-real-key",
				"content-type": "application/json"
			},
			method: "POST"
		});
		if (response.statusCode === 429) throttled = true;
		else if (response.statusCode !== 401) {
			throw new Error(
				`Expected 401 or 429 from repeated bad-key attempts, got ${response.statusCode}.`
			);
		}
	}
	if (!throttled) {
		throw new Error(
			"Auth-fail rate limit never triggered after 40 bad-key attempts."
		);
	}

	log("API smoke passed");
}

async function assertPersistenceAppliesChanges() {
	log("checking persistence applies filesystem changes");

	log("checking persistence layout and command surface");
	await waitForExec("test -x /opt/composery/bin/composery");
	await waitForExec("command -v composery");
	await waitForExec("test -f /opt/persistence/baseline.sqlite");
	await waitForExec("test -f /data/persistence/.internal/state.sqlite");
	await waitForExec("test -f /run/persistence/ready");
	execSh("test ! -e /run/persistence/restore-failed");
	execSh("test ! -e /run/persistence/watch-failed");
	execSh(
		'composery persistence status --json | jq -e ".ready == true and .baselineValid == true"'
	);
	execSh(
		'composery persistence doctor --json | jq -e ".rebuiltPublicIndex == true"'
	);
	execSh(
		"composery persistence prune --json | jq -e '.removed | type == \"array\"'"
	);

	log("creating files that should be applied after restart");
	execSh("printf hello > /home/user/Desktop/smoke.txt", {
		user: "user"
	});
	execSh("printf restored > /custom-restore");
	execSh("mkdir -p /foo123 && printf nested > /foo123/nested.txt");

	log("waiting for persistence to record changed filesystem state");
	await waitForExec("test -f /data/persistence/config.json");
	await waitForExec("test -d /data/persistence/changed");
	await waitForExec("test -d /data/persistence/removed");
	await waitForExec("test -f /data/persistence/metadata.jsonl");
	await waitForExec("test -f /data/persistence/.internal/lock");
	await waitForContainerFile(
		"/data/persistence/changed/home/user/Desktop/smoke.txt"
	);
	await waitForContainerFile("/data/persistence/changed/custom-restore");
	await waitForContainerFile("/data/persistence/changed/foo123/nested.txt");

	log("restarting container and checking changed files are applied");
	restartContainer();
	await waitForHttp("/_composery/healthz", DEFAULT_ATTEMPTS.readiness);
	execSh('test "$(cat /home/user/Desktop/smoke.txt)" = hello');
	execSh('test "$(cat /custom-restore)" = restored');
	execSh("test -d /foo123");
	execSh('test "$(cat /foo123/nested.txt)" = nested');

	log("removing a file and checking the removal is applied");
	execSh("rm /custom-restore");
	await waitForContainerPathAbsent("/data/persistence/changed/custom-restore");
	restartContainer();
	await waitForHttp("/_composery/healthz", DEFAULT_ATTEMPTS.readiness);
	execSh("test ! -e /custom-restore");

	log(
		"recreating container with the same volume and checking changes are applied"
	);
	docker(["rm", "-f", config.containerName], { capture: true, quiet: true });
	runDefaultContainer();
	await waitForHttp("/_composery/healthz", DEFAULT_ATTEMPTS.readiness);
	execSh('test "$(cat /home/user/Desktop/smoke.txt)" = hello');
	execSh("test -d /foo123");

	log("checking image-file deletion and tombstone removal");
	execSh("rm /usr/share/applications/composery-text-editor.desktop");
	await waitForContainerFile(
		"/data/persistence/removed/usr/share/applications/composery-text-editor.desktop"
	);
	docker(["rm", "-f", config.containerName], { capture: true, quiet: true });
	runDefaultContainer();
	await waitForHttp("/_composery/healthz", DEFAULT_ATTEMPTS.readiness);
	execSh("test ! -e /usr/share/applications/composery-text-editor.desktop");
	docker(["rm", "-f", config.containerName], { capture: true, quiet: true });
	runWithDataVolume(
		"rm -f /data/persistence/removed/usr/share/applications/composery-text-editor.desktop"
	);
	runDefaultContainer();
	await waitForHttp("/_composery/healthz", DEFAULT_ATTEMPTS.readiness);
	execSh("test -f /usr/share/applications/composery-text-editor.desktop");

	log("checking baseline-equal changes do not remain in changed");
	execSh(
		"cp /etc/mailcap /tmp/mailcap.baseline && printf changed > /etc/mailcap"
	);
	await waitForExec("test -e /data/persistence/changed/etc/mailcap");
	execSh("cat /tmp/mailcap.baseline > /etc/mailcap");
	await waitForContainerPathAbsent("/data/persistence/changed/etc/mailcap");

	log("checking touched large baseline file does not create changed payload");
	const large = execSh(
		"find /opt/composery/ide/current -xdev -type f -size +1M | head -n1",
		{ capture: true, quiet: true }
	).stdout.trim();
	if (!large) throw new Error("No large baseline file found for smoke check.");
	execSh('touch "$1"', { args: [large] });
	await assertContainerPathStaysAbsent(
		`/data/persistence/changed/${large.replace(/^\//, "")}`,
		5
	);

	log("checking custom exclusions are ignored and not pruned");
	execSh(
		'tmp="$(mktemp)"; jq \'.exclude += ["/excluded-smoke"]\' /data/persistence/config.json > "$tmp"; mv "$tmp" /data/persistence/config.json'
	);
	restartContainer();
	await waitForHttp("/_composery/healthz", DEFAULT_ATTEMPTS.readiness);
	execSh("mkdir -p /excluded-smoke && printf ignored > /excluded-smoke/file");
	await assertContainerPathStaysAbsent(
		"/data/persistence/changed/excluded-smoke/file",
		5
	);
	execSh(
		"mkdir -p /data/persistence/changed/excluded-smoke /data/persistence/removed/excluded-smoke && printf dormant > /data/persistence/changed/excluded-smoke/dormant && : > /data/persistence/removed/excluded-smoke/tombstone"
	);
	dockerExec(["composery", "persistence", "prune", "--json"], {
		capture: true,
		quiet: true
	});
	execSh("test -f /data/persistence/changed/excluded-smoke/dormant");
	execSh("test -f /data/persistence/removed/excluded-smoke/tombstone");
}

function assertVolumeMountWarning() {
	log("checking the unmounted-volume warning stays quiet on a real volume");

	// This container has a volume on /data, so the warning firing here would mean
	// the device comparison is inverted and every deploy gets a false alarm.
	const logs = docker(["logs", config.containerName], {
		capture: true,
		quiet: true
	});
	const output = `${logs.stdout}${logs.stderr}`;
	if (output.includes("no volume is mounted at")) {
		throw new Error(
			"Entrypoint warned about an unmounted volume while /data was a mounted volume."
		);
	}
}

async function assertPasswordRemoval() {
	log("checking the password removal toggle");

	// A throwaway root shell on the real image and volume: the boot script is
	// run directly against a scratch config so the live one keeps its password.
	runWithDataVolume(
		[
			"set -e",
			"cfg=/data/smoke-remove-password.yaml",
			"remove=/opt/composery/remove-password.sh",
			'write_config() { printf \'auth: password\\nhashed-password: $argon2i$v=19$m=4096,t=3,p=1$c29tZXNhbHQ$%s\\n\' "$1" > "$cfg"; }',
			// A registered password is removed, and nothing else in the config is.
			"write_config first",
			'COMPOSERY_CONFIG="$cfg" COMPOSERY_REMOVE_PASSWORD=true "$remove"',
			"grep -q '^auth: password$' \"$cfg\"",
			'! grep -q hashed-password "$cfg"',
			// Every boot, not once: a password registered since is removed again.
			// Accepted spellings are trimmed and case-insensitive.
			'for on in 1 true TRUE " true "; do write_config again; COMPOSERY_CONFIG="$cfg" COMPOSERY_REMOVE_PASSWORD="$on" "$remove"; ! grep -q hashed-password "$cfg"; done',
			// Off, and anything unrecognised, must fail safe and keep the password.
			'for off in 0 false FALSE no "" nonsense "t rue"; do write_config keep; COMPOSERY_CONFIG="$cfg" COMPOSERY_REMOVE_PASSWORD="$off" "$remove"; grep -q hashed-password "$cfg"; done',
			// Unset behaves like off.
			"write_config unset",
			'COMPOSERY_CONFIG="$cfg" "$remove"',
			'grep -q hashed-password "$cfg"',
			'rm -f "$cfg"'
		].join("\n")
	);
}

async function login(cookies) {
	const loginPage = await waitForHttp(
		"/ide/login",
		DEFAULT_ATTEMPTS.readiness,
		{
			cookies
		}
	);
	storeCookies(cookies, loginPage.headers["set-cookie"]);

	const body = new URLSearchParams({
		password: config.password
	}).toString();

	const response = await request("/ide/login", {
		body,
		cookies,
		headers: {
			"content-length": Buffer.byteLength(body).toString(),
			"content-type": "application/x-www-form-urlencoded"
		},
		method: "POST"
	});
	storeCookies(cookies, response.headers["set-cookie"]);
	if (!isHttpSuccess(response)) {
		throw new Error(`Login failed with HTTP ${response.statusCode}.`);
	}
	assertSessionCookieScope(response.headers["set-cookie"]);
}

// The one thing the cookie jar above cannot check for itself: it replays every
// cookie everywhere, while a browser obeys Path. Scoping the session to the
// workbench mount kept it away from /proxy and /absproxy - which this same
// server authenticates with it - and left Sign Out unable to clear a cookie
// Composery sign-in had set at a different path.
function assertSessionCookieScope(setCookie) {
	const session = (Array.isArray(setCookie) ? setCookie : [setCookie]).find(
		(value) => value?.startsWith("composery-session=")
	);
	if (!session) {
		throw new Error("Sign-in did not set a session cookie.");
	}
	const attributes = session
		.split(";")
		.slice(1)
		.map((part) => part.trim().toLowerCase());
	if (!attributes.includes("path=/")) {
		throw new Error(
			`Expected the session cookie at Path=/, got ${session.split(";").slice(1).join(";")}.`
		);
	}
	if (!attributes.includes("httponly")) {
		throw new Error("Expected the session cookie to be HttpOnly.");
	}
	if (attributes.some((attribute) => attribute.startsWith("domain="))) {
		throw new Error(
			"Expected a host-only session cookie; Domain widens it to every sibling host."
		);
	}
}

async function assertPortProxyAcceptsTheSession(cookies) {
	// Port 9 (discard) has nothing listening, so a signed-in request gets as far
	// as a failed connection - anything but the sign-in redirect an unauthorized
	// one gets. That difference is the whole check: the proxy is mounted above
	// the workbench, so it only works while the session cookie reaches it.
	const anonymous = await request("/proxy/9/");
	if (anonymous.statusCode !== 302) {
		throw new Error(
			`Expected /proxy/9/ to redirect an anonymous request, got ${anonymous.statusCode}.`
		);
	}
	const authorized = await request("/proxy/9/", { cookies });
	if (authorized.statusCode === 302) {
		throw new Error(
			"Expected /proxy/9/ to accept the IDE session, got a sign-in redirect."
		);
	}
}

async function assertSignOutClearsTheSession(cookies) {
	const response = await request("/ide/logout", { cookies });
	const cleared = (response.headers["set-cookie"] ?? []).find((value) =>
		value.startsWith("composery-session=;")
	);
	if (!cleared) {
		throw new Error("Sign Out did not clear the session cookie.");
	}
	// Identical scope, or the browser keeps the original cookie alongside it.
	if (!cleared.toLowerCase().includes("path=/;")) {
		throw new Error(
			`Sign Out cleared a differently scoped cookie: ${cleared}.`
		);
	}
	const after = new Map(cookies);
	storeCookies(after, response.headers["set-cookie"]);
	const workbench = await request("/ide/", { cookies: after });
	if (workbench.statusCode !== 302) {
		throw new Error(
			`Expected the workbench to ask for sign-in after Sign Out, got ${workbench.statusCode}.`
		);
	}
}

async function assertIdeScope(idePage, cookies) {
	const baseUrl = `http://127.0.0.1:${config.port}`;
	const manifestResponse = await request("/ide/manifest.json", { cookies });
	if (manifestResponse.statusCode !== 200) {
		throw new Error(
			`Expected /ide/manifest.json to return 200, got ${manifestResponse.statusCode}.`
		);
	}
	const manifest = JSON.parse(manifestResponse.body);
	if (manifest.start_url !== ".") {
		throw new Error(
			`Expected manifest start_url ".", got ${manifest.start_url}.`
		);
	}
	const manifestScope = new URL(
		manifest.start_url,
		`${baseUrl}/ide/manifest.json`
	);
	if (manifestScope.pathname !== "/ide/") {
		throw new Error(`Manifest resolved outside /ide/: ${manifestScope.href}.`);
	}
	if (
		new URL("/proxy/3000/", baseUrl).pathname.startsWith(manifestScope.pathname)
	) {
		throw new Error("Root port proxy is inside the PWA manifest scope.");
	}

	assertContains(
		"workbench service-worker scope",
		idePage,
		"&quot;scope&quot;:&quot;./&quot;"
	);
	assertContains(
		"root port-proxy template",
		idePage,
		"&quot;proxyEndpointTemplate&quot;:&quot;/proxy/{{port}}/&quot;"
	);
	const workerScope = new URL("./", `${baseUrl}/ide/`);
	if (workerScope.pathname !== "/ide/") {
		throw new Error(
			`Service worker resolved outside /ide/: ${workerScope.href}.`
		);
	}
	const worker = await request("/ide/_static/out/browser/serviceWorker.js", {
		cookies
	});
	if (worker.headers["service-worker-allowed"] !== "/ide/") {
		throw new Error(
			`Expected Service-Worker-Allowed /ide/, got ${worker.headers["service-worker-allowed"] ?? "missing"}.`
		);
	}
}

async function fetchAuthedText(path, cookies) {
	const response = await waitForHttp(path, DEFAULT_ATTEMPTS.readiness, {
		cookies
	});
	return response.body;
}

async function waitForHttp(path, attempts, options = {}) {
	return retry(`fetch ${path}`, attempts, async () => {
		const response = await requestFollow(path, options);
		if (isHttpSuccess(response)) return response;
		throw new Error(`HTTP ${response.statusCode} from ${path}.`);
	});
}

async function requestFollow(path, options = {}, redirects = 5) {
	const response = await request(path, options);
	storeCookies(options.cookies, response.headers["set-cookie"]);
	const location = response.headers.location;
	if (
		response.statusCode >= 300 &&
		response.statusCode < 400 &&
		location &&
		redirects > 0
	) {
		const next = new URL(location, `http://127.0.0.1:${config.port}${path}`);
		const base = `http://127.0.0.1:${config.port}`;
		if (next.origin !== base) {
			throw new Error(`Refusing smoke redirect to ${next.href}.`);
		}
		const headers = { ...(options.headers ?? {}) };
		delete headers["content-length"];
		delete headers["content-type"];
		return requestFollow(
			`${next.pathname}${next.search}`,
			{
				...options,
				body: undefined,
				headers,
				method: "GET"
			},
			redirects - 1
		);
	}
	return response;
}

function request(path, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const headers = { ...(options.headers ?? {}) };
		const cookie = cookieHeader(options.cookies);
		if (cookie) headers.cookie = cookie;

		const requestOptions = {
			headers,
			host: "127.0.0.1",
			method: options.method ?? "GET",
			path,
			port: config.port,
			timeout: 5000
		};

		const clientRequest = http.request(requestOptions, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => {
				resolvePromise({
					body: Buffer.concat(chunks).toString("utf8"),
					headers: response.headers,
					statusCode: response.statusCode ?? 0
				});
			});
		});

		clientRequest.on("error", reject);
		clientRequest.on("timeout", () => {
			clientRequest.destroy(new Error(`Timed out fetching ${path}.`));
		});

		if (options.body) clientRequest.write(options.body);
		clientRequest.end();
	});
}

async function assertWebsocketUpgrade(cookies) {
	const { expected, headers, status } = await websocketHandshake(cookies);

	if (!status.startsWith("HTTP/1.1 101")) {
		throw new Error(`Unexpected websocket status: ${status}`);
	}
	if (headers.upgrade?.toLowerCase() !== "websocket") {
		throw new Error("Missing websocket upgrade header.");
	}
	const connection = headers.connection ?? "";
	if (
		!connection
			.split(",")
			.map((value) => value.trim().toLowerCase())
			.includes("upgrade")
	) {
		throw new Error("Missing websocket connection upgrade header.");
	}
	if (headers["sec-websocket-accept"] !== expected) {
		throw new Error("Unexpected websocket accept header.");
	}
}

async function assertWebsocketServiceUnavailable(cookies) {
	const { status } = await websocketHandshake(cookies);
	if (!status.startsWith("HTTP/1.1 503")) {
		throw new Error(`Expected websocket 503 while not ready; got ${status}.`);
	}
}

function websocketHandshake(cookies) {
	return new Promise((resolvePromise, reject) => {
		const key = randomBytes(16).toString("base64");
		const expected = createHash("sha1")
			.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64");
		const requestText = [
			"GET /ide/websocket-smoke HTTP/1.1",
			`Host: 127.0.0.1:${config.port}`,
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Cookie: ${cookieHeader(cookies)}`,
			`Sec-WebSocket-Key: ${key}`,
			"Sec-WebSocket-Version: 13",
			"",
			""
		].join("\r\n");
		let response = "";
		const socket = net.createConnection(
			{ host: "127.0.0.1", port: config.port },
			() => socket.write(requestText, "ascii")
		);

		socket.setTimeout(5000);
		socket.on("data", (chunk) => {
			response += chunk.toString("latin1");
			if (response.includes("\r\n\r\n")) {
				socket.end();
				try {
					const parsed = parseHttpHeaders(response);
					resolvePromise({ ...parsed, expected });
				} catch (error) {
					reject(error);
				}
			}
		});
		socket.on("error", reject);
		socket.on("timeout", () => {
			socket.destroy();
			reject(new Error("Timed out waiting for websocket upgrade."));
		});
	});
}

function parseHttpHeaders(response) {
	const lines = response.split("\r\n");
	const headers = {};
	for (const line of lines.slice(1)) {
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		headers[line.slice(0, separator).trim().toLowerCase()] = line
			.slice(separator + 1)
			.trim();
	}
	return { headers, status: lines[0] ?? "" };
}

async function createApiTerminal(key, command) {
	const response = await request("/_composery/api/v1/terminals", {
		body: JSON.stringify({ command }),
		headers: {
			authorization: `Bearer ${key}`,
			"content-type": "application/json"
		},
		method: "POST"
	});
	if (response.statusCode !== 201) {
		throw new Error(
			`Expected terminal creation to return 201, got ${response.statusCode}.`
		);
	}
	const terminal = JSON.parse(response.body);
	if (!Number.isSafeInteger(terminal.id)) {
		throw new Error("Terminal creation did not return a numeric id.");
	}
	return terminal.id;
}

async function runPtyOverWebsocket(key, command) {
	const id = await createApiTerminal(key, command);
	const { status, output } = await ptyWebsocket(key, id);
	if (status !== 101) {
		throw new Error(`Expected PTY websocket to upgrade (101), got ${status}.`);
	}
	return output;
}

// Minimal RFC 6455 client: manual frame decode of the server's unmasked
// text/binary frames. `detachOnUpgrade` hangs up the moment the upgrade lands,
// leaving the terminal running with nobody reading it.
function ptyWebsocket(key, id, { detachOnUpgrade = false } = {}) {
	return new Promise((resolvePromise, reject) => {
		const handshake = [
			`GET /_composery/api/v1/terminals/${id} HTTP/1.1`,
			`Host: 127.0.0.1:${config.port}`,
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Authorization: Bearer ${key}`,
			`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
			"Sec-WebSocket-Version: 13",
			"Sec-WebSocket-Protocol: composery-terminal-v1",
			"",
			""
		].join("\r\n");

		const socket = net.createConnection(
			{ host: "127.0.0.1", port: config.port },
			() => socket.write(handshake, "ascii")
		);
		socket.setTimeout(15_000);

		let buffer = Buffer.alloc(0);
		let upgraded = false;
		let output = "";

		const finish = (status) => {
			socket.end();
			resolvePromise({ status, output });
		};

		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (!upgraded) {
				const separator = buffer.indexOf("\r\n\r\n");
				if (separator === -1) return;
				const head = buffer.slice(0, separator).toString("latin1");
				const status = Number(head.split(" ")[1]) || 0;
				if (status !== 101) {
					finish(status);
					return;
				}
				const { headers } = parseHttpHeaders(head);
				if (headers["sec-websocket-protocol"] !== "composery-terminal-v1") {
					socket.destroy();
					reject(new Error("PTY websocket did not select its protocol."));
					return;
				}
				upgraded = true;
				buffer = buffer.slice(separator + 4);
				if (detachOnUpgrade) {
					socket.destroy();
					resolvePromise({ status: 101, output });
					return;
				}
			}
			while (buffer.length >= 2) {
				const opcode = buffer[0] & 0x0f;
				let length = buffer[1] & 0x7f;
				let offset = 2;
				if (length === 126) {
					if (buffer.length < 4) break;
					length = buffer.readUInt16BE(2);
					offset = 4;
				} else if (length === 127) {
					if (buffer.length < 10) break;
					length = Number(buffer.readBigUInt64BE(2));
					offset = 10;
				}
				if (buffer.length < offset + length) break;
				const payload = buffer.slice(offset, offset + length);
				buffer = buffer.slice(offset + length);
				if (opcode === 0x8) {
					finish(101);
					return;
				}
				output += payload.toString("utf8");
				if (output.includes('"exit"')) {
					finish(101);
					return;
				}
			}
		});

		socket.on("error", reject);
		socket.on("timeout", () => {
			socket.destroy();
			reject(new Error("PTY websocket timed out."));
		});
		socket.on("close", () =>
			resolvePromise({ status: upgraded ? 101 : 0, output })
		);
	});
}

async function waitForExec(script, args = []) {
	await retry(`exec ${script}`, DEFAULT_ATTEMPTS.exec, async () => {
		const result = execSh(script, {
			args,
			check: false,
			quiet: true
		});
		if (result.status === 0) return true;
		throw new Error(`Command failed in container: ${script}`);
	});
}

function waitForContainerFile(path) {
	return waitForExec('test -f "$1"', [path]);
}

function waitForContainerPathAbsent(path) {
	return waitForExec('test ! -e "$1"', [path]);
}

async function assertContainerPathStaysAbsent(path, seconds) {
	for (let second = 0; second < seconds; second += 1) {
		assertContainerRunning();
		execSh('test ! -e "$1"', { args: [path], quiet: true });
		await sleep(1000);
	}
}

async function retry(label, attempts, fn) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			assertContainerRunning();
			return await fn();
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

function restartContainer() {
	docker(["restart", config.containerName], { capture: true, quiet: true });
}

function runWithDataVolume(script) {
	docker(
		[
			"run",
			"--rm",
			"-v",
			`${config.volumeName}:/data`,
			"--entrypoint",
			"sh",
			config.imageTag,
			"-lc",
			script
		],
		{ capture: true, quiet: true }
	);
}

function dockerExec(args, options = {}) {
	return docker(["exec", config.containerName, ...args], options);
}

function execSh(script, options = {}) {
	const args = ["exec"];
	if (options.user) args.push("--user", options.user);
	args.push(config.containerName, "sh", "-lc", script, "sh");
	if (options.args) args.push(...options.args);
	return docker(args, options);
}

function assertContainerRunning() {
	const result = docker(
		["inspect", "-f", "{{.State.Running}}", config.containerName],
		{
			capture: true,
			check: false,
			quiet: true
		}
	);
	if (result.status !== 0 || result.stdout.trim() !== "true") {
		throw new Error(`Container ${config.containerName} is not running.`);
	}
}

function docker(args, options = {}) {
	return run("docker", args, options);
}

function run(command, args, options = {}) {
	if (!options.quiet) logCommand(command, args);
	const result = spawnSync(command, args, {
		cwd: REPO_ROOT,
		encoding: "utf8",
		stdio: options.capture ? "pipe" : "inherit",
		timeout:
			options.timeoutMs === null ? undefined : (options.timeoutMs ?? 120_000)
	});
	if (result.error) throw result.error;
	if (options.check !== false && result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed with exit code ${
				result.status ?? "unknown"
			}.`
		);
	}
	return {
		status: result.status ?? 1,
		stderr: result.stderr ?? "",
		stdout: result.stdout ?? ""
	};
}

function cleanupResources() {
	docker(["rm", "-f", config.containerName], {
		capture: true,
		check: false,
		quiet: true
	});
	docker(["volume", "rm", config.volumeName], {
		capture: true,
		check: false,
		quiet: true
	});
}

function dumpContainerLogs() {
	if (failureDumped) return;
	failureDumped = true;
	try {
		run("docker", ["ps", "-a"], { check: false, quiet: true });
		run("docker", ["logs", config.containerName], {
			check: false,
			quiet: true
		});
		dumpPersistenceDiagnostics();
	} catch {
		// Keep the original error when Docker itself is unavailable.
	}
}

function dumpPersistenceDiagnostics() {
	dockerExec(["composery", "persistence", "status", "--json"], {
		check: false
	});
	dockerExec(
		[
			"sh",
			"-lc",
			'for file in /data/persistence/.internal/apply-error.log /data/persistence/.internal/watch-error.log; do if [ -f "$file" ]; then echo "== $file =="; cat "$file"; fi; done'
		],
		{ check: false }
	);
}

function stopFromSignal(signal, exitCode) {
	console.error(`Received ${signal}; cleaning up smoke resources.`);
	cleanupResources();
	process.exit(exitCode);
}

function cookieHeader(cookies) {
	if (!cookies || cookies.size === 0) return "";
	return [...cookies.entries()]
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

function storeCookies(cookies, values) {
	if (!cookies || !values) return;
	for (const value of Array.isArray(values) ? values : [values]) {
		const pair = value.split(";", 1)[0];
		const separator = pair.indexOf("=");
		if (separator === -1) continue;
		cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
	}
}

function isHttpSuccess(response) {
	return response.statusCode >= 200 && response.statusCode < 400;
}

function assertContains(label, haystack, needle) {
	if (!haystack.toLowerCase().includes(needle.toLowerCase())) {
		throw new Error(`Expected ${label} to contain ${needle}.`);
	}
}

function parseBoolean(value) {
	return value === "1" || value === "true";
}

function parseOptionalTimeout(value) {
	if (value === undefined || value === "") return null;
	const timeout = Number(value);
	if (!Number.isSafeInteger(timeout) || timeout < 1) {
		throw new Error(`Invalid smoke build timeout: ${value}`);
	}
	return timeout;
}

function parsePort(value) {
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid smoke port: ${value}`);
	}
	return port;
}

function log(message) {
	console.log(`[smoke] ${message}`);
}

function logCommand(command, args) {
	console.log(`\n$ ${[command, ...args].map(formatArg).join(" ")}`);
}

function formatArg(arg) {
	if (/^[A-Za-z0-9_./:@=-]+$/.test(arg)) return arg;
	return JSON.stringify(arg);
}
