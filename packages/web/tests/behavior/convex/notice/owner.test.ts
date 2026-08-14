import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { customerEmailAlertKey } from "@/convex/email";
import { ownerNoticeEmail } from "@/convex/notice/owner";
import { SUPPORT_EMAIL } from "@/convex/model/links";

// One address the deployment cannot hand over, so `sendOwnerNotice`'s never-throw
// contract is reachable from here at all. Arranged rather than found: the
// component accepts an impossible address at queue time and lets Resend reject
// it later. Same wrapper as `accountEmail.test.ts`, for the same reason - a
// message handed to a queue and forgotten has no other observable.
type SentEmail = {
	replyTo?: string[];
	subject: string;
	text: string;
	to: string;
};

const { sent, UNREACHABLE } = vi.hoisted(() => ({
	sent: [] as SentEmail[],
	UNREACHABLE: "unreachable@example.com"
}));

vi.mock("@convex-dev/resend", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@convex-dev/resend")>();
	return {
		...actual,
		Resend: class {
			readonly inner: InstanceType<typeof actual.Resend>;

			constructor(...args: ConstructorParameters<typeof actual.Resend>) {
				this.inner = new actual.Resend(...args);
			}

			sendEmail(ctx: never, options: SentEmail) {
				if (options.to === UNREACHABLE) {
					throw new Error("Resend rejected the recipient address.");
				}
				sent.push(options);
				return this.inner.sendEmail(ctx, options as never);
			}
		}
	} as unknown as typeof actual;
});

import {
	boxEvents,
	readBox,
	seedBox,
	seedUser,
	staffAlerts,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// The five things a box owner is told, and the two ways of getting one wrong:
// saying something that was never true of their box, or repeating something
// written for staff. The wiring tests below run the real lifecycle mutations
// rather than calling the sender, because "which events reach an owner" is a
// property of those mutations and a test that called `sendOwnerNotice` directly
// would keep passing after the call site was deleted.

const NOW = Date.UTC(2026, 6, 28, 9, 0, 0);
const BOX = { slug: "atlas", url: "https://composery.test/boxes/box_1" };
const AUTOMATIC_REASON =
	"Automatic suspension: Sustained egress bandwidth at 940 Mbps (threshold 500 Mbps) over the last 30 minutes.";
const STAFF_REASON =
	"Suspended following a report of abusive or malicious use.";

function stubOwnerEmailEnv() {
	vi.stubEnv("RESEND_API_KEY", "re_test");
	vi.stubEnv(
		"RESEND_NOTICES_FROM",
		"Composery Notices <notices@composery.test>"
	);
}

beforeEach(() => {
	sent.length = 0;
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("what a deletion notice says", () => {
	test("names the subscription when the subscription is what ended", () => {
		const { subject, text } = ownerNoticeEmail(
			{ type: "deleted", trigger: "system:subscription_revoked" },
			BOX
		);

		expect(subject).toBe("Your Composery box atlas has been deleted");
		expect(text).toContain("Its subscription ended");
	});

	test("names the account deletion the owner asked for", () => {
		const { text } = ownerNoticeEmail(
			{ type: "deleted", trigger: "system:account_deletion" },
			BOX
		);

		expect(text).toContain("delete your Composery account");
	});

	test("says staff deleted it when staff did", () => {
		const { text } = ownerNoticeEmail(
			{ type: "deleted", trigger: "staff" },
			BOX
		);

		expect(text).toContain("Composery staff deleted it");
	});

	test("invents no reason for a re-driven deletion, which does not know one", () => {
		const { text } = ownerNoticeEmail(
			{ type: "deleted", trigger: "system:delete_retry" },
			BOX
		);

		expect(text).not.toContain("subscription");
		expect(text).not.toContain("account");
		expect(text).not.toContain("staff deleted");
	});

	test("says the deletion cannot be undone, whatever ordered it", () => {
		for (const trigger of [
			"system:subscription_revoked",
			"system:account_deletion",
			"staff",
			undefined
		] as const) {
			const { text } = ownerNoticeEmail({ type: "deleted", trigger }, BOX);
			expect(text).toContain("cannot be undone");
		}
	});
});

describe("what a suspension notice says", () => {
	test("repeats the measurement an automatic suspension was based on", () => {
		const { subject, text } = ownerNoticeEmail(
			{ type: "suspended", reason: AUTOMATIC_REASON },
			BOX
		);

		expect(subject).toBe("Your Composery box atlas has been suspended");
		expect(text).toContain(AUTOMATIC_REASON);
	});

	// A staff reason is forwarded too, and that is a deliberate reversal.
	//
	// It was withheld on the argument that a staff note is written for other
	// staff. Three surfaces disagree: the console dialog's presets are worded for
	// customers under a field that tells staff the reason is shown to the account
	// owner, and both the owner's box page and the account block already display
	// it. Withholding it here only made the email say less than the page it links
	// to. If that ever needs revisiting, all four move together.
	test("forwards a staff reason, which is written for the owner", () => {
		const { text } = ownerNoticeEmail(
			{ type: "suspended", reason: STAFF_REASON },
			BOX
		);

		expect(text).toContain(STAFF_REASON);
	});

	test("promises the files are still there, because they are", () => {
		const { text } = ownerNoticeEmail(
			{ type: "suspended", reason: undefined },
			BOX
		);

		expect(text).toContain("Nothing has been deleted");
		expect(text).toContain("have the suspension reviewed");
	});
});

describe("what a usage notice says", () => {
	// The one notice an owner can act on while there is still time, so it has to
	// carry both figures and the remedy - a percentage alone tells somebody they
	// have a problem without telling them the size of it or what to do.
	test("gives both figures, the cost of running out, and the way out", () => {
		const { subject, text } = ownerNoticeEmail(
			{
				type: "usage",
				signal: "disk",
				step: 80,
				usedBytes: 32_000_000_000,
				allowanceBytes: 40_000_000_000
			},
			BOX
		);

		expect(subject).toBe("Your Composery box atlas has used 80% of its disk");
		expect(text).toContain("32.0 GB of the 40.0 GB it includes");
		expect(text).toContain("stops the box writing");
		expect(text).toContain("prune Docker images");
	});

	test("names the signal it is about, so two limits cannot read alike", () => {
		const { subject, text } = ownerNoticeEmail(
			{
				type: "usage",
				signal: "traffic",
				step: 95,
				usedBytes: 19_000_000_000_000,
				allowanceBytes: 20_000_000_000_000
			},
			BOX
		);

		expect(subject).toBe(
			"Your Composery box atlas has used 95% of its outbound traffic"
		);
		expect(text).toContain("19.0 TB of the 20.0 TB it includes");
		expect(text).not.toContain("disk");
	});
});

describe("the other two notices", () => {
	test("an unsuspension says the box is back", () => {
		const { subject, text } = ownerNoticeEmail({ type: "unsuspended" }, BOX);

		expect(subject).toBe("Your Composery box atlas is running again");
		expect(text).toContain("suspension on your box atlas has been lifted");
	});

	test("a failed create tells the owner not to report it", () => {
		const { subject, text } = ownerNoticeEmail({ type: "create_failed" }, BOX);

		expect(subject).toBe("Your Composery box atlas could not be created");
		expect(text).toContain("You do not need to report it");
	});
});

test("a deployment with no website origin loses the link, not the sentence", () => {
	const { text } = ownerNoticeEmail(
		{ type: "deleted", trigger: "staff" },
		{ slug: "atlas", url: undefined }
	);

	expect(text).not.toContain("undefined");
	expect(text).not.toContain("The box:");
	expect(text).toContain("Composery staff deleted it");
});

// --- Which lifecycle outcomes actually reach an owner ------------------------

async function openOperation(
	t: Harness,
	boxId: Id<"boxes">,
	type: "create" | "delete" | "reset" | "suspend" | "unsuspend" | "stop",
	metadata?: Record<string, unknown>
) {
	return await t.run(
		async (ctx) =>
			await ctx.db.insert("box_operations", {
				box_id: boxId,
				type,
				status: "running",
				idempotency_key: `${type}:${boxId}`,
				trigger: type === "suspend" ? "system:abuse_suspension" : "staff",
				metadata,
				created_at: NOW,
				updated_at: NOW
			})
	);
}

async function emailedNotices(t: Harness, boxId: Id<"boxes">) {
	const events = await boxEvents(t, boxId);
	return events
		.filter((event) => event.type === "box.owner_emailed")
		.map((event) => event.metadata?.notice);
}

describe("which lifecycle outcomes email the owner", () => {
	test("a deletion does", async () => {
		stubOwnerEmailEnv();
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleting"
		});
		const operationId = await openOperation(t, boxId, "delete");

		await t.mutation(internal.boxes.operation.record.markDeleted, {
			boxId,
			operationId
		});

		expect(await emailedNotices(t, boxId)).toEqual(["deleted"]);
	});

	test("a suspension does, and a stop does not", async () => {
		stubOwnerEmailEnv();
		const t = testConvex();
		const owner = await seedUser(t);
		const suspended = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "suspended-box",
			status: "suspending"
		});
		const stopped = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "stopped-box",
			status: "stopping"
		});

		await t.mutation(
			internal.boxes.operation.record.setBoxStatusWithOperationSucceeded,
			{
				boxId: suspended,
				operationId: await openOperation(t, suspended, "suspend", {
					reason: AUTOMATIC_REASON
				}),
				status: "suspended"
			}
		);
		await t.mutation(
			internal.boxes.operation.record.setBoxStatusWithOperationSucceeded,
			{
				boxId: stopped,
				operationId: await openOperation(t, stopped, "stop"),
				status: "stopped"
			}
		);

		expect(await emailedNotices(t, suspended)).toEqual(["suspended"]);
		expect(await emailedNotices(t, stopped)).toEqual([]);
	});

	// Gated on the status it settled at as well as the operation type, because
	// this mutation also carries the transient `suspending`/`unsuspending`
	// statuses. A caller reporting progress through it must not announce a
	// suspension that has not happened, or a return that has not landed.
	test.each([
		["suspend", "suspending"],
		["unsuspend", "unsuspending"]
	] as const)(
		"a %s still in progress tells the owner nothing yet",
		async (type, status) => {
			stubOwnerEmailEnv();
			const t = testConvex();
			const owner = await seedUser(t);
			const boxId = await seedBox(t, {
				user_id: owner.clerkUserId,
				status: "running"
			});

			await t.mutation(
				internal.boxes.operation.record.setBoxStatusWithOperationSucceeded,
				{
					boxId,
					operationId: await openOperation(t, boxId, type),
					status
				}
			);

			expect(await emailedNotices(t, boxId)).toEqual([]);
		}
	);

	test("an unsuspension does", async () => {
		stubOwnerEmailEnv();
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "unsuspending"
		});

		await t.mutation(
			internal.boxes.operation.record.setBoxStatusWithOperationSucceeded,
			{
				boxId,
				operationId: await openOperation(t, boxId, "unsuspend"),
				status: "running"
			}
		);

		expect(await emailedNotices(t, boxId)).toEqual(["unsuspended"]);
	});

	test("a failed create does, and a failed reset does not", async () => {
		stubOwnerEmailEnv();
		const t = testConvex();
		const owner = await seedUser(t);
		const created = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "new-box",
			status: "creating"
		});
		const reset = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "old-box",
			status: "resetting"
		});

		await t.mutation(internal.boxes.operation.record.markOperationFailed, {
			boxId: created,
			error: "hetzner said 409 on 10.0.0.4",
			operationId: await openOperation(t, created, "create"),
			targetBoxStatus: "create_failed"
		});
		await t.mutation(internal.boxes.operation.record.markOperationFailed, {
			boxId: reset,
			error: "the host never answered",
			operationId: await openOperation(t, reset, "reset"),
			targetBoxStatus: "reset_failed"
		});

		expect(await emailedNotices(t, created)).toEqual(["create_failed"]);
		expect(await emailedNotices(t, reset)).toEqual([]);
	});
});

describe("when an owner cannot be reached", () => {
	test("a deployment without a sender configured emails nobody", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleting"
		});
		const operationId = await openOperation(t, boxId, "delete");

		await t.mutation(internal.boxes.operation.record.markDeleted, {
			boxId,
			operationId
		});

		expect(await emailedNotices(t, boxId)).toEqual([]);
		expect(await readBox(t, boxId)).toMatchObject({ status: "deleted" });
	});

	test("an already-scrubbed account is not mailed at its placeholder address", async () => {
		stubOwnerEmailEnv();
		const t = testConvex();
		const owner = await seedUser(t, {
			email: "deleted-user-abc@deleted.invalid"
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(owner.userId, { deletion_finished_at: NOW - 1000 });
		});
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleting"
		});
		const operationId = await openOperation(t, boxId, "delete");

		await t.mutation(internal.boxes.operation.record.markDeleted, {
			boxId,
			operationId
		});

		expect(await emailedNotices(t, boxId)).toEqual([]);
		expect(await readBox(t, boxId)).toMatchObject({ status: "deleted" });
	});

	// The guarantee the whole design rests on: the notice is the last thing in a
	// transaction that has already torn a box down, so a box with no owner row at
	// all still finishes its deletion and still closes its operation. A throw here
	// would fail the operation, and a failed delete operation is what leaves a box
	// holding its own lock in `delete_failed` for ever.
	// An owner notice keeps no row, so a delivery event for one finds nothing to
	// update. That is the whole design - a bounce has no action behind it - with
	// one exception: a complaint is a problem with the sender, not the recipient,
	// and owner notices share their sending reputation with these very alerts.
	test.each([
		["email.bounced", "warning", "A box owner notice was not delivered"],
		[
			"email.complained",
			"critical",
			"A box owner marked a Composery notice as spam"
		]
	])("a %s owner notice tells staff", async (type, severity, subject) => {
		const t = testConvex();

		await t.mutation(internal.staff.alerts.recordEmailEvent, {
			id: "email_owner_1",
			event: {
				type,
				created_at: "2026-07-28T09:00:00.000Z",
				data: {
					created_at: "2026-07-28T09:00:00.000Z",
					email_id: "email_owner_1",
					from: "Composery Notices <notices@composery.test>",
					to: "owner@example.com",
					subject: "Your Composery box atlas has been deleted",
					...(type === "email.bounced"
						? {
								bounce: {
									type: "Permanent",
									subType: "General",
									message: "The mailbox does not exist."
								}
							}
						: {})
				}
			}
		} as never);

		expect(await staffAlerts(t)).toMatchObject([
			{ severity, subject, text: expect.stringContaining("owner@example.com") }
		]);
	});

	test("a delivered owner notice tells staff nothing", async () => {
		const t = testConvex();

		await t.mutation(internal.staff.alerts.recordEmailEvent, {
			id: "email_owner_2",
			event: {
				type: "email.delivered",
				created_at: "2026-07-28T09:00:00.000Z",
				data: {
					created_at: "2026-07-28T09:00:00.000Z",
					email_id: "email_owner_2",
					from: "Composery Notices <notices@composery.test>",
					to: "owner@example.com",
					subject: "Your Composery box atlas has been deleted"
				}
			}
		} as never);

		expect(await staffAlerts(t)).toEqual([]);
	});

	test("a box whose owner row is gone still finishes its deletion", async () => {
		stubOwnerEmailEnv();
		const t = testConvex();
		const boxId = await seedBox(t, {
			user_id: "clerk_user_that_no_longer_exists",
			status: "deleting"
		});
		const operationId = await openOperation(t, boxId, "delete");

		await t.mutation(internal.boxes.operation.record.markDeleted, {
			boxId,
			operationId
		});

		expect(await emailedNotices(t, boxId)).toEqual([]);
		expect(await readBox(t, boxId)).toMatchObject({ status: "deleted" });
		expect(await staffAlerts(t)).toEqual([]);
	});
});

// Each of the four notices, whole.
//
// Everything above asks whether a particular sentence is present, which is the
// right question for each on its own and cannot answer the one that matters:
// what does the owner read? A notice is assembled from a list of paragraphs,
// some of which drop out, so the failures worth catching are between the
// sentences - a doubled blank line where the reason should have been, a link
// line that outlived its link, "this cannot be undone" landing after the
// sign-off.
//
// The `not.toContain("undefined")` checks above cannot see any of that: joining
// an array containing `undefined` renders it as an empty string, not as the word.
// So these assert the whole body, which is the only assertion here a reordering
// or a lost separator cannot pass.
describe("each notice, whole", () => {
	const BOX = { slug: "atlas", url: "https://composery.test/boxes/abc" };
	const REPLY = `Reply to this email if you need a hand - it reaches ${SUPPORT_EMAIL}.`;

	const body = (
		notice: Parameters<typeof ownerNoticeEmail>[0],
		box: Parameters<typeof ownerNoticeEmail>[1] = BOX
	) => ownerNoticeEmail(notice, box).text;

	test("a deletion the subscription ended", () => {
		expect(
			body({ type: "deleted", trigger: "system:subscription_revoked" })
		).toBe(
			[
				"Your box atlas has been deleted.",
				"Its subscription ended. A box exists only while its subscription is active.",
				"Its files, snapshots and backups went with it. Composery keeps no copy of a deleted box, so this cannot be undone.",
				`Your remaining boxes: ${BOX.url}`,
				REPLY
			].join("\n\n")
		);
	});

	// A re-driven deletion knows no reason, so the paragraph is absent rather
	// than blank - and the sentences either side must still read as one message.
	test("a deletion that knows no reason", () => {
		expect(body({ type: "deleted", trigger: "owner" })).toBe(
			[
				"Your box atlas has been deleted.",
				"Its files, snapshots and backups went with it. Composery keeps no copy of a deleted box, so this cannot be undone.",
				`Your remaining boxes: ${BOX.url}`,
				REPLY
			].join("\n\n")
		);
	});

	test("a suspension with the reason that caused it", () => {
		expect(body({ type: "suspended", reason: "Sustained 98% CPU." })).toBe(
			[
				"Your box atlas has been suspended and its server powered off.",
				"Nothing has been deleted. Your files are exactly as you left them and come back with the box.",
				"Sustained 98% CPU.",
				`The box: ${BOX.url}`,
				`Reply to this email to have the suspension reviewed - it reaches ${SUPPORT_EMAIL}.`
			].join("\n\n")
		);
	});

	test("a suspension with no reason to give", () => {
		expect(body({ type: "suspended", reason: undefined })).toBe(
			[
				"Your box atlas has been suspended and its server powered off.",
				"Nothing has been deleted. Your files are exactly as you left them and come back with the box.",
				`The box: ${BOX.url}`,
				`Reply to this email to have the suspension reviewed - it reaches ${SUPPORT_EMAIL}.`
			].join("\n\n")
		);
	});

	test("an unsuspension", () => {
		expect(body({ type: "unsuspended" })).toBe(
			[
				"The suspension on your box atlas has been lifted and its server is back on.",
				`The box: ${BOX.url}`,
				REPLY
			].join("\n\n")
		);
	});

	test("a create that could not finish", () => {
		expect(body({ type: "create_failed" })).toBe(
			[
				"We could not finish creating your box atlas, so there is nothing running yet.",
				"Composery staff were alerted automatically and are looking at it. You do not need to report it.",
				`The box: ${BOX.url}`,
				REPLY
			].join("\n\n")
		);
	});

	// A deployment with no website has no page to send anyone to, so the line
	// goes rather than pointing at nothing. Asked of every notice, because the
	// link paragraph is written out separately in each.
	test.each([
		["deleted", { type: "deleted", trigger: "system:subscription_revoked" }],
		["suspended", { type: "suspended", reason: undefined }],
		["unsuspended", { type: "unsuspended" }],
		["create_failed", { type: "create_failed" }]
	] as const)(
		"a %s notice with no box link drops the line",
		(_name, notice) => {
			const text = body(notice as Parameters<typeof ownerNoticeEmail>[0], {
				slug: "atlas",
				url: undefined
			});

			expect(text).not.toContain("The box:");
			expect(text).not.toContain("Your remaining boxes:");
			expect(text).not.toContain("\n\n\n");
		}
	);

	// The suspension signs off differently from the other three: it invites a
	// challenge, they offer help. Telling somebody whose box was just deleted to
	// "have the suspension reviewed" would point them at the wrong remedy.
	test("only the suspension invites a review", () => {
		const invites = "have the suspension reviewed";

		expect(body({ type: "suspended", reason: undefined })).toContain(invites);
		for (const notice of [
			{ type: "deleted", trigger: "system:subscription_revoked" },
			{ type: "unsuspended" },
			{ type: "create_failed" }
		] as const) {
			expect(body(notice as Parameters<typeof ownerNoticeEmail>[0])).toContain(
				REPLY
			);
		}
	});
});

// A notice that cannot be queued, which must not undo what it was reporting.
//
// Every caller is a mutation whose real work has already happened in the same
// transaction - the box is deleted, the box is suspended. A notice that threw
// would roll that back, so the box would come out of the mutation still running
// and the operation that deleted it recorded as done. Hence the whole body is
// caught, and the alert reporting the catch is caught too: the fallback must not
// be the thing that finally fails what it was covering for.
describe("when a box notice cannot be queued", () => {
	async function deleteBoxOwnedBy(t: Harness, email: string) {
		const owner = await seedUser(t, { email });
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleting"
		});
		const operationId = await openOperation(t, boxId, "delete");
		await t.mutation(internal.boxes.operation.record.markDeleted, {
			boxId,
			operationId
		});
		return boxId;
	}

	test("the deletion it was reporting still stands", async () => {
		stubOwnerEmailEnv();
		const t = testConvex();

		const boxId = await deleteBoxOwnedBy(t, UNREACHABLE);

		expect(await readBox(t, boxId)).toMatchObject({ status: "deleted" });
	});

	// Reported once per window rather than per owner: a queue failure is a
	// property of the deployment, so one misconfiguration must not raise an alert
	// for every customer it silently failed to reach.
	test("staff are told, in the boxes stream", async () => {
		stubOwnerEmailEnv();
		const t = testConvex();

		await deleteBoxOwnedBy(t, UNREACHABLE);

		expect(await staffAlerts(t)).toMatchObject([
			{
				key: customerEmailAlertKey("notices"),
				severity: "warning",
				subject: "A box owner could not be emailed"
			}
		]);
	});

	// The alert has to say who was not reached and what they were not told -
	// nothing retries this, so acting on it by hand is the only remedy.
	test("the alert names the box, the owner and what went wrong", async () => {
		stubOwnerEmailEnv();
		const t = testConvex();

		await deleteBoxOwnedBy(t, UNREACHABLE);

		const [alert] = await staffAlerts(t);
		expect(alert.text).toContain("A deleted notice for box");
		expect(alert.text).toContain("Resend rejected the recipient address.");
		// Names the variable to check by the name it actually has. An alert whose
		// whole job is pointing at the right dial is worse than useless when it
		// names one that does not exist.
		expect(alert.text).toContain("RESEND_NOTICES_FROM");
	});

	test("two owners in one window open one alert", async () => {
		stubOwnerEmailEnv();
		const t = testConvex();

		await deleteBoxOwnedBy(t, UNREACHABLE);
		await deleteBoxOwnedBy(t, UNREACHABLE);

		expect(await staffAlerts(t)).toHaveLength(1);
	});
});

// Where a reply to a box notice goes.
//
// Each of these ends by inviting a reply, and they are sent from a notices
// address nobody watches. The reply-to header is what makes the invitation true;
// without it the owner answers a deletion or a suspension into nothing, which is
// the one path a customer has to reach a person about a box that is gone.
describe("where a reply to a box notice goes", () => {
	test("a deletion notice replies to support", async () => {
		stubOwnerEmailEnv();
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleting"
		});
		const operationId = await openOperation(t, boxId, "delete");

		await t.mutation(internal.boxes.operation.record.markDeleted, {
			boxId,
			operationId
		});

		expect(sent).toMatchObject([{ replyTo: [SUPPORT_EMAIL] }]);
	});

	// The address the owner is told to write to is the address replies go to.
	test("sends replies to the address the message names", async () => {
		stubOwnerEmailEnv();
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleting"
		});
		const operationId = await openOperation(t, boxId, "delete");

		await t.mutation(internal.boxes.operation.record.markDeleted, {
			boxId,
			operationId
		});

		const [message] = sent;
		expect(message.text).toContain(message.replyTo?.[0]);
	});
});
