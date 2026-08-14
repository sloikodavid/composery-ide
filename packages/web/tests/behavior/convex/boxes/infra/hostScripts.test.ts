import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
	COMPOSERY_VOLUME_NAMES,
	renderRuntimeArtifacts
} from "@/convex/boxes/infra/artifacts";
import {
	DISK_SCRIPT,
	INSPECT_SCRIPT,
	applyRuntimeConfigScript,
	bootstrapScript,
	copyFromParkingScript,
	copyToParkingFromRescueScript,
	parkingVolumeDevicePath,
	parseDiskUsage,
	parseParkingVerification,
	parseRuntimeInspection,
	repairScript,
	reloadCaddyfileScript,
	rewritePasswordScript,
	runtimeLogsScript,
	updateScript,
	shellQuote,
	sshEnrollScript,
	sshFailure,
	sshListScript,
	sshRevokeScript,
	unmountParkingScript,
	unmountRescueScript,
	verifyParkingScript
} from "@/convex/boxes/infra/hostScripts";

// Removals the script makes that are not its own scratch.
//
// `rm` anywhere used to be forbidden outright, which is the right idea and
// the wrong rule: these scripts stage files through `mktemp`, and the EXIT trap
// that removes that same path is the thing keeping a half-written compose file
// off the box. A guard that fails on it teaches the next person to delete the
// guard. So the trap is named exactly - same variable, EXIT, nothing else - and
// every other removal is still refused.
const CLEANUP_TRAP = /^trap 'rm -[rf]+ "\$\w+"' EXIT$/;

function removalsOutsideCleanup(script: string) {
	return script
		.split("\n")
		.filter((line) => /\brm\s+-/.test(line))
		.filter((line) => !CLEANUP_TRAP.test(line.trim()));
}

describe("ssh failures", () => {
	// What a failed repair actually leaves on stderr: compose progress, then the
	// one sentence the owner needs.
	test("reports the failure, not the progress that led to it", () => {
		expect(
			sshFailure(
				`caddy Pulling
composery Pulling
Container composery Started
The runtime came up but its editor never started.
`,
				1
			)
		).toBe("The runtime came up but its editor never started.");
	});

	test("falls back to the exit code when the script said nothing", () => {
		expect(sshFailure("", 137)).toBe("SSH command failed with exit 137.");
		expect(sshFailure("\n  \n", 2)).toBe("SSH command failed with exit 2.");
	});

	test("removes whitespace around the last error line", () => {
		expect(sshFailure("progress\n  failed here  \n", 1)).toBe("failed here");
	});
});

describe("runtime inspection", () => {
	test("parses known component states and ignores untrusted extra output", () => {
		expect(
			parseRuntimeInspection(`banner from host
docker=active
outer_caddy=inactive
composery=active
persistence=active
caddy=missing
ide=unexpected
arbitrary=value
`)
		).toEqual({
			hostReachable: true,
			httpReachable: false,
			engine: "unknown",
			docker: "active",
			outerCaddy: "inactive",
			composery: "active",
			persistence: "active",
			caddy: "missing",
			ide: "unknown"
		});
	});

	test("returns unknown states when output is incomplete", () => {
		expect(parseRuntimeInspection("")).toEqual({
			hostReachable: true,
			httpReachable: false,
			engine: "unknown",
			docker: "unknown",
			outerCaddy: "unknown",
			composery: "unknown",
			persistence: "unknown",
			caddy: "unknown",
			ide: "unknown"
		});
	});

	test("accepts padded output and both persistence engines", () => {
		expect(parseRuntimeInspection("  engine=overlay  \n").engine).toBe(
			"overlay"
		);
		expect(parseRuntimeInspection("engine=copy\n").engine).toBe("copy");
	});

	// Every key printed by the script, read back out of the script itself:
	// literal `echo key=` / `printf 'key=%s`, plus the loop that prints one line
	// per service it iterates.
	function emittedKeys(script: string) {
		const literal = [...script.matchAll(/(?:echo |printf ')([a-z_]+)=/g)].map(
			(match) => match[1]
		);
		const loop = script.match(/for service in ([a-z ]+); do/);
		return [...new Set([...literal, ...(loop?.[1].trim().split(/\s+/) ?? [])])];
	}

	// The parser is only as good as the script feeding it. Renaming a key on
	// either side leaves its field permanently "unknown", which looks like a
	// quiet box rather than a broken check - so pin the two together.
	test("prints a key for every field the Repair dialog reads", () => {
		const keys = emittedKeys(INSPECT_SCRIPT);
		expect(keys).toHaveLength(7);

		const stdout = keys
			.map((key) => {
				if (key === "engine") return `${key}=copy`;
				return `${key}=active`;
			})
			.join("\n");

		expect(parseRuntimeInspection(stdout)).toEqual({
			hostReachable: true,
			httpReachable: false,
			engine: "copy",
			docker: "active",
			outerCaddy: "active",
			composery: "active",
			persistence: "active",
			caddy: "active",
			ide: "active"
		});
	});
});

// The host prints one key per line. Joined rather than written as one escaped
// literal, so each key stays a separate word: an escaped newline joins the line
// before it to the line after for anything reading this file as text, and the
// repository's vocabulary check is one of those things.
function lines(...values: string[]) {
	return values.map((value) => `${value}\n`).join("");
}

const TOTAL = "disk_total_bytes";
const USED = "disk_used_bytes";

describe("disk usage", () => {
	// The script asks for one-byte blocks, so the numbers crossing the wire are
	// the numbers stored. Dropping `-B1` would silently multiply every box's
	// disk reading by 1024 and email its owner about a disk that is not full.
	test("asks the host for bytes rather than blocks", () => {
		expect(DISK_SCRIPT).toContain("df -PB1 /");
	});

	test("reads the total and used figures off the second line", () => {
		expect(
			parseDiskUsage(lines(`${TOTAL}=42949672960`, `${USED}=8589934592`))
		).toEqual({ totalBytes: 42_949_672_960, usedBytes: 8_589_934_592 });
	});

	test("ignores anything else the host printed", () => {
		expect(
			parseDiskUsage(
				lines(
					"banner from host",
					`${TOTAL}=100`,
					"arbitrary=value",
					`${USED}=25`
				)
			)
		).toEqual({ totalBytes: 100, usedBytes: 25 });
	});

	// `df` failing still runs the script, which then prints nothing at all.
	// Reading a missing value as 0 would report a perfectly empty disk for a box
	// nobody measured - the answer that makes the box look fine, and the wrong one.
	test("reports an unmeasurable disk as unknown, not as empty", () => {
		expect(parseDiskUsage("")).toBe(null);
		expect(parseDiskUsage(lines(`${TOTAL}=`, `${USED}=`))).toBe(null);
		expect(parseDiskUsage(lines(`${TOTAL}=100`))).toBe(null);
	});

	// The box owner is root on their own host, so this output is whatever that
	// host chose to print. Nothing that could not describe a filesystem may pass.
	test("refuses readings a real filesystem could not produce", () => {
		for (const raw of ["-5", "1e999", "nonsense", "0x10", " 100"]) {
			expect(parseDiskUsage(lines(`${TOTAL}=${raw}`, `${USED}=1`))).toBe(null);
		}
		// Used above total is not a fuller disk; it is a reading that describes no
		// filesystem, and storing it would draw a meter past its own end.
		expect(parseDiskUsage(lines(`${TOTAL}=100`, `${USED}=101`))).toBe(null);
		// A zero-size filesystem has no percentage to report, and dividing by it is
		// how a box with no reading gets a real-looking one.
		expect(parseDiskUsage(lines(`${TOTAL}=0`, `${USED}=0`))).toBe(null);
		expect(parseDiskUsage(lines(`${TOTAL}=100`, `${USED}=100`))).toEqual({
			totalBytes: 100,
			usedBytes: 100
		});
	});
});

describe("runtime bootstrap and repair scripts", () => {
	const artifacts = renderRuntimeArtifacts({
		cloudBoxId: "box_123",
		cloudOrigin: "https://www.composery.io",
		domain: "my-box.composery.cloud",
		runtimeAuthHash: "$argon2id$v=19$m=1,t=1,p=1$salt$hash",
		runtimeImage: "ghcr.io/sloikodavid/composery@sha256:abc",
		runtimePort: 8080
	});
	const repair = repairScript(artifacts);
	const bootstrap = bootstrapScript(artifacts);
	const update = updateScript(artifacts);

	// Force-recreate is the entire difference between a repair and a no-op: a
	// wedged container whose config still matches is exactly what `up -d` skips.
	// An update always changes the compose file's image reference, so compose
	// recreates the service on its own; forcing it would only restart the
	// containers that did not change.
	test("force-recreates every container only when repairing", () => {
		expect(repair).toContain("up -d --force-recreate");
		expect(bootstrap).toContain("up -d\n");
		expect(bootstrap).not.toContain("--force-recreate");
		expect(update).not.toContain("--force-recreate");
	});

	// The promise the owner is shown is "your box is fixed". `up -d` returning
	// only means the container was created, so a repair that stops there would
	// report success over a crash-looping editor. An update makes the same
	// promise about a box that was working before it started, so it waits too -
	// and that wait is what lets a failed update leave the row on the last image
	// known to serve.
	test("waits for the editor to answer before calling a repair or update done", () => {
		for (const script of [repair, update]) {
			expect(script).toContain("/_composery/healthz");
			expect(script).toContain("exit 1");
			expect(script.trimEnd().endsWith("exit 1")).toBe(true);
		}
		expect(bootstrap).not.toContain("/_composery/healthz");
	});

	// An update exists to move the box to a new image. If that image cannot be
	// pulled there is nothing to update to, and a tolerant pull would restart the
	// box on the image it already had - which then reports success and lets the
	// caller advance the row to a digest the host never ran. Repair's tolerance
	// is right for repair and wrong here.
	test("requires the pull to succeed when updating, unlike repairing", () => {
		expect(update).toMatch(/ pull\n/);
		expect(update).not.toMatch(/ pull \|\| echo /);
		expect(repair).toMatch(/ pull \|\| echo /);
	});

	test("rewrites all three runtime files and re-pulls the image", () => {
		expect(repair).toContain("/opt/composery-web/compose.yaml");
		expect(repair).toContain("/opt/composery-web/composery.env");
		expect(repair).toContain("/opt/composery-web/Caddyfile");
		expect(repair).toContain(artifacts.compose);
		expect(repair).toContain(artifacts.env);
		expect(repair).toContain(artifacts.caddyfile);
		expect(repair).toContain("compose -p composery -f");
		expect(repair).toContain(" pull ");
		expect(repair).toContain("set -euo pipefail");
		expect(repair).toContain("mktemp -d /opt/composery-web/.stage.");
		expect(repair).toContain("config -q");
		expect(repair.indexOf("config -q")).toBeLessThan(
			repair.indexOf('mv -f "$stage/compose.yaml"')
		);
	});

	// Repair exists to get a broken box serving again. Under `set -e` a pruned
	// digest or an unreachable registry would abort the script before anything
	// restarted, leaving the box as broken as it was - the "repair does nothing"
	// report. Bootstrap keeps failing there, because a first boot with no image
	// has nothing to fall back to.
	test("repairs with the local image when the pull fails, but never bootstraps", () => {
		expect(repair).toMatch(/ pull \|\| echo /);
		expect(bootstrap).not.toContain("||");
		expect(bootstrap).toMatch(/ pull\n/);
	});

	// Repair is offered as the safe option, and the box's files live in named
	// volumes. Nothing here may remove them.
	test("never removes the volumes holding the box's files", () => {
		expect(repair).not.toMatch(/\bdown\b/);
		expect(repair).not.toMatch(/\bvolume\s+rm\b/);
		expect(removalsOutsideCleanup(repair)).toEqual([]);
		expect(repair).not.toMatch(/--volumes\b/);
	});

	// A file whose contents happen to contain the delimiter would end its
	// heredoc early and hand the remainder to the shell as root.
	test("keeps heredoc delimiters out of the contents it writes", () => {
		for (const delimiter of [
			"__COMPOSERY_COMPOSE__",
			"__COMPOSERY_ENV__",
			"__COMPOSERY_CADDY__"
		]) {
			expect(repair.split(delimiter)).toHaveLength(3);
		}
	});
});

describe("repair parking scripts", () => {
	const artifacts = renderRuntimeArtifacts({
		cloudBoxId: "box_123",
		cloudOrigin: "https://www.composery.io",
		domain: "my-box.composery.cloud",
		runtimeAuthHash: "$argon2id$v=19$m=1,t=1,p=1$salt$hash",
		runtimeImage: "ghcr.io/sloikodavid/composery@sha256:abc",
		runtimePort: 8080
	});
	const volumeId = 4242;
	const copyOut = copyToParkingFromRescueScript(volumeId);
	const copyBack = copyFromParkingScript(artifacts, volumeId);
	const verifyOut = verifyParkingScript("out", volumeId);
	const verifyBack = verifyParkingScript("back", volumeId);
	const everyScript = [copyOut, copyBack, verifyOut, verifyBack];

	// The only test here that starts a process, and how long that takes is a fact
	// about the machine rather than about the scripts: `bash` on a Windows
	// developer's PATH can be WSL's, which boots a virtual machine on first use
	// and spends seconds before it reads a line. CI resolves Git Bash and returns
	// in milliseconds. The allowance is sized for the slow reading so a correct
	// script is never reported as a broken one.
	test("is valid Bash before any host receives it", () => {
		const result = spawnSync("bash", ["-n"], {
			input: everyScript.join("\n"),
			encoding: "utf8"
		});
		expect(result.status, result.stderr).toBe(0);
	}, 120_000);

	// The runtime and Repair import one list, so a new persistent volume cannot
	// silently exist outside recovery.
	test("uses every volume name rendered into compose", () => {
		for (const script of everyScript) {
			for (const name of COMPOSERY_VOLUME_NAMES) expect(script).toContain(name);
		}
	});

	// The persistence delta stores xattrs, ACLs, file caps, hardlinks, whiteout
	// devices, and sparse files. Only these flags preserve them; cp -a would not.
	test("copies with the full-fidelity rsync flags in both directions", () => {
		expect(copyOut).toContain("rsync -aHAXS --numeric-ids --delete");
		expect(copyBack).toContain("rsync -aHAXS --numeric-ids --delete");
	});

	// The copy is only believed once an independent checksum pass proves it.
	test("verifies with a dry-run checksum compare that reports every difference", () => {
		for (const verify of [verifyOut, verifyBack]) {
			expect(verify).toContain("rsync -aHAXS --numeric-ids -ni -c --delete");
		}
	});

	test("verifies in the direction of whichever copy is authoritative", () => {
		// On the way out the box's volume is the source; on the way back the parked
		// copy is. A swapped direction would verify the wrong tree.
		expect(verifyOut).toContain('"$mp/" "/mnt/composery-parking/$key/"');
		expect(verifyBack).toContain('"/mnt/composery-parking/$key/" "$mp/"');
	});

	test("reads a stopped boot disk without the installed OS or Docker", () => {
		expect(copyOut).toContain("lsblk -rpn");
		expect(copyOut).toContain("mount -o ro");
		expect(copyOut).toContain("/var/lib/docker/volumes/$1/_data");
		expect(copyOut).not.toContain("docker ");
	});

	// Hetzner normally formats the volume in its create action. If that action
	// failed after the volume itself was created, Repair would otherwise reuse the
	// same unmountable volume for ever. Only the outbound path can initialize it:
	// the boot disk is still authoritative there, while copy-back never may.
	test("initializes only a new parking volume with no filesystem", () => {
		expect(copyOut).toContain('blkid -p "$device"');
		expect(copyOut).toContain('mkfs.ext4 -F "$device"');
		for (const script of [copyBack, verifyOut, verifyBack]) {
			expect(script).not.toContain("mkfs.ext4");
		}
	});

	// The parked copy is the only copy once the server is gone. Nothing on the
	// restore path may reformat the volume or remove a volume's contents.
	test("never reformats the volume or destroys data on the way back", () => {
		expect(copyBack).not.toContain("mkfs");
		expect(copyBack).not.toMatch(/\bvolume\s+rm\b/);
		expect(removalsOutsideCleanup(copyBack)).toEqual([]);
		// It materializes the empty volumes without starting anything, then copies.
		expect(copyBack).toContain(
			"docker compose -p composery -f /opt/composery-web/compose.yaml create"
		);
		expect(copyBack).toContain(
			"docker compose -p composery -f /opt/composery-web/compose.yaml pull"
		);
		// And it lays the runtime files down first (needs the compose file present).
		expect(copyBack).toContain(artifacts.compose);
	});

	test("treats any itemized verification line as a difference, empty as clean", () => {
		expect(parseParkingVerification("")).toEqual([]);
		expect(parseParkingVerification("\n  \n")).toEqual([]);
		expect(
			parseParkingVerification(
				"composery_data: >f+++++++++ foo\ncaddy_data: cL+++ bar\n"
			)
		).toEqual(["composery_data: >f+++++++++ foo", "caddy_data: cL+++ bar"]);
		expect(parseParkingVerification("changed  \n")).toEqual(["changed"]);
	});
});

describe("the parking volume's device path", () => {
	// The stable by-id path is what lets the mount script find the attached
	// volume without guessing a /dev/sd* letter that can shift between boots.
	test("locates a volume deterministically from its id", () => {
		expect(parkingVolumeDevicePath(1234)).toBe(
			"/dev/disk/by-id/scsi-0HC_Volume_1234"
		);
	});

	test("is the path the mount script actually waits for", () => {
		expect(copyToParkingFromRescueScript(1234)).toContain(
			parkingVolumeDevicePath(1234)
		);
	});
});

// The three scripts that rewrite what a running box is started with. Each was
// written inline inside the action that sent it, where the only way to check the
// shell was to read it - and a template literal is a bad place to keep shell,
// because the two languages disagree about backslashes and `$`.
describe("rewriting a running box", () => {
	test("applies a configuration and waits for the editor to come back", () => {
		const script = applyRuntimeConfigScript("COMPOSERY_DISABLE_API=1");
		const leadingNewline = applyRuntimeConfigScript("\nA=1");

		expect(script).toContain("set -euo pipefail");
		// The env file is written through a quoted heredoc, so nothing in an
		// owner's value is expanded by the shell on the way in.
		expect(script).toContain("<<'__COMPOSERY_ENV__'");
		expect(script).toContain("mktemp /opt/composery-web/composery.env.");
		expect(script.indexOf("chmod 0600")).toBeLessThan(script.indexOf("mv -f"));
		expect(script).toContain("COMPOSERY_DISABLE_API=1");
		expect(script).toContain("COMPOSERY_DISABLE_API=1\n__COMPOSERY_ENV__");
		expect(leadingNewline).toContain("\nA=1\n__COMPOSERY_ENV__");
		expect(script).toContain("--force-recreate --no-deps composery");
		// Recreating is not the same as serving: a configuration that stops the
		// box booting has to fail the operation, not report a clean apply.
		expect(script).toContain("/_composery/healthz");
		expect(script.trimEnd().endsWith("exit 1")).toBe(true);
	});

	// An argon2 hash is full of `$`, and the check compares it against what the
	// running editor was actually started with. Both halves are escaping the
	// template literal could silently eat.
	test("proves the container came back on the new password hash", () => {
		const hash = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA";
		const script = rewritePasswordScript("A=1", hash);

		// The hash rides in through a quoted heredoc rather than the command line.
		expect(script).toContain("<<'__COMPOSERY_EXPECTED_HASH__'");
		expect(script).toContain(`
${hash}`);
		expect(script).toContain('if [ "$actual_hash" = "$expected_hash" ]');
		// `tr` gets its own escapes, not the shell's: the environ file is
		// NUL-separated, so these have to reach `tr` as backslash-000 and
		// backslash-n. A single backslash here would send a literal NUL byte and
		// a real newline, and the read would silently return nothing - which
		// reads as "the password did not take" on every change.
		expect(script).toContain(String.raw`tr "\000" "\n"`);
		expect(script).toContain('test "${pid:-0}" -gt 0');
		expect(script).toContain("supervisorctl pid ide");
		expect(script).toContain("COMPOSERY_HASHED_PASSWORD=");
	});

	test("reloads a new Caddyfile in place, or brings Caddy up if it is down", () => {
		const script = reloadCaddyfileScript("example.test { }");

		expect(script).toContain("<<'__COMPOSERY_CADDY__'");
		expect(script).toContain("example.test { }");
		expect(script).toContain("caddy reload --config /etc/caddy/Caddyfile");
		expect(script).toContain("|| docker compose");
		expect(script).toContain("up -d caddy");
	});
});

describe("releasing a parking volume", () => {
	// A settled copy is unmounted before the volume is detached and deleted, and
	// the step can be retried - a repair that resumes must not fail because the
	// volume is already unmounted.
	test("unmounts only what is mounted", () => {
		const script = unmountParkingScript();

		expect(script).toContain("mountpoint -q");
		expect(script).toContain("umount");
		expect(script).toContain("set -euo pipefail");
	});

	test("unmounts both rescue filesystems before the provider detaches them", () => {
		const script = unmountRescueScript();
		expect(script).toContain("/mnt/composery-source");
		expect(script).toContain("/mnt/composery-parking");
		expect(script.indexOf("/mnt/composery-source")).toBeLessThan(
			script.indexOf("/mnt/composery-parking")
		);
	});
});

describe("reading a box's logs", () => {
	test("reads the one compose log stream", () => {
		const script = runtimeLogsScript(200);

		expect(script).toContain("--tail 200");
		expect(script).not.toContain("journalctl");
	});
});

// A certificate is named by its owner, so the name is arbitrary text that ends
// up on a command line. Asserting the quoted string alone is not enough here:
// the broken spelling this replaced looked plausible and only a shell could say
// it was wrong, so bash is asked whether it parses and what it gets.
describe("naming a certificate", () => {
	const parse = (script: string) =>
		spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });

	// `String.raw`, because the expectation is one backslash and an ordinary
	// string literal is where the original lost it: "\'" and `\'` are both just a
	// quote. Written this way the four characters are on the page.
	test("closes, escapes and reopens every quote in a name", () => {
		expect(shellQuote("a phone's name")).toBe(String.raw`'a phone'\''s name'`);
		expect(shellQuote("plain")).toBe("'plain'");
		expect(shellQuote("''")).toBe(String.raw`''\'''\'''`);
	});

	test("hands bash a name it reads back whole", () => {
		const name = "the owner's laptop; rm -rf /";
		const read = spawnSync("bash", ["-c", `printf '%s' ${shellQuote(name)}`], {
			encoding: "utf8"
		});

		expect(read.status, read.stderr).toBe(0);
		expect(read.stdout).toBe(name);
	});

	test("is valid Bash for every certificate command", () => {
		for (const script of [
			sshEnrollScript("a phone's name"),
			sshListScript(),
			sshRevokeScript(42)
		]) {
			const result = parse(script);
			expect(result.status, result.stderr).toBe(0);
		}
	});

	// A serial is a number this deployment read back from the box, and it is
	// interpolated bare. Anything but a positive whole number is a bug upstream,
	// and refusing it here is what keeps it from becoming shell text.
	test("refuses a serial that is not a positive whole number", () => {
		for (const serial of [0, -1, 1.5, Number.NaN, Number.MAX_VALUE]) {
			expect(() => sshRevokeScript(serial)).toThrow();
		}
	});
});
