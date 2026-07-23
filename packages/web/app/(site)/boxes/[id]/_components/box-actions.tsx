"use client";

import { useQuery } from "convex/react";
import { BoxActionsBar } from "@/components/box/actions-bar";
import { api } from "@/convex/_generated/api";

export function BoxActions({
	boxId,
	labelOnly = false
}: {
	boxId: string;
	labelOnly?: boolean;
}) {
	const detail = useQuery(api.owner.boxes.getById, { boxId });
	if (!detail) return null;
	if (labelOnly) return detail.box.slug;

	return <BoxActionsBar runtimeUrl={detail.box.runtimeUrl} />;
}
