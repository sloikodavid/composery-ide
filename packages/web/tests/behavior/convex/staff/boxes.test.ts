import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "@/convex/_generated/api";
import {
	STAFF_BOX_LIST_LIMIT,
	STAFF_BOX_SEARCH_SCAN_LIMIT
} from "@/convex/staff/boxes";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { BOX_PLANS } from "@/convex/model/box/plan";

import {
	boxOperations,
	readBox,
	readOperation,
	seedBox,
	scheduledJobs,
	seedSettings,
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Caller,
	type Harness
} from "../../../support/convex.ts";

// The staff console acts on boxes staff do not own, so every entry point here is
// a capability check with an operation behind it. The pair of questions each
// test asks is: does a customer get refused, and does the action a staff member
// takes carry their name?
const NOW = Date.UTC(2026, 8, 9, 10, 11, 12);

// Any well-formed page request: the authorization tests below never get far
// enough to read it.
const PAGE = { cursor: null, numItems: 10 };

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

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

describe("acting on a box as staff", () => {
	test("stops any box for a staff member with box powers", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			status: "running"
		});

		await admin.as.mutation(api.staff.boxes.stop, { boxId });

		expect(await readBox(t, boxId)).toMatchObject({ status: "stopping" });
	});

	test("refuses the same call from the box's own owner", async () => {
		const t = testConvex();
		const { customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			status: "running"
		});

		await expect(
			customer.as.mutation(api.staff.boxes.stop, { boxId })
		).rejects.toThrow(/Staff access required/);
		expect(await readBox(t, boxId)).toMatchObject({ status: "running" });
	});

	// Staff act on a box's behalf, so the operation is triggered by "staff" - and
	// automatic repair reads that field alone to decide a human is on the box.
	test("records a staff-triggered operation as staff, not owner", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			status: "running"
		});

		await admin.as.mutation(api.staff.boxes.reset, { boxId });

		expect(await boxOperations(t, boxId)).toMatchObject([
			{ type: "reset", trigger: "staff" }
		]);
	});

	// The console deliberately bypasses the owner's weekly reissue cap, because a
	// support engineer resetting a broken box is not the case the cap is for.
	test("resets past the reissue budget the owner is held to", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			slug: "spent",
			status: "running"
		});
		await t.run(async (ctx) => {
			for (let index = 0; index < 5; index += 1) {
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "reset",
					status: "succeeded",
					idempotency_key: `past-${index}`,
					trigger: "owner",
					created_at: NOW - 1000,
					updated_at: NOW - 1000
				});
			}
		});

		await admin.as.mutation(api.staff.boxes.reset, { boxId });

		expect(await readBox(t, boxId)).toMatchObject({ status: "resetting" });
	});

	test("suspends a box on a staff member's say-so and keeps the reason", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			status: "running"
		});

		await admin.as.action(api.staff.boxes.suspend, {
			boxId,
			reason: "egress abuse"
		});

		expect(await boxOperations(t, boxId)).toMatchObject([
			{
				type: "suspend",
				trigger: "staff",
				metadata: { reason: "egress abuse" }
			}
		]);
	});

	test("refuses a suspension to a customer", async () => {
		const t = testConvex();
		const { customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			status: "running"
		});

		await expect(
			customer.as.action(api.staff.boxes.suspend, { boxId })
		).rejects.toThrow(/Staff access required/);
		expect(await boxOperations(t, boxId)).toEqual([]);
	});
});

// Cancelling is the lever a person pulls on a wedged operation, and the one
// place staff can end an operation that is still nominally alive.
describe("cancelling a wedged operation", () => {
	async function openOperation(t: Harness, boxId: Id<"boxes">) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "repair",
					status: "running",
					idempotency_key: `repair:${boxId}`,
					trigger: "owner",
					created_at: NOW - 1000,
					updated_at: NOW - 1000
				})
		);
	}

	test("closes the operation and frees the box", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			status: "repairing"
		});
		const operationId = await openOperation(t, boxId);

		await admin.as.action(api.staff.boxes.cancelOperation, { boxId });

		expect(await readOperation(t, operationId)).toMatchObject({
			status: "failed"
		});
		expect(await readBox(t, boxId)).toMatchObject({ status: "repair_failed" });
	});

	test("says so when the box has nothing in progress", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });

		await expect(
			admin.as.action(api.staff.boxes.cancelOperation, { boxId })
		).rejects.toThrow(/no operation in progress/);
	});

	test("refuses a cancellation to a customer", async () => {
		const t = testConvex();
		const { customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			status: "repairing"
		});
		const operationId = await openOperation(t, boxId);

		await expect(
			customer.as.action(api.staff.boxes.cancelOperation, { boxId })
		).rejects.toThrow(/Staff access required/);
		expect(await readOperation(t, operationId)).toMatchObject({
			status: "running"
		});
	});
});

describe("dismissing a failure", () => {
	async function failedOperation(t: Harness, boxId: Id<"boxes">) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "reset",
					status: "failed",
					idempotency_key: `reset:${boxId}`,
					trigger: "owner",
					last_error: "boom",
					created_at: NOW - 1000,
					updated_at: NOW - 1000
				})
		);
	}

	// `requireCapability` hands the staff row back so callers can attribute the
	// action; the dismissal is where that attribution is stored.
	test("records which staff member dismissed the failure", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });
		const operationId = await failedOperation(t, boxId);

		await admin.as.mutation(api.staff.boxes.dismissFailedOperation, {
			operationId
		});

		expect(await readOperation(t, operationId)).toMatchObject({
			dismissed_at: NOW,
			dismissed_by: admin.clerkUserId
		});
	});

	// A dismissal is a note about a failure, not a way to close a live operation.
	test("leaves an operation that has not failed alone", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });
		const operationId = await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "reset",
					status: "running",
					idempotency_key: `reset:${boxId}`,
					trigger: "owner",
					created_at: NOW,
					updated_at: NOW
				})
		);

		await admin.as.mutation(api.staff.boxes.dismissFailedOperation, {
			operationId
		});

		const operation = await readOperation(t, operationId);
		expect(operation?.dismissed_at).toBeUndefined();
	});

	test("keeps the first dismissal when the same failure is dismissed twice", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });
		const operationId = await failedOperation(t, boxId);
		await admin.as.mutation(api.staff.boxes.dismissFailedOperation, {
			operationId
		});

		const second = await seedUser(t, {
			clerkUserId: "admin_2",
			email: "admin2@example.com",
			role: "admin"
		});
		await second.as.mutation(api.staff.boxes.dismissFailedOperation, {
			operationId
		});

		expect(await readOperation(t, operationId)).toMatchObject({
			dismissed_by: admin.clerkUserId
		});
	});

	test("refuses a dismissal to a customer", async () => {
		const t = testConvex();
		const { customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });
		const operationId = await failedOperation(t, boxId);

		await expect(
			customer.as.mutation(api.staff.boxes.dismissFailedOperation, {
				operationId
			})
		).rejects.toThrow(/Staff access required/);
	});
});

// Minting a free box creates real infrastructure that costs money, which is why
// it gates on its own capability rather than on general box powers.
describe("comping a box", () => {
	beforeEach(() => {
		vi.stubEnv("RUNTIME_IMAGE", "ghcr.io/test/composery@sha256:abc");
	});

	// A comp mints real infrastructure, so it answers to the same capacity gate a
	// paid checkout does - including the one that holds everything back until a
	// deployment's provider limits have been entered at all.
	test("refuses a comp while the deployment has no capacity limits configured", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);

		await expect(
			admin.as.mutation(api.staff.boxes.grantComp, {
				plan: "air",
				email: customer.email,
				slug: "gift",
				reason: "conference"
			})
		).rejects.toThrow(/capacity/i);
	});

	test("refuses a comp once the server limit is reached", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		await seedSettings(t, { hetzner_server_limit: 1 });
		await seedBox(t, { user_id: "someone", slug: "existing" });

		await expect(
			admin.as.mutation(api.staff.boxes.grantComp, {
				plan: "air",
				email: customer.email,
				slug: "gift",
				reason: "conference"
			})
		).rejects.toThrow(/capacity/i);
	});

	test("creates a comped box for the named account", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		await seedSettings(t);

		const { boxId } = await admin.as.mutation(api.staff.boxes.grantComp, {
			plan: "air",
			email: customer.email,
			slug: "gift",
			reason: "conference"
		});

		expect(await readBox(t, boxId)).toMatchObject({
			user_id: customer.clerkUserId,
			slug: "gift",
			status: "creating",
			comped_by: admin.clerkUserId,
			comp_reason: "conference"
		});
	});

	// The address reaches staff by whatever route the customer sent it - a
	// support thread, a conference badge - so the lookup normalizes rather than
	// telling staff the account does not exist.
	test("finds the account however the address was typed", async () => {
		const t = testConvex();
		const { customer } = await cast(t);
		await seedSettings(t);
		const admin = await seedUser(t, {
			clerkUserId: "admin",
			email: "admin@example.com",
			role: "admin"
		});

		const { boxId } = await admin.as.mutation(api.staff.boxes.grantComp, {
			plan: "air",
			email: `  ${customer.email.toUpperCase()} `,
			slug: "gift",
			reason: "conference"
		});

		expect(await readBox(t, boxId)).toMatchObject({
			user_id: customer.clerkUserId
		});
	});

	// A comp is backed by no subscription, so nothing else may look like one.
	test("leaves a comped box with no subscription attached", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		await seedSettings(t);

		const { boxId } = await admin.as.mutation(api.staff.boxes.grantComp, {
			plan: "air",
			email: customer.email,
			slug: "gift",
			reason: "conference"
		});

		const box = await readBox(t, boxId);
		expect(box?.polar_subscription_id).toBeUndefined();
		expect(box?.polar_customer_id).toBeUndefined();
	});

	test("refuses a comp with no stated reason", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		await seedSettings(t);

		await expect(
			admin.as.mutation(api.staff.boxes.grantComp, {
				plan: "air",
				email: customer.email,
				slug: "gift",
				reason: "   "
			})
		).rejects.toThrow(/reason is required/);
	});

	test("refuses a comp for an account that does not exist", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await seedSettings(t);

		await expect(
			admin.as.mutation(api.staff.boxes.grantComp, {
				plan: "air",
				email: "nobody@example.com",
				slug: "gift",
				reason: "conference"
			})
		).rejects.toThrow(/User not found/);
	});

	test("refuses a comp for a suspended account", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await seedSettings(t);
		const banned = await seedUser(t, {
			clerkUserId: "banned",
			email: "banned@example.com",
			suspended: true
		});

		await expect(
			admin.as.mutation(api.staff.boxes.grantComp, {
				plan: "air",
				email: banned.email,
				slug: "gift",
				reason: "conference"
			})
		).rejects.toThrow(/suspended/i);
	});

	test("refuses a comp on a slug that is already taken", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		await seedSettings(t);
		await seedBox(t, { user_id: "someone", slug: "gift" });

		await expect(
			admin.as.mutation(api.staff.boxes.grantComp, {
				plan: "air",
				email: customer.email,
				slug: "gift",
				reason: "conference"
			})
		).rejects.toThrow(/unavailable/i);
	});

	test("refuses a comp to a customer", async () => {
		const t = testConvex();
		const { customer } = await cast(t);

		await expect(
			customer.as.mutation(api.staff.boxes.grantComp, {
				plan: "air",
				email: customer.email,
				slug: "gift",
				reason: "conference"
			})
		).rejects.toThrow(/Staff access required/);
	});

	// A comp has no subscription to revoke, so this is its only teardown lever -
	// and it must refuse to fire on a paid box, whose deletion has to go through
	// billing.
	test("refuses to revoke a comp on a box that is not one", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			polar_subscription_id: "sub_1"
		});

		await expect(
			admin.as.mutation(api.staff.boxes.revokeComp, { boxId })
		).rejects.toThrow(/not a comp/);
	});

	test("tears down a comped box when its comp is revoked", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			comped_at: NOW - 1000,
			comped_by: admin.clerkUserId,
			status: "running"
		});

		await admin.as.mutation(api.staff.boxes.revokeComp, { boxId });

		expect(await readBox(t, boxId)).toMatchObject({ status: "deleting" });
	});
});

// The console's box search. It is how staff find a box from whatever a customer
// happened to give them - a slug, an email, a subscription id off an invoice -
// so a field missing from it is a box support cannot reach.
describe("finding a box from the console", () => {
	async function fleet(t: Harness) {
		const owner = await seedUser(t, {
			clerkUserId: "clerk_owner",
			email: "Person@Example.com"
		});
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			polar_subscription_id: "sub_ABC123"
		});
		const other = await seedUser(t, {
			clerkUserId: "clerk_other",
			email: "someone@else.test"
		});
		await seedBox(t, { user_id: other.clerkUserId, slug: "zeta" });
		return { boxId, owner };
	}

	const search = async (
		staff: Awaited<ReturnType<typeof cast>>["admin"],
		term: string
	) => await staff.as.query(api.staff.boxes.search, { query: term });

	test.each([
		["a slug", "atlas"],
		["part of a slug", "atl"],
		["an owner's clerk id", "clerk_owner"],
		["an email, whatever its case", "PERSON@example.com"],
		["a subscription id, whatever its case", "sub_abc123"]
	])("finds a box by %s", async (_name, term) => {
		const t = testConvex();
		const { admin } = await cast(t);
		const { boxId } = await fleet(t);

		expect((await search(admin, term)).map((row) => row.id)).toEqual([boxId]);
	});

	test("finds a box by its own id", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		const { boxId } = await fleet(t);

		expect((await search(admin, boxId)).map((row) => row.id)).toEqual([boxId]);
	});

	test("finds nothing for a term no box carries", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await fleet(t);

		expect(await search(admin, "nothing-like-this")).toEqual([]);
	});

	// The console is behind a capability, and search reads every box in the
	// fleet including their owners' addresses.
	test("refuses a caller without the console capability", async () => {
		const t = testConvex();
		const owner = await seedUser(t, { clerkUserId: "clerk_owner" });
		await seedBox(t, { user_id: owner.clerkUserId, slug: "atlas" });

		await expect(
			owner.as.query(api.staff.boxes.search, { query: "atlas" })
		).rejects.toThrow();
	});
});

// Clearing the failure feed. It is a bulk write over a table that can be large,
// so it is batched and re-driven; a dismiss that stopped at one batch would
// leave the console showing failures staff had already cleared.
describe("dismissing every failed operation", () => {
	async function failures(t: Harness, count: number, age = 0) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		await t.run(async (ctx) => {
			for (let index = 0; index < count; index += 1) {
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "repair",
					status: "failed",
					idempotency_key: `failed-${index}`,
					trigger: "owner",
					created_at: Date.now() - age,
					updated_at: Date.now() - age
				});
			}
		});
		return boxId;
	}

	const undismissed = async (t: Harness) =>
		(await t.run((ctx) => ctx.db.query("box_operations").collect())).filter(
			(row) => row.dismissed_at === undefined
		);

	test("marks the failures it cleared, and by whom", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await failures(t, 3);

		await admin.as.mutation(api.staff.boxes.dismissAllFailedOperations, {});

		expect(await undismissed(t)).toEqual([]);
		const [row] = await t.run((ctx) =>
			ctx.db.query("box_operations").collect()
		);
		expect(row?.dismissed_by).toBe(admin.clerkUserId);
	});

	// Only the window the feed shows. An older failure is not on the page staff
	// are looking at, and clearing it would hide history they never saw.
	test("leaves a failure older than the feed's window alone", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await failures(t, 1, 400 * 24 * 60 * 60 * 1000);

		await admin.as.mutation(api.staff.boxes.dismissAllFailedOperations, {});

		expect(await undismissed(t)).toHaveLength(1);
	});

	test("comes back for the rest when it fills a batch", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await failures(t, 100);

		await admin.as.mutation(api.staff.boxes.dismissAllFailedOperations, {});

		expect(
			await scheduledJobs(t, "staff/boxes:dismissAllFailedOperationsBatch")
		).toHaveLength(1);
	});

	test("stops when it did not fill one", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await failures(t, 2);

		await admin.as.mutation(api.staff.boxes.dismissAllFailedOperations, {});

		expect(
			await scheduledJobs(t, "staff/boxes:dismissAllFailedOperationsBatch")
		).toEqual([]);
	});

	test("refuses a caller without the operations capability", async () => {
		const t = testConvex();
		const owner = await seedUser(t, { clerkUserId: "clerk_owner" });

		await expect(
			owner.as.mutation(api.staff.boxes.dismissAllFailedOperations, {})
		).rejects.toThrow();
	});
});

// Every staff endpoint on a box, driven by somebody who is not staff.
//
// These are the console's own operations: reset somebody's box, change its slug,
// suspend it, take or restore a snapshot, grant a free one. Each opens with a
// capability check, and each check is one line that a new endpoint can be
// written without. There is no second gate behind them - the box id is the only
// other argument - so a missing line here is a stranger operating other people's
// machines.
//
// A table rather than twenty-six tests because there is one rule, and
// `tests/invariants/convex/staff-authorization.test.ts` is what stops an
// endpoint added later from quietly not being in it.
describe("a staff endpoint reached by somebody who is not staff", () => {
	// Named exactly as they are called, with the arguments each needs. The
	// arguments do not have to be valid - the capability check comes first, and
	// that is the point being made.
	const ENDPOINTS = {
		auditEvents: { kind: "query", paginationOpts: PAGE },
		auditOperations: { kind: "query", paginationOpts: PAGE },
		cancelOperation: { kind: "action" },
		changeSlug: { kind: "mutation", newSlug: "taken" },
		createSnapshot: { kind: "mutation" },
		deleteSnapshot: { kind: "mutation", noBox: true, needsSnapshot: true },
		dismissAllFailedOperations: { kind: "mutation", noBox: true },
		dismissFailedOperation: {
			kind: "mutation",
			noBox: true,
			needsOperation: true
		},
		getById: { kind: "query", stringBoxId: true },
		grantComp: {
			kind: "mutation",
			noBox: true,
			email: "someone@example.com",
			plan: "air",
			reason: "because",
			slug: "granted"
		},
		recentFailedOperations: { kind: "query", noBox: true },
		recoveryStatus: { kind: "action" },
		repair: { kind: "action" },
		reset: { kind: "mutation" },
		restoreSnapshot: { kind: "mutation", noBox: true, needsSnapshot: true },
		retryCreate: { kind: "mutation" },
		revokeComp: { kind: "mutation" },
		runtimeLogs: { kind: "action" },
		search: { kind: "query", noBox: true },
		snapshots: { kind: "query" },
		start: { kind: "mutation" },
		stop: { kind: "mutation" },
		suspend: { kind: "action", reason: "abuse" },
		unsuspend: { kind: "action" },
		update: { kind: "action" }
	} as const;

	// Convex validates arguments before the handler runs, so every id here has to
	// be a real one: a malformed argument is refused by the validator and the
	// capability check - the thing under test - would never be reached.
	async function callAs(
		t: Harness,
		as: Caller,
		name: keyof typeof ENDPOINTS,
		ids: Subject
	) {
		const { kind, needsOperation, needsSnapshot, noBox, stringBoxId, ...rest } =
			ENDPOINTS[name] as {
				kind: "action" | "mutation" | "query";
				needsOperation?: boolean;
				needsSnapshot?: boolean;
				noBox?: boolean;
				stringBoxId?: boolean;
			} & Record<string, unknown>;
		const args = {
			...(noBox ? {} : { boxId: stringBoxId ? String(ids.boxId) : ids.boxId }),
			...(needsSnapshot ? { snapshotId: ids.snapshotId } : {}),
			...(needsOperation ? { operationId: ids.operationId } : {}),
			...rest
		};
		const reference = api.staff.boxes[name];
		// One dynamic dispatch over a table of endpoints, which no signature can
		// follow: the reference and its arguments are chosen at run time. Cast
		// once, at the call, rather than giving each argument the `never` and
		// leaving the checker a tuple it then refuses.
		const call = as[kind] as (
			reference: unknown,
			args: unknown
		) => Promise<unknown>;
		return await call(reference, args);
	}

	type Subject = {
		boxId: Id<"boxes">;
		operationId: Id<"box_operations">;
		owner: Awaited<ReturnType<typeof seedUser>>;
		snapshotId: Id<"box_snapshots">;
	};

	async function subject(t: Harness): Promise<Subject> {
		const owner = await seedUser(t, { clerkUserId: "owner" });
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas"
		});
		const rows = await t.run(async (ctx) => ({
			operationId: await ctx.db.insert("box_operations", {
				box_id: boxId,
				type: "repair",
				status: "failed",
				idempotency_key: "staff-auth",
				trigger: "staff",
				created_at: NOW,
				updated_at: NOW
			}),
			snapshotId: await ctx.db.insert("box_snapshots", {
				box_id: boxId,
				class: "manual",
				status: "complete",
				created_at: NOW
			})
		}));
		return { boxId, owner, ...rows };
	}

	test.each(Object.keys(ENDPOINTS))(
		"%s refuses a signed-out caller",
		async (name) => {
			const t = testConvex();
			const ids = await subject(t);

			await expect(
				callAs(t, t, name as keyof typeof ENDPOINTS, ids)
			).rejects.toThrow(/Staff access required\.|Authentication required\./);
		}
	);

	test.each(Object.keys(ENDPOINTS))(
		"%s refuses an ordinary signed-in user",
		async (name) => {
			const t = testConvex();
			const ids = await subject(t);
			const stranger = await seedUser(t, {
				clerkUserId: "stranger",
				email: "stranger@example.com"
			});

			await expect(
				callAs(t, stranger.as, name as keyof typeof ENDPOINTS, ids)
			).rejects.toThrow("Staff access required.");
		}
	);

	// The owner of the box is still not staff. A console operation is not
	// something a customer may reach for their own box - the user-facing API is,
	// and it has its own rules.
	test.each(Object.keys(ENDPOINTS))(
		"%s refuses even the box's own owner",
		async (name) => {
			const t = testConvex();
			const ids = await subject(t);

			await expect(
				callAs(t, ids.owner.as, name as keyof typeof ENDPOINTS, ids)
			).rejects.toThrow("Staff access required.");
		}
	);
});

// The console operations that reach into a customer's data, driven as staff.
//
// The authorization table above proves nobody else can reach them; these prove
// what they do once reached. Both halves matter: a gate in front of an operation
// that does the wrong thing is no safer than no gate.
describe("what a staff operation does once it is allowed", () => {
	async function snapshotOf(
		t: Harness,
		boxId: Id<"boxes">,
		userId: string,
		status: Doc<"box_snapshots">["status"] = "complete"
	) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("box_snapshots", {
					box_id: boxId,
					class: "manual",
					status,
					hetzner_image_id: 4242,
					created_at: NOW - 1000
				})
		);
	}

	describe("restoring a snapshot over a customer's box", () => {
		test("opens a restore against the snapshot's own box", async () => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const boxId = await seedBox(t, {
				user_id: customer.clerkUserId,
				status: "running"
			});
			const snapshotId = await snapshotOf(t, boxId, customer.clerkUserId);

			await admin.as.mutation(api.staff.boxes.restoreSnapshot, { snapshotId });

			expect(await boxOperations(t, boxId)).toMatchObject([
				{ type: "restore", trigger: "staff" }
			]);
		});

		// Restoring from a capture that never finished would hand the box an image
		// Hetzner does not have, and the box's own disk is overwritten first.
		test.each(["pending", "creating", "failed", "deleting"] as const)(
			"refuses to restore from a %s snapshot",
			async (status) => {
				const t = testConvex();
				const { admin, customer } = await cast(t);
				const boxId = await seedBox(t, {
					user_id: customer.clerkUserId,
					status: "running"
				});
				const snapshotId = await snapshotOf(
					t,
					boxId,
					customer.clerkUserId,
					status
				);

				await expect(
					admin.as.mutation(api.staff.boxes.restoreSnapshot, { snapshotId })
				).rejects.toThrow("Only a finished snapshot can be restored.");
				expect(await boxOperations(t, boxId)).toEqual([]);
			}
		);

		test("says so when the snapshot is not there", async () => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const boxId = await seedBox(t, { user_id: customer.clerkUserId });
			const snapshotId = await snapshotOf(t, boxId, customer.clerkUserId);
			await t.run(async (ctx) => await ctx.db.delete(snapshotId));

			await expect(
				admin.as.mutation(api.staff.boxes.restoreSnapshot, { snapshotId })
			).rejects.toThrow("Snapshot not found.");
		});

		// One restore at a time. Reporting a second as started would tell a
		// support engineer the box is being restored twice.
		test("refuses a second restore while one is in flight", async () => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const boxId = await seedBox(t, {
				user_id: customer.clerkUserId,
				status: "running"
			});
			const snapshotId = await snapshotOf(t, boxId, customer.clerkUserId);
			await admin.as.mutation(api.staff.boxes.restoreSnapshot, { snapshotId });

			await expect(
				admin.as.mutation(api.staff.boxes.restoreSnapshot, { snapshotId })
			).rejects.toThrow(/already in flight|busy/);
		});
	});

	describe("deleting a customer's snapshot", () => {
		test("claims the row and queues the image delete", async () => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const boxId = await seedBox(t, { user_id: customer.clerkUserId });
			const snapshotId = await snapshotOf(t, boxId, customer.clerkUserId);

			await admin.as.mutation(api.staff.boxes.deleteSnapshot, { snapshotId });

			expect(await t.run((ctx) => ctx.db.get(snapshotId))).toMatchObject({
				status: "deleting"
			});
			expect(await scheduledJobs(t, "boxes/snapshots:runDelete")).toHaveLength(
				1
			);
		});

		test("says so when the snapshot is not there", async () => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const boxId = await seedBox(t, { user_id: customer.clerkUserId });
			const snapshotId = await snapshotOf(t, boxId, customer.clerkUserId);
			await t.run(async (ctx) => await ctx.db.delete(snapshotId));

			await expect(
				admin.as.mutation(api.staff.boxes.deleteSnapshot, { snapshotId })
			).rejects.toThrow("Snapshot not found.");
		});
	});

	// A comp is a box somebody gets without paying, so every guard on it is a
	// guard against giving away infrastructure by accident - and it is attributed,
	// because a free box with no name against it is one nobody can account for.
	describe("granting a comped box", () => {
		const grant = (
			admin: Awaited<ReturnType<typeof cast>>["admin"],
			over: Record<string, unknown> = {}
		) =>
			admin.as.mutation(api.staff.boxes.grantComp, {
				email: "customer@example.com",
				plan: "air",
				slug: "gifted",
				reason: "beta tester",
				...over
			});

		test("creates the box against the named account and records who gave it", async () => {
			const t = testConvex();
			vi.stubEnv("RUNTIME_IMAGE", "ghcr.io/composery/composery:latest");
			await seedSettings(t);
			const { admin, customer } = await cast(t);

			await grant(admin);

			const boxes = await t.run((ctx) => ctx.db.query("boxes").collect());
			expect(boxes).toMatchObject([
				{
					user_id: customer.clerkUserId,
					slug: "gifted",
					plan: "air",
					comped_by: admin.clerkUserId,
					comp_reason: "beta tester"
				}
			]);
		});

		// A comp with no stated reason is an unaccountable free box.
		test.each(["", "   "])("refuses a reason of %p", async (reason) => {
			const t = testConvex();
			await seedSettings(t);
			const { admin } = await cast(t);

			await expect(grant(admin, { reason })).rejects.toThrow(
				"A comp reason is required."
			);
		});

		test("refuses an account that does not exist", async () => {
			const t = testConvex();
			await seedSettings(t);
			const { admin } = await cast(t);

			await expect(
				grant(admin, { email: "nobody@example.com" })
			).rejects.toThrow("User not found.");
		});

		// The same answer the owner would get. A comp must not be a way around a
		// suspension the account is under.
		test("refuses an account its own owner is locked out of", async () => {
			const t = testConvex();
			await seedSettings(t);
			const { admin } = await cast(t);
			await seedUser(t, {
				clerkUserId: "blocked",
				email: "blocked@example.com",
				suspended: true,
				suspendedReason: "abuse"
			});

			await expect(
				grant(admin, { email: "blocked@example.com" })
			).rejects.toThrow();
		});

		test("refuses a slug that is not a slug", async () => {
			const t = testConvex();
			await seedSettings(t);
			const { admin } = await cast(t);

			await expect(grant(admin, { slug: "!!" })).rejects.toThrow(
				"Slug is unavailable."
			);
		});

		// Two boxes on one name would collide on DNS and on the runtime domain.
		test("refuses a slug another box already holds", async () => {
			const t = testConvex();
			await seedSettings(t);
			const { admin, customer } = await cast(t);
			await seedBox(t, { user_id: customer.clerkUserId, slug: "gifted" });

			await expect(grant(admin)).rejects.toThrow();
		});

		// A comp still consumes a real machine, so it is held to the same capacity
		// admission as a sale - giving one away when the fleet is full would
		// oversubscribe the provider.
		test("refuses a comp the fleet has no capacity for", async () => {
			const t = testConvex();
			await seedSettings(t, { hetzner_server_limit: 0 });
			const { admin } = await cast(t);

			await expect(grant(admin)).rejects.toThrow();
		});
	});
});

// What the console shows staff before they act.
//
// Every operation above is chosen from one of these lists, so a search that
// cannot find a box by the identifier a customer quoted, or a failure feed that
// hides a failure, is not a display bug - it is staff acting on the wrong box or
// not acting at all.
describe("what the console finds for staff", () => {
	async function fleet(t: Harness) {
		const { admin, customer } = await cast(t);
		const atlas = await seedBox(t, {
			user_id: customer.clerkUserId,
			slug: "atlas",
			polar_subscription_id: "sub_atlas",
			created_at: NOW - 2000
		});
		const borealis = await seedBox(t, {
			user_id: customer.clerkUserId,
			slug: "borealis",
			created_at: NOW - 1000
		});
		return { admin, atlas, borealis, customer };
	}

	const search = (
		admin: Awaited<ReturnType<typeof cast>>["admin"],
		query?: string
	) =>
		admin.as.query(
			api.staff.boxes.search,
			query === undefined ? {} : { query }
		);

	// The three identifiers a customer can quote: the name they chose, the id in
	// a URL, and the subscription id on an invoice.
	test("finds a box by its slug", async () => {
		const t = testConvex();
		const { admin, atlas } = await fleet(t);

		expect((await search(admin, "atlas")).map((box) => box.id)).toContain(
			atlas
		);
	});

	test("finds a box by its own id", async () => {
		const t = testConvex();
		const { admin, atlas } = await fleet(t);

		expect((await search(admin, atlas)).map((box) => box.id)).toContain(atlas);
	});

	test("finds a box by the subscription that pays for it", async () => {
		const t = testConvex();
		const { admin, atlas } = await fleet(t);

		expect((await search(admin, "sub_atlas")).map((box) => box.id)).toContain(
			atlas
		);
	});

	// A customer quoting their box name will not match its case or spacing.
	test.each(["ATLAS", "  atlas  "])(
		"finds a box quoted as %p",
		async (query) => {
			const t = testConvex();
			const { admin, atlas } = await fleet(t);

			expect((await search(admin, query)).map((box) => box.id)).toContain(
				atlas
			);
		}
	);

	// With nothing typed the console shows the fleet, newest first, so the box
	// somebody just created is the one on screen.
	test("lists the newest boxes when nothing was typed", async () => {
		const t = testConvex();
		const { admin, atlas, borealis } = await fleet(t);

		const results = (await search(admin)).map((box) => box.id);

		expect(results).toEqual([borealis, atlas]);
	});

	test("finds nothing for a term that matches nothing", async () => {
		const t = testConvex();
		const { admin } = await fleet(t);

		expect(await search(admin, "nothing-like-this")).toEqual([]);
	});
});

// The failure feed is the console's front page, and the only thing that says a
// box needs a person. A failure it does not show is one nobody acts on.
describe("the failures the console puts in front of staff", () => {
	async function failure(
		t: Harness,
		boxId: Id<"boxes">,
		over: Record<string, unknown> = {}
	) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "repair",
					status: "failed",
					idempotency_key: `k-${Math.random()}`,
					trigger: "owner",
					last_error: "ssh refused",
					created_at: NOW - 1000,
					updated_at: NOW - 1000,
					...over
				})
		);
	}

	const feed = (admin: Awaited<ReturnType<typeof cast>>["admin"]) =>
		admin.as.query(api.staff.boxes.recentFailedOperations, {});

	test("shows a recent failure with the box and the reason", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			slug: "atlas"
		});
		await failure(t, boxId);

		expect(await feed(admin)).toMatchObject([
			{ boxId, slug: "atlas", type: "repair", lastError: "ssh refused" }
		]);
	});

	// Dismissing is how staff mark a failure handled; a dismissed one coming back
	// would make the feed impossible to clear.
	test("hides a failure somebody already dismissed", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });
		await failure(t, boxId, { dismissed_at: NOW - 500 });

		expect(await feed(admin)).toEqual([]);
	});

	test("ignores an operation that did not fail", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });
		await failure(t, boxId, { status: "succeeded" });

		expect(await feed(admin)).toEqual([]);
	});

	// A failure whose box has since been purged has nothing to act on, and
	// rendering it would crash the row rather than inform anyone.
	test("drops a failure whose box is gone", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });
		await failure(t, boxId);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		expect(await feed(admin)).toEqual([]);
	});

	// A failure with no recorded message still has to appear - "something failed
	// and nobody wrote down why" is exactly what staff need to see.
	test("shows a failure that recorded no message", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });
		await failure(t, boxId, { last_error: undefined });

		expect(await feed(admin)).toMatchObject([{ lastError: null }]);
	});
});

// The rest of the console's levers on a customer's box.
//
// Each opens an operation staff are told started, so the property that matters
// throughout is that "started" is true: reporting a start over a request that
// began nothing is the same lie as an operation that never reports an outcome,
// and it is what sends a support engineer away believing a box is being fixed.
describe("the operations the console starts on a box", () => {
	async function running(t: Harness) {
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			slug: "atlas",
			status: "running"
		});
		return { admin, boxId, customer };
	}

	describe("repairing", () => {
		test("opens a staff-triggered repair", async () => {
			const t = testConvex();
			const { admin, boxId } = await running(t);

			await admin.as.action(api.staff.boxes.repair, { boxId });

			expect(await boxOperations(t, boxId)).toMatchObject([
				{ type: "repair", trigger: "staff" }
			]);
		});

		test("says so rather than reporting a repair it did not start", async () => {
			const t = testConvex();
			const { admin, boxId } = await running(t);
			await admin.as.action(api.staff.boxes.repair, { boxId });

			await expect(
				admin.as.action(api.staff.boxes.repair, { boxId })
			).rejects.toThrow();
			expect(await boxOperations(t, boxId)).toHaveLength(1);
		});

		test("refuses a box that is not there", async () => {
			const t = testConvex();
			const { admin, boxId } = await running(t);
			await t.run(async (ctx) => await ctx.db.delete(boxId));

			await expect(
				admin.as.action(api.staff.boxes.repair, { boxId })
			).rejects.toThrow("Box not found.");
		});
	});

	describe("updating", () => {
		test("opens a staff-triggered update", async () => {
			const t = testConvex();
			const { admin, boxId } = await running(t);

			await admin.as.action(api.staff.boxes.update, { boxId });

			expect(await boxOperations(t, boxId)).toMatchObject([
				{ type: "update", trigger: "staff" }
			]);
		});

		// Staff and owner keys are deliberately separate, so a staff update is not
		// deduplicated against an owner's and silently reported as started.
		test("says so rather than reporting an update it did not start", async () => {
			const t = testConvex();
			const { admin, boxId } = await running(t);
			await admin.as.action(api.staff.boxes.update, { boxId });

			await expect(
				admin.as.action(api.staff.boxes.update, { boxId })
			).rejects.toThrow(/already in flight|busy/);
		});

		test("refuses a box that is not there", async () => {
			const t = testConvex();
			const { admin, boxId } = await running(t);
			await t.run(async (ctx) => await ctx.db.delete(boxId));

			await expect(
				admin.as.action(api.staff.boxes.update, { boxId })
			).rejects.toThrow("Box not found.");
		});
	});

	describe("renaming", () => {
		test("opens a rename and reserves the new name against it", async () => {
			const t = testConvex();
			const { admin, boxId } = await running(t);

			await admin.as.mutation(api.staff.boxes.changeSlug, {
				boxId,
				newSlug: "borealis"
			});

			expect(await boxOperations(t, boxId)).toMatchObject([
				{
					type: "change_slug",
					trigger: "staff",
					reserved_slug: "borealis",
					metadata: { newSlug: "borealis" }
				}
			]);
		});

		// The name is sanitised before it is judged, so what staff typed and what
		// the box gets are the same value the owner-facing path would produce.
		test("sanitises the name before reserving it", async () => {
			const t = testConvex();
			const { admin, boxId } = await running(t);

			await admin.as.mutation(api.staff.boxes.changeSlug, {
				boxId,
				newSlug: "  Borealis  "
			});

			expect(await boxOperations(t, boxId)).toMatchObject([
				{ reserved_slug: "borealis" }
			]);
		});

		test.each(["", "  ", "!!", "-nope-"])(
			"refuses %p as a name",
			async (newSlug) => {
				const t = testConvex();
				const { admin, boxId } = await running(t);

				await expect(
					admin.as.mutation(api.staff.boxes.changeSlug, { boxId, newSlug })
				).rejects.toThrow("Slug is unavailable.");
				expect(await boxOperations(t, boxId)).toEqual([]);
			}
		);

		// Two boxes cannot share a name: they would collide on DNS and on the
		// runtime domain the proxy routes by.
		test("refuses a name another box already holds", async () => {
			const t = testConvex();
			const { admin, boxId, customer } = await running(t);
			await seedBox(t, { user_id: customer.clerkUserId, slug: "borealis" });

			await expect(
				admin.as.mutation(api.staff.boxes.changeSlug, {
					boxId,
					newSlug: "borealis"
				})
			).rejects.toThrow();
		});
	});

	describe("retrying a create that failed", () => {
		test("opens a staff-triggered create", async () => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const boxId = await seedBox(t, {
				user_id: customer.clerkUserId,
				status: "create_failed"
			});

			await admin.as.mutation(api.staff.boxes.retryCreate, { boxId });

			expect(await boxOperations(t, boxId)).toMatchObject([
				{ type: "create", trigger: "staff" }
			]);
		});

		// Keyed per box, so pressing the button twice is one create rather than
		// two machines for one customer.
		test("does not open a second create for the same box", async () => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const boxId = await seedBox(t, {
				user_id: customer.clerkUserId,
				status: "create_failed"
			});

			await admin.as.mutation(api.staff.boxes.retryCreate, { boxId });
			await admin.as
				.mutation(api.staff.boxes.retryCreate, { boxId })
				.catch(() => undefined);

			expect(await boxOperations(t, boxId)).toHaveLength(1);
		});
	});

	describe("starting", () => {
		test("opens a staff-triggered start", async () => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const boxId = await seedBox(t, {
				user_id: customer.clerkUserId,
				status: "stopped"
			});

			await admin.as.mutation(api.staff.boxes.start, { boxId });

			expect(await boxOperations(t, boxId)).toMatchObject([
				{ type: "start", trigger: "staff" }
			]);
		});
	});
});

// The box page a support engineer opens before doing anything, and the audit
// trails beside it. Everything acted on later is chosen from these, so a page
// that shows the wrong box, or an audit that hides a step, is staff acting on a
// story that is not the box's.
describe("the box page the console draws", () => {
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

	const page = (
		admin: Awaited<ReturnType<typeof cast>>["admin"],
		boxId: string
	) => admin.as.query(api.staff.boxes.getById, { boxId });

	test("shows the box with its owner", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			slug: "atlas",
			status: "running"
		});

		expect(await page(admin, boxId)).toMatchObject({
			box: { id: boxId, slug: "atlas" },
			user: { clerkUserId: customer.clerkUserId, email: customer.email }
		});
	});

	// Staff need to see that the owner is locked out - it is usually why the
	// box is in front of them.
	test("says when the owner is suspended", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		const banned = await seedUser(t, {
			clerkUserId: "banned",
			email: "banned@example.com",
			suspended: true,
			suspendedReason: "abuse"
		});
		const boxId = await seedBox(t, { user_id: banned.clerkUserId });

		expect(await page(admin, boxId)).toMatchObject({
			user: { suspended: true }
		});
	});

	// A box whose owner row is gone still has to render - staff are often
	// looking at it precisely because the account was removed.
	test("shows a box whose owner row is gone", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		const boxId = await seedBox(t, { user_id: "vanished" });

		expect(await page(admin, boxId)).toMatchObject({ user: null });
	});

	// An id that is not a box id reads as "no box", not as an error about the
	// id's shape - the console passes whatever was in the URL.
	test.each(["not-an-id", ""])("reports no box for %p", async (boxId) => {
		const t = testConvex();
		const { admin } = await cast(t);

		expect(await page(admin, boxId)).toBeNull();
	});

	test("reports no box for an id nothing is stored under", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		expect(await page(admin, boxId)).toBeNull();
	});

	// The console shows what the box is doing now, which is what decides whether
	// the buttons are safe to press.
	test("carries the box's open operation", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			status: "repairing"
		});
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "repair",
					status: "running",
					idempotency_key: "open",
					trigger: "staff",
					created_at: NOW - 500,
					updated_at: NOW - 500
				})
		);

		expect((await page(admin, boxId))?.activeOperation).toMatchObject({
			type: "repair"
		});
	});

	// "Failure" is the box's *current* state, not its history: the latest
	// operation, and only if that one failed. A box that failed and was then
	// repaired is not a failing box, and showing the old error would send a
	// support engineer after something already fixed.
	test("shows the latest operation's failure", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			status: "repair_failed"
		});
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "repair",
					status: "failed",
					idempotency_key: "failed",
					trigger: "staff",
					last_error: "ssh refused",
					created_at: NOW - 500,
					updated_at: NOW - 500
				})
		);

		expect((await page(admin, boxId))?.failure).toMatchObject({
			error: "ssh refused",
			type: "repair"
		});
	});

	test("shows no failure once a later operation succeeded", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });
		await t.run(async (ctx) => {
			await ctx.db.insert("box_operations", {
				box_id: boxId,
				type: "reset",
				status: "failed",
				idempotency_key: "old",
				trigger: "owner",
				last_error: "ssh refused",
				created_at: NOW - 5000,
				updated_at: NOW - 5000
			});
			await ctx.db.insert("box_operations", {
				box_id: boxId,
				type: "repair",
				status: "succeeded",
				idempotency_key: "new",
				trigger: "staff",
				created_at: NOW - 500,
				updated_at: NOW - 500
			});
		});

		expect((await page(admin, boxId))?.failure).toBeNull();
	});

	test("refuses the page to somebody who is not staff", async () => {
		const t = testConvex();
		const { customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });

		await expect(
			customer.as.query(api.staff.boxes.getById, { boxId })
		).rejects.toThrow("Staff access required.");
	});

	describe("the audit trails", () => {
		const PAGE_ARGS = { cursor: null, numItems: 10 };

		test("lists a box's operations newest first", async () => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const boxId = await seedBox(t, { user_id: customer.clerkUserId });
			await t.run(async (ctx) => {
				for (const [index, type] of ["reset", "repair"].entries()) {
					await ctx.db.insert("box_operations", {
						box_id: boxId,
						type: type as "repair",
						status: "succeeded",
						idempotency_key: `k-${index}`,
						trigger: "staff",
						created_at: NOW - 1000 + index,
						updated_at: NOW - 1000 + index
					});
				}
			});

			const result = await admin.as.query(api.staff.boxes.auditOperations, {
				boxId,
				paginationOpts: PAGE_ARGS
			});

			expect(result.page.map((row) => row.type)).toEqual(["repair", "reset"]);
		});

		test("lists a box's events newest first", async () => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const boxId = await seedBox(t, { user_id: customer.clerkUserId });
			await t.run(async (ctx) => {
				for (const [index, type] of (
					["box.create_succeeded", "box.repair_succeeded"] as const
				).entries()) {
					await ctx.db.insert("box_events", {
						box_id: boxId,
						user_id: customer.clerkUserId,
						type,
						created_at: NOW - 1000 + index
					});
				}
			});

			const result = await admin.as.query(api.staff.boxes.auditEvents, {
				boxId,
				paginationOpts: PAGE_ARGS
			});

			expect(result.page.map((row) => row.type)).toEqual([
				"box.repair_succeeded",
				"box.create_succeeded"
			]);
		});

		// Each trail is one box's. Another box's history appearing here would have
		// staff reading the wrong machine's story.
		test.each(["auditOperations", "auditEvents"] as const)(
			"%s shows only the box it was asked about",
			async (name) => {
				const t = testConvex();
				const { admin, customer } = await cast(t);
				const mine = await seedBox(t, {
					user_id: customer.clerkUserId,
					slug: "mine"
				});
				const other = await seedBox(t, {
					user_id: customer.clerkUserId,
					slug: "other"
				});
				await t.run(async (ctx) => {
					await ctx.db.insert("box_operations", {
						box_id: other,
						type: "reset",
						status: "succeeded",
						idempotency_key: "other",
						trigger: "staff",
						created_at: NOW,
						updated_at: NOW
					});
					await ctx.db.insert("box_events", {
						box_id: other,
						user_id: customer.clerkUserId,
						type: "box.create_succeeded",
						created_at: NOW
					});
				});

				const result = await admin.as.query(api.staff.boxes[name], {
					boxId: mine,
					paginationOpts: PAGE_ARGS
				});

				expect(result.page).toEqual([]);
			}
		);
	});

	describe("a box's snapshots", () => {
		test("lists the box's snapshots newest first", async () => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const boxId = await seedBox(t, { user_id: customer.clerkUserId });
			await t.run(async (ctx) => {
				for (const [index, cls] of ["manual", "scheduled"].entries()) {
					await ctx.db.insert("box_snapshots", {
						box_id: boxId,
						class: cls as "manual",
						status: "complete",
						created_at: NOW - 1000 + index
					});
				}
			});

			const rows = await admin.as.query(api.staff.boxes.snapshots, { boxId });

			expect(rows.map((row) => row.class)).toEqual(["scheduled", "manual"]);
		});

		test("shows only the box it was asked about", async () => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const mine = await seedBox(t, {
				user_id: customer.clerkUserId,
				slug: "mine"
			});
			const other = await seedBox(t, {
				user_id: customer.clerkUserId,
				slug: "other"
			});
			await t.run(
				async (ctx) =>
					await ctx.db.insert("box_snapshots", {
						box_id: other,
						class: "manual",
						status: "complete",
						created_at: NOW
					})
			);

			expect(
				await admin.as.query(api.staff.boxes.snapshots, { boxId: mine })
			).toEqual([]);
		});
	});
});

// Reading a box's logs is the first thing done on a box that is misbehaving,
// and it is the one console call that reaches the machine itself.
describe("reading a box's logs from the console", () => {
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

	// A box that is not running has nothing to read, and saying so beats an SSH
	// attempt against a host that is off.
	test.each(["stopped", "suspended", "creating", "create_failed"] as const)(
		"answers with no logs for a %s box",
		async (status) => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const boxId = await seedBox(t, {
				user_id: customer.clerkUserId,
				status
			});

			expect(
				await admin.as.action(api.staff.boxes.runtimeLogs, { boxId })
			).toEqual({ logs: null });
		}
	);

	test("refuses a box that is not there", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await expect(
			admin.as.action(api.staff.boxes.runtimeLogs, { boxId })
		).rejects.toThrow("Box not found.");
	});
});

// Finding a box the recent scan does not reach.
//
// Search reads the newest STAFF_BOX_SEARCH_SCAN_LIMIT boxes and filters them,
// which answers every term on a small fleet - and that is what makes the indexed
// lookups beside it invisible. They exist for one case: a box old enough to fall
// out of that scan. On a fleet past the horizon a customer's box is found only
// if its own index is consulted, so each lookup gets its term here, past the
// horizon, where deleting it would show staff nothing.
describe("finding a box the recent scan does not reach", () => {
	// One more box than the scan reads, all newer than the target, so the target
	// is reachable only through an index.
	async function fleetPastTheHorizon(t: Harness) {
		const owner = await seedUser(t, {
			clerkUserId: "clerk_owner",
			email: "person@example.com"
		});
		const boxId = await t.run(
			async (ctx) =>
				await ctx.db.insert("boxes", {
					user_id: owner.clerkUserId,
					slug: "atlas",
					plan: "air",
					manual_snapshot_cap: 0,
					status: "running",
					polar_subscription_id: "sub_abc123",
					created_at: NOW - 1_000_000,
					updated_at: NOW - 1_000_000
				})
		);
		await t.run(async (ctx) => {
			for (let index = 0; index < STAFF_BOX_SEARCH_SCAN_LIMIT; index += 1) {
				await ctx.db.insert("boxes", {
					user_id: `filler-${index}`,
					slug: `filler-${index}`,
					plan: "air",
					manual_snapshot_cap: 0,
					status: "running",
					created_at: NOW - 1000 + index,
					updated_at: NOW - 1000 + index
				});
			}
		});
		return { boxId, owner };
	}

	test("the filler alone buries it", async () => {
		const t = testConvex();
		const { boxId } = await fleetPastTheHorizon(t);

		// The control the rest of this block rests on: the scan cannot see the
		// target, so anything that finds it below was found by an index.
		const scanned = await t.run(
			async (ctx) =>
				await ctx.db
					.query("boxes")
					.withIndex("created_at")
					.order("desc")
					.take(STAFF_BOX_SEARCH_SCAN_LIMIT)
		);
		expect(scanned.map((box) => box._id)).not.toContain(boxId);
	});

	test.each([
		["its slug", "atlas"],
		["its owner's account id", "clerk_owner"],
		["its owner's email address", "person@example.com"],
		["its subscription id", "sub_abc123"]
	])("finds it by %s", async (_name, term) => {
		const t = testConvex();
		const { admin } = await cast(t);
		const { boxId } = await fleetPastTheHorizon(t);

		expect(
			(await admin.as.query(api.staff.boxes.search, { query: term })).map(
				(row) => row.id
			)
		).toContain(boxId);
	});

	test("finds it by its own id", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		const { boxId } = await fleetPastTheHorizon(t);

		expect(
			(await admin.as.query(api.staff.boxes.search, { query: boxId })).map(
				(row) => row.id
			)
		).toContain(boxId);
	});

	// The id lookup is normalised against the boxes table, so a well-formed id
	// belonging to another table finds nothing rather than a box that happens to
	// share its bytes.
	test("does not answer an id from another table with a box", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await fleetPastTheHorizon(t);
		const userRow = await t.run(
			async (ctx) => await ctx.db.query("users").first()
		);

		expect(
			await admin.as.query(api.staff.boxes.search, { query: userRow!._id })
		).toEqual([]);
	});
});

// With nothing typed, search is the console's fleet list rather than a search,
// and the two numbers that shape it are different from the ones a term uses.
describe("the fleet list search shows for an empty term", () => {
	async function fleet(t: Harness, count: number) {
		await seedUser(t, { clerkUserId: "clerk_owner" });
		await t.run(async (ctx) => {
			for (let index = 0; index < count; index += 1) {
				await ctx.db.insert("boxes", {
					user_id: "clerk_owner",
					slug: `box-${index}`,
					plan: "air",
					manual_snapshot_cap: 0,
					status: "running",
					created_at: NOW - 10_000 + index,
					updated_at: NOW - 10_000 + index
				});
			}
		});
	}

	test.each([
		["no argument at all", {}],
		["an empty string", { query: "" }],
		["only spaces", { query: "   " }]
	])("lists the fleet for %s", async (_name, args) => {
		const t = testConvex();
		const { admin } = await cast(t);
		await fleet(t, 3);

		expect(await admin.as.query(api.staff.boxes.search, args)).toHaveLength(3);
	});

	// Newest first, because the console reads top-down and the box somebody has
	// just created is the one being asked about.
	test("puts the newest box first", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await fleet(t, 3);

		expect(
			(await admin.as.query(api.staff.boxes.search, {})).map((row) => row.slug)
		).toEqual(["box-2", "box-1", "box-0"]);
	});

	// The list is capped, and the cap keeps the newest - a page that answered
	// with the oldest boxes on a fleet past the cap would be useless.
	test("caps the list at its limit, keeping the newest", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await fleet(t, STAFF_BOX_LIST_LIMIT + 5);

		const rows = await admin.as.query(api.staff.boxes.search, {});

		expect(rows).toHaveLength(STAFF_BOX_LIST_LIMIT);
		expect(rows[0].slug).toBe(`box-${STAFF_BOX_LIST_LIMIT + 4}`);
	});

	// A term is capped the same way after its own wider scan, so a term matching
	// the whole fleet cannot return more rows than the page can draw.
	test("caps a matching term at the same limit", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await fleet(t, STAFF_BOX_LIST_LIMIT + 5);

		expect(
			await admin.as.query(api.staff.boxes.search, { query: "box-" })
		).toHaveLength(STAFF_BOX_LIST_LIMIT);
	});
});

// Whose work an operation says it is, and one box's work staying its own.
//
// Every operation carries a trigger, and automatic repair reads that field alone
// to decide whether a person is already working on a box - so a staff action
// recorded as anything but "staff" invites the sweep to start a second repair
// underneath the engineer doing the first. It is one literal per endpoint, in a
// file where endpoints are written by copying the one above.
//
// The idempotency keys beside them are prefixed apart from the owner's for the
// same reason the trigger exists: the console and the owner are two hands on one
// box, and the console must not have its request silently absorbed by the
// owner's. Each is `staff-<type>:<box>`, so each is pressed here on two boxes.
describe("what a console action records", () => {
	// Endpoint -> the status its operation starts from. All of them take the box
	// by id; the console works from a box page, not from a name somebody typed.
	const CONSOLE = {
		changeSlug: {
			kind: "mutation",
			from: "running",
			args: { newSlug: "renamed" }
		},
		createSnapshot: { kind: "mutation", from: "running" },
		repair: { kind: "action", from: "running" },
		reset: { kind: "mutation", from: "running" },
		retryCreate: { kind: "mutation", from: "create_failed" },
		start: { kind: "mutation", from: "stopped" },
		stop: { kind: "mutation", from: "running" },
		suspend: { kind: "action", from: "running" },
		unsuspend: { kind: "action", from: "suspended" },
		update: { kind: "action", from: "running" }
	} as const;

	const names = Object.keys(CONSOLE) as (keyof typeof CONSOLE)[];

	async function box(
		t: Harness,
		name: keyof typeof CONSOLE,
		slug: string,
		owner: string
	) {
		return await seedBox(t, {
			user_id: owner,
			slug,
			// Pro, because a manual snapshot is a Pro capability and the console
			// does not carry an exemption from it.
			plan: "pro",
			manual_snapshot_cap: BOX_PLANS.pro.snapshotManualDefault,
			status: CONSOLE[name].from
		});
	}

	const press = (
		admin: Awaited<ReturnType<typeof cast>>["admin"],
		name: keyof typeof CONSOLE,
		boxId: Id<"boxes">
	) => {
		const entry = CONSOLE[name] as { kind: string; args?: object };
		const reference = api.staff.boxes[name];
		const payload = { boxId, ...entry.args };
		const call = admin.as[entry.kind === "action" ? "action" : "mutation"] as (
			reference: unknown,
			payload: unknown
		) => Promise<unknown>;
		return call(reference, payload);
	};

	// Renaming needs a second free name per box, so each case gets its own.
	const renameArgs = (name: keyof typeof CONSOLE, suffix: string) =>
		name === "changeSlug" ? { newSlug: `renamed-${suffix}` } : {};

	test.each(names)("%s records the work as staff's", async (name) => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await box(t, name, "atlas", customer.clerkUserId);

		await press(admin, name, boxId);

		expect(await boxOperations(t, boxId)).toMatchObject([{ trigger: "staff" }]);
	});

	// A console press is not an owner press: nothing here may be recorded against
	// the customer, which would tell the repair sweep to keep its hands off a box
	// no person is actually holding.
	test.each(names)("%s records nothing as the owner's", async (name) => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await box(t, name, "atlas", customer.clerkUserId);

		await press(admin, name, boxId);

		expect(
			(await boxOperations(t, boxId)).map((row) => row.trigger)
		).not.toContain("owner");
	});

	test.each(names)("%s keys its work per box", async (name) => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const first = await box(t, name, "atlas", customer.clerkUserId);
		const second = await box(t, name, "beta", customer.clerkUserId);

		const reference = api.staff.boxes[name];
		const send = (boxId: Id<"boxes">, suffix: string) => {
			const payload = { boxId, ...renameArgs(name, suffix) };
			const call = admin.as[
				CONSOLE[name].kind === "action" ? "action" : "mutation"
			] as (reference: unknown, payload: unknown) => Promise<unknown>;
			return call(reference, payload);
		};
		await send(first, "one");
		await send(second, "two");

		expect(await boxOperations(t, first)).toHaveLength(1);
		expect(await boxOperations(t, second)).toHaveLength(1);
	});

	// The console is subject to the plan, not exempt from it: taking a manual
	// snapshot for an Air customer would hand out a Pro capability by way of
	// support, and quietly cost a snapshot slot the plan does not budget for.
	test("refuses a manual snapshot on a plan without them", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			slug: "atlas",
			plan: "air",
			status: "running"
		});

		await expect(
			admin.as.mutation(api.staff.boxes.createSnapshot, { boxId })
		).rejects.toThrow(/Box Pro/);
		expect(await boxOperations(t, boxId)).toEqual([]);
	});

	// A box that is not there is reported as such rather than acted on. The
	// console passes an id out of a URL, and a stale tab is the ordinary case.
	test.each(names)("%s refuses a box that is not there", async (name) => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await box(t, name, "atlas", customer.clerkUserId);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await expect(press(admin, name, boxId)).rejects.toThrow(/not found/);
	});
});

// The console calls that read a box rather than act on it, and the two that key
// on something other than the box.
//
// These sit outside the attribution table above because they start no operation
// (the two readers) or key on more than the box (restore). They still answer to
// the same rule as everything else the console does: an id out of a stale URL is
// reported as "no such box" rather than acted on, or read past.
describe("the console calls left out of the attribution table", () => {
	async function box(t: Harness, status: Doc<"boxes">["status"] = "running") {
		const customer = await seedUser(t, {
			clerkUserId: "customer",
			email: "customer@example.com"
		});
		return await seedBox(t, {
			user_id: customer.clerkUserId,
			slug: "atlas",
			plan: "pro",
			manual_snapshot_cap: BOX_PLANS.pro.snapshotManualDefault,
			status
		});
	}

	// Pins the answer, not the line that produces it. Both of these load the box
	// through `getBoxLifecycleSnapshot`, which throws "Box not found." itself, so
	// the `if (!box)` guard beside each call site is unreachable and its message
	// is a second copy of the query's. Asserting the message therefore cannot
	// tell the two apart - it passes with either one deleted. What it does hold
	// is the thing staff see: an id from a stale console tab is reported as no
	// such box rather than acted on.
	test.each(["runtimeLogs", "recoveryStatus"] as const)(
		"%s reports a box that is not there, whichever guard answers",
		async (name) => {
			const t = testConvex();
			const { admin } = await cast(t);
			const boxId = await box(t);
			await t.run(async (ctx) => await ctx.db.delete(boxId));

			await expect(
				admin.as.action(api.staff.boxes[name], { boxId })
			).rejects.toThrow("Box not found.");
		}
	);

	test("restoreSnapshot refuses a snapshot that is not there", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		const boxId = await box(t);
		const snapshotId = await t.run(async (ctx) => {
			const id = await ctx.db.insert("box_snapshots", {
				box_id: boxId,
				class: "manual",
				status: "complete",
				created_at: NOW - 1000
			});
			await ctx.db.delete(id);
			return id;
		});

		await expect(
			admin.as.mutation(api.staff.boxes.restoreSnapshot, { snapshotId })
		).rejects.toThrow(/not found/);
	});

	// Restoring keys on the snapshot as well as the box, because restoring
	// yesterday's and last week's are two different pieces of work - and staff
	// pressing the second while the first runs must not have it absorbed as a
	// repeat.
	test("restoreSnapshot keys its work per snapshot", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		const boxId = await box(t);
		const [older, newer] = await t.run(async (ctx) => [
			await ctx.db.insert("box_snapshots", {
				box_id: boxId,
				class: "manual",
				status: "complete",
				created_at: NOW - 5000
			}),
			await ctx.db.insert("box_snapshots", {
				box_id: boxId,
				class: "manual",
				status: "complete",
				created_at: NOW - 1000
			})
		]);

		await admin.as.mutation(api.staff.boxes.restoreSnapshot, {
			snapshotId: older
		});

		// The second is a different request, so the key does not absorb it - the
		// box-busy guard behind the key refuses it instead.
		await expect(
			admin.as.mutation(api.staff.boxes.restoreSnapshot, { snapshotId: newer })
		).rejects.toThrow(/busy/);
		expect(await boxOperations(t, boxId)).toHaveLength(1);
	});

	// A box that is not running has no container to read from, and saying so
	// beats an SSH attempt against a host that is powered off.
	test.each(["stopped", "suspended", "creating", "create_failed"] as const)(
		"runtimeLogs answers with no logs for a %s box",
		async (status) => {
			const t = testConvex();
			const { admin } = await cast(t);
			const boxId = await box(t, status);

			expect(
				await admin.as.action(api.staff.boxes.runtimeLogs, { boxId })
			).toEqual({ logs: null });
		}
	);

	// Suspending and unsuspending are opposite requests, so they cannot share a
	// key. Asked while the suspension is still in flight, because that is the
	// only moment the two answers differ: a distinct key makes the unsuspend a
	// new request, which the box-busy guard turns away out loud, while a shared
	// key makes it a repeat of the suspension - absorbed in silence, reported to
	// staff as done, and the box stays off.
	test("suspend and unsuspend do not share a key", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		const boxId = await box(t, "running");

		await admin.as.action(api.staff.boxes.suspend, { boxId });
		// The status alone, not the operation: the suspension is still running.
		await t.run(
			async (ctx) => await ctx.db.patch(boxId, { status: "suspended" })
		);

		await expect(
			admin.as.action(api.staff.boxes.unsuspend, { boxId })
		).rejects.toThrow(/busy/);
	});

	// And once the suspension has settled, the unsuspend is its own operation
	// rather than a repeat of it.
	test("an unsuspend after a settled suspend is its own work", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		const boxId = await box(t, "running");

		await admin.as.action(api.staff.boxes.suspend, { boxId });
		await t.run(async (ctx) => {
			await ctx.db.patch(boxId, { status: "suspended" });
			for (const row of await ctx.db.query("box_operations").collect()) {
				await ctx.db.patch(row._id, { status: "succeeded" });
			}
		});

		await admin.as.action(api.staff.boxes.unsuspend, { boxId });

		expect(
			(await boxOperations(t, boxId)).map((row) => row.type).sort()
		).toEqual(["suspend", "unsuspend"]);
	});

	// A comp cannot take a name a paid checkout could not. Anything that
	// sanitises to nothing usable is refused rather than silently corrected.
	test.each(["!!!", "   ", "-"])(
		"a comp for the name %p is refused",
		async (slug) => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			await seedSettings(t);

			await expect(
				admin.as.mutation(api.staff.boxes.grantComp, {
					plan: "air",
					email: customer.email,
					slug,
					reason: "conference"
				})
			).rejects.toThrow("Slug is unavailable.");
		}
	);
});
