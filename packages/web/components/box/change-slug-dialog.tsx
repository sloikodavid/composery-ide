"use client";

import { useState } from "react";
import { AnimatedIconButton } from "@/components/animated-icon";
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
import { Input } from "@/components/base/input";
import { useBusyAction } from "@/hooks/use-busy-action";
import {
	isValidSlug,
	sanitizeSlug,
	SLUG_MAX_LENGTH
} from "@/convex/model/box/slug";

// Owner and console box pages share this dialog; the caller's onSubmit performs
// the slug change (and any post-change navigation). A caller that opens the
// dialog from outside (a menu) passes `open` and `onOpenChange`; absent, the
// dialog owns its state and renders its own button.
export function ChangeSlugDialog({
	onOpenChange,
	onSubmit,
	open: openProp,
	slug
}: {
	onOpenChange?: (open: boolean) => void;
	onSubmit: (newSlug: string) => Promise<unknown>;
	open?: boolean;
	slug: string;
}) {
	const [internalOpen, setInternalOpen] = useState(false);
	const open = openProp ?? internalOpen;
	const [newSlug, setNewSlug] = useState("");
	const { busy, run } = useBusyAction();

	function changeOpen(nextOpen: boolean) {
		if (onOpenChange) onOpenChange(nextOpen);
		else setInternalOpen(nextOpen);
	}

	return (
		<>
			{openProp === undefined ? (
				<AnimatedIconButton
					icon="square-pen"
					iconPosition="start"
					onClick={() => changeOpen(true)}
					variant="outline"
				>
					Change slug
				</AnimatedIconButton>
			) : null}
			<Dialog onOpenChange={changeOpen} open={open}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Change slug for {slug}</DialogTitle>
						<DialogDescription>
							This changes the box URL. Pipelines and bookmarks using the
							current address will stop working.
						</DialogDescription>
					</DialogHeader>
					<Input
						autoCapitalize="none"
						autoComplete="off"
						maxLength={SLUG_MAX_LENGTH}
						onChange={(event) => setNewSlug(sanitizeSlug(event.target.value))}
						placeholder="new-slug"
						spellCheck={false}
						value={newSlug}
					/>
					<DialogFooter>
						<DialogClose render={<Button variant="outline">Cancel</Button>} />
						<Button
							disabled={busy === "slug" || !isValidSlug(newSlug)}
							onClick={() =>
								// In progress, not done. The mutation only queues the work - new DNS
								// records and a proxy reload happen after it returns, and the box
								// keeps its old slug until both land. This used to say "Slug
								// changed", so an owner whose change then failed and rolled back
								// had been told it succeeded and was told nothing after. The
								// outcome now shows on the box page itself.
								run("slug", "Changing slug", async () => {
									await onSubmit(newSlug);
									setNewSlug("");
									changeOpen(false);
								})
							}
						>
							Change slug
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
