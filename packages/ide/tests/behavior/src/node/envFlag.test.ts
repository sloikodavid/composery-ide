import { afterEach, describe, expect, test } from "vitest";

import { envFlag } from "../../../../overlay/src/node/envFlag.ts";

const NAME = "COMPOSERY_TEST_FLAG";

afterEach(() => {
	delete process.env[NAME];
});

function read(value: string | undefined): boolean {
	if (value === undefined) delete process.env[NAME];
	else process.env[NAME] = value;
	return envFlag(NAME);
}

describe("envFlag", () => {
	test.each(["1", "true", "TRUE", "True", " true ", "\t1\n"])(
		"%j turns the switch on",
		(value) => {
			expect(read(value)).toBe(true);
		}
	);

	test.each([
		undefined,
		"",
		"   ",
		"0",
		"false",
		"FALSE",
		"no",
		"yes",
		"on",
		"t rue",
		"true1",
		"1 1",
		"truthy"
	])("%j leaves the switch off", (value) => {
		expect(read(value)).toBe(false);
	});

	test("an unset variable is off without reading a neighbour", () => {
		process.env[`${NAME}_SUFFIX`] = "true";
		try {
			expect(read(undefined)).toBe(false);
		} finally {
			delete process.env[`${NAME}_SUFFIX`];
		}
	});
});
