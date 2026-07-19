import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { METRICS_POLL_INTERVAL_MINUTES } from "./boxes/metrics";

const crons = cronJobs();

crons.interval(
	"release expired checkout intents",
	{ minutes: 15 },
	internal.checkout.checkoutIntents.releaseExpiredCheckoutIntents
);

crons.interval(
	"delete expired box authorization records",
	{ minutes: 15 },
	internal.instance.auth.deleteExpiredAuthRecords
);

crons.interval(
	"reconcile capacity alerts",
	{ minutes: 15 },
	internal.boxes.capacity.reconcile
);

crons.interval(
	"retry staff alerts",
	{ minutes: 15 },
	internal.staff.alerts.retryPending
);

// Deploying a notice is what sends it, and this is what notices the deploy. It
// finds nothing on almost every run - there are only ever a handful of declared
// notices and a finished one returns on a single point read - which is the
// normal state for the mechanism that has to work on the day it does not.
crons.interval(
	"send legal notices",
	{ minutes: 15 },
	internal.notice.legal.sweepLegalNotices
);

// Boxes follow their subscriptions: one that has ended is deleted, and one whose
// product no longer names the plan it runs on is reported to staff - a box's
// plan is fixed at purchase, so that drift has no automatic answer. The webhooks
// delete sooner; this is the floor under a webhook that was missed, arrived out
// of order, or found the box busy with something else.
crons.hourly(
	"subscription reconciliation",
	{ minuteUTC: 11 },
	internal.billing.reconciliation.reconcileBoxSubscriptions
);

crons.hourly(
	"account deletion finalization",
	{ minuteUTC: 19 },
	internal.account.deletion.sweepPendingAccountDeletions
);

// A deletion that stopped part-way leaves the record claiming a box exists when
// its server is already gone, and nothing else re-drives one - see
// boxes/cleanup.ts. Runs after the two sweeps that can put a box into
// delete_failed in the first place.
crons.hourly(
	"finish failed box deletions",
	{ minuteUTC: 27 },
	internal.boxes.cleanup.finishFailedDeletions
);

crons.interval(
	"poll box metrics",
	{ minutes: METRICS_POLL_INTERVAL_MINUTES },
	internal.boxes.metricsPoll.pollBoxMetrics
);

// Hourly, and not on the metrics interval, because this is the one sweep that
// opens an SSH connection per box. A disk fills over hours, so an hourly reading
// answers the question the meter asks - and the box page states when the reading
// was taken rather than implying it is live. Outbound traffic is not here: the
// provider already reports it over HTTP, so it rides the metrics poll.
crons.hourly(
	"sample box disk usage",
	{ minuteUTC: 51 },
	internal.boxes.usage.sweepBoxDiskUsage
);

crons.hourly(
	"roll up hourly box metrics",
	{ minuteUTC: 4 },
	internal.boxes.metrics.rollupHourlyMetrics,
	{}
);

crons.daily(
	"delete old box metrics",
	{ hourUTC: 4, minuteUTC: 23 },
	internal.boxes.metrics.deleteOldSamples
);

crons.daily(
	"normalize deleted boxes",
	{ hourUTC: 4, minuteUTC: 29 },
	internal.boxes.cleanup.normalizeDeletedBoxes
);

crons.daily(
	"purge expired deleted boxes",
	{ hourUTC: 4, minuteUTC: 31 },
	internal.boxes.cleanup.scheduleExpiredBoxPurges,
	{}
);

crons.daily(
	"purge expired checkout records",
	{ hourUTC: 4, minuteUTC: 37 },
	internal.boxes.cleanup.purgeExpiredCheckoutRecords
);

crons.daily(
	"purge expired deleted accounts",
	{ hourUTC: 4, minuteUTC: 39 },
	internal.account.deletion.purgeExpiredDeletedAccounts
);

crons.daily(
	"purge expired staff alerts",
	{ hourUTC: 4, minuteUTC: 43 },
	internal.staff.alerts.purgeExpired
);

crons.daily(
	"purge expired legal notices",
	{ hourUTC: 4, minuteUTC: 47 },
	internal.notice.legal.purgeExpiredLegalNotices
);

// Aligned with metrics polling: both sweep every running box, and the
// consecutive-failure count automatic repair gates on is expressed in these
// ticks (see boxes/autoRepair.ts). Derived rather than restated, because the
// alignment was a claim in this comment beside a hardcoded 10 - retuning the
// poll would have silently unaligned them and turned SUSTAINED_FAILURES into a
// different amount of real time.
crons.interval(
	"sweep box health",
	{ minutes: METRICS_POLL_INTERVAL_MINUTES },
	internal.boxes.autoRepair.sweepBoxHealth
);

// An operation nothing will ever finish holds its box's lock for ever, and every
// later action on that box is refused as "busy". Nothing should reach that state -
// see boxes/operation/sweep.ts - so this normally finds nothing, which is
// exactly why it has to run rather than be assumed.
crons.interval(
	"sweep stuck box operations",
	{ minutes: 15 },
	internal.boxes.operation.sweep.sweepStuckOperations
);

// Hourly rather than per box or per page view: one registry round trip answers
// "what does the channel resolve to now" for the entire fleet.
crons.hourly(
	"refresh runtime release",
	{ minuteUTC: 26 },
	internal.boxes.version.refreshRuntimeRelease
);

// The product webhooks only fire on a change, so a deployment that has not seen
// one holds no catalogue and the pricing page has no price to show. Hourly for
// the same reason as the release refresh above: one round trip answers for every
// visitor, and it is the floor under a webhook that was missed or never sent.
crons.hourly(
	"sync Polar products",
	{ minuteUTC: 33 },
	internal.billing.polar.syncBoxProducts
);

// Reads the refreshed release, so it runs after it within the same hour.
crons.hourly(
	"update boxes past their floor deadline",
	{ minuteUTC: 41 },
	internal.boxes.version.updateBoxesPastDeadline,
	{}
);

crons.daily(
	"snapshot running boxes",
	{ hourUTC: 3, minuteUTC: 7 },
	internal.boxes.snapshots.scheduleAutomaticSnapshots,
	{}
);

crons.daily(
	"delete expired snapshots",
	{ hourUTC: 4, minuteUTC: 41 },
	internal.boxes.snapshots.deleteExpiredSnapshots
);

// Runs after the snapshot/expiry crons so it reconciles the settled state.
crons.daily(
	"reconcile Hetzner resources",
	{ hourUTC: 5, minuteUTC: 17 },
	internal.boxes.reconcile.reconcileHetznerResources
);

export default crons;
