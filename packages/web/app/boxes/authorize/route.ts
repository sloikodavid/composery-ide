import { auth } from "@clerk/nextjs/server";
import { fetchAction } from "convex/nextjs";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { signInUrlForReturnPath } from "@/lib/auth-routing";
import {
	CLOUD_AUTH_HEADERS,
	isAuthorizationType,
	isBoxIdString,
	isFlowSecret,
	isOauthState,
	isRedirectUri
} from "@/convex/model/box/auth";

export const dynamic = "force-dynamic";

function error(message: string, status = 400) {
	return new NextResponse(message, { status, headers: CLOUD_AUTH_HEADERS });
}

export async function GET(request: Request) {
	const url = new URL(request.url);
	const boxId = url.searchParams.get("box_id") ?? "";
	const codeChallenge = url.searchParams.get("code_challenge") ?? "";
	const state = url.searchParams.get("state") ?? "";
	const redirectUri = url.searchParams.get("redirect_uri") ?? "";
	const type = url.searchParams.get("type") ?? "password";
	if (
		!isBoxIdString(boxId) ||
		!isFlowSecret(codeChallenge) ||
		!isOauthState(state) ||
		!isAuthorizationType(type) ||
		!isRedirectUri(redirectUri)
	) {
		return error("Invalid box authorization request.");
	}

	const session = await auth();
	if (!session.isAuthenticated) {
		const returnPath = `${url.pathname}${url.search}`;
		return NextResponse.redirect(
			new URL(signInUrlForReturnPath(returnPath), url.origin),
			{ headers: { "Cache-Control": "no-store" } }
		);
	}

	const token = await session.getToken({ template: "convex" });
	if (!token) return error("Authentication unavailable.", 503);

	try {
		const authorization = await fetchAction(
			api.instance.auth.createAuthorizationCode,
			{
				boxId: boxId as Id<"boxes">,
				codeChallenge,
				redirectUri,
				type
			},
			{ token }
		);
		const callback = new URL(authorization.redirectUri);
		callback.searchParams.set("code", authorization.code);
		callback.searchParams.set("state", state);
		return NextResponse.redirect(callback, { headers: CLOUD_AUTH_HEADERS });
	} catch {
		return error("Box authorization is unavailable.", 404);
	}
}
