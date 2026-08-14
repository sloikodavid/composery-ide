import { describe, expect, test } from "vitest";

import {
	ROLLBACK_SNAPSHOT_OPERATIONS,
	rollbackCaptureFailure
} from "@/convex/model/box/snapshot";
import { operationLabel } from "@/convex/model/box/operation";

// What an owner reads when the safety snapshot could not be taken.
//
// The sentence is built from the operation's own label rather than written out
// per operation, and it is tested here rather than left in the workflow that
// throws it: a workflow body cannot be run by any test, so a sentence composed
// there is one nothing can check.
describe("telling an owner the safety snapshot failed", () => {
	test("names the operation that did not start, and why", () => {
		expect(rollbackCaptureFailure("update", "Hetzner refused.")).toBe(
			"The safety snapshot failed, so the update did not start. Hetzner refused."
		);
	});

	// Every operation that takes one can say this, in its own name. A row added to
	// the table without a label would read as "the  did not start".
	test.each(ROLLBACK_SNAPSHOT_OPERATIONS)(
		"names %s in the sentence about it",
		(operation) => {
			expect(rollbackCaptureFailure(operation, "why")).toContain(
				`so the ${operationLabel(operation, true)} did not start`
			);
		}
	);

	// The provider's own reason is the actionable half, so it is never dropped:
	// "the snapshot failed" with no cause is a sentence nobody can act on.
	test("keeps the reason it was given", () => {
		expect(
			rollbackCaptureFailure("reset", "Snapshot quota exceeded.")
		).toContain("Snapshot quota exceeded.");
	});
});
