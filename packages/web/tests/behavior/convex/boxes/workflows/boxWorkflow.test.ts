import { describe, expect, test } from "vitest";
import { operationError } from "@/convex/boxes/workflows/boxWorkflow";

describe("operationError", () => {
	// Verbatim shape of a repair failure as Convex hands it back, and as the
	// Repair dialog used to print it.
	test("strips the Convex wrapper and the server stack trace", () => {
		expect(
			operationError(
				new Error(
					`Uncaught Error: The runtime came up but its editor never started.
    at Channel.<anonymous> (../../../convex/boxes/infra/host.ts:156:13)
    at Channel.emit (node:events:518:28)`
				)
			)
		).toBe("The runtime came up but its editor never started.");
	});

	test("passes a plain message through", () => {
		expect(
			operationError(new Error("Box has no runtime image for repair."))
		).toBe("Box has no runtime image for repair.");
		expect(operationError("thrown string")).toBe("thrown string");
	});

	test("never records an empty reason", () => {
		expect(operationError(new Error("Uncaught Error: "))).toBe(
			"Something went wrong."
		);
	});
});
