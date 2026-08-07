import { ConvexError } from "convex/values";

// Reading what a Convex error says about itself.
//
// A `ConvexError` may carry structured data as well as a message, and two
// readers care about it: a toast, which wants one sentence, and the boxes
// boundary, which draws the blocked-account case as a card. Each was parsing
// that payload itself, so "does this error already have words in it" had two
// answers written two different ways.
type ConvexErrorData = {
	detail?: unknown;
	kind?: unknown;
	title?: unknown;
};

function convexErrorData(error: unknown): ConvexErrorData | null {
	if (!(error instanceof ConvexError)) return null;
	const data: unknown = error.data;
	if (!data || typeof data !== "object") return null;
	return data as ConvexErrorData;
}

// A title and a detail, when the error carries both. This is what lets an error
// that already reads as prose be drawn as prose rather than as its own JSON.
function titledError(data: ConvexErrorData) {
	return typeof data.title === "string" && typeof data.detail === "string"
		? { detail: data.detail, title: data.title }
		: null;
}

// The refusal every entry point behind the boxes pages returns for a suspended
// or mid-deletion account (see `convex/users.ts` -> AccountBlock), or null for
// anything else. `kind` is what separates it from any other titled error.
export function accountBlock(error: unknown) {
	const data = convexErrorData(error);
	if (!data || data.kind !== "account_unavailable") return null;
	return titledError(data);
}

export function errorMessage(error: unknown) {
	if (error instanceof ConvexError) {
		const payload: unknown = error.data;
		if (typeof payload === "string") return payload;

		const data = convexErrorData(error);
		const titled = data && titledError(data);
		if (titled) return `${titled.title}. ${titled.detail}`;

		try {
			return JSON.stringify(payload) ?? "Something went wrong.";
		} catch {
			return "Something went wrong.";
		}
	}

	if (error instanceof Error) return error.message;
	return String(error);
}
