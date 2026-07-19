type BoxDeletionStatus = {
	polar_subscription_id?: string;
	status: string;
};

export function deletionIdempotencyKey(subscriptionId: string) {
	return `delete:${subscriptionId}`;
}

// Paid boxes key their delete on the subscription (webhooks and the sweep use
// the same key). Comp boxes have no subscription, so they key on the box id
// instead. A box is only ever one or the other, so the two never collide.
export function boxDeletionIdempotencyKey(box: {
	_id: string;
	polar_subscription_id?: string;
}) {
	return box.polar_subscription_id
		? deletionIdempotencyKey(box.polar_subscription_id)
		: `delete:${box._id}`;
}

export function accountDeletionBoxTargets<T extends BoxDeletionStatus>(
	boxes: readonly T[]
) {
	return boxes.filter((box) => box.status !== "deleted");
}

export function accountDeletionReady(boxes: readonly BoxDeletionStatus[]) {
	return boxes.every((box) => box.status === "deleted");
}

export function scrubbedAccountEmail(userId: string) {
	return `deleted-user-${userId.replace(/[^a-zA-Z0-9_-]/g, "-")}@deleted.invalid`;
}

export function scrubbedUserId(userId: string) {
	return `deleted:${userId}`;
}
