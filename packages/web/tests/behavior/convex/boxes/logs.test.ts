import { describe, expect, test, vi } from "vitest";

import type { ActionCtx } from "@/convex/_generated/server";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchRuntimeLogsSafely } from "@/convex/boxes/logs";

// The log stream a box's page polls while the box is broken - which is the only
// time anyone reads it. "Unavailable" is a normal answer here: a stopped box, a
// container mid-restart, a host that has not finished booting. Throwing would
// take down the page the owner opened to find out what is wrong.

const BOX_ID = "boxes:1" as Id<"boxes">;

function ctxReturning(logs: string): ActionCtx {
	return { runAction: vi.fn(async () => logs) } as unknown as ActionCtx;
}

function ctxThrowing(error: unknown): ActionCtx {
	return {
		runAction: vi.fn(async () => {
			throw error;
		})
	} as unknown as ActionCtx;
}

describe("fetching a box's runtime logs", () => {
	test("hands back what the host printed", async () => {
		expect(
			await fetchRuntimeLogsSafely(ctxReturning("boot ok"), BOX_ID)
		).toEqual({ logs: "boot ok" });
	});

	// Distinguishable from a box that printed nothing: null is "we could not
	// read them", an empty string is "there are none", and the page says
	// different things about each.
	test("reports an empty log as empty rather than unavailable", async () => {
		expect(await fetchRuntimeLogsSafely(ctxReturning(""), BOX_ID)).toEqual({
			logs: ""
		});
	});

	test.each([
		["a host that will not answer", new Error("connect ETIMEDOUT")],
		["a container mid-restart", new Error("No such container")],
		["something that is not an Error at all", "boom"]
	])("reports %s as unavailable rather than throwing", async (_name, error) => {
		expect(await fetchRuntimeLogsSafely(ctxThrowing(error), BOX_ID)).toEqual({
			logs: null
		});
	});
});
