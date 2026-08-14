import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "@/convex/_generated/api";
import { BOX_OPERATIONS } from "@/convex/model/box/operation";
import { FLOOR_UPDATE_STATUSES } from "@/convex/boxes/version";

import {
	boxOperations,
	seedBox,
	seedSettings,
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// The one path that recreates an owner's container without them asking. Two
// things have to hold and neither is visible from the outside: it must not fire
// before staff have set both a floor and a deadline, and once it does fire it
// must keep firing until the box is actually across the floor.

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const FLOOR_IMAGE = "ghcr.io/composery/composery@sha256:floor";
const OLD_IMAGE = "ghcr.io/composery/composery@sha256:old";

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

async function seedFloor(
	t: Harness,
	settings: { deadline?: number; image?: string } = {}
) {
	await seedSettings(t, {
		minimum_runtime_image: settings.image ?? FLOOR_IMAGE,
		minimum_runtime_deadline: settings.deadline
	});
}

async function seedBoxBelowFloor(
	t: Harness,
	overrides: { slug: string; status?: "running" | "update_failed" }
) {
	const owner = await seedUser(t, { clerkUserId: `user_${overrides.slug}` });
	return await seedBox(t, {
		user_id: owner.clerkUserId,
		slug: overrides.slug,
		status: overrides.status ?? "running",
		runtime_image: OLD_IMAGE
	});
}

function pastDeadline(t: Harness) {
	return t.query(internal.boxes.version.boxesPastFloorDeadline, {});
}

describe("selecting boxes past the floor deadline", () => {
	// The sweep reads this rather than listing statuses of its own, so a status
	// added to the operation table is swept on the day it is added. It queried
	// `running` alone and filtered on this same table afterwards, which is a
	// filter no row could fail - and it hid `update_failed` completely.
	test("sweeps exactly the statuses an update may begin from", () => {
		expect(FLOOR_UPDATE_STATUSES).toBe(BOX_OPERATIONS.update.from);
		expect(FLOOR_UPDATE_STATUSES).toContain("update_failed");
	});

	test("selects a running box below the floor once the deadline has passed", async () => {
		const t = testConvex();
		await seedFloor(t, { deadline: NOW - 1 });
		const boxId = await seedBoxBelowFloor(t, { slug: "behind" });

		expect(await pastDeadline(t)).toEqual([boxId]);
	});

	// The failure mode this whole file exists for. A forced update that fails
	// leaves the box in `update_failed`; if the sweep cannot see that status, the
	// box stays below a mandatory floor for ever with nothing retrying it.
	test("still selects a box whose previous forced update failed", async () => {
		const t = testConvex();
		await seedFloor(t, { deadline: NOW - 1 });
		const boxId = await seedBoxBelowFloor(t, {
			slug: "failed-before",
			status: "update_failed"
		});

		expect(await pastDeadline(t)).toEqual([boxId]);
	});

	test("selects nothing before the deadline", async () => {
		const t = testConvex();
		await seedFloor(t, { deadline: NOW + 1 });
		await seedBoxBelowFloor(t, { slug: "behind" });

		expect(await pastDeadline(t)).toEqual([]);
	});

	// A floor with an image but no date announces itself in the interface and
	// never acts, which is what makes setting one ahead of enforcing it safe.
	test("selects nothing when a floor has no deadline", async () => {
		const t = testConvex();
		await seedFloor(t);
		await seedBoxBelowFloor(t, { slug: "behind" });

		expect(await pastDeadline(t)).toEqual([]);
	});

	test("selects nothing when no floor is set at all", async () => {
		const t = testConvex();
		await seedSettings(t);
		await seedBoxBelowFloor(t, { slug: "behind" });

		expect(await pastDeadline(t)).toEqual([]);
	});

	test("leaves a box already on the floor image alone", async () => {
		const t = testConvex();
		await seedFloor(t, { deadline: NOW - 1 });
		const owner = await seedUser(t);
		await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "current",
			runtime_image: FLOOR_IMAGE
		});

		expect(await pastDeadline(t)).toEqual([]);
	});

	// A box with no recorded image cannot be compared, and `runtimeStanding`
	// refuses to call an unknown box non-compliant. Forcing an update on one
	// would recreate a container from an image nobody has established it is on.
	test("leaves a box with no recorded image alone", async () => {
		const t = testConvex();
		await seedFloor(t, { deadline: NOW - 1 });
		const owner = await seedUser(t);
		await seedBox(t, { user_id: owner.clerkUserId, slug: "unknown" });

		expect(await pastDeadline(t)).toEqual([]);
	});

	// Statuses outside the operation table: a stopped host cannot answer over SSH
	// and a box mid-operation must not have an update queued behind it.
	test("leaves a stopped box alone", async () => {
		const t = testConvex();
		await seedFloor(t, { deadline: NOW - 1 });
		const owner = await seedUser(t);
		await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "stopped",
			status: "stopped",
			runtime_image: OLD_IMAGE
		});

		expect(await pastDeadline(t)).toEqual([]);
	});
});

describe("updating boxes past the floor deadline", () => {
	test("starts one update per selected box, recording why", async () => {
		const t = testConvex();
		await seedFloor(t, { deadline: NOW - 1 });
		const boxId = await seedBoxBelowFloor(t, { slug: "behind" });

		await t.action(internal.boxes.version.updateBoxesPastDeadline, {});

		expect(await boxOperations(t, boxId)).toMatchObject([
			{
				type: "update",
				trigger: "system:runtime_floor",
				metadata: { reason: "minimum_runtime_version" }
			}
		]);
	});

	// One unreachable or ineligible box must not stop the rest of the fleet from
	// crossing the floor, so a refusal is swallowed per box rather than aborting.
	test("keeps going when one box refuses the operation", async () => {
		const t = testConvex();
		await seedFloor(t, { deadline: NOW - 1 });
		const busy = await seedBoxBelowFloor(t, { slug: "busy" });
		const free = await seedBoxBelowFloor(t, { slug: "free" });
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: busy,
					type: "reset",
					status: "running",
					idempotency_key: "held",
					trigger: "owner",
					created_at: NOW,
					updated_at: NOW
				})
		);

		await t.action(internal.boxes.version.updateBoxesPastDeadline, {});

		expect(await boxOperations(t, free)).toMatchObject([{ type: "update" }]);
		expect(await boxOperations(t, busy)).toMatchObject([{ type: "reset" }]);
	});

	// The key covers an update that is still in flight and nothing more, which is
	// what lets the next hourly run retry a box whose update failed.
	test("does not queue a second update behind one already running", async () => {
		const t = testConvex();
		await seedFloor(t, { deadline: NOW - 1 });
		const boxId = await seedBoxBelowFloor(t, { slug: "behind" });

		await t.action(internal.boxes.version.updateBoxesPastDeadline, {});
		await t.action(internal.boxes.version.updateBoxesPastDeadline, {});

		expect(await boxOperations(t, boxId)).toHaveLength(1);
	});
});

// The key is per box, so two boxes below the floor are two updates. An empty or
// shared key would make the first box in a sweep the only one that ever crosses.
describe("keying one update per box", () => {
	test("starts an update for every box past the deadline", async () => {
		const t = testConvex();
		await seedFloor(t, { deadline: NOW - 1 });
		const first = await seedBoxBelowFloor(t, { slug: "first" });
		const second = await seedBoxBelowFloor(t, { slug: "second" });

		await t.action(internal.boxes.version.updateBoxesPastDeadline, {});

		expect(await boxOperations(t, first)).toMatchObject([{ type: "update" }]);
		expect(await boxOperations(t, second)).toMatchObject([{ type: "update" }]);
	});
});
