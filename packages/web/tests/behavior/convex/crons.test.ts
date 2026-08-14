import { describe, expect, test } from "vitest";
import crons from "@/convex/crons";
import { AUTOMATIC_SNAPSHOT_INTERVAL_MS } from "@/convex/boxes/snapshotPolicy";
import { DAY_MS } from "@/convex/time";

// The catalogue sync is the floor under a webhook that was missed or never sent:
// `convex/billing/polar.ts#boxPricing` reads Polar's synced products and reports
// null when it finds none, and the pricing page shows no figure at all. Deleting
// this cron therefore costs the site its prices without failing anything else,
// which is exactly the kind of silence a scheduled job earns a test for.
describe("scheduled jobs", () => {
	test("keeps the Polar catalogue synced for the pricing page", () => {
		const job = crons.crons["sync Polar products"];

		expect(job).toBeDefined();
		expect(job.schedule).toMatchObject({ type: "hourly" });
	});

	// `startAutomaticSnapshot` deduplicates a night's capture with a key bucketed
	// by `AUTOMATIC_SNAPSHOT_INTERVAL_MS`. If this cron ran more often than that
	// bucket is wide, every run after the first in a bucket would be silently
	// dropped as a duplicate; if it ran less often, nothing would be deduplicated.
	// The two are one decision, so the schedule is pinned to the constant.
	test("snapshots running boxes on the cadence its idempotency key assumes", () => {
		const job = crons.crons["snapshot running boxes"];

		expect(job).toBeDefined();
		expect(job.schedule).toMatchObject({ type: "daily" });
		expect(AUTOMATIC_SNAPSHOT_INTERVAL_MS).toBe(DAY_MS);
	});
});
