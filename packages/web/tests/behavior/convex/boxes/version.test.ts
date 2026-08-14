import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "@/convex/_generated/api";

import { seedSettings, testConvex } from "../../../support/convex.ts";
import {
	floorDeadlinePassed,
	runtimeStanding,
	updateAlreadyApplied
} from "@/convex/boxes/version";

const OLD = "ghcr.io/sloikodavid/composery@sha256:old";
const NEW = "ghcr.io/sloikodavid/composery@sha256:new";

const standing = (over: Parameters<typeof runtimeStanding>[0]) =>
	runtimeStanding(over);

describe("runtimeStanding", () => {
	test("reports an update when the box's digest differs from the fleet's", () => {
		const result = standing({
			boxImage: OLD,
			boxVersion: "0.2.0",
			fleet: { image: NEW, version: "0.2.1" },
			minimum: null
		});

		expect(result.updateAvailable).toBe(true);
		expect(result.currentVersion).toBe("0.2.0");
		expect(result.availableVersion).toBe("0.2.1");
		expect(result.required).toBe(false);
		expect(result.requiredBy).toBe(null);
	});

	test("reports no update when the box is already on the fleet digest", () => {
		expect(
			standing({
				boxImage: NEW,
				boxVersion: "0.2.1",
				fleet: { image: NEW, version: "0.2.1" },
				minimum: null
			}).updateAvailable
		).toBe(false);
	});

	// The version label is decoration. A channel that rebuilds under an unchanged
	// label still ships a different image, and comparing labels would call that
	// "up to date" forever.
	test("compares digests, not version labels", () => {
		expect(
			standing({
				boxImage: OLD,
				boxVersion: "0.2.1",
				fleet: { image: NEW, version: "0.2.1" },
				minimum: null
			}).updateAvailable
		).toBe(true);
	});

	// Unknown must never render as "an update is available": offering an update
	// we cannot describe is worse than waiting for the next refresh.
	test("stays quiet when the fleet release or the box image is unknown", () => {
		expect(
			standing({
				boxImage: OLD,
				boxVersion: null,
				fleet: null,
				minimum: null
			}).updateAvailable
		).toBe(false);
		expect(
			standing({
				boxImage: undefined,
				boxVersion: null,
				fleet: { image: NEW, version: "0.2.1" },
				minimum: null
			}).updateAvailable
		).toBe(false);
	});

	// `updateAvailable: false` means "on the fleet image" and "nothing to compare
	// against" alike. `comparable` is the only thing that separates them, and the
	// interface renders "up to date" off it, so it has to be false wherever either
	// digest is missing.
	test("reports whether the comparison could be made at all", () => {
		const base = { boxVersion: null, minimum: null };
		expect(
			standing({ ...base, boxImage: OLD, fleet: { image: NEW, version: null } })
				.comparable
		).toBe(true);
		expect(standing({ ...base, boxImage: OLD, fleet: null }).comparable).toBe(
			false
		);
		expect(
			standing({
				...base,
				boxImage: undefined,
				fleet: { image: NEW, version: "0.2.1" }
			}).comparable
		).toBe(false);
	});

	test("marks a box below the floor as required, carrying the deadline", () => {
		const result = standing({
			boxImage: OLD,
			boxVersion: "0.2.0",
			fleet: { image: NEW, version: "0.2.1" },
			minimum: { image: NEW, version: "0.2.1", deadline: 5_000 }
		});

		expect(result.required).toBe(true);
		expect(result.requiredBy).toBe(5_000);
	});

	// The floor is raised deliberately and lags the channel, so a box sitting
	// exactly on the floor is compliant even while a newer optional release
	// exists. Conflating the two would force every box onto every release.
	test("treats a box on the floor as compliant even when a newer release exists", () => {
		const result = standing({
			boxImage: OLD,
			boxVersion: "0.2.0",
			fleet: { image: NEW, version: "0.2.1" },
			minimum: { image: OLD, version: "0.2.0", deadline: 5_000 }
		});

		expect(result.required).toBe(false);
		expect(result.requiredBy).toBe(null);
		expect(result.updateAvailable).toBe(true);
	});
});

describe("updateAlreadyApplied", () => {
	test("skips only when both digests are known and identical", () => {
		expect(updateAlreadyApplied(OLD, OLD)).toBe(true);
		expect(updateAlreadyApplied(OLD, NEW)).toBe(false);
	});

	// The direction that matters: a missing digest on either side must do the
	// work rather than settle as skipped. A skip here is an update that never
	// happens while `markUpdateSucceeded` records the new digest anyway, so the
	// box would report a version it is not running.
	test("never skips when either digest is unknown", () => {
		for (const unknown of [null, undefined, ""]) {
			expect(updateAlreadyApplied(unknown, NEW)).toBe(false);
			expect(updateAlreadyApplied(OLD, unknown)).toBe(false);
			expect(updateAlreadyApplied(unknown, unknown)).toBe(false);
		}
	});
});

describe("floorDeadlinePassed", () => {
	const below = standing({
		boxImage: OLD,
		boxVersion: "0.2.0",
		fleet: { image: NEW, version: "0.2.1" },
		minimum: { image: NEW, version: "0.2.1", deadline: 1_000 }
	});

	test("passes only once the deadline is reached", () => {
		expect(floorDeadlinePassed(below, 999)).toBe(false);
		expect(floorDeadlinePassed(below, 1_000)).toBe(true);
		expect(floorDeadlinePassed(below, 1_001)).toBe(true);
	});

	// A floor with no deadline announces itself and never acts, which is what
	// makes naming an image ahead of a date a safe thing to do.
	test("never forces a box when the floor has no deadline", () => {
		const noDeadline = standing({
			boxImage: OLD,
			boxVersion: "0.2.0",
			fleet: { image: NEW, version: "0.2.1" },
			minimum: { image: NEW, version: "0.2.1", deadline: null }
		});

		expect(noDeadline.required).toBe(true);
		expect(floorDeadlinePassed(noDeadline, Number.MAX_SAFE_INTEGER)).toBe(
			false
		);
	});

	test("never forces a box that is already on the floor image", () => {
		const compliant = standing({
			boxImage: NEW,
			boxVersion: "0.2.1",
			fleet: { image: NEW, version: "0.2.1" },
			minimum: { image: NEW, version: "0.2.1", deadline: 1 }
		});

		expect(floorDeadlinePassed(compliant, Number.MAX_SAFE_INTEGER)).toBe(false);
	});
});

// What a box is told the fleet is running, and the one query that answers it
// without a session.
//
// It is deliberately public: the digest is the content address of a public
// image, and a box compares it against its own COMPOSERY_RUNTIME_IMAGE to decide
// whether it is out of date. What stays behind the authenticated queries is
// everything about the fleet itself - the floor, its deadline, the box count.
describe("the fleet's current release", () => {
	test("answers a deployment that has never resolved one with nothing", async () => {
		const t = testConvex();
		await seedSettings(t);

		expect(await t.query(api.instance.release.fleetVersion, {})).toEqual({
			image: null,
			version: null
		});
	});

	// A deployment with no settings row at all is the same answer, not a crash:
	// this is the query every box calls on a schedule.
	test("answers a deployment with no settings at all with nothing", async () => {
		const t = testConvex();

		expect(await t.query(api.instance.release.fleetVersion, {})).toEqual({
			image: null,
			version: null
		});
	});

	test("answers with the release that was recorded", async () => {
		const t = testConvex();
		await seedSettings(t, {
			runtime_release: {
				image: "ghcr.io/sloikodavid/composery@sha256:current",
				version: "1.4.0",
				checked_at: 1
			}
		});

		expect(await t.query(api.instance.release.fleetVersion, {})).toEqual({
			image: "ghcr.io/sloikodavid/composery@sha256:current",
			version: "1.4.0"
		});
	});

	// A release resolved without a readable label is still a release: the digest
	// is what every comparison is made from, and the label is decoration on it.
	test("answers with a digest whose version could not be read", async () => {
		const t = testConvex();
		await seedSettings(t, {
			runtime_release: {
				image: "ghcr.io/sloikodavid/composery@sha256:current",
				version: null,
				checked_at: 1
			}
		});

		expect(await t.query(api.instance.release.fleetVersion, {})).toEqual({
			image: "ghcr.io/sloikodavid/composery@sha256:current",
			version: null
		});
	});
});

// The hourly refresh: one registry round trip for the whole fleet, because the
// answer is the same for every box.
describe("refreshing the fleet's release", () => {
	const DIGEST = `sha256:${"a".repeat(64)}`;

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	test("records what the configured channel resolves to", async () => {
		const t = testConvex();
		await seedSettings(t);
		vi.stubEnv("RUNTIME_IMAGE", "ghcr.io/sloikodavid/composery:edge");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL | string) => ({
				ok: true,
				status: 200,
				headers: new Headers({ "Docker-Content-Digest": DIGEST }),
				json: async () =>
					String(input).includes("/blobs/")
						? {
								config: {
									Labels: { "org.opencontainers.image.version": "1.4.0" }
								}
							}
						: { config: { digest: `sha256:${"c".repeat(64)}` } }
			}))
		);

		await t.action(internal.boxes.version.refreshRuntimeRelease, {});

		expect(await t.query(api.instance.release.fleetVersion, {})).toEqual({
			image: `ghcr.io/sloikodavid/composery@${DIGEST}`,
			version: "1.4.0"
		});
	});
});
