"use client";

import { useQuery } from "convex/react";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/base/button";
import { BoxActionsMenu } from "@/components/box/actions-menu";
import { api } from "@/convex/_generated/api";
import { useBoxActions } from "@/hooks/use-box-actions";
import type { OwnerBox } from "@/lib/box/detail";

// One row's copy of everything the box page offers.
//
// A row carries only what the list shows - a slug, a date, a status - so the rest
// is read the first time this menu opens and never before: drawing a page of rows
// must not read every box's operations, subscription and release standing for
// menus nobody opened. Once read it stays read, because the dialogs the menu
// opens outlive the menu itself.
export function RowMenu({ box }: { box: OwnerBox }) {
	const [opened, setOpened] = useState(false);
	const actions = useBoxActions(box.slug);
	const detail = useQuery(
		api.owner.boxes.getById,
		opened ? { boxId: box.id } : "skip"
	);

	return (
		<BoxActionsMenu
			actions={actions}
			box={box}
			detail={detail ?? undefined}
			onOpenChange={(open) => {
				if (open) setOpened(true);
			}}
			primary
			trigger={
				<Button
					aria-label={`More actions for ${box.slug}`}
					size="icon-sm"
					variant="ghost"
				>
					<EllipsisIcon />
				</Button>
			}
		/>
	);
}
