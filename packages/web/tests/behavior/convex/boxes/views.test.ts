import { afterEach, describe, expect, test } from "vitest";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
	boxRuntimeStanding,
	latestFailure,
	latestRepair,
	latestUpdate,
	safeBox,
	staffBox
} from "@/convex/boxes/views";
import { type BoxOperationType } from "@/convex/model/box/operation";
import { resolveSnapshotSplit } from "@/convex/model/box/plan";

import {
	seedBox,
	seedSettings,
	seedUser,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

const previousDomain = process.env.CLOUD_DOMAIN;
afterEach(() => {
	if (previousDomain === undefined) delete process.env.CLOUD_DOMAIN;
	else process.env.CLOUD_DOMAIN = previousDomain;
});

function box(overrides: Partial<Doc<"boxes">> = {}): Doc<"boxes"> {
	return {
		_id: "boxes:1" as Doc<"boxes">["_id"],
		_creationTime: 1,
		user_id: "user_1",
		slug: "my-box",
		plan: "air" as const,
		manual_snapshot_cap: 0,
		status: "running",
		polar_customer_id: "cust_1",
		polar_subscription_id: "sub_1",
		runtime_image: "ghcr.io/app:tag",
		runtime_auth_hash: "$argon2id$hash",
		created_at: 1_000,
		updated_at: 2_000,
		...overrides
	} as Doc<"boxes">;
}

describe("safeBox", () => {
	// Exhaustive on purpose. This object is what every box list ships to a
	// browser, so a field added to it has to be added here too - which is the
	// moment to ask whether the owner's page reads it or only the console does.
	test("sends the owner exactly the fields their pages render", () => {
		process.env.CLOUD_DOMAIN = "composery.cloud";
		expect(safeBox(box())).toEqual({
			id: "boxes:1",
			slug: "my-box",
			status: "running",
			runtimeUrl: "https://my-box.composery.cloud/ide/",
			createdAt: 1_000,
			comp: false,
			plan: "air",
			snapshots: resolveSnapshotSplit("air", 0)
		});
	});

	// Billing identifiers and retention dates belong to the console. Nothing on
	// the owner's own pages reads them, and a subscription id is not something to
	// hand a browser for every row of a list just because the row's owner is
	// entitled to it.
	test("keeps billing and retention detail out of the owner's payload", () => {
		process.env.CLOUD_DOMAIN = "composery.cloud";
		const view = safeBox(
			box({ ready_at: 1_500, deleted_at: 9_000, purge_at: 12_000 })
		) as Record<string, unknown>;
		for (const field of [
			"polarSubscriptionId",
			"purgeAt",
			"deletedAt",
			"readyAt",
			"updatedAt",
			"runtimeVersion"
		]) {
			expect(view).not.toHaveProperty(field);
		}
	});

	test("marks a comp box and nulls its absent subscription for staff", () => {
		process.env.CLOUD_DOMAIN = "composery.cloud";
		const overrides = {
			polar_customer_id: undefined,
			polar_subscription_id: undefined,
			comped_by: "user_staff",
			comped_at: 5_000,
			comp_reason: "beta tester"
		};
		expect(safeBox(box(overrides)).comp).toBe(true);
		const staff = staffBox(box(overrides));
		expect(staff.polarSubscriptionId).toBeNull();
		expect(staff.polarCustomerId).toBeNull();
		expect(staff.compedBy).toBe("user_staff");
		expect(staff.compReason).toBe("beta tester");
	});

	test("keeps a deleted box's status but drops its unreachable url for staff", () => {
		process.env.CLOUD_DOMAIN = "composery.cloud";
		const staff = staffBox(
			box({ deleted_at: 9_000, purge_at: 12_000, status: "deleted" })
		);
		expect(staff.status).toBe("deleted");
		expect(staff.deletedAt).toBe(9_000);
		expect(staff.purgeAt).toBe(12_000);
		expect(staff.runtimeUrl).toBeNull();
	});
});

describe("staffBox", () => {
	test("extends safeBox with infra + owner fields, falling back to empty email", () => {
		process.env.CLOUD_DOMAIN = ".composery.cloud.";
		const view = staffBox(
			box({
				hetzner_server_id: 42,
				hetzner_server_type: "cx23",
				hetzner_location: "nbg1",
				hetzner_ipv4: "203.0.113.1",
				hetzner_ipv6: "2001:db8::1/64",
				dns_record_id: "rec-a",
				dns_record_aaaa_id: "rec-aaaa"
			})
		);
		expect(view.runtimeUrl).toBe("https://my-box.composery.cloud/ide/");
		expect(view.userId).toBe("user_1");
		expect(view.userEmail).toBe("");
		expect(view.hetznerServerId).toBe(42);
		expect(view.hetznerServerType).toBe("cx23");
		expect(view.hetznerLocation).toBe("nbg1");
		expect(view.hetznerIpv4).toBe("203.0.113.1");
		expect(view.dnsRecordId).toBe("rec-a");
	});

	test("attaches the owner email when the user row is supplied", () => {
		process.env.CLOUD_DOMAIN = "composery.cloud";
		const view = staffBox(box(), {
			_id: "users:1" as never,
			_creationTime: 1,
			clerk_user_id: "user_1",
			email: "name@example.com",
			role: "user",
			suspended: false,
			created_at: 0,
			updated_at: 0
		} as Doc<"users">);
		expect(view.userEmail).toBe("name@example.com");
	});
});

// The database-reading half of this module. Every box page reads its progress
// and its failure notice from these three, and none of them was exercised: the
// pure projections above were, and being in the same file made that look like
// the module was covered.
describe("reading a box's recent operations", () => {
	async function seedOperation(
		t: Harness,
		boxId: Id<"boxes">,
		operation: {
			type: BoxOperationType;
			status: "pending" | "running" | "succeeded" | "failed";
			createdAt: number;
			error?: string;
			finishedAt?: number;
		}
	) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: operation.type,
					status: operation.status,
					idempotency_key: `${operation.type}:${operation.createdAt}`,
					trigger: "owner",
					last_error: operation.error,
					finished_at: operation.finishedAt,
					created_at: operation.createdAt,
					updated_at: operation.createdAt
				})
		);
	}

	async function seedOwnedBox(t: Harness) {
		const owner = await seedUser(t);
		return await seedBox(t, { user_id: owner.clerkUserId });
	}

	test("summarises the most recent operation of the type asked for", async () => {
		const t = testConvex();
		const boxId = await seedOwnedBox(t);
		await seedOperation(t, boxId, {
			type: "repair",
			status: "succeeded",
			createdAt: 1
		});
		await seedOperation(t, boxId, {
			type: "repair",
			status: "failed",
			createdAt: 2,
			error: "ssh refused",
			finishedAt: 3
		});

		expect(await t.run((ctx) => latestRepair(ctx.db, boxId))).toEqual({
			status: "failed",
			error: "ssh refused",
			finishedAt: 3
		});
	});

	// Repair and Update read the same helper with different types, so an argument
	// that went astray would have each dialog reporting the other's outcome.
	test("never answers with another operation type", async () => {
		const t = testConvex();
		const boxId = await seedOwnedBox(t);
		await seedOperation(t, boxId, {
			type: "repair",
			status: "failed",
			createdAt: 1,
			error: "repair error"
		});
		await seedOperation(t, boxId, {
			type: "update",
			status: "succeeded",
			createdAt: 2
		});

		expect(await t.run((ctx) => latestUpdate(ctx.db, boxId))).toMatchObject({
			status: "succeeded"
		});
		expect(await t.run((ctx) => latestRepair(ctx.db, boxId))).toMatchObject({
			error: "repair error"
		});
	});

	test("says nothing about an operation type the box has never run", async () => {
		const t = testConvex();
		const boxId = await seedOwnedBox(t);

		expect(await t.run((ctx) => latestUpdate(ctx.db, boxId))).toBeNull();
	});

	// The failure notice is deliberately about the *latest* operation, not the
	// latest failure: something that succeeded afterwards means the box is fine
	// now, and a notice that outlived its cause is one owners learn to ignore.
	describe("the failure notice a box shows", () => {
		test("reports the latest operation when it failed", async () => {
			const t = testConvex();
			const boxId = await seedOwnedBox(t);
			await seedOperation(t, boxId, {
				type: "reset",
				status: "failed",
				createdAt: 5,
				error: "the host never answered",
				finishedAt: 6
			});

			expect(await t.run((ctx) => latestFailure(ctx.db, boxId))).toEqual({
				type: "reset",
				error: "the host never answered",
				finishedAt: 6
			});
		});

		test("clears itself as soon as anything else finishes", async () => {
			const t = testConvex();
			const boxId = await seedOwnedBox(t);
			await seedOperation(t, boxId, {
				type: "reset",
				status: "failed",
				createdAt: 5,
				error: "boom"
			});
			await seedOperation(t, boxId, {
				type: "stop",
				status: "succeeded",
				createdAt: 6
			});

			expect(await t.run((ctx) => latestFailure(ctx.db, boxId))).toBeNull();
		});

		test("stays quiet while an operation is still running", async () => {
			const t = testConvex();
			const boxId = await seedOwnedBox(t);
			await seedOperation(t, boxId, {
				type: "repair",
				status: "running",
				createdAt: 5
			});

			expect(await t.run((ctx) => latestFailure(ctx.db, boxId))).toBeNull();
		});

		// A failure with nothing recorded still has to be reported, because the
		// status alone is what an owner would otherwise be left staring at.
		test("reports a failure that recorded no reason", async () => {
			const t = testConvex();
			const boxId = await seedOwnedBox(t);
			await seedOperation(t, boxId, {
				type: "restore",
				status: "failed",
				createdAt: 5
			});

			expect(await t.run((ctx) => latestFailure(ctx.db, boxId))).toEqual({
				type: "restore",
				error: null,
				finishedAt: null
			});
		});

		test("says nothing for a box that has never run an operation", async () => {
			const t = testConvex();
			const boxId = await seedOwnedBox(t);

			expect(await t.run((ctx) => latestFailure(ctx.db, boxId))).toBeNull();
		});
	});
});

// One reading of the fleet release, so the owner page and the console cannot
// disagree about whether a box is behind or overdue.
describe("a box's runtime standing", () => {
	test("compares the box against the cached fleet release and floor", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			runtime_image: "sha256:old",
			runtime_version: "1.0.0"
		});
		await seedSettings(t, {
			runtime_release: {
				image: "sha256:new",
				version: "1.1.0",
				checked_at: 1
			},
			minimum_runtime_image: "sha256:new",
			minimum_runtime_deadline: 4_000
		});

		expect(
			await t.run(async (ctx) => {
				const box = await ctx.db.get(boxId);
				return await boxRuntimeStanding(ctx.db, box!);
			})
		).toEqual({
			updateAvailable: true,
			comparable: true,
			availableVersion: "1.1.0",
			currentVersion: "1.0.0",
			required: true,
			requiredBy: 4_000
		});
	});

	// No cached release is "not known", never "you are current" - the difference
	// is what stops the interface reporting a check it never made.
	test("reports an uncomparable box rather than calling it up to date", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			runtime_image: "sha256:old"
		});
		await seedSettings(t);

		expect(
			await t.run(async (ctx) => {
				const box = await ctx.db.get(boxId);
				return await boxRuntimeStanding(ctx.db, box!);
			})
		).toMatchObject({
			comparable: false,
			updateAvailable: false,
			required: false,
			requiredBy: null
		});
	});
});
