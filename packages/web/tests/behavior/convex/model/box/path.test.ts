import { describe, expect, test } from "vitest";
import { boxPath, consoleBoxPath } from "@/convex/model/box/path";

describe("box detail routes", () => {
	test("uses the immutable box id for the owner route", () => {
		expect(boxPath("box-id-123")).toBe("/boxes/box-id-123");
	});

	test("uses the same immutable identity under the staff namespace", () => {
		expect(consoleBoxPath("box-id-123")).toBe("/console/boxes/box-id-123");
	});
});
