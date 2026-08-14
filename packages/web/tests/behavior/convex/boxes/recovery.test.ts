import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "@/convex/_generated/api";

import {
	seedBox,
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// What the Repair dialog shows, and the log it shows beside it. Both are
// read-only and both are reached while a box is broken, so the one thing they
// must never do is fail: a recovery page that throws is a page the owner cannot
// use at exactly the moment they need it.

beforeEach(() => {
	stubDeploymentEnv();
	vi.stubEnv("HOST_SSH_USER", "composery");
	vi.stubEnv("HOST_SSH_PRIVATE_KEY", "not-a-key");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function seedRunningBox(t: Harness) {
	const owner = await seedUser(t);
	return await seedBox(t, {
		user_id: owner.clerkUserId,
		slug: "atlas",
		hetzner_ipv4: "1.2.3.4"
	});
}

describe("reporting a box's recovery status", () => {
	// The public probe and the host inspection answer different questions - "is
	// it serving" and "is the machine alive" - and the dialog shows both, so one
	// unreachable layer must not erase the other's answer.
	test("combines the public probe with what the host reported", async () => {
		const t = testConvex();
		const boxId = await seedRunningBox(t);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true }) as Response)
		);

		const status = await t.action(internal.boxes.health.recoveryStatus, {
			boxId
		});

		expect(status).toMatchObject({ httpReachable: true });
		// SSH cannot connect from a test, so the host half degrades rather than
		// throwing - which is the behaviour a broken box depends on.
		expect(status).toMatchObject({ hostReachable: false });
	});

	test("reports a box that answers nothing as unreachable on both layers", async () => {
		const t = testConvex();
		const boxId = await seedRunningBox(t);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connect ETIMEDOUT");
			})
		);

		expect(
			await t.action(internal.boxes.health.recoveryStatus, { boxId })
		).toMatchObject({ hostReachable: false, httpReachable: false });
	});

	// Every component the dialog renders has to be present in the answer, or the
	// page shows an empty row where a state belongs.
	test("names every runtime component the dialog renders", async () => {
		const t = testConvex();
		const boxId = await seedRunningBox(t);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false }) as Response)
		);

		expect(
			Object.keys(
				await t.action(internal.boxes.health.recoveryStatus, { boxId })
			).sort()
		).toEqual([
			"caddy",
			"composery",
			"docker",
			"engine",
			"hostReachable",
			"httpReachable",
			"ide",
			"outerCaddy",
			"persistence"
		]);
	});
});
