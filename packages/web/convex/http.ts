import { Webhook } from "svix";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { registerPolarWebhookRoutes } from "./billing/webhooks";
import { resendClient } from "./email";
import { optionalEnv } from "./env";

type ClerkUserDeletedPayload = {
	data?: {
		id?: unknown;
	};
	type?: unknown;
};

const http = httpRouter();

function svixHeaders(request: Request) {
	return {
		"svix-id": request.headers.get("svix-id") ?? "",
		"svix-timestamp": request.headers.get("svix-timestamp") ?? "",
		"svix-signature": request.headers.get("svix-signature") ?? ""
	};
}

registerPolarWebhookRoutes(http);

http.route({
	path: "/resend/events",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		return await resendClient().handleResendEventWebhook(ctx, request);
	})
});

http.route({
	path: "/clerk/events",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const secret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
		if (!secret) {
			return new Response("Missing Clerk webhook signing secret.", {
				status: 500
			});
		}

		const body = await request.text();
		let payload: ClerkUserDeletedPayload;

		try {
			payload = new Webhook(secret).verify(
				body,
				svixHeaders(request)
			) as ClerkUserDeletedPayload;
		} catch {
			return new Response("Invalid Clerk webhook signature.", { status: 401 });
		}

		if (payload.type !== "user.deleted") {
			return new Response("Ignored.", { status: 202 });
		}

		const clerkUserId = payload.data?.id;
		if (typeof clerkUserId !== "string" || !clerkUserId) {
			return new Response("Missing Clerk user id.", { status: 400 });
		}

		await ctx.runAction(
			internal.account.deletion.requestAccountDeletionForClerkUser,
			{ clerkUserId }
		);

		return new Response("Accepted.", { status: 202 });
	})
});

export default http;
