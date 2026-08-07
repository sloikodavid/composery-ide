import { fetchAction } from "convex/nextjs";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
	CLOUD_AUTH_HEADERS,
	isBoxIdString,
	isFlowSecret,
	isPasswordHash
} from "@/convex/model/box/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return response({ error: "Invalid request." }, 400);
	}
	// Two ways to authorise the same write: a setup grant from the website
	// (ownership proven through Clerk), or the box's current hash (the holder
	// proved the current password on the box itself).
	if (isPasswordChangeRequest(body)) {
		try {
			const result = await fetchAction(api.instance.auth.changePassword, {
				boxId: body.boxId as Id<"boxes">,
				currentRuntimeAuthHash: body.currentRuntimeAuthHash,
				runtimeAuthHash: body.runtimeAuthHash
			});
			return response(result, 202);
		} catch {
			return response({ error: "Password change could not start." }, 409);
		}
	}
	if (!isPasswordRequest(body)) {
		return response({ error: "Invalid request." }, 400);
	}

	try {
		const result = await fetchAction(api.instance.auth.installPassword, {
			boxId: body.boxId as Id<"boxes">,
			grant: body.grant,
			runtimeAuthHash: body.runtimeAuthHash
		});
		return response(result, 202);
	} catch {
		return response({ error: "Password setup could not start." }, 409);
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPasswordChangeRequest(value: unknown): value is {
	boxId: string;
	currentRuntimeAuthHash: string;
	runtimeAuthHash: string;
} {
	return (
		isObject(value) &&
		isBoxIdString(value.boxId) &&
		isPasswordHash(value.currentRuntimeAuthHash) &&
		isPasswordHash(value.runtimeAuthHash)
	);
}

function isPasswordRequest(value: unknown): value is {
	boxId: string;
	grant: string;
	runtimeAuthHash: string;
} {
	return (
		isObject(value) &&
		isBoxIdString(value.boxId) &&
		isFlowSecret(value.grant) &&
		isPasswordHash(value.runtimeAuthHash)
	);
}

function response(body: unknown, status: number) {
	return NextResponse.json(body, { status, headers: CLOUD_AUTH_HEADERS });
}
