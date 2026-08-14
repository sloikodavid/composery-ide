import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { stubDeploymentEnv, testConvex } from "../../support/convex.ts";

// The two signed webhook routes, asked the only question a test can answer
// without the sender's private key: does an unsigned request get in? Both routes
// act on their body - one records mail delivery, the other deletes a Composery
// account and every box on it - so "verify first" is the whole security of the
// endpoint, and an endpoint that stopped verifying would still answer 2xx to
// every legitimate call and pass any test that only checked the happy path.

beforeEach(() => {
	stubDeploymentEnv();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

// The budget is the file's, not any one test's, because the cost is the file's:
// whichever of these runs first pays for loading the webhook verification stack
// behind both routes (svix, and the Resend component's client), and `shuffle`
// decides which one that is. Measured at ~1s for the first and milliseconds for
// the rest on an idle machine; the whole-repo run contends five packages for the
// same cores, which is where the stock 15s ceiling caught the wrong test.
describe("signed webhook routes", { timeout: 60_000 }, () => {
	// This one throws where the Clerk route below answers 401, and that asymmetry
	// is left alone deliberately. A throw becomes a 500, and Resend retries a 500
	// while it drops a 401 - so an internal failure part-way through recording a
	// delivery event gets another attempt instead of being lost. Reading a clean
	// 401 back out of the component would mean matching on an error name from a
	// transitive dependency, which is a brittle way to buy tidier logs.
	test("the Resend event route refuses an unsigned request", async () => {
		vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_test");
		const t = testConvex();

		await expect(
			t.fetch("/resend/events", {
				method: "POST",
				body: JSON.stringify({ type: "email.delivered" })
			})
		).rejects.toThrow(/headers|signature/i);
	});

	test("the Clerk event route refuses an unsigned request", async () => {
		vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_test");
		const t = testConvex();

		const response = await t.fetch("/clerk/events", {
			method: "POST",
			body: JSON.stringify({ type: "user.deleted", data: { id: "clerk_1" } })
		});

		expect(response.status).toBe(401);
	});

	// A deployment with no Clerk secret must not treat "cannot verify" as
	// "verified": the payload it would then trust deletes an account.
	test("the Clerk event route refuses everything when it has no secret", async () => {
		const t = testConvex();

		const response = await t.fetch("/clerk/events", {
			method: "POST",
			body: JSON.stringify({ type: "user.deleted", data: { id: "clerk_1" } })
		});

		expect(response.status).toBe(500);
	});
});

// Everything the Clerk route decides once the signature has checked out.
//
// The tests above prove an unsigned request cannot get in. These sign a real
// payload with the same secret, which is the only way to reach the branches
// behind verification - and those branches decide whether an account and every
// box on it are deleted.
describe("what the Clerk route does with a request it trusts", () => {
	const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
	// svix stamps and then checks the signature's timestamp against now, so both
	// sides have to read the same clock. Pinning it makes that one instant.
	const NOW = Date.UTC(2026, 6, 28, 9, 0, 0);

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// The signature svix itself would compute, so verification passes for the
	// same reason it would in production.
	async function signedPost(
		t: ReturnType<typeof testConvex>,
		payload: unknown
	) {
		const { Webhook } = await import("svix");
		const body = JSON.stringify(payload);
		const id = "msg_test";
		const timestamp = new Date();
		const signature = new Webhook(SECRET).sign(id, timestamp, body);

		return await t.fetch("/clerk/events", {
			method: "POST",
			body,
			headers: {
				"svix-id": id,
				"svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
				"svix-signature": signature
			}
		});
	}

	const deletions = (t: ReturnType<typeof testConvex>) =>
		t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(job) => job.name.startsWith("accountDeletion")
			)
		);

	test("starts the deletion a user.deleted event asks for", async () => {
		vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", SECRET);
		const t = testConvex();
		await t.run(
			async (ctx) =>
				await ctx.db.insert("users", {
					clerk_user_id: "clerk_1",
					email: "gone@example.com",
					role: "user",
					suspended: false,
					created_at: 1,
					updated_at: 1
				})
		);

		const response = await signedPost(t, {
			type: "user.deleted",
			data: { id: "clerk_1" }
		});

		expect(response.status).toBe(202);
		const [user] = await t.run((ctx) => ctx.db.query("users").collect());
		expect(user).toMatchObject({ deletion_pending: true });
	});

	// Clerk sends every event on one endpoint. Anything that is not a deletion is
	// acknowledged and ignored - answering an error would make Clerk retry an
	// event we were never going to act on.
	test.each(["user.created", "user.updated", "session.created"])(
		"acknowledges and ignores a %s event",
		async (type) => {
			vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", SECRET);
			const t = testConvex();

			const response = await signedPost(t, { type, data: { id: "clerk_1" } });

			expect(response.status).toBe(202);
			expect(await deletions(t)).toEqual([]);
		}
	);

	// A deletion naming nobody is a malformed request, not something to act on -
	// and acting on it would mean deleting whatever `undefined` resolves to.
	test.each([
		["no data at all", { type: "user.deleted" }],
		["no id", { type: "user.deleted", data: {} }],
		["an empty id", { type: "user.deleted", data: { id: "" } }],
		["an id that is not a string", { type: "user.deleted", data: { id: 7 } }]
	])("refuses a deletion with %s", async (_name, payload) => {
		vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", SECRET);
		const t = testConvex();

		const response = await signedPost(t, payload);

		expect(response.status).toBe(400);
		expect(await deletions(t)).toEqual([]);
	});
});
