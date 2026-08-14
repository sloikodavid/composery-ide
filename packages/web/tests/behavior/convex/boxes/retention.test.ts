import { describe, expect, test } from "vitest";
import {
	BILLING_RECORD_RETENTION_YEARS,
	DELETED_BOX_RETENTION_DAYS,
	billingRecordPurgeAt,
	deletedBoxDataPatch,
	deletedBoxPurgeAt,
	retainedOperationMetadata,
	suspensionReason,
	terminalCheckoutSecretPatch,
	unpaidCheckoutPurgeAt
} from "@/convex/boxes/retention";
import schema from "@/convex/schema";

describe("box retention", () => {
	test("keeps a deleted box audit tombstone for exactly 180 days", () => {
		const deletedAt = Date.UTC(2026, 0, 1);
		expect(DELETED_BOX_RETENTION_DAYS).toBe(180);
		expect(deletedBoxPurgeAt(deletedAt)).toBe(
			Date.UTC(2026, 0, 1) + 180 * 24 * 60 * 60 * 1000
		);
	});

	// Every optional field on the row is either cleared or deliberately kept, and
	// this asks the schema which fields exist rather than restating them.
	//
	// The previous version of this test listed six fields and used
	// `toMatchObject`, so it could only ever confirm that what it already named
	// was cleared - a field left behind was invisible to it, which is how
	// `runtime_config` (the owner's own environment for the box, including a
	// GitHub token) survived deletion for the full 180-day tombstone window.
	test("clears every optional field the tombstone does not deliberately keep", () => {
		const deletedAt = Date.UTC(2026, 0, 1);
		const patch = deletedBoxDataPatch(deletedAt) as Record<string, unknown>;
		const optional = Object.entries(schema.tables.boxes.validator.fields)
			.filter(([, validator]) => validator.isOptional === "optional")
			.map(([field]) => field);

		expect(optional).toContain("runtime_config");
		expect(optional.length).toBeGreaterThan(10);

		const kept = optional.filter((field) => !(field in patch));
		expect(kept.sort()).toEqual([
			"comp_reason",
			"comped_at",
			"comped_by",
			"polar_customer_id",
			"polar_subscription_id",
			"ready_at"
		]);

		for (const field of optional) {
			if (kept.includes(field)) continue;
			if (field === "deleted_at" || field === "purge_at") continue;
			expect(patch[field], `${field} is not cleared`).toBeUndefined();
		}

		expect(patch.status).toBe("deleted");
		expect(patch.deleted_at).toBe(deletedAt);
		expect(patch.purge_at).toBe(deletedBoxPurgeAt(deletedAt));
	});

	test("removes unpaid checkout records after 30 days", () => {
		const finishedAt = Date.UTC(2026, 0, 1);
		expect(unpaidCheckoutPurgeAt(finishedAt)).toBe(Date.UTC(2026, 0, 31));
	});

	test("uses calendar years for statutory billing retention", () => {
		const finishedAt = Date.UTC(2024, 1, 29, 12);
		expect(BILLING_RECORD_RETENTION_YEARS).toBe(6);
		expect(billingRecordPurgeAt(finishedAt)).toBe(Date.UTC(2030, 2, 1, 12));
	});

	test("retains only a manual suspension reason from operation metadata", () => {
		expect(
			retainedOperationMetadata("suspend", {
				reason: "Repeated outbound abuse",
				secret: "drop-me"
			})
		).toEqual({ reason: "Repeated outbound abuse" });
		expect(
			retainedOperationMetadata("change_slug", {
				oldSlug: "old",
				newSlug: "new"
			})
		).toBeUndefined();
	});

	test("removes checkout secrets as soon as an intent becomes terminal", () => {
		expect(terminalCheckoutSecretPatch()).toEqual({
			polar_checkout_url: undefined,
			runtime_auth_hash: undefined
		});
	});
});

// A suspension reason reaches an owner's inbox, so a value that is not usable
// prose has to be nothing rather than something that renders as an empty line
// where an explanation should be.
describe("the reason a suspension records", () => {
	test("keeps a real reason", () => {
		expect(suspensionReason({ reason: "Sustained egress" })).toBe(
			"Sustained egress"
		);
	});

	test.each([
		["no metadata at all", undefined],
		["metadata with no reason", {}],
		["a reason that is only whitespace", { reason: "   " }],
		["an empty reason", { reason: "" }],
		["a reason that is not a string", { reason: { text: "nope" } }]
	])("has nothing to say for %s", (_name, metadata) => {
		expect(suspensionReason(metadata)).toBeUndefined();
	});
});

describe("what a deleted box's operations keep", () => {
	test("keeps nothing from an operation that is not a suspension", () => {
		expect(
			retainedOperationMetadata("change_slug", { reason: "Sustained egress" })
		).toBeUndefined();
	});

	test("keeps nothing when a suspension recorded no usable reason", () => {
		expect(
			retainedOperationMetadata("suspend", { reason: "  " })
		).toBeUndefined();
	});
});
