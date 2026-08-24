import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { readRepoFile, repoRoot } from "../support/repo.ts";

// A shell script with its comment lines removed, for assertions about what a
// script *does* and in what order. These scripts explain themselves at length,
// so matching the raw text lets a comment satisfy a requirement the code never
// implements, and lets a step named in the comment above a command appear to
// run before it. Both happened here.
function readShellCode(path: string): string {
	return readRepoFile(path)
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
}

const BINARY = new Set([".ico", ".png", ".sqlite", ".svg", ".webm", ".woff2"]);

// Every COMPOSERY_* name mentioned anywhere under the given repo paths.
function envNamesUnder(paths: string[]): Set<string> {
	const names = new Set<string>();
	const visit = (path: string): void => {
		if (statSync(path).isDirectory()) {
			for (const entry of readdirSync(path).sort()) visit(join(path, entry));
			return;
		}
		if (BINARY.has(extname(path))) return;
		for (const match of readFileSync(path, "utf8").matchAll(
			/COMPOSERY_[A-Z_]+/g
		))
			names.add(match[0]);
	};
	for (const path of paths) visit(resolve(repoRoot, path));
	return names;
}

describe("runtime process managers", () => {
	test("names the IDE service after the process it runs", () => {
		const ideServicePath = resolve(
			repoRoot,
			"rootfs/usr/lib/systemd/system/ide.service"
		);
		const oldServicePath = resolve(
			repoRoot,
			"rootfs/etc/systemd/system/composery.service"
		);
		const ideService = readFileSync(ideServicePath, "utf8");
		const persistenceService = readRepoFile(
			"rootfs/usr/lib/systemd/system/persistence.service"
		);
		const dockerfile = readRepoFile("Dockerfile");

		expect(existsSync(ideServicePath)).toBe(true);
		expect(existsSync(oldServicePath)).toBe(false);
		expect(ideService).toContain("Description=Composery IDE");
		expect(ideService).toContain("ExecStart=/opt/composery/ide.sh");
		expect(persistenceService).toContain("Before=ide.service");
		expect(dockerfile).toContain(
			"/usr/lib/systemd/system/ide.service /etc/systemd/system/multi-user.target.wants/ide.service"
		);
		expect(dockerfile).not.toContain("composery.service");
	});

	test("provides the standard local supervisorctl interface", () => {
		const config = readRepoFile("rootfs/etc/supervisor/supervisord.conf");

		expect(config).toContain("[unix_http_server]");
		expect(config).toContain("file=/run/supervisor.sock");
		expect(config).toContain("[rpcinterface:supervisor]");
		expect(config).toContain("[supervisorctl]");
		expect(config).toContain("serverurl=unix:///run/supervisor.sock");
	});

	// Docker restart policies only react when PID 1 exits; an unhealthy container
	// otherwise stays unhealthy for ever. The watchdog deliberately exits only a
	// runtime that served earlier, so a bad startup cannot become a restart loop.
	test("restarts a failed running runtime without looping a failed boot", () => {
		const supervisor = readRepoFile(
			"rootfs/etc/supervisor/conf.d/composery.conf"
		);
		const watchdog = readShellCode("rootfs/opt/composery/watchdog.sh");
		const artifacts = readRepoFile(
			"packages/web/convex/boxes/infra/artifacts.ts"
		);

		expect(supervisor).toContain("[program:watchdog]");
		expect(watchdog).toContain("was_healthy=false");
		expect(watchdog).toContain('if [ "$was_healthy" = false ]');
		expect(watchdog.indexOf('if [ "$was_healthy" = false ]')).toBeLessThan(
			watchdog.indexOf("kill -TERM 1")
		);
		expect(watchdog).toContain('if [ "$failures" -lt 3 ]');
		// The systemd profile is the cloud path, and systemd PID 1 re-execs on
		// SIGTERM instead of stopping, so its stop is the manager's own exit.
		// Both stops must sit after the never-healthy guard like the SIGTERM one.
		expect(watchdog).toContain("systemctl exit");
		expect(watchdog.indexOf('if [ "$was_healthy" = false ]')).toBeLessThan(
			watchdog.indexOf("systemctl exit")
		);
		expect(
			readRepoFile("rootfs/usr/lib/systemd/system/composery-watchdog.service")
		).toContain("ExecStart=/opt/composery/watchdog.sh");
		expect(readRepoFile("Dockerfile")).toContain("composery-watchdog.service");
		expect(artifacts).toContain("restart: always");
		expect(artifacts).toContain("init: true");
		expect(artifacts).not.toContain("cgroup: host");
		expect(artifacts).not.toContain("/sys/fs/cgroup:/sys/fs/cgroup");
	});

	test("keeps the outer Caddy version identical across hosted and self-hosted recipes", () => {
		const image =
			"caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648";

		for (const path of [
			"Dockerfile",
			"packages/web/convex/boxes/infra/artifacts.ts",
			"templates/systemd-caddy-compose/compose.yaml",
			"templates/supervisor-caddy-compose/compose.yaml"
		]) {
			expect(readRepoFile(path), path).toContain(image);
		}
	});

	test("runs the standard user-owned Caddyfile in both runtime profiles", () => {
		const caddyfile = readRepoFile("rootfs/etc/caddy/Caddyfile");
		const ide = readRepoFile("rootfs/opt/composery/ide.sh");
		const systemd = readRepoFile("rootfs/usr/lib/systemd/system/caddy.service");
		const supervisor = readRepoFile(
			"rootfs/etc/supervisor/conf.d/composery.conf"
		);

		expect(ide).toContain("127.0.0.1:${COMPOSERY_IDE_PORT:-8081}");
		expect(ide).toContain("unset PORT COMPOSERY_HOST");
		expect(caddyfile).toContain("handle_path /ide/*");
		expect(caddyfile).toContain("handle /_composery/healthz*");
		expect(caddyfile).toContain("handle /_composery/api/v1/*");
		expect(caddyfile).toContain("@outside_ide path /ide/proxy");
		expect(caddyfile).not.toContain("import ");
		expect(systemd).toContain(
			"ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile"
		);
		expect(systemd).toContain(
			"ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile"
		);
		expect(supervisor).toContain("[program:caddy]");
		expect(supervisor).toContain(
			"command=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile"
		);
	});

	test("reserves only the permanent Composery control namespace", () => {
		const apiPath = readRepoFile(
			"packages/ide/overlay/src/node/routes/api/constants.ts"
		);
		const apiPatch = readRepoFile("packages/ide/patches/api.diff");
		const readinessPatch = readRepoFile("packages/ide/patches/readiness.diff");

		expect(apiPath).toContain('"/_composery/api/v1"');
		expect(readinessPatch).toContain(
			'app.router.use("/_composery/healthz", health.router)'
		);
		expect(apiPath).not.toContain('"/v1"');
		expect(apiPatch).not.toContain('app.router.get("/_composery"');
		expect(readinessPatch).not.toContain('+  app.router.use("/healthz"');
	});

	test("uses Host instead of client-controlled forwarded host headers", () => {
		const hostPatch = readRepoFile(
			"packages/ide/patches/request-host-trust.diff"
		);

		expect(hostPatch).toContain(
			'+  const [host] = splitOnFirstEquals(getFirstHeader(req, "host") || "")'
		);
		expect(hostPatch).toContain(
			'-  const forwardedRaw = getFirstHeader(req, "forwarded")'
		);
		expect(hostPatch).toContain(
			'-  const xHost = getFirstHeader(req, "x-forwarded-host")'
		);
	});

	test("makes the direct durable volume an ordinary user disk", () => {
		const entrypoint = readRepoFile("rootfs/opt/composery/entrypoint.sh");

		expect(entrypoint).toContain(
			'volume_root="${COMPOSERY_DOCKER_VOLUME_PATH:-/data}"'
		);
		expect(entrypoint).toContain('chown user:user "$volume_root"');
		expect(entrypoint).toContain(
			'install -d -m 0700 -o user -g user "$volume_root/api"'
		);
		// Devices, not mountpoints: a volume root inside a mount is still durable.
		expect(entrypoint).toContain(
			'if [ "$(stat -c %d "$volume_root")" = "$(stat -c %d /)" ]; then'
		);
	});

	// The rotation itself is checked by booting real containers
	// (`tests/system/identity/run.sh`), which is the only thing that can say the
	// inventory is complete. What is pinned here is the *placement*, because
	// placement is what makes the rotation load-bearing and no runtime assertion
	// can see it: a rotation that runs after sshd starts has already lost.
	test("rotates instance identity before anything can serve on the copied disk", () => {
		const entrypoint = readShellCode("rootfs/opt/composery/entrypoint.sh");
		const identity = readShellCode("rootfs/opt/composery/identity.sh");

		expect(entrypoint).toContain("/opt/composery/identity.sh apply");

		// Before the machine-id block, which is what regenerates what it truncates.
		expect(entrypoint.indexOf("/opt/composery/identity.sh apply")).toBeLessThan(
			entrypoint.indexOf("/proc/sys/kernel/random/uuid")
		);
		// Before either init system starts, which is when sshd first accepts a
		// connection - on a copied disk, under the source instance's CA.
		for (const start of [
			"/opt/composery/init/supervisor.sh",
			"/opt/composery/init/systemd.sh",
			"/opt/composery/ssh.sh install-keys"
		]) {
			expect(
				entrypoint.indexOf("/opt/composery/identity.sh apply")
			).toBeLessThan(entrypoint.indexOf(start));
		}

		// Disagreement is the whole trigger, and an unreadable record must rotate
		// rather than skip - the rotation is the protection, so an unknown state
		// fails towards performing it.
		expect(identity).toContain(
			"current_identity() {\n\tprintf '%s' \"${COMPOSERY_CLOUD_BOX_ID:-${SELF_HOSTED}}\""
		);
		expect(identity).toContain('if [ -z "${recorded}" ]; then');
		expect(identity).toContain('if [ "${recorded}" = "${current}" ]; then');

		// COMPOSERY_CLOUD_BOX_ID is only trustworthy as a trigger because an owner
		// cannot set it. That is enforced in the web plane, so this is the second
		// copy of the fact and has to name the first.
		expect(
			readRepoFile("packages/web/convex/boxes/infra/artifacts.ts")
		).toContain('"COMPOSERY_CLOUD_BOX_ID"');

		// Every script under /opt/composery is made executable by a glob rather
		// than an enumerated list. A new script missing from a list would ship
		// non-executable and fail only at boot.
		expect(readRepoFile("Dockerfile")).toContain(
			"chmod +x /opt/composery/*.sh /opt/composery/init/*.sh"
		);
	});

	// systemd accumulates ExecStartPre across a drop-in rather than replacing it,
	// so a drop-in that forgets the empty assignment silently inherits the base
	// unit's `sshd -t` *before* the step that generates the host keys. The image
	// ships no host keys by design, so that ordering meant sshd never started on a
	// first boot under the systemd profile - invisible on cloud, which defaults to
	// supervisor, and fatal for the systemd templates.
	//
	// Pinned here for the same reason as the rotation placement: no runtime
	// assertion can see an inherited list, because the symptom is a service that
	// does not start rather than a value that is wrong.
	test("resets sshd's inherited ExecStartPre so keys exist before the config check", () => {
		const dropIn = readShellCode(
			"rootfs/etc/systemd/system/ssh.service.d/composery.conf"
		);
		const lines = dropIn
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("ExecStartPre"));

		// The reset comes first, or everything after it is appended to Debian's list
		// instead of replacing it.
		expect(lines[0]).toBe("ExecStartPre=");
		// Keys before the validation that reads them.
		expect(lines).toEqual([
			"ExecStartPre=",
			"ExecStartPre=/opt/composery/ssh.sh prepare",
			"ExecStartPre=/usr/sbin/sshd -t"
		]);

		// The precondition that makes all of this necessary: the image ships no
		// host keys, so nothing but `prepare` can put them there.
		expect(readRepoFile("Dockerfile")).toContain("rm -f /etc/ssh/ssh_host_*");
	});

	test("removes the registered password on every boot, after persistence", () => {
		const entrypoint = readRepoFile("rootfs/opt/composery/entrypoint.sh");
		const removal = readRepoFile("rootfs/opt/composery/remove-password.sh");

		// Order matters: putting the delta back first would restore the password.
		// remove-password runs in the shared finalize tail, which the copy path
		// reaches only after `persistence apply` and the overlay path only after
		// the kernel has mounted the delta (the post-pivot re-exec into finalize),
		// so it always runs once the delta is live for either engine.
		expect(entrypoint).toContain("/opt/composery/remove-password.sh");
		expect(
			entrypoint.indexOf("/opt/composery/remove-password.sh")
		).toBeLessThan(entrypoint.indexOf("persistence select-engine"));
		expect(entrypoint.indexOf("composery persistence apply")).toBeLessThan(
			entrypoint.lastIndexOf("finalize")
		);
		expect(entrypoint).toContain(
			'if [ "${PORT:-8080}" = "${COMPOSERY_IDE_PORT:-8081}" ]'
		);
		// The config path has to track paths.config, which rebrand.mjs now sets:
		// the patch stack renames nothing, so the rule is the only home for it.
		expect(readRepoFile("packages/ide/scripts/rebrand.mjs")).toContain(
			'envPaths("composery", { suffix: "" })'
		);
		expect(removal).toContain(
			'config_path="${COMPOSERY_CONFIG:-/home/user/.config/composery/config.yaml}"'
		);
		expect(removal).toContain('chown user:user "$config_path"');
		// Only 1/true may enable a switch that unprotects the instance, so an
		// unrecognised value keeps the password rather than removing it.
		expect(removal).toContain("1 | true) ;;");
		expect(removal).toContain("*) exit 0 ;;");
		// Trim the edges only. Deleting all whitespace turns "t rue" into the
		// destructive value "true" and violates fail-towards-protected parsing.
		expect(removal).toContain('${removal#"${removal%%[![:space:]]*}"}');
		expect(removal).toContain('${removal%"${removal##*[![:space:]]}"}');
		expect(removal).toContain("${removal,,}");
		expect(removal).not.toContain("//[[:space:]]/");
		expect(removal).not.toContain("password-removed");
		// Shell cannot import the one reading of "set to 1 or true", so this is
		// the second copy of it and has to say which module it is a copy of.
		// packages/ide/tests/invariants/env-flags.test.ts pins the other.
		expect(removal).toContain("packages/ide/overlay/src/node/envFlag.ts");
		expect(readRepoFile("packages/ide/overlay/src/node/envFlag.ts")).toContain(
			'raw === "1" || raw === "true"'
		);
	});

	test("selects the persistence engine before applying, mirroring COMPOSERY_INIT", () => {
		const entrypoint = readShellCode("rootfs/opt/composery/entrypoint.sh");

		// Same auto|overlay|copy plus exit-64-on-unknown contract COMPOSERY_INIT uses.
		expect(entrypoint).toContain('case "${COMPOSERY_PERSISTENCE:-auto}" in');
		expect(entrypoint).toContain("auto | overlay | copy) ;;");
		expect(entrypoint).toMatch(
			/Unsupported COMPOSERY_PERSISTENCE[\s\S]*?exit 64/
		);

		// The choice is recorded for `persistence status`, and the copy engine
		// still applies the delta - selection runs first.
		expect(entrypoint).toContain("persistence select-engine");
		expect(entrypoint.indexOf("persistence select-engine")).toBeLessThan(
			entrypoint.indexOf("persistence apply")
		);

		// The overlay engine is finished: its branch hands off to init/overlay.sh
		// (build the overlay, pivot, finalize) rather than failing loudly.
		expect(entrypoint).toMatch(
			/"\$engine" = overlay[\s\S]*?exec \/opt\/composery\/init\/overlay\.sh/
		);
		expect(entrypoint).not.toMatch(/"\$engine" = overlay[\s\S]*?exit 1/);
	});

	test("the overlay engine boot follows the spike's proven order", () => {
		const overlay = readShellCode("rootfs/opt/composery/init/overlay.sh");
		const entrypoint = readShellCode("rootfs/opt/composery/entrypoint.sh");

		// Hygiene (recreate work/, reconcile stale whiteouts / opaque dirs) runs
		// before the mount and sources the reserved upper/work paths from Rust
		// rather than a second hardcoded copy.
		expect(overlay).toContain("persistence overlay-hygiene");
		expect(overlay.indexOf("persistence overlay-hygiene")).toBeLessThan(
			overlay.indexOf("mount -t overlay")
		);
		// Private propagation before any move (spike: pivot_root refuses a shared /).
		expect(overlay.indexOf("mount --make-rprivate /")).toBeLessThan(
			overlay.indexOf("pivot_root")
		);
		// Kernel filesystems, the volume, AND the resolver files (Hazard D: no DNS
		// in the pivoted root without them).
		expect(overlay).toContain("mount --rbind /proc");
		for (const file of ["/etc/resolv.conf", "/etc/hosts", "/etc/hostname"]) {
			expect(overlay).toContain(file);
		}
		// /opt/composery and /opt/persistence bound so image code cannot become a
		// user delta under overlay (the structural integrity exclusion).
		expect(overlay).toContain("for d in /opt/composery /opt/persistence");
		// Pivot, then re-enter the shared finalize tail through the entrypoint.
		expect(overlay).toContain("pivot_root . mnt/oldroot");
		expect(overlay.indexOf("pivot_root")).toBeLessThan(
			overlay.indexOf("COMPOSERY_OVERLAY_STAGE=finalize")
		);
		expect(overlay).toContain("exec /opt/composery/entrypoint.sh");
		expect(entrypoint).toMatch(
			/COMPOSERY_OVERLAY_STAGE:-\}" = finalize[\s\S]*?finalize/
		);
	});

	test("wires every environment variable the docs promise", () => {
		// COMPOSERY_DISABLE_FILE_UPLOADS was documented for a release with no env
		// var behind it: upstream left --disable-file-uploads CLI-only, and
		// Composery passes no CLI flags. Documented but inert is the worst case -
		// the operator believes uploads are blocked - so pin docs to real wiring.
		const documented = [
			...readRepoFile("docs/configuration.md").matchAll(
				/`(COMPOSERY_[A-Z_]+)`/g
			)
		].flatMap((match) => match[1] ?? []);
		const wired = envNamesUnder([
			"Dockerfile",
			"packages/cli/crates",
			"packages/ide/overlay/src",
			"packages/ide/patches",
			"packages/ide/scripts",
			"rootfs",
			"scripts"
		]);

		expect(documented.length).toBeGreaterThan(20);
		expect(documented.filter((name) => !wired.has(name))).toEqual([]);
	});

	// The cloud configuration surface is a third copy of these names, after the
	// docs and the code that reads them. A key offered there but not wired is a
	// switch an owner flips that does nothing at all - the same inert-path failure
	// the test above exists to catch, one layer further out. The managed and
	// infrastructure variables are checked from the other direction: offering any
	// of them would let a saved configuration take an instance off its own
	// password or detach it from the control plane.
	test("only offers configuration for variables that are documented and wired", () => {
		// Read rather than imported. This suite lives in the root TypeScript
		// project, which resolves modules differently from packages/web's, so
		// importing a Convex source file here fights the two configurations for no
		// benefit - and every other assertion in this file already reads its
		// evidence off disk.
		const RUNTIME_CONFIG_KEYS = [
			...readRepoFile("packages/web/convex/boxes/configuration.ts").matchAll(
				/^\t\tkey: "([A-Z_]+)"/gm
			)
		].map((match) => match[1] as string);
		const documented = new Set(
			[
				...readRepoFile("docs/configuration.md").matchAll(
					/`(COMPOSERY_[A-Z_]+)`/g
				)
			].flatMap((match) => match[1] ?? [])
		);
		const wired = envNamesUnder([
			"Dockerfile",
			"packages/cli/crates",
			"packages/ide/overlay/src",
			"packages/ide/patches",
			"packages/ide/scripts",
			"rootfs",
			"scripts"
		]);

		const offered = RUNTIME_CONFIG_KEYS.filter((key: string) =>
			key.startsWith("COMPOSERY_")
		);
		expect(offered.length).toBeGreaterThan(10);
		expect(offered.filter((key: string) => !documented.has(key))).toEqual([]);
		expect(offered.filter((key: string) => !wired.has(key))).toEqual([]);

		// Variables the website owns, or that the rendered compose file and
		// Caddyfile are written against. None may be owner-configurable.
		for (const managed of [
			"COMPOSERY_HASHED_PASSWORD",
			"COMPOSERY_PASSWORD",
			"COMPOSERY_REMOVE_PASSWORD",
			"COMPOSERY_CLOUD_BOX_ID",
			"COMPOSERY_CLOUD_ORIGIN",
			// Written by the website so an instance knows which digest it was started
			// as. An owner who could set it would make their instance report a
			// version it is not running.
			"COMPOSERY_RUNTIME_IMAGE",
			"COMPOSERY_INIT",
			"COMPOSERY_IDE_PORT",
			"COMPOSERY_DOCKER_VOLUME_PATH",
			"COMPOSERY_PERSISTENCE",
			"COMPOSERY_CONFIG"
		]) {
			expect(RUNTIME_CONFIG_KEYS).not.toContain(managed);
		}
	});

	test("bridges cloud identity and the managed password into the IDE service", () => {
		const entrypoint = readRepoFile("rootfs/opt/composery/entrypoint.sh");
		const service = readRepoFile("rootfs/usr/lib/systemd/system/ide.service");

		// The bare name is a trap: "HASHED_PASSWORD" also matches inside
		// "COMPOSERY_HASHED_PASSWORD", so asserting it cannot tell the two apart.
		// The IDE reads the prefixed name (rebrand.mjs rewrites cli.ts), so
		// ^COMPOSERY_ already carries it and the cloud env file must use it too.
		expect(entrypoint).toContain("^COMPOSERY_");
		expect(entrypoint).not.toMatch(/\|HASHED_PASSWORD\|/);
		expect(entrypoint).toContain("umask 077");
		expect(service).toContain("EnvironmentFile=-/run/composery.env");
		expect(
			readRepoFile("packages/web/convex/boxes/infra/artifacts.ts")
		).toContain("`COMPOSERY_HASHED_PASSWORD=${quoteEnvFileValue");
		expect(readRepoFile("packages/ide/scripts/rebrand.mjs")).toContain(
			'"process.env.COMPOSERY_HASHED_PASSWORD"'
		);
	});
});

// Docker's storage layout is one decision that Docker itself splits across two
// files, and neither daemon can notice the other is misconfigured. Since Engine
// 29 the containerd image store holds images and container snapshots, and
// `data-root` does not reach them - so shipping one setting without the other
// starts cleanly, looks deliberate, and puts every image layer back on the root
// filesystem. Nothing at runtime fails, which is why the pairing is pinned here.
describe("bundled Docker", () => {
	test("keeps both storage roots on the durable volume", () => {
		const daemon = JSON.parse(
			readRepoFile("rootfs/etc/docker/daemon.json")
		) as Record<string, unknown>;
		const containerd = readRepoFile("rootfs/etc/containerd/config.toml");

		expect(daemon["data-root"]).toBe("/data/docker");
		expect(containerd).toMatch(/^root = "\/data\/containerd"$/m);
	});

	test("runs containerd as its own service so its config is read", () => {
		// A bare `dockerd` starts a private containerd from a generated config,
		// which would ignore the file above entirely. Both profiles therefore run
		// containerd separately and point dockerd at its socket: the supervisor
		// one through this flag, the systemd one through Docker's own unit.
		const script = readShellCode("rootfs/opt/composery/docker.sh");
		const supervisor = readRepoFile(
			"rootfs/etc/supervisor/conf.d/composery.conf"
		);

		expect(script).toContain(
			'exec /usr/bin/dockerd --containerd "${CONTAINERD_SOCKET}"'
		);
		expect(script).toContain(
			"CONTAINERD_SOCKET=/run/containerd/containerd.sock"
		);
		expect(supervisor).toContain("[program:containerd]");
		expect(supervisor).toContain("command=/opt/composery/docker.sh containerd");
	});

	test("treats a refusal as a decision in both process managers", () => {
		// 78 is docker.sh refusing to run. Supervisor must not restart it and
		// systemd must not mark the unit failed, or an unprivileged deployment
		// logs the same refusal forever.
		//
		// Read per program, not across the whole file: both programs carry these
		// settings, so a whole-file `toContain` stays green while one of them
		// loses them - which is the half of this that would actually loop.
		const supervisor = readRepoFile(
			"rootfs/etc/supervisor/conf.d/composery.conf"
		);
		const condition = "ExecCondition=/opt/composery/docker.sh check";
		const program = (name: string) =>
			supervisor.split(/^\[program:/m).find((s) => s.startsWith(`${name}]`));

		for (const name of ["containerd", "docker"]) {
			expect(program(name)).toContain("exitcodes=78");
			expect(program(name)).toContain("autorestart=unexpected");
		}
		expect(
			readRepoFile("rootfs/etc/systemd/system/docker.service.d/composery.conf")
		).toContain(condition);
		expect(
			readRepoFile(
				"rootfs/etc/systemd/system/containerd.service.d/composery.conf"
			)
		).toContain(condition);
	});
});

// An instance's SSH identity has to be generated by that instance. A host key in
// the image would be one identity shared by every Composery ever pulled, so
// anybody holding the image could impersonate any of them and no client could
// tell - and nothing about a working SSH login would look wrong. Debian's
// openssh-server generates a pair in its postinst, so this is the state the build
// arrives in rather than one we would have to introduce.
describe("bundled SSH", () => {
	test("never ships a host key, and generates one per instance", () => {
		const dockerfile = readRepoFile("Dockerfile");
		const ssh = readShellCode("rootfs/opt/composery/ssh.sh");
		const rootfsSsh = resolve(repoRoot, "rootfs/etc/ssh");

		expect(dockerfile).toContain("rm -f /etc/ssh/ssh_host_*");
		expect(ssh).toContain("ssh-keygen -A");
		expect(
			readdirSync(rootfsSsh).filter((name) => name.startsWith("ssh_host_"))
		).toEqual([]);
	});

	test("accepts keys only, and never as root", () => {
		const config = readRepoFile("rootfs/etc/ssh/sshd_config.d/composery.conf");

		expect(config).toContain("PasswordAuthentication no");
		expect(config).toContain("KbdInteractiveAuthentication no");
		expect(config).toContain("PermitRootLogin no");
		expect(config).toContain("AllowUsers user");
		// Two files, so the deployment's keys and the account's own keys have one
		// writer each and neither can drop the other's.
		expect(config).toContain(
			"AuthorizedKeysFile .ssh/authorized_keys /etc/ssh/authorized_keys.d/%u"
		);
	});

	test("reads the deployment's keys where both profiles can see them", () => {
		// The value is an authorized_keys file and so multi-line, and the systemd
		// profile bridges settings through a file built with `env | grep`, which
		// keeps only a value's first line. Reading it from the entrypoint is what
		// stops systemd honouring one key while supervisor honours all of them.
		const entrypoint = readShellCode("rootfs/opt/composery/entrypoint.sh");
		const ssh = readShellCode("rootfs/opt/composery/ssh.sh");

		expect(entrypoint).toContain("/opt/composery/ssh.sh install-keys");
		expect(ssh).toContain(
			'"${COMPOSERY_SSH_AUTHORIZED_KEYS:-}" >"${MANAGED_KEYS}"'
		);
		expect(
			readShellCode("rootfs/etc/systemd/system/ssh.service.d/composery.conf")
		).not.toContain("COMPOSERY_SSH_AUTHORIZED_KEYS");
	});

	// Every gated service reads the same bridge file. Without it systemd starts the
	// unit with a clean environment, the gate sees an unset variable, and the
	// service runs on an instance configured to have it off - the failure that
	// looks healthy right up until someone checks.
	test("lets both gates see their setting under systemd", () => {
		for (const unit of ["ssh", "docker", "containerd"]) {
			const dropIn = readRepoFile(
				`rootfs/etc/systemd/system/${unit}.service.d/composery.conf`
			);
			expect(dropIn, unit).toContain("EnvironmentFile=-/run/composery.env");
			expect(dropIn, unit).toContain("ExecCondition=");
		}
	});
});
