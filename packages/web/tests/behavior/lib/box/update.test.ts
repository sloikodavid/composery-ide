import { describe, expect, test } from "vitest";
import type { RuntimeStanding } from "@/convex/boxes/version";
import { formatDateTime } from "@/lib/datetime";
import { standingNotices } from "@/lib/box/update";

function standing(over: Partial<RuntimeStanding> = {}): RuntimeStanding {
	return {
		updateAvailable: false,
		comparable: true,
		availableVersion: "0.2.1",
		currentVersion: "0.2.1",
		required: false,
		requiredBy: null,
		...over
	};
}

const text = (over: Partial<RuntimeStanding> = {}) =>
	standingNotices(standing(over))
		.map((notice) => notice.text)
		.join(" ");

const tones = (over: Partial<RuntimeStanding> = {}) =>
	standingNotices(standing(over)).map((notice) => notice.tone);

describe("standingNotices", () => {
	// The four combinations of the two independent booleans. Each has to say both
	// things, because a box can be below the floor while sitting on the newest
	// release the fleet has published, and can have an optional update waiting
	// while being perfectly compliant.
	test("reports neither when the box is current and compliant", () => {
		expect(text()).toContain("on the current release (0.2.1)");
		expect(text()).not.toContain("minimum version");
		expect(tones()).toEqual(["ok"]);
	});

	test("reports an optional update on a compliant box", () => {
		const result = text({ updateAvailable: true, currentVersion: "0.2.0" });
		expect(result).toContain("Version 0.2.1 is available");
		expect(result).toContain("This box runs 0.2.0");
		expect(result).not.toContain("minimum version");
	});

	test("reports the floor on a box that is otherwise on the cached release", () => {
		const result = text({ required: true });
		expect(result).toContain("on the current release");
		expect(result).toContain("below the minimum version");
		// Both lines are true at once, so the reason they can be is spelled out.
		expect(result).toContain("not the release we last cached");
		expect(tones({ required: true })).toEqual(["ok", "warn"]);
	});

	test("reports the floor and the available update together", () => {
		const result = text({ required: true, updateAvailable: true });
		expect(result).toContain("Version 0.2.1 is available");
		expect(result).toContain("below the minimum version");
		expect(result).not.toContain("not the release we last cached");
	});

	// The failure this whole module exists to prevent: `updateAvailable: false`
	// with nothing to compare against must never read as "up to date".
	test("never claims a box is current when it cannot be compared", () => {
		const result = text({ comparable: false, availableVersion: null });
		expect(result).toContain("nothing to compare this box against");
		expect(result).not.toContain("on the current release");
		expect(tones({ comparable: false, availableVersion: null })).toEqual([
			"muted"
		]);
	});

	// A cached fleet release with no version label is still a comparison, so the
	// box's standing is known even though neither version can be named.
	test("names no version it does not have", () => {
		expect(text({ availableVersion: null })).toBe(
			"This box is on the current release."
		);
		expect(text({ updateAvailable: true, availableVersion: null })).toContain(
			"the image changed"
		);
		expect(text({ updateAvailable: true, currentVersion: null })).toContain(
			"a version we can't name"
		);
	});

	test("names the deadline when the floor has one, and says so when it has none", () => {
		expect(text({ required: true, requiredBy: 1_800_000_000_000 })).toContain(
			`updated automatically after ${formatDateTime(1_800_000_000_000)}`
		);
		expect(text({ required: true })).toContain(
			"No date is set for updating it automatically"
		);
	});
});
