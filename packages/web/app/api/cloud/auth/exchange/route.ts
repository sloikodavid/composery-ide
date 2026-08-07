import { fetchAction } from "convex/nextjs";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
	CLOUD_AUTH_HEADERS,
	isAuthorizationType,
	isBoxIdString,
	isFlowSecret,
	isRedirectUri,
	type AuthorizationType
} from "@/convex/model/box/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return response({ error: "Invalid request." }, 400);
	}
	if (!isExchangeRequest(body)) {
		return response({ error: "Invalid request." }, 400);
	}

	try {
		const result = await fetchAction(
			api.instance.auth.exchangeAuthorizationCode,
			{
				boxId: body.boxId as Id<"boxes">,
				code: body.code,
				codeVerifier: body.codeVerifier,
				redirectUri: body.redirectUri,
				type: body.type ?? "password"
			}
		);
		return response(result, 200);
	} catch {
		return response({ error: "Invalid or expired authorization code." }, 401);
	}
}

function isExchangeRequest(value: unknown): value is {
	boxId: string;
	code: string;
	codeVerifier: string;
	redirectUri: string;
	type?: AuthorizationType;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const body = value as Record<string, unknown>;
	return (
		isBoxIdString(body.boxId) &&
		isFlowSecret(body.code) &&
		isFlowSecret(body.codeVerifier) &&
		isRedirectUri(body.redirectUri) &&
		(body.type === undefined || isAuthorizationType(body.type))
	);
}

function response(body: unknown, status: number) {
	return NextResponse.json(body, { status, headers: CLOUD_AUTH_HEADERS });
}
