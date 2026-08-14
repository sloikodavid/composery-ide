import { describe, expect, test } from "vitest";

import { API_OPERATION, SPEC_ID } from "@/lib/docs/openapi.ts";

describe("openapi", () => {
	test("the spec is registered under the id every reader asks for", () => {
		// source.ts and api-operation.tsx both call getSchema(SPEC_ID); the id has
		// to be the one createOpenAPI registered, and `input: { instance: ... }`
		// is what names it.
		expect(SPEC_ID).toBe("instance");
	});

	test("API_OPERATION matches the tag a page uses and nothing else", () => {
		const line = '<APIOperation path="/terminals" method="post" />';

		expect([...line.matchAll(API_OPERATION)].map((m) => [m[1], m[2]])).toEqual([
			["/terminals", "post"]
		]);
	});

	test("API_OPERATION ignores a tag that is not alone on its line", () => {
		// It is replaced by a component, so a partial match would rewrite prose
		// around it. Anchored to the whole line for that reason.
		expect(
			`text <APIOperation path="/terminals" method="post" />`.match(
				API_OPERATION
			)
		).toBeNull();
	});
});
