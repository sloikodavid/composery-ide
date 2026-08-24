import { describe, expect, test } from "vitest";

import { readRepoFile } from "../support/repo.ts";

// The workflow component is not executable in the test harness. These orders
// are the two external ownership gates that cannot be derived: the provider may
// destroy the boot disk only after a verified, unmounted copy exists, and may
// delete the parking volume only after a verified, unmounted server copy exists.
describe("repair data ownership", () => {
	const source = readRepoFile(
		"packages/web/convex/boxes/workflows/repairBox.ts"
	)
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"))
		.join("\n");

	test("crosses into rebuild only after the rescue copy is verified and unmounted", () => {
		const steps = [
			"copyToParking",
			"verifyParkingCopy",
			"unmountParkingFromRescue",
			"markParkingRestoring",
			"detachParkingVolume",
			"rebuildServer"
		].map((name) => source.indexOf(name));

		expect(steps.every((position) => position >= 0)).toBe(true);
		expect(steps).toEqual([...steps].sort((left, right) => left - right));
	});

	test("clears the pointer before deleting a redundant parking volume", () => {
		const verified = source.indexOf("verifyParkingBack");
		const unmounted = source.lastIndexOf("unmountParking");
		const detached = source.lastIndexOf("detachParkingVolume");
		const cleared = source.indexOf("clearParkingVolume");
		const deleted = source.indexOf("deleteParkingVolume");

		const steps = [verified, unmounted, detached, cleared, deleted];
		expect(steps.every((position) => position >= 0)).toBe(true);
		expect(steps).toEqual(steps.toSorted((left, right) => left - right));
	});
});
