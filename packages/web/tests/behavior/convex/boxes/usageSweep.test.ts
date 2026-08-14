import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

import {
	seedBox,
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// The hourly sweep that asks every running box how full its disk is.
//
// A file of its own rather than part of `usage.test.ts` because it needs the SSH
// transport mocked, and mocking a module affects the whole file: the recording
// tests next door assert what the mutations do with a reading, and they must not
// be run against a host that only exists because this file stubbed one.
//
// What it has to get right is what a sweep always has to get right - it runs
// unattended, over the whole fleet, and one box must never be able to stop it.

const ssh = vi.hoisted(() => ({
	byHost: new Map<string, string>(),
	failing: new Set<string>()
}));

vi.mock("@/convex/boxes/infra/hostTransport", () => ({
	runSsh: vi.fn(async (target: { host: string }) => {
		if (ssh.failing.has(target.host)) {
			throw new Error(`connection refused for ${target.host}`);
		}
		return { stderr: "", stdout: ssh.byHost.get(target.host) ?? "" };
	})
}));

const NOW = Date.UTC(2026, 7, 2, 9, 0, 0);

beforeEach(() => {
	ssh.byHost.clear();
	ssh.failing.clear();
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
	vi.stubEnv("HOST_SSH_PRIVATE_KEY", "private");
	vi.stubEnv("HOST_SSH_USER", "composery");
	vi.stubEnv("RUNTIME_PORT", "8080");
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

// One key per line, joined rather than written as one escaped literal: an
// escaped newline joins the line before it to the line after for anything
// reading this file as text.
function df(usedBytes: number, totalBytes: number) {
	return [`disk_total_bytes=${totalBytes}`, `disk_used_bytes=${usedBytes}`]
		.map((line) => `${line}\n`)
		.join("");
}

async function runningBox(
	t: Harness,
	slug: string,
	ipv4: string,
	status: "running" | "stopped" = "running"
) {
	const owner = await seedUser(t, { clerkUserId: `clerk_${slug}` });
	return await seedBox(t, {
		user_id: owner.clerkUserId,
		slug,
		status,
		hetzner_ipv4: ipv4
	});
}

function usageRows(t: Harness, boxId: Id<"boxes">) {
	return t.run(
		async (ctx) =>
			await ctx.db
				.query("box_usage")
				.withIndex("box_id_signal", (query) => query.eq("box_id", boxId))
				.collect()
	);
}

describe("the disk usage sweep", () => {
	test("records what each running box reported", async () => {
		const t = testConvex();
		const boxId = await runningBox(t, "atlas", "1.2.3.4");
		ssh.byHost.set("1.2.3.4", df(30_000_000_000, 40_000_000_000));

		await t.action(internal.boxes.usage.sweepBoxDiskUsage, {});

		expect(await usageRows(t, boxId)).toMatchObject([
			{
				signal: "disk",
				used_bytes: 30_000_000_000,
				allowance_bytes: 40_000_000_000,
				sampled_at: NOW
			}
		]);
	});

	// A stopped box has a powered-off host. Asking it would fail, and a failure
	// recorded as a reading would replace a real figure with nothing.
	test("leaves a box that is not running alone", async () => {
		const t = testConvex();
		const boxId = await runningBox(t, "parked", "5.6.7.8", "stopped");
		ssh.byHost.set("5.6.7.8", df(1, 2));

		await t.action(internal.boxes.usage.sweepBoxDiskUsage, {});

		expect(await usageRows(t, boxId)).toEqual([]);
	});

	// The property every unattended sweep owes: one unreachable host must not mean
	// the fleet stops being measured.
	test("finishes the fleet when a host refuses the connection", async () => {
		const t = testConvex();
		const broken = await runningBox(t, "broken", "1.1.1.1");
		const healthy = await runningBox(t, "healthy", "2.2.2.2");
		ssh.failing.add("1.1.1.1");
		ssh.byHost.set("2.2.2.2", df(10, 100));

		await t.action(internal.boxes.usage.sweepBoxDiskUsage, {});

		expect(await usageRows(t, broken)).toEqual([]);
		expect(await usageRows(t, healthy)).toHaveLength(1);
	});

	// An unreadable answer is not an empty disk. The last real reading stays on
	// the page with its own timestamp, which is a truthful "this is what we last
	// saw" rather than a claim about a box nobody could measure.
	test("keeps the last real reading when a host answers with nonsense", async () => {
		const t = testConvex();
		const boxId = await runningBox(t, "atlas", "1.2.3.4");
		ssh.byHost.set("1.2.3.4", df(30_000_000_000, 40_000_000_000));
		await t.action(internal.boxes.usage.sweepBoxDiskUsage, {});

		ssh.byHost.set("1.2.3.4", "df: /: No such file or directory\n");
		await t.action(internal.boxes.usage.sweepBoxDiskUsage, {});

		expect(await usageRows(t, boxId)).toMatchObject([
			{ used_bytes: 30_000_000_000 }
		]);
	});

	test("asks nothing of a box with no host recorded", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "running",
			hetzner_ipv4: undefined
		});

		await t.action(internal.boxes.usage.sweepBoxDiskUsage, {});

		expect(await usageRows(t, boxId)).toEqual([]);
	});
});
