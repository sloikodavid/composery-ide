"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Button } from "@/components/base/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from "@/components/base/dialog";

// Wraps a destructive action in a confirmation step. `children` is a render prop
// that receives an `open` callback to wire onto the trigger button, so callers
// keep full control of the trigger's styling/icon/disabled state. A caller that
// opens the dialog from outside (a menu) passes `open` and `onOpenChange` and no
// children; absent, the dialog owns its state and its trigger renders it.
export function ConfirmDialog({
	children,
	confirmLabel = "Confirm",
	description,
	destructive = false,
	onConfirm,
	onOpenChange,
	open: openProp,
	title
}: {
	children?: (open: () => void) => ReactNode;
	confirmLabel?: string;
	description: string;
	destructive?: boolean;
	onConfirm: () => void | Promise<void>;
	onOpenChange?: (open: boolean) => void;
	open?: boolean;
	title: string;
}) {
	const [internalOpen, setInternalOpen] = useState(false);
	const open = openProp ?? internalOpen;

	function changeOpen(nextOpen: boolean) {
		if (onOpenChange) onOpenChange(nextOpen);
		else setInternalOpen(nextOpen);
	}

	return (
		<>
			{children?.(() => changeOpen(true))}
			<Dialog onOpenChange={changeOpen} open={open}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose render={<Button variant="outline">Cancel</Button>} />
						<Button
							onClick={async () => {
								await onConfirm();
								changeOpen(false);
							}}
							variant={destructive ? "destructive" : "default"}
						>
							{confirmLabel}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
