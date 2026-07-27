"use client";

import { useQuery } from "convex/react";
import { BoxActionsBar } from "@/components/box/actions-bar";
import { api } from "@/convex/_generated/api";

export function BoxActions({ boxId }: { boxId: string }) {
	const detail = useQuery(api.staff.boxes.getById, { boxId });
	if (!detail?.box.runtimeUrl) return null;

	return <BoxActionsBar runtimeUrl={detail.box.runtimeUrl} />;
}
