import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "@/convex/_generated/api";
import { RECONCILE_MIN_AGE_MS, isReclaimable } from "@/convex/boxes/reconcile";

import {
	seedBox,
	seedUser,
	staffAlerts,
	stubDeploymentEnv,
	testConvex,
	withoutHetznerBackoff,
	type Harness
} from "../../../support/convex.ts";

describe("isReclaimable", () => {
	const now = 10_000_000_000;
	const old = now - RECONCILE_MIN_AGE_MS - 1;
	const fresh = now - 1;

	test("reclaims aged, unreferenced resources", () => {
		expect(isReclaimable(old, now, false)).toBe(true);
	});

	test("never reclaims referenced resources", () => {
		expect(isReclaimable(old, now, true)).toBe(false);
		expect(isReclaimable(fresh, now, true)).toBe(false);
	});

	test("spares unreferenced resources inside the grace window", () => {
		expect(isReclaimable(fresh, now, false)).toBe(false);
		expect(isReclaimable(now, now, false)).toBe(false);
	});

	// Parking volumes reuse this rule with `referenced = a live box still points
	// at it`. A succeeded repair clears the pointer and a deleted box drops it,
	// so those volumes become reclaimable orphans; a `repair_failed` box keeps
	// its pointer (referenced === true), which is what protects its files from
	// being reclaimed before the owner retries.
	test("reclaims an orphaned parking volume but never one a box still holds", () => {
		// Orphan: aged, no box points at it -> reclaimed.
		expect(isReclaimable(old, now, false)).toBe(true);
		// A repair_failed box still references its parking volume -> kept.
		expect(isReclaimable(old, now, true)).toBe(false);
	});
});

// The daily sweep that reclaims Hetzner resources nothing in this database
// points at any more.
//
// It is the only job here that deletes provider resources on its own judgement,
// and both directions of a mistake are expensive: reclaiming something still in
// use destroys a box's snapshot or a repair's parking volume, and reclaiming
// nothing leaves images and volumes billing for ever. Servers and Primary IPs
// are deliberately only *reported*, because a tracking bug there would destroy
// live boxes.

const NOW = Date.UTC(2026, 9, 1, 6, 0, 0);
const OLD = new Date(NOW - RECONCILE_MIN_AGE_MS - 1).toISOString();
const FRESH = new Date(NOW - 1000).toISOString();

withoutHetznerBackoff();

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
	vi.stubEnv("HETZNER_CLOUD_TOKEN", "token");
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

type Fleet = {
	images?: { id: number; created: string }[];
	primaryIps?: { id: number; assignee_id: number | null; created: string }[];
	servers?: { id: number; name?: string; created: string }[];
	volumes?: { id: number; created: string }[];
};

// One Hetzner, answering every list this sweep reads and recording what it was
// asked to delete.
function stubFleet(fleet: Fleet) {
	const deleted: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL | string, init?: RequestInit) => {
			const url = String(input);
			if (init?.method === "DELETE") {
				deleted.push(url);
				return {
					ok: true,
					status: 200,
					headers: new Headers(),
					text: async () => "{}"
				} as unknown as Response;
			}
			if (init?.method === "POST") {
				return {
					ok: true,
					status: 201,
					headers: new Headers(),
					text: async () =>
						JSON.stringify({ action: { id: 1, status: "success" } })
				} as unknown as Response;
			}
			const body = url.includes("/images")
				? { images: fleet.images ?? [] }
				: url.includes("/volumes/")
					? { volume: { id: 1, server: null } }
					: url.includes("/volumes")
						? { volumes: fleet.volumes ?? [] }
						: url.includes("/primary_ips")
							? { primary_ips: fleet.primaryIps ?? [] }
							: { servers: fleet.servers ?? [] };
			return {
				ok: true,
				status: 200,
				headers: new Headers(),
				text: async () =>
					JSON.stringify({
						...body,
						meta: { pagination: { next_page: null } }
					})
			} as unknown as Response;
		})
	);
	return deleted;
}

const reconcile = (t: Harness) =>
	t.action(internal.boxes.reconcile.reconcileHetznerResources, {});

async function boxWith(t: Harness, fields: Record<string, unknown>) {
	const owner = await seedUser(t, {
		clerkUserId: `user_${JSON.stringify(fields).length}`
	});
	return await seedBox(t, {
		user_id: owner.clerkUserId,
		slug: `box-${JSON.stringify(fields).length}`,
		...fields
	});
}

describe("reclaiming orphaned snapshot images", () => {
	test("deletes an aged image no snapshot row points at", async () => {
		const t = testConvex();
		const deleted = stubFleet({ images: [{ id: 4242, created: OLD }] });

		await reconcile(t);

		expect(deleted.filter((url) => url.includes("/images/4242"))).toHaveLength(
			1
		);
	});

	// The row is the only record that an image belongs to somebody. Deleting one
	// a row still names destroys a snapshot an owner can still see and restore.
	test("keeps an image a snapshot row still names", async () => {
		const t = testConvex();
		const boxId = await boxWith(t, {});
		await t.run(async (ctx) => {
			await ctx.db.insert("box_snapshots", {
				box_id: boxId,
				class: "manual",
				status: "complete",
				hetzner_image_id: 4242,
				created_at: 1
			});
		});
		const deleted = stubFleet({ images: [{ id: 4242, created: OLD }] });

		await reconcile(t);

		expect(deleted).toEqual([]);
	});

	// The grace window is what keeps this off anything mid-flight: an image
	// exists for seconds before its row is patched with the id.
	test("keeps an image younger than the grace window", async () => {
		const t = testConvex();
		const deleted = stubFleet({ images: [{ id: 4242, created: FRESH }] });

		await reconcile(t);

		expect(deleted).toEqual([]);
	});
});

describe("reclaiming orphaned parking volumes", () => {
	test("deletes an aged volume no live box points at", async () => {
		const t = testConvex();
		const deleted = stubFleet({ volumes: [{ id: 909, created: OLD }] });

		await reconcile(t);

		expect(deleted.filter((url) => url.includes("/volumes/909"))).toHaveLength(
			1
		);
	});

	// A repair that failed keeps its pointer, and the volume holds the only copy
	// of that box's files until it is retried. This is the one that would lose an
	// owner's work.
	test("keeps the volume a failed repair is still holding files on", async () => {
		const t = testConvex();
		await boxWith(t, { parking_volume_id: 909, status: "repair_failed" });
		const deleted = stubFleet({ volumes: [{ id: 909, created: OLD }] });

		await reconcile(t);

		expect(deleted).toEqual([]);
	});

	// A deleted box's tombstone is not a live pointer: the box is gone, so the
	// volume really is an orphan.
	test("reclaims a volume whose box has been deleted", async () => {
		const t = testConvex();
		await boxWith(t, { parking_volume_id: 909, status: "deleted" });
		const deleted = stubFleet({ volumes: [{ id: 909, created: OLD }] });

		await reconcile(t);

		expect(deleted.filter((url) => url.includes("/volumes/909"))).toHaveLength(
			1
		);
	});

	test("keeps a volume younger than the grace window", async () => {
		const t = testConvex();
		const deleted = stubFleet({ volumes: [{ id: 909, created: FRESH }] });

		await reconcile(t);

		expect(deleted).toEqual([]);
	});
});

// Servers are never deleted automatically: a tracking bug would destroy live
// boxes, so the answer is always a person.
describe("reporting orphaned servers", () => {
	test("reports an aged server no live box claims, and deletes nothing", async () => {
		const t = testConvex();
		const deleted = stubFleet({
			servers: [{ id: 77, name: "composery-ghost", created: OLD }]
		});

		await reconcile(t);

		expect(deleted).toEqual([]);
		const [alert] = await staffAlerts(t);
		expect(alert).toMatchObject({ severity: "critical" });
		expect(alert?.text).toContain("77");
	});

	test("says nothing about a server a live box is running on", async () => {
		const t = testConvex();
		await boxWith(t, { hetzner_server_id: 77 });
		stubFleet({ servers: [{ id: 77, created: OLD }] });

		await reconcile(t);

		expect(await staffAlerts(t)).toEqual([]);
	});

	// A tombstone clears its server id, but this file exists to catch tracking
	// bugs - so only a live row counts as proof the server is owned.
	test("reports a server whose only claimant is a deleted box", async () => {
		const t = testConvex();
		await boxWith(t, { hetzner_server_id: 77, status: "deleted" });
		stubFleet({ servers: [{ id: 77, created: OLD }] });

		await reconcile(t);

		expect(await staffAlerts(t)).toMatchObject([{ severity: "critical" }]);
	});
});

// Hetzner is expected to remove a Primary IP with the server it was created
// for. Finding one attached to nothing means that did not happen and it is
// billing for nothing - reported, never deleted, because it carries none of our
// labels and so is not provably ours.
describe("reporting unassigned Primary IPs", () => {
	test("reports an aged Primary IP attached to nothing", async () => {
		const t = testConvex();
		const deleted = stubFleet({
			primaryIps: [{ id: 5, assignee_id: null, created: OLD }]
		});

		await reconcile(t);

		expect(deleted).toEqual([]);
		expect(await staffAlerts(t)).toMatchObject([{ severity: "warning" }]);
	});

	test("says nothing about one that is doing its job", async () => {
		const t = testConvex();
		stubFleet({ primaryIps: [{ id: 5, assignee_id: 999, created: OLD }] });

		await reconcile(t);

		expect(await staffAlerts(t)).toEqual([]);
	});

	test("says nothing about one younger than the grace window", async () => {
		const t = testConvex();
		stubFleet({ primaryIps: [{ id: 5, assignee_id: null, created: FRESH }] });

		await reconcile(t);

		expect(await staffAlerts(t)).toEqual([]);
	});
});

// A sweep that stopped half way has reclaimed some things and not others, and
// nobody is watching it run. Failing quietly would leave the fleet billing for
// resources this job exists to find.
describe("when reconciliation itself fails", () => {
	test("pages staff and re-throws rather than reporting a clean run", async () => {
		const t = testConvex();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("Hetzner is unreachable");
			})
		);

		await expect(reconcile(t)).rejects.toThrow("Hetzner is unreachable");

		const [alert] = await staffAlerts(t);
		expect(alert).toMatchObject({ severity: "critical" });
		expect(alert?.text).toContain("Hetzner is unreachable");
	});

	// Keyed per day, so a provider outage that lasts an afternoon is one alert
	// rather than one per run.
	test("raises one alert however many runs fail in a day", async () => {
		const t = testConvex();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("Hetzner is unreachable");
			})
		);

		await expect(reconcile(t)).rejects.toThrow();
		await expect(reconcile(t)).rejects.toThrow();

		expect(await staffAlerts(t)).toHaveLength(1);
	});
});

describe("a fleet with nothing to reclaim", () => {
	test("deletes nothing and tells nobody", async () => {
		const t = testConvex();
		const deleted = stubFleet({});

		await reconcile(t);

		expect(deleted).toEqual([]);
		expect(await staffAlerts(t)).toEqual([]);
	});
});

// What the two "review this by hand" alerts actually say, and how they
// deduplicate.
//
// Both are raised by a daily cron against resources nothing will ever delete
// automatically, so the same leak is found again tomorrow and the day after.
// The key is what keeps that one alert rather than one a day for ever, and the
// body is the whole of what an operator has to work from - there is no console
// link to a box, because by definition no box owns these.
describe("what an orphaned-resource alert says", () => {
	const servers = (t: Harness, list: { serverId: number; name?: string }[]) =>
		t.mutation(internal.boxes.reconcile.alertOrphanedServers, {
			servers: list
		});

	const primaryIps = (
		t: Harness,
		list: { primaryIpId: number; ip?: string }[]
	) =>
		t.mutation(internal.boxes.reconcile.alertUnassignedPrimaryIps, {
			primaryIps: list
		});

	test("counts the servers in its subject and lists each on its own line", async () => {
		const t = testConvex();

		await servers(t, [
			{ serverId: 77, name: "composery-ghost" },
			{ serverId: 12 }
		]);

		const [alert] = await staffAlerts(t);
		expect(alert?.subject).toBe("2 orphaned Hetzner server(s) need review");
		expect(alert?.text).toContain("- 77 (composery-ghost)");
		// No name recorded is no parenthesis, not an empty one.
		expect(alert?.text).toContain("- 12\n");
		expect(alert?.text).not.toContain("- 12 ()");
	});

	test("counts the Primary IPs in its subject and lists each on its own line", async () => {
		const t = testConvex();

		await primaryIps(t, [
			{ primaryIpId: 5, ip: "203.0.113.4" },
			{ primaryIpId: 9 }
		]);

		const [alert] = await staffAlerts(t);
		expect(alert?.subject).toBe(
			"2 unassigned Hetzner Primary IP(s) need review"
		);
		expect(alert?.text).toContain("- 5 (203.0.113.4)");
		expect(alert?.text).toContain("- 9\n");
		expect(alert?.text).not.toContain("- 9 ()");
	});

	// The key is built from the ids, sorted. Hetzner does not promise an order,
	// so the same leak listed differently tomorrow must still be the same alert -
	// otherwise a daily cron mails the same two servers every day for ever.
	test.each([
		[
			"servers",
			() => [{ serverId: 12 }, { serverId: 77 }],
			() => [{ serverId: 77 }, { serverId: 12 }]
		]
	])(
		"raises one %s alert however the provider ordered them",
		async (_name, first, second) => {
			const t = testConvex();

			await servers(t, first());
			await servers(t, second());

			expect(await staffAlerts(t)).toHaveLength(1);
		}
	);

	test("raises one Primary IP alert however the provider ordered them", async () => {
		const t = testConvex();

		await primaryIps(t, [{ primaryIpId: 9 }, { primaryIpId: 5 }]);
		await primaryIps(t, [{ primaryIpId: 5 }, { primaryIpId: 9 }]);

		expect(await staffAlerts(t)).toHaveLength(1);
	});

	// A different set of ids is a different leak and has to be said again.
	test("raises a new alert when a further server leaks", async () => {
		const t = testConvex();

		await servers(t, [{ serverId: 12 }]);
		await servers(t, [{ serverId: 12 }, { serverId: 77 }]);

		expect(await staffAlerts(t)).toHaveLength(2);
	});

	test("raises a new alert when a further Primary IP leaks", async () => {
		const t = testConvex();

		await primaryIps(t, [{ primaryIpId: 5 }]);
		await primaryIps(t, [{ primaryIpId: 5 }, { primaryIpId: 9 }]);

		expect(await staffAlerts(t)).toHaveLength(2);
	});
});

// The grace window's own edge. A resource is reclaimable once it has been idle
// *for* the window, so the instant it reaches it counts - the alternative is a
// resource that is one millisecond short on every daily run and so is never
// reclaimed at all.
describe("the instant the grace window closes", () => {
	const now = 10_000_000_000;

	test("reclaims a resource exactly as old as the window", () => {
		expect(isReclaimable(now - RECONCILE_MIN_AGE_MS, now, false)).toBe(true);
	});

	test("leaves one a millisecond short of it", () => {
		expect(isReclaimable(now - RECONCILE_MIN_AGE_MS + 1, now, false)).toBe(
			false
		);
	});
});

// The daily run's own log line. It is what an operator greps when they want to
// know whether the backstop is doing anything, so it has to report work that
// happened and stay quiet about work that did not - a cron that logs "deleted 0"
// every night is a line people learn to skip past.
describe("what the sweep reports to the log", () => {
	test("says nothing about a night with nothing to reclaim", async () => {
		const t = testConvex();
		stubFleet({});
		const info = vi.spyOn(console, "info").mockImplementation(() => {});

		await reconcile(t);

		expect(
			info.mock.calls.filter((call) => String(call[0]).includes("[reconcile]"))
		).toEqual([]);
		info.mockRestore();
	});

	test("names what it reclaimed when it reclaimed something", async () => {
		const t = testConvex();
		stubFleet({ images: [{ id: 3, created: OLD }] });
		const info = vi.spyOn(console, "info").mockImplementation(() => {});

		await reconcile(t);

		expect(info.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
			"deleted 1 orphaned snapshot image(s)"
		);
		info.mockRestore();
	});
});

// The alert key has to separate the ids it is built from, and the body has to
// keep them on separate lines. Both are the kind of detail that only shows up as
// two different leaks quietly sharing one alert.
describe("keeping two different leaks apart", () => {
	const servers = (t: Harness, list: { serverId: number; name?: string }[]) =>
		t.mutation(internal.boxes.reconcile.alertOrphanedServers, {
			servers: list
		});

	const primaryIps = (t: Harness, list: { primaryIpId: number }[]) =>
		t.mutation(internal.boxes.reconcile.alertUnassignedPrimaryIps, {
			primaryIps: list
		});

	// One server each, different servers. Nothing about the count distinguishes
	// them, so only the id in the key can.
	test("two different single servers are two alerts", async () => {
		const t = testConvex();

		await servers(t, [{ serverId: 12 }]);
		await servers(t, [{ serverId: 77 }]);

		expect(await staffAlerts(t)).toHaveLength(2);
	});

	test("two different single Primary IPs are two alerts", async () => {
		const t = testConvex();

		await primaryIps(t, [{ primaryIpId: 5 }]);
		await primaryIps(t, [{ primaryIpId: 9 }]);

		expect(await staffAlerts(t)).toHaveLength(2);
	});

	// Ids run together without a separator collide: servers 1 and 23 render as
	// "123", and so does server 123 on its own. Two unrelated leaks would share
	// one alert and the second would never be seen.
	test("does not let two server sets collide into one key", async () => {
		const t = testConvex();

		await servers(t, [{ serverId: 1 }, { serverId: 23 }]);
		await servers(t, [{ serverId: 123 }]);

		expect(await staffAlerts(t)).toHaveLength(2);
	});

	test("does not let two Primary IP sets collide into one key", async () => {
		const t = testConvex();

		await primaryIps(t, [{ primaryIpId: 1 }, { primaryIpId: 23 }]);
		await primaryIps(t, [{ primaryIpId: 123 }]);

		expect(await staffAlerts(t)).toHaveLength(2);
	});

	// One resource per line, because the list is read by a person who has to
	// find each one in the Hetzner console.
	test("puts each server on its own line", async () => {
		const t = testConvex();

		await servers(t, [{ serverId: 77, name: "ghost" }, { serverId: 12 }]);

		expect((await staffAlerts(t))[0]?.text).toContain("- 77 (ghost)\n- 12");
	});

	test("puts each Primary IP on its own line", async () => {
		const t = testConvex();

		await primaryIps(t, [{ primaryIpId: 5 }, { primaryIpId: 9 }]);

		expect((await staffAlerts(t))[0]?.text).toContain("- 5\n- 9");
	});
});

// The rest of the nightly log line, and the failure alert's own window.
describe("what a working night and a failing one report", () => {
	test("names the parking volumes it reclaimed", async () => {
		const t = testConvex();
		stubFleet({ volumes: [{ id: 4, created: OLD }] });
		const info = vi.spyOn(console, "info").mockImplementation(() => {});

		await reconcile(t);

		expect(info.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
			"deleted 1 orphaned parking volume(s)"
		);
		info.mockRestore();
	});

	test("names the servers it refused to touch", async () => {
		const t = testConvex();
		stubFleet({
			servers: [
				{ id: 77, created: OLD },
				{ id: 12, created: OLD }
			]
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await reconcile(t);

		const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
		expect(logged).toContain("orphaned Hetzner server(s), not auto-deleted");
		expect(logged).toContain("77, 12");
		warn.mockRestore();
	});

	test("names the Primary IPs it refused to touch", async () => {
		const t = testConvex();
		stubFleet({
			primaryIps: [
				{ id: 5, assignee_id: null, created: OLD },
				{ id: 9, assignee_id: null, created: OLD }
			]
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await reconcile(t);

		const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
		expect(logged).toContain(
			"unassigned Hetzner Primary IP(s), not auto-deleted"
		);
		expect(logged).toContain("5, 9");
		warn.mockRestore();
	});

	// The failure alert is keyed by the day, so an outage lasting an afternoon
	// is one alert. Keyed by the raw clock instead it would be one per run, which
	// is the thing the key exists to prevent.
	test("raises one alert for runs that fail hours apart on the same day", async () => {
		const t = testConvex();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("Hetzner is unreachable");
			})
		);

		await expect(reconcile(t)).rejects.toThrow();
		vi.setSystemTime(NOW + 3 * 60 * 60 * 1000);
		await expect(reconcile(t)).rejects.toThrow();

		const alerts = await staffAlerts(t);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.subject).toBe("Hetzner resource reconciliation failed");
	});

	// A new day is a new outage worth saying out loud.
	test("raises it again the next day", async () => {
		const t = testConvex();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("Hetzner is unreachable");
			})
		);

		await expect(reconcile(t)).rejects.toThrow();
		vi.setSystemTime(NOW + 24 * 60 * 60 * 1000);
		await expect(reconcile(t)).rejects.toThrow();

		expect(await staffAlerts(t)).toHaveLength(2);
	});
});
