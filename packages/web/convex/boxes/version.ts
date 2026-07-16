import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalAction, internalQuery } from "../_generated/server";
import { readGlobalSettings } from "../settings";
import { startBoxOperation } from "./operation/start";
import { BOX_OPERATIONS } from "../model/box/operation";

// How a box's recorded runtime image compares to the fleet's, and what that
// means for its owner. Pure, so the whole matrix is testable without a registry
// or a database - the interface, the floor cron, and the staff console all read
// their answer from here rather than each re-deriving it from digests.
export type RuntimeStanding = {
	// True only when we positively know the box is behind. Unknown - no fleet
	// release cached yet, or a box with no recorded image - is never reported as
	// an update being available, because offering an update we cannot describe is
	// worse than staying quiet until the next refresh.
	updateAvailable: boolean;
	// Whether the comparison above could be made at all - both the box's digest
	// and the fleet's were known. `updateAvailable: false` covers "on the fleet
	// image" and "nothing to compare against" alike, and only this separates
	// them, so an interface that renders the second as "up to date" is reporting
	// a success it never checked.
	comparable: boolean;
	availableVersion: string | null;
	currentVersion: string | null;
	// Set when a floor applies to this box. `deadline` is when it stops being the
	// owner's choice; null means a floor exists but nothing is scheduled yet.
	requiredBy: number | null;
	required: boolean;
};

export type FleetRelease = {
	image: string;
	version: string | null;
} | null;

export type MinimumRelease = {
	deadline: number | null;
	image: string;
	version: string | null;
} | null;

// Comparison is by digest and never by version string. A channel can publish a
// new build under an unchanged version label, and two different labels can name
// the same digest after a retag; the digest is the only thing that says what a
// box actually runs.
export function runtimeStanding({
	boxImage,
	boxVersion,
	fleet,
	minimum
}: {
	boxImage: string | null | undefined;
	boxVersion: string | null | undefined;
	fleet: FleetRelease;
	minimum: MinimumRelease;
}): RuntimeStanding {
	const currentVersion = boxVersion ?? null;
	// Both digests known is what makes the comparison mean anything: without it
	// "not behind" is only "not known to be behind".
	const comparable = Boolean(boxImage && fleet?.image);
	const behindFleet = comparable && boxImage !== fleet?.image;

	// A floor only binds a box that is not already on the floor's image. It is
	// deliberately independent of the fleet comparison: the floor can lag the
	// channel (it is raised deliberately, after the fleet has moved), and a box
	// sitting exactly on the floor is compliant even while an optional newer
	// release exists.
	const required = Boolean(
		boxImage && minimum?.image && boxImage !== minimum.image
	);

	return {
		updateAvailable: behindFleet,
		comparable,
		availableVersion: fleet?.version ?? null,
		currentVersion,
		required,
		requiredBy: required ? (minimum?.deadline ?? null) : null
	};
}

// Whether an update has nothing left to do, because the box already runs the
// digest the channel resolved to for this run.
//
// This is a race rather than a mistake - the fleet version can move between the
// page rendering an Update button and the owner pressing it, and a floor
// deadline can fire on a box its owner updated by hand a minute earlier. So the
// operation settles as `skipped` instead of failing, which would report a
// problem that does not exist, or recreating the container anyway, which would
// drop the owner's terminals for no change at all.
//
// It lives here rather than in the workflow body that acts on it because a
// workflow body is excluded from coverage and mutation testing (see
// `stryker.config.json`): a decision written there is a decision nothing checks.
//
// An unknown image on either side is never "already applied". Both arguments are
// digests a caller believes it has, and the safe direction when one is missing is
// to do the work: a redundant container recreate costs the owner their terminals,
// while a skip on a box whose image we could not read is an update that silently
// never happens - and `markUpdateSucceeded` would then record the new digest on a
// box still running the old one.
export function updateAlreadyApplied(
	boxImage: string | null | undefined,
	releaseImage: string | null | undefined
): boolean {
	if (!boxImage || !releaseImage) return false;
	return boxImage === releaseImage;
}

// True when a box below the floor has run out of time to update itself. The
// comparison is `>=` so a deadline exactly now has passed; a floor with no
// deadline never forces anything, which is what makes setting an image without
// a date a safe way to announce a floor before enforcing it.
export function floorDeadlinePassed(
	standing: RuntimeStanding,
	now: number
): boolean {
	return (
		standing.required &&
		standing.requiredBy !== null &&
		now >= standing.requiredBy
	);
}

// The version label of the cached fleet release, and nothing else.
//
// Public and unauthenticated because the in-IDE update notifier on every cloud
// box asks for it and a box holds no website session. That is why it returns one
// string instead of the settings object: the digest, the floor and its deadline,
// and everything else about the fleet stay behind the authenticated queries.
//
// Null means we have no cached release to compare against - never refreshed yet,
// or a channel tag that resolved to no version. Callers must read that as "not
// known", never as "you are current".
// Refresh the cached fleet release. Scheduled hourly rather than computed per
// box or per page view: it is one registry round trip for the whole fleet, and
// the answer is identical for every box.
export const refreshRuntimeRelease = internalAction({
	args: {},
	handler: async (ctx) => {
		const release = await ctx.runAction(
			internal.boxes.infra.image.resolveConfiguredRuntimeRelease,
			{}
		);
		await ctx.runMutation(internal.settings.recordRuntimeRelease, {
			image: release.image,
			version: release.version
		});
	}
});

// Which boxes the floor sweep considers: exactly the statuses an update may
// begin from, read from the table that enforces it rather than restated here.
//
// That table is `["running", "update_failed"]`, and the second entry is the
// whole reason this is derived. The sweep used to query `running` alone and
// filter on the same table afterwards - a filter that could not fail, because
// every row it saw was already `running`. So a box whose forced update failed
// landed in `update_failed` and left the only set this sweep looks at, for ever:
// it stayed below the mandatory floor with nothing retrying it and no failure to
// read, which is precisely the outcome a deadline exists to prevent.
//
// The statuses left out are left out by that table, not by this one. A stopped
// or suspended box cannot be reached over SSH, and a box mid-operation must not
// have one queued behind it; both are picked up by a later run once they are
// eligible again.
export const FLOOR_UPDATE_STATUSES = BOX_OPERATIONS.update.from;

// Boxes whose floor deadline has passed and which are still below it.
export const boxesPastFloorDeadline = internalQuery({
	args: {},
	handler: async (ctx) => {
		const settings = await readGlobalSettings(ctx);
		// A cost guard, not a decision: `floorDeadlinePassed` already refuses every
		// box when no deadline is set, so removing this changes nothing but the
		// hourly table scan it saves on the deployments that have no floor - which
		// is most of them. Equivalent by construction, hence the annotation rather
		// than a test that could only assert the same empty list twice.
		// Stryker disable next-line ConditionalExpression: skipping the scan is the whole effect; the answer is identical either way.
		if (!settings.minimumRuntime?.deadline) return [];

		const now = Date.now();
		const boxIds: Id<"boxes">[] = [];
		for (const status of FLOOR_UPDATE_STATUSES) {
			const boxes = await ctx.db
				.query("boxes")
				.withIndex("status", (query) => query.eq("status", status))
				.collect();
			for (const box of boxes) {
				const standing = runtimeStanding({
					boxImage: box.runtime_image,
					boxVersion: box.runtime_version,
					fleet: settings.runtimeRelease,
					minimum: settings.minimumRuntime
				});
				if (floorDeadlinePassed(standing, now)) boxIds.push(box._id);
			}
		}
		return boxIds;
	}
});

// Update the boxes whose owners have run out of time to do it themselves.
//
// This is the only path that recreates a box's container without its owner
// asking, so it is deliberately narrow: it fires only when staff have set both
// a floor image and a deadline, only on boxes actually below that floor, and
// only once that deadline has passed. A floor with no deadline announces itself
// in the interface and never acts.
//
// Failures are per box and never abort the batch - one unreachable host must not
// stop the rest of the fleet from crossing the floor. Each failure is already
// recorded against its own operation and alerted on by `markOperationFailed`, so
// there is nothing to re-report here.
export const updateBoxesPastDeadline = internalAction({
	args: {},
	handler: async (ctx) => {
		const boxIds = await ctx.runQuery(
			internal.boxes.version.boxesPastFloorDeadline,
			{}
		);

		for (const boxId of boxIds) {
			try {
				await startBoxOperation(ctx, boxId, "update", {
					// Keyed by box alone, and deliberately not by the deadline: the key
					// only ever matches an operation that is still pending or running, so
					// it stops a second update being queued behind one in flight while
					// leaving a box whose update failed free to be retried next run.
					idempotencyKey: `floor-update:${boxId}`,
					metadata: { reason: "minimum_runtime_version" },
					trigger: "system:runtime_floor"
				});
			} catch {
				// Busy with another operation, or no longer eligible. Both are normal
				// and both resolve themselves by the next run.
			}
		}
	}
});
