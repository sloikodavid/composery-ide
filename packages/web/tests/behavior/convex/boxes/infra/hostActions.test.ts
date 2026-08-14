import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { HOST_SSH_PORT } from "@/convex/boxes/infra/artifacts";
import {
	seedBox,
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../../support/convex.ts";

const ssh = vi.hoisted(() => ({
	calls: [] as {
		command: string;
		options?: { maxOutputBytes?: number; timeoutMs?: number };
		target: { host: string; privateKey: string; username: string };
	}[],
	error: undefined as Error | undefined,
	stderr: "",
	stdout: ""
}));

vi.mock("@/convex/boxes/infra/hostTransport", () => ({
	runSsh: vi.fn(
		async (
			target: (typeof ssh.calls)[number]["target"],
			command: string,
			options?: (typeof ssh.calls)[number]["options"]
		) => {
			ssh.calls.push({ command, options, target });
			if (ssh.error) throw ssh.error;
			return { stderr: ssh.stderr, stdout: ssh.stdout };
		}
	)
}));

beforeEach(() => {
	ssh.calls.length = 0;
	ssh.error = undefined;
	ssh.stderr = "";
	ssh.stdout = "";
	stubDeploymentEnv();
	vi.stubEnv("HOST_SSH_PRIVATE_KEY", "private");
	vi.stubEnv("HOST_SSH_USER", "composery");
	vi.stubEnv("RUNTIME_PORT", "8080");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

async function box(t: Harness, seed: Record<string, unknown> = {}) {
	const owner = await seedUser(t);
	return await seedBox(t, {
		user_id: owner.clerkUserId,
		slug: "atlas",
		hetzner_ipv4: "1.2.3.4",
		runtime_image: "ghcr.io/composery/composery@sha256:current",
		runtime_auth_hash: "$argon2id$current",
		...seed
	});
}

const sent = () => ssh.calls.map((call) => call.command).join("\n");

describe("writing a box's runtime files", () => {
	test("uses the recorded image for repair and the requested image for update", async () => {
		const t = testConvex();
		const boxId = await box(t);

		await t.action(internal.boxes.infra.host.repairRuntime, { boxId });
		expect(sent()).toContain("sha256:current");
		expect(sent()).toContain("--force-recreate");
		expect(ssh.calls[0].target).toEqual({
			host: "1.2.3.4",
			// The host's own sshd moved off 22 so the instance could have it.
			port: HOST_SSH_PORT,
			privateKey: "private",
			username: "composery"
		});

		ssh.calls.length = 0;
		await t.action(internal.boxes.infra.host.updateRuntime, {
			boxId,
			runtimeImage: "ghcr.io/composery/composery@sha256:next"
		});
		expect(sent()).toContain("sha256:next");
		expect(sent()).not.toContain("sha256:current");
		expect(sent()).not.toContain("--force-recreate");
	});

	test("bootstraps without waiting for the workflow's readiness check", async () => {
		const t = testConvex();
		const boxId = await box(t);

		await t.action(internal.boxes.infra.host.bootstrapRuntime, { boxId });
		expect(sent()).not.toContain(
			"The runtime came up but its editor never started"
		);
	});

	test("applies the supplied configuration", async () => {
		const t = testConvex();
		const boxId = await box(t);

		await t.action(internal.boxes.infra.host.applyRuntimeConfig, {
			boxId,
			config: { COMPOSERY_DISABLE_FILE_UPLOADS: "1" }
		});
		expect(sent()).toContain("COMPOSERY_DISABLE_FILE_UPLOADS");
	});

	test("rewrites the complete environment with the new password", async () => {
		const t = testConvex();
		const boxId = await box(t, {
			runtime_config: { COMPOSERY_DISABLE_FILE_UPLOADS: "1" }
		});

		await t.action(internal.boxes.infra.host.rewritePasswordAndRestart, {
			boxId,
			runtimeAuthHash: "$argon2id$new"
		});
		expect(sent()).toContain("$argon2id$new");
		expect(sent()).not.toContain("$argon2id$current");
		expect(sent()).toContain("COMPOSERY_DISABLE_FILE_UPLOADS");
		expect(sent()).toContain("sha256:current");
		expect(sent()).toContain(boxId);
	});

	test("reloads Caddy on the requested slug", async () => {
		const t = testConvex();
		const boxId = await box(t);

		await t.action(internal.boxes.infra.host.reloadSlug, {
			boxId,
			newSlug: "renamed"
		});
		expect(sent()).toContain("renamed.dev.composery.cloud");
	});
});

describe("inspecting and reading a box", () => {
	const inspect = (t: Harness, boxId: Id<"boxes">) =>
		t.action(internal.boxes.infra.host.inspectRuntime, { boxId });

	test("parses inspection output and turns connection failure into unreachable", async () => {
		const t = testConvex();
		const boxId = await box(t);
		ssh.stdout = [
			"host_reachable=true",
			"engine=overlay",
			"docker=active",
			"outer_caddy=active",
			"composery=active",
			"persistence=active",
			"caddy=active",
			"ide=active"
		].join("\n");
		await expect(inspect(t, boxId)).resolves.toMatchObject({
			hostReachable: true,
			ide: "active"
		});

		ssh.error = new Error("connection refused");
		await expect(inspect(t, boxId)).resolves.toMatchObject({
			hostReachable: false
		});
	});

	test("returns logs and clamps their requested tail", async () => {
		const t = testConvex();
		const boxId = await box(t);
		ssh.stdout = "editor listening on 8080";

		await expect(
			t.action(internal.boxes.infra.host.fetchRuntimeLogs, {
				boxId,
				tail: 1_000_000
			})
		).resolves.toContain("editor listening");
		expect(sent()).toContain("5000");
		expect(sent()).not.toContain("1000000");
	});
});

describe("parking a box's files", () => {
	test("stops on a copy difference and names its direction", async () => {
		const t = testConvex();
		const boxId = await box(t);
		ssh.stdout = ["home/user/notes.md", "home/user/project/main.rs"].join("\n");

		await expect(
			t.action(internal.boxes.infra.host.verifyParkingCopy, {
				boxId,
				volumeId: 909
			})
		).rejects.toThrow("verification (out) found 2 difference(s)");
		await expect(
			t.action(internal.boxes.infra.host.verifyParkingBack, {
				boxId,
				volumeId: 909
			})
		).rejects.toThrow("verification (back)");
	});

	test("allows an exact parking copy", async () => {
		const t = testConvex();
		const boxId = await box(t);
		await expect(
			t.action(internal.boxes.infra.host.verifyParkingCopy, {
				boxId,
				volumeId: 909
			})
		).resolves.toBeNull();
	});

	test("uses the rescue root account for the copy and its verification", async () => {
		const t = testConvex();
		const boxId = await box(t);
		await t.action(internal.boxes.infra.host.copyToParking, {
			boxId,
			volumeId: 909
		});
		await t.action(internal.boxes.infra.host.verifyParkingCopy, {
			boxId,
			volumeId: 909
		});
		expect(ssh.calls.map((call) => call.target.username)).toEqual([
			"root",
			"root"
		]);
	});
});

describe("SSH command policy", () => {
	test.each([
		["inspectRuntime", {}, 64 * 1024, 20_000, ""],
		["copyToParking", { volumeId: 9 }, undefined, 60 * 60_000, ""],
		["copyFromParking", { volumeId: 9 }, undefined, 60 * 60_000, ""],
		["verifyParkingCopy", { volumeId: 9 }, 4 * 1024 * 1024, 60 * 60_000, ""],
		["unmountParking", {}, undefined, 5 * 60_000, ""],
		["unmountParkingFromRescue", {}, undefined, 5 * 60_000, ""]
	] as const)(
		"gives %s its bounded transport policy",
		async (action, args, maxOutputBytes, timeoutMs, stdout) => {
			const t = testConvex();
			const boxId = await box(t);
			ssh.stdout = stdout;
			await t.action(internal.boxes.infra.host[action], {
				boxId,
				...args
			} as never);
			expect(ssh.calls.at(-1)?.options).toEqual({
				...(maxOutputBytes ? { maxOutputBytes } : {}),
				timeoutMs
			});
		}
	);
});

describe("an action against a box with no host", () => {
	test.each([
		["repairRuntime", {}],
		["updateRuntime", { runtimeImage: "ghcr.io/team/image@sha256:next" }],
		["bootstrapRuntime", {}],
		["applyRuntimeConfig", { config: {} }],
		["rewritePasswordAndRestart", { runtimeAuthHash: "$argon2id$new" }],
		["fetchRuntimeLogs", { tail: 100 }],
		["reloadSlug", { newSlug: "renamed" }],
		["copyToParking", { volumeId: 9 }],
		["copyFromParking", { volumeId: 9 }],
		["verifyParkingCopy", { volumeId: 9 }],
		["verifyParkingBack", { volumeId: 9 }],
		["unmountParking", {}],
		["unmountParkingFromRescue", {}]
	] as const)(
		"refuses %s before opening a connection",
		async (action, args) => {
			const t = testConvex();
			const boxId = await box(t, { hetzner_ipv4: undefined });

			await expect(
				t.action(internal.boxes.infra.host[action], {
					boxId,
					...args
				} as never)
			).rejects.toThrow(/Hetzner IPv4|reachable host/);
			expect(ssh.calls).toEqual([]);
		}
	);

	test("reports an inspection without a host as unreachable", async () => {
		const t = testConvex();
		const boxId = await box(t, { hetzner_ipv4: undefined });
		await expect(
			t.action(internal.boxes.infra.host.inspectRuntime, { boxId })
		).resolves.toMatchObject({ hostReachable: false });
		expect(ssh.calls).toEqual([]);
	});
});
