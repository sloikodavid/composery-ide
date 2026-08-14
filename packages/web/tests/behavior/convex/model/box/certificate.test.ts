import { describe, expect, test } from "vitest";

import {
	certificateHeadroom,
	CERTIFICATE_CREATING_OPERATIONS,
	CERTIFICATE_ISSUING_OPERATIONS,
	CERTIFICATE_RECOVERY_RESERVE,
	isCertificateCreatingOperation
} from "@/convex/model/box/certificate";

describe("the fleet's weekly certificate budget", () => {
	// The direction that matters most. An unset allowance is the operator not
	// having told us the apex ceiling, and reading that as "unlimited" is how a
	// deployment finds the real ceiling by exhausting it - which takes every
	// box's reset, rename and restore down with it for the rest of the week.
	test("an unconfigured allowance leaves no headroom at all", () => {
		const headroom = certificateHeadroom({ issuedThisWeek: 0, limit: null });

		expect(headroom.forCreation).toBe(0);
		expect(headroom.forRecovery).toBe(0);
	});

	test("recovery keeps the reserve that creation may not touch", () => {
		// Exactly at the point where creation runs out: everything but the reserve
		// has been spent, so a recovery still has the reserve and a new box has
		// nothing.
		const headroom = certificateHeadroom({
			issuedThisWeek: 50 - CERTIFICATE_RECOVERY_RESERVE,
			limit: 50
		});

		expect(headroom.forCreation).toBe(0);
		expect(headroom.forRecovery).toBe(CERTIFICATE_RECOVERY_RESERVE);
	});

	test("creation has room while the week is young", () => {
		const headroom = certificateHeadroom({ issuedThisWeek: 0, limit: 50 });

		expect(headroom.forCreation).toBe(50 - CERTIFICATE_RECOVERY_RESERVE);
		expect(headroom.forRecovery).toBe(50);
	});

	// A week that has already eaten into the reserve must report zero rather than
	// a negative, and must never report creation headroom that recovery does not
	// also have.
	test("an overspent week never reports negative or inverted headroom", () => {
		for (const issued of [50, 60, 1_000]) {
			const headroom = certificateHeadroom({
				issuedThisWeek: issued,
				limit: 50
			});

			expect(headroom.forCreation).toBe(0);
			expect(headroom.forRecovery).toBe(0);
		}

		// The invariant across the whole range: creation can never exceed recovery,
		// because the reserve only ever comes out of creation's share.
		for (let issued = 0; issued <= 60; issued += 1) {
			const headroom = certificateHeadroom({
				issuedThisWeek: issued,
				limit: 50
			});
			expect(headroom.forCreation).toBeLessThanOrEqual(headroom.forRecovery);
			expect(headroom.forCreation).toBeGreaterThanOrEqual(0);
		}
	});

	// The two sets are what decide which operations spend the budget and which
	// are held back by the reserve. `create` covers Duplicate, which provisions
	// through the ordinary create path under a new slug.
	test("names every operation that causes an issuance, and which of them create", () => {
		expect([...CERTIFICATE_ISSUING_OPERATIONS].sort()).toEqual([
			"change_slug",
			"create",
			"reset",
			"restore"
		]);
		expect([...CERTIFICATE_CREATING_OPERATIONS]).toEqual(["create"]);

		expect(isCertificateCreatingOperation("create")).toBe(true);
		for (const recovery of ["reset", "change_slug", "restore"] as const) {
			expect(isCertificateCreatingOperation(recovery)).toBe(false);
		}
	});
});
