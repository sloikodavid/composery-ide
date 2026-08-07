import type { RuntimeStanding } from "@/convex/boxes/version";
import { formatDateTime } from "@/lib/datetime";
import type { Tone } from "@/lib/box/repair";

export type UpdateNotice = { tone: Tone; text: string };

// What the Update dialog says about where a box stands, as prose the dialog only
// has to render.
//
// `required` and `updateAvailable` are independent - the floor is raised
// deliberately and can lag or lead the channel - so all four combinations happen
// and each keeps its own line rather than being collapsed into one verdict a box
// does not match.
//
// The one thing this must never do is turn "we don't know" into "you're up to
// date". `updateAvailable` is false for a box on the fleet image and for a box
// there is nothing to compare against alike; `comparable` is what separates
// them, and only the comparable half earns the green line.
export function standingNotices(standing: RuntimeStanding): UpdateNotice[] {
	const notices: UpdateNotice[] = [];

	if (!standing.comparable) {
		notices.push({
			tone: "muted",
			text: "There is nothing to compare this box against yet: no current release has been cached, or the box has no recorded image. Whether it is up to date is unknown."
		});
	} else if (standing.updateAvailable) {
		notices.push({
			tone: "warn",
			text: standing.availableVersion
				? `Version ${standing.availableVersion} is available. This box runs ${standing.currentVersion ?? "a version we can't name"}.`
				: "A newer release is available. The registry didn't name its version, so all we can say is that the image changed."
		});
	} else {
		notices.push({
			tone: "ok",
			text: standing.availableVersion
				? `This box is on the current release (${standing.availableVersion}).`
				: "This box is on the current release."
		});
	}

	if (standing.required) {
		// Being on the current release and below the floor at once is not a
		// contradiction: the floor names an image of its own, and the cached fleet
		// release can be older than it for as long as the hourly refresh takes.
		// Saying so keeps the two lines above and below from reading as a bug.
		const target =
			standing.comparable && !standing.updateAvailable
				? " The required image is not the release we last cached, so the update moves this box to whatever the channel resolves to now."
				: "";
		notices.push({
			tone: "warn",
			text: standing.requiredBy
				? `This box is below the minimum version Composery requires. If you don't update it yourself, it is updated automatically after ${formatDateTime(standing.requiredBy)}.${target}`
				: `This box is below the minimum version Composery requires. No date is set for updating it automatically, so when to update is still your choice.${target}`
		});
	}

	return notices;
}
