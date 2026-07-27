"use client";

import { useQuery } from "convex/react";
import { OpenInConvex, OpenInHetzner, OpenInPolar } from "@/components/open-in";
import { api } from "@/convex/_generated/api";

// The console dashboard links beside the slug in the breadcrumb. Shares the
// boxDetail subscription with the detail view, so it adds no extra reads; the
// group stays hidden until the box record is loaded, then fades in together.
export function BoxLinks({
	boxId,
	showSlug = false
}: {
	boxId: string;
	showSlug?: boolean;
}) {
	const detail = useQuery(api.staff.boxes.getById, { boxId });
	if (!detail) return null;
	const slug = detail.box.slug;

	return (
		<span className="page-fade-in inline-flex items-center gap-1">
			{showSlug ? slug : null}
			<OpenInHetzner
				iconOnly
				label={`Open ${slug} server in Hetzner`}
				serverId={detail.box.hetznerServerId ?? null}
			/>
			<OpenInPolar
				iconOnly
				label={`Open ${slug} subscription in Polar`}
				subscriptionId={detail.box.polarSubscriptionId ?? null}
			/>
			<OpenInConvex iconOnly table="boxes" value={detail.box.id} />
		</span>
	);
}
