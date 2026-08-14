import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "@/convex/_generated/api";

import {
	boxOperations,
	seedBox,
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// Suspension starts real box operations, so the clock is pinned the way the
// other operation suites pin it.
const NOW = Date.UTC(2026, 5, 6, 7, 8, 9);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

// Suspension is the moderation control, and the two rules on it are the ones
// that decide whether the console can be used to lock the console out: an admin
// must not suspend themselves, and must not suspend another admin. Neither rule
// had a test, and neither fails visibly - a broken one only shows up as an
// account nobody can reach.

function suspensionOf(t: Harness, clerkUserId: string) {
	return t.run(async (ctx) => {
		const user = await ctx.db
			.query("users")
			.withIndex("clerk_user_id", (query) =>
				query.eq("clerk_user_id", clerkUserId)
			)
			.first();
		return {
			suspended: user?.suspended,
			suspendedAt: user?.suspended_at,
			suspendedReason: user?.suspended_reason
		};
	});
}

describe("suspending an account", () => {
	test("records the reason and when it happened", async () => {
		const t = testConvex();
		const admin = await seedUser(t, { clerkUserId: "admin", role: "admin" });
		const customer = await seedUser(t, { clerkUserId: "customer" });

		await t.mutation(internal.staff.users.setUserSuspension, {
			callerClerkUserId: admin.clerkUserId,
			clerkUserId: customer.clerkUserId,
			reason: "chargeback pending",
			suspended: true
		});

		expect(await suspensionOf(t, customer.clerkUserId)).toEqual({
			suspended: true,
			suspendedAt: expect.any(Number),
			suspendedReason: "chargeback pending"
		});
	});

	// Lifting a suspension clears the note with it. A stale reason on a live
	// account is a sentence the console would keep showing about something that
	// is no longer true.
	test("clears the reason when the suspension is lifted", async () => {
		const t = testConvex();
		const admin = await seedUser(t, { clerkUserId: "admin", role: "admin" });
		const customer = await seedUser(t, {
			clerkUserId: "customer",
			suspended: true,
			suspendedReason: "chargeback pending"
		});

		await t.mutation(internal.staff.users.setUserSuspension, {
			callerClerkUserId: admin.clerkUserId,
			clerkUserId: customer.clerkUserId,
			suspended: false
		});

		expect(await suspensionOf(t, customer.clerkUserId)).toEqual({
			suspended: false,
			suspendedAt: undefined,
			suspendedReason: undefined
		});
	});

	test("refuses to suspend the account doing the suspending", async () => {
		const t = testConvex();
		const admin = await seedUser(t, { clerkUserId: "admin", role: "admin" });

		await expect(
			t.mutation(internal.staff.users.setUserSuspension, {
				callerClerkUserId: admin.clerkUserId,
				clerkUserId: admin.clerkUserId,
				suspended: true
			})
		).rejects.toThrow(/your own account/i);
		expect((await suspensionOf(t, admin.clerkUserId)).suspended).toBe(false);
	});

	test("refuses to suspend another staff account", async () => {
		const t = testConvex();
		const admin = await seedUser(t, { clerkUserId: "admin", role: "admin" });
		const other = await seedUser(t, { clerkUserId: "other", role: "admin" });

		await expect(
			t.mutation(internal.staff.users.setUserSuspension, {
				callerClerkUserId: admin.clerkUserId,
				clerkUserId: other.clerkUserId,
				suspended: true
			})
		).rejects.toThrow(/Staff accounts/i);
	});

	// Unsuspending is not moderation of a person, so neither rule applies to it -
	// an admin locked out by an earlier mistake has to be reachable.
	test("still lifts a suspension from a staff account", async () => {
		const t = testConvex();
		const admin = await seedUser(t, { clerkUserId: "admin", role: "admin" });
		const other = await seedUser(t, {
			clerkUserId: "other",
			role: "admin",
			suspended: true
		});

		await t.mutation(internal.staff.users.setUserSuspension, {
			callerClerkUserId: admin.clerkUserId,
			clerkUserId: other.clerkUserId,
			suspended: false
		});

		expect((await suspensionOf(t, other.clerkUserId)).suspended).toBe(false);
	});

	test("refuses an identity with no account", async () => {
		const t = testConvex();
		const admin = await seedUser(t, { clerkUserId: "admin", role: "admin" });

		await expect(
			t.mutation(internal.staff.users.setUserSuspension, {
				callerClerkUserId: admin.clerkUserId,
				clerkUserId: "never-signed-in",
				suspended: true
			})
		).rejects.toThrow(/User not found/);
	});

	test("refuses the public action to a customer", async () => {
		const t = testConvex();
		const customer = await seedUser(t, { clerkUserId: "customer" });

		await expect(
			customer.as.action(api.staff.users.setUserSuspended, {
				clerkUserId: "someone",
				suspended: true
			})
		).rejects.toThrow(/Staff access required/);
	});
});

// Suspending an account is two things at once: the account row, and every box
// that account still has running. Doing the first without the second leaves a
// suspended customer's machines serving - which is the whole point of the
// suspension - so the sweep over their boxes is the part that matters.
describe("what suspending an account does to its boxes", () => {
	async function cast(t: Harness) {
		const admin = await seedUser(t, {
			clerkUserId: "admin",
			email: "admin@example.com",
			role: "admin"
		});
		const customer = await seedUser(t, {
			clerkUserId: "customer",
			email: "customer@example.com"
		});
		return { admin, customer };
	}

	const suspend = (
		admin: Awaited<ReturnType<typeof seedUser>>,
		over: Record<string, unknown> = {}
	) =>
		admin.as.action(api.staff.users.setUserSuspended, {
			clerkUserId: "customer",
			suspended: true,
			reason: "abuse report",
			...over
		});

	test("marks the account and suspends every running box it has", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxes = [];
		for (const slug of ["one", "two"]) {
			boxes.push(
				await seedBox(t, {
					user_id: customer.clerkUserId,
					slug,
					status: "running"
				})
			);
		}

		await suspend(admin);

		for (const boxId of boxes) {
			expect(await boxOperations(t, boxId)).toMatchObject([
				{ type: "suspend", trigger: "staff" }
			]);
		}
	});

	// A box that is already stopped is not running, so there is nothing to
	// suspend - and starting one would be an operation on a box nobody asked
	// about.
	test.each(["stopped", "suspended", "deleted", "creating"] as const)(
		"leaves a %s box alone",
		async (status) => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const boxId = await seedBox(t, {
				user_id: customer.clerkUserId,
				slug: "quiet",
				status
			});

			await suspend(admin);

			expect(await boxOperations(t, boxId)).toEqual([]);
		}
	);

	// Lifting a suspension is the mirror image: it acts on the boxes the
	// suspension stopped, and on nothing else.
	test("unsuspends the boxes the suspension stopped", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const suspended = await seedBox(t, {
			user_id: customer.clerkUserId,
			slug: "held",
			status: "suspended"
		});
		const running = await seedBox(t, {
			user_id: customer.clerkUserId,
			slug: "fine",
			status: "running"
		});

		await suspend(admin, { suspended: false, reason: undefined });

		expect(await boxOperations(t, suspended)).toMatchObject([
			{ type: "unsuspend", trigger: "staff" }
		]);
		expect(await boxOperations(t, running)).toEqual([]);
	});

	// The reason belongs to the suspension, not to lifting it.
	test("carries the reason onto the suspension it starts", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			slug: "one",
			status: "running"
		});

		await suspend(admin);

		expect(await boxOperations(t, boxId)).toMatchObject([
			{ metadata: { reason: "abuse report" } }
		]);
	});

	// A customer with more boxes than one page still has all of them acted on.
	// A sweep that stopped at the first page would leave the rest serving while
	// the account reads as suspended.
	test("walks past the first page of a customer's boxes", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		await t.run(async (ctx) => {
			for (let index = 0; index < 101; index += 1) {
				await ctx.db.insert("boxes", {
					user_id: customer.clerkUserId,
					slug: `bulk-${index}`,
					plan: "air",
					manual_snapshot_cap: 0,
					status: "running",
					created_at: 1,
					updated_at: 1
				});
			}
		});

		await suspend(admin);

		const operations = await t.run((ctx) =>
			ctx.db.query("box_operations").collect()
		);
		expect(operations).toHaveLength(101);
	});

	// The account is marked first, so a suspension whose box actions fail still
	// leaves the customer locked out - and says how many boxes did not follow.
	test("reports the boxes it could not act on, having still marked the account", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			slug: "busy",
			status: "running"
		});
		// An operation already in flight is what makes the suspension fail for
		// this box.
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "repair",
					status: "running",
					idempotency_key: "held",
					trigger: "owner",
					created_at: NOW,
					updated_at: NOW
				})
		);

		await expect(suspend(admin)).rejects.toThrow(/box action\(s\) failed/);

		expect(
			await t.run((ctx) =>
				ctx.db
					.query("users")
					.filter((q) => q.eq(q.field("clerk_user_id"), "customer"))
					.first()
			)
		).toMatchObject({ suspended: true });
	});

	test("refuses the whole thing to somebody without the power", async () => {
		const t = testConvex();
		const { customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			status: "running"
		});

		await expect(
			customer.as.action(api.staff.users.setUserSuspended, {
				clerkUserId: "customer",
				suspended: true
			})
		).rejects.toThrow("Staff access required.");
		expect(await boxOperations(t, boxId)).toEqual([]);
	});
});
