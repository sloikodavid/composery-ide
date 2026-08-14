import { afterEach, describe, expect, test, vi } from "vitest";
import { generateParseableKeyPair } from "../../../../support/ssh.ts";

import type { Doc } from "@/convex/_generated/dataModel";
import {
	PARKING_DIFFS_SHOWN,
	logTail,
	parkingVerificationFailure,
	requireBoxHost,
	rescueSshTarget,
	runtimeArtifactsForBox,
	runtimePort,
	sshTarget
} from "@/convex/boxes/infra/host";
import { HOST_SSH_PORT } from "@/convex/boxes/infra/artifacts";

// The decisions inside the SSH layer, rather than the SSH layer. Each one used
// to sit inside an action whose first statement is a network call, so nothing
// could reach it - and three of them are the difference between a repair that
// restores an owner's files and one that quietly loses them.

afterEach(() => {
	vi.unstubAllEnvs();
});

function stubHostEnv() {
	const keyPair = generateParseableKeyPair();
	vi.stubEnv("HOST_SSH_PRIVATE_KEY", keyPair.private.replace(/\n/g, "\\n"));
	vi.stubEnv("HOST_SSH_USER", "composery");
	vi.stubEnv("RUNTIME_PORT", "8080");
	vi.stubEnv("CLOUD_DOMAIN", "dev.composery.cloud");
	vi.stubEnv("WEBSITE_ORIGIN", "https://composery.test");
	return keyPair;
}

function box(overrides: Partial<Doc<"boxes">> = {}): Doc<"boxes"> {
	return {
		_id: "boxes:1" as Doc<"boxes">["_id"],
		_creationTime: 1,
		user_id: "user_1",
		slug: "atlas",
		plan: "pro",
		manual_snapshot_cap: 2,
		status: "running",
		hetzner_ipv4: "1.2.3.4",
		runtime_image: "ghcr.io/composery/composery@sha256:current",
		created_at: 1,
		updated_at: 1,
		...overrides
	} as Doc<"boxes">;
}

// Rendered straight into a compose file and a Caddyfile, so a value that is not
// a port produces a host that boots into a proxy pointing at nothing.
describe("the port the editor is proxied to", () => {
	test("reads a configured port", () => {
		vi.stubEnv("RUNTIME_PORT", "8080");
		expect(runtimePort()).toBe(8080);
	});

	test.each([
		["not a number", "http"],
		["a fraction", "8080.5"],
		["zero", "0"],
		["negative", "-1"],
		["empty", " "]
	])("refuses a port that is %s", (_name, value) => {
		vi.stubEnv("RUNTIME_PORT", value);
		expect(() => runtimePort()).toThrow(
			"RUNTIME_PORT must be a positive integer."
		);
	});
});

// The log stream is read over SSH into memory, so the ceiling is what keeps a
// caller asking for a million lines from being a request nothing survives.
describe("how much of a box's log is fetched", () => {
	test("asks for what was requested when it is reasonable", () => {
		expect(logTail(200)).toBe(200);
	});

	test("clamps a request larger than the ceiling", () => {
		expect(logTail(1_000_000)).toBe(5000);
		expect(logTail(5000)).toBe(5000);
		expect(logTail(5001)).toBe(5000);
	});

	test.each([
		["zero", 0],
		["negative", -1],
		["a fraction", 1.5],
		["not a number", Number.NaN]
	])("refuses a tail that is %s", (_name, value) => {
		expect(() => logTail(value)).toThrow(
			"Log tail must be a positive integer."
		);
	});
});

// Repair's precondition, said up front rather than five destructive steps in.
describe("requiring a reachable host", () => {
	test("hands back the address a box records", () => {
		expect(requireBoxHost(box())).toBe("1.2.3.4");
	});

	// The message is the whole value of this check: an owner whose networking or
	// sshd is broken needs to be pointed at Restore, not told "repair failed".
	test("names Restore as the way out for a box with no address", () => {
		expect(() => requireBoxHost(box({ hetzner_ipv4: undefined }))).toThrow(
			/can only be recovered by Restore/
		);
	});
});

// The one place a box row becomes the files its host runs, and the override that
// makes a failed update recoverable.
describe("rendering a box's runtime files", () => {
	test("renders from the image the row records", () => {
		stubHostEnv();

		const artifacts = runtimeArtifactsForBox(box());

		expect(artifacts.compose).toContain("sha256:current");
		expect(artifacts.caddyfile).toContain("atlas.dev.composery.cloud");
	});

	// An update writes the compose file for the image it is moving *to* while the
	// row still names the last image known to serve. Reading the row here instead
	// would make an update a no-op, and repairing a box that failed one would
	// reinstall the image that broke it.
	test("renders the image an update is moving to, not the row's", () => {
		stubHostEnv();

		const artifacts = runtimeArtifactsForBox(
			box(),
			"ghcr.io/composery/composery@sha256:next"
		);

		expect(artifacts.compose).toContain("sha256:next");
		expect(artifacts.compose).not.toContain("sha256:current");
	});

	// A box with no image has no compose file to write; rendering one with an
	// empty image would produce a host that pulls nothing and serves nothing.
	test("refuses a box that has no image at all", () => {
		stubHostEnv();

		expect(() =>
			runtimeArtifactsForBox(box({ runtime_image: undefined }))
		).toThrow("Box has no runtime image.");
	});

	test("carries the owner's configuration into the environment file", () => {
		stubHostEnv();

		const artifacts = runtimeArtifactsForBox(
			box({ runtime_config: { COMPOSERY_DISABLE_FILE_UPLOADS: "1" } })
		);

		// Quoted, because the env file is read by a shell and the value is the
		// owner's. `renderComposeryEnv` owns that escaping; what matters here is
		// that the row's configuration reaches it at all - it is the reason a
		// setting survives the next Reset or Repair.
		expect(artifacts.env).toContain("COMPOSERY_DISABLE_FILE_UPLOADS='1'");
	});
});

// The gate that decides whether a repair may continue past its copy. Everything
// downstream of a "yes" here is destructive.
describe("verifying a parking copy", () => {
	test("passes only on an exact match", () => {
		expect(parkingVerificationFailure("out", [])).toBeNull();
	});

	// One difference is a difference. There is no threshold below which
	// continuing is safe, because the next step rebuilds the server.
	test("refuses to continue on a single difference", () => {
		const failure = parkingVerificationFailure("out", ["home/user/notes.md"]);

		expect(failure).toContain("found 1 difference(s)");
		expect(failure).toContain("refusing to continue");
		expect(failure).toContain("home/user/notes.md");
	});

	// The count is the whole count; the list is what an operator can read. A
	// truncated count would understate how much of the box did not survive.
	test("reports every difference it found while showing a readable few", () => {
		const diffs = Array.from(
			{ length: PARKING_DIFFS_SHOWN + 25 },
			(_value, index) => `file-${index}`
		);

		const failure = parkingVerificationFailure("back", diffs);

		expect(failure).toContain(`found ${diffs.length} difference(s)`);
		expect(failure).toContain(`file-${PARKING_DIFFS_SHOWN - 1}`);
		expect(failure).not.toContain(`file-${PARKING_DIFFS_SHOWN}\n`);
		expect(failure?.split("\n")).toHaveLength(PARKING_DIFFS_SHOWN + 1);
	});

	// Which direction failed says which copy is authoritative, and so whether the
	// owner's files are on the volume or still on the server.
	test("says which direction of the copy failed", () => {
		expect(parkingVerificationFailure("out", ["x"])).toContain(
			"verification (out)"
		);
		expect(parkingVerificationFailure("back", ["x"])).toContain(
			"verification (back)"
		);
	});
});

describe("addressing a box's host", () => {
	test("pairs the host with the deployment's own user and key", () => {
		const keyPair = stubHostEnv();

		expect(sshTarget("1.2.3.4")).toEqual({
			host: "1.2.3.4",
			port: HOST_SSH_PORT,
			username: "composery",
			privateKey: keyPair.private
		});
	});

	// Port 22 on a box belongs to the instance, whose container shares the host's
	// network stack. Rescue is a different operating system netboot in place of
	// the installed one, so its sshd is on 22 like any stock system - following
	// the control port there would make the one way back into a broken host fail.
	test("does not move rescue off the port a netboot system answers on", () => {
		stubHostEnv();

		expect(sshTarget("1.2.3.4").port).toBe(HOST_SSH_PORT);
		expect(HOST_SSH_PORT).not.toBe(22);
		expect(rescueSshTarget("1.2.3.4").port).toBeUndefined();
	});
});
