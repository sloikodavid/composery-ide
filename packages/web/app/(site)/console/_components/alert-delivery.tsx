"use client";

import { useQuery } from "convex/react";
import { TriangleAlertIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { formatDateTime } from "@/lib/datetime";

// Only renders when email delivery is unhealthy, so a working deployment shows
// nothing here.
//
// It names the alerts rather than counting them: this panel is read at the one
// moment staff cannot rely on being told anything by email, and a bare count
// would send whoever is reading it to the Convex dashboard for the subject line
// it already has in hand.
//
// It covers every sender rather than the alert channel alone. Each class of mail
// has its own address and the customer classes sit on a different verified
// domain, so a healthy alert channel says nothing about whether a box owner or a
// legal notice can be delivered - and those are precisely the two that fail
// invisibly, because nobody on this side of the service is waiting for them.
export function AlertDelivery() {
	const health = useQuery(api.staff.alerts.health, {});
	if (!health) return null;

	const configurationIssues = [
		health.senders.alerts ? null : "the staff alert sender is not configured",
		health.senders.notices ? null : "the box notice sender is not configured",
		health.senders.accounts
			? null
			: "the legal notice sender is not configured",
		health.recipientCount === 0 ? "no alert recipient is configured" : null,
		health.deliveryTrackingConfigured
			? null
			: "Resend delivery tracking is not configured"
	].filter((issue) => issue !== null);

	if (configurationIssues.length === 0 && health.recentIssues.length === 0) {
		return null;
	}

	return (
		<div className="rounded-2xl border border-destructive/40 bg-card px-4 py-3">
			<div className="flex items-start gap-2">
				<TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
				<div className="min-w-0 space-y-2 text-sm">
					<p className="font-medium text-foreground">Email delivery</p>
					{configurationIssues.length > 0 ? (
						<p className="text-muted-foreground">
							{configurationIssues.join("; ")}.
						</p>
					) : null}
					{health.recentIssues.length > 0 ? (
						<ul className="space-y-1 text-muted-foreground">
							{health.recentIssues.map((issue) => (
								<li className="min-w-0" key={issue.id}>
									<span className="text-foreground">{issue.subject}</span>{" "}
									<span className="wrap-break-word whitespace-normal">
										{issue.error ??
											issue.lastEmailEvent ??
											`queue: ${issue.queueStatus}`}
									</span>{" "}
									<span className="text-xs">
										{formatDateTime(issue.createdAt)}
									</span>
								</li>
							))}
						</ul>
					) : null}
				</div>
			</div>
		</div>
	);
}
