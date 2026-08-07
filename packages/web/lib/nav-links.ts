"use client";

import { useQuery } from "convex/react";
import type { AnimatedIconName } from "@/components/animated-icon";
import { api } from "@/convex/_generated/api";

export type NavLink = {
	href: string;
	icon: AnimatedIconName;
	label: string;
};

export const PUBLIC_NAV_LINKS: NavLink[] = [
	{ href: "/pricing", icon: "wallet", label: "Pricing" },
	{ href: "/docs", icon: "book-open", label: "Docs" }
];

const USER_LINKS: NavLink[] = [
	{ href: "/boxes", icon: "washing-machine", label: "Boxes" }
];
const STAFF_LINKS: NavLink[] = [
	{ href: "/console", icon: "layout-grid", label: "Console" }
];

// Nothing until the answer is known, so the nav grows once. Answering with
// USER_LINKS while the query is in flight puts Boxes on the bar and then
// displaces it again a round trip later when Console turns up beside it.
export function useAuthedNavLinks(): NavLink[] {
	const staff = useQuery(api.owner.account.canAccessStaffConsole);
	if (staff === undefined) return [];
	return [...USER_LINKS, ...(staff ? STAFF_LINKS : [])];
}
