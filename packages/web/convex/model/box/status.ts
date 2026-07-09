// What state a box is in, as literals rather than as a validator.
//
// This is the root of the box vocabulary: the operation catalogue names these
// statuses, `convex/schema.ts` builds `vBoxStatus` from this list, and the
// interface labels them. Declaring them here rather than in the schema is what
// makes the dependency run one way - the model knows nothing about Convex, and
// everything that does know about Convex reads the model. The reverse (statuses
// living in the schema, derived back out with `vBoxStatus.members.map(...)`)
// forced every module that only wanted the words to import the database.
//
// Order is the order a box moves through them, so a reader meets `creating`
// before `deleted` rather than in whatever order the union grew.
export const BOX_STATUSES = [
	"creating",
	"create_failed",
	"running",
	"stopping",
	"stopped",
	"starting",
	"resetting",
	"reset_failed",
	"repairing",
	"repair_failed",
	"updating",
	"update_failed",
	"restoring",
	"restore_failed",
	"suspending",
	"suspended",
	"unsuspending",
	"deleting",
	"delete_failed",
	"deleted"
] as const;

export type BoxStatus = (typeof BOX_STATUSES)[number];

// "Every box status except these."
//
// Several rules mean "all live boxes": which ones hold a server against
// capacity, which ones keep their slug reserved, which ones a subscription is
// reconciled against, which ones roll metrics up. Each of those was a
// hand-written subset of the union, and a subset is exactly what the type
// checker cannot check - so every status added since had to be pasted into all
// of them by hand, and `repair_failed` had already fallen out of the metrics
// rollup that way.
//
// The direction of the failure is what makes this worth deriving rather than
// remembering: a status missing from one of these lists means a box that quietly
// stops counting against capacity, or stops holding its own slug so someone else
// can claim it. Naming the exclusions inverts that - a new status is in every
// list by default and only leaves one deliberately.
export function boxStatusesExcept(
	...excluded: readonly BoxStatus[]
): BoxStatus[] {
	return BOX_STATUSES.filter((status) => !excluded.includes(status));
}
