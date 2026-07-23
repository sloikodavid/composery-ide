"use client";

import { useState } from "react";
import {
	AnimatedIconAnchor,
	AnimatedIconButton
} from "@/components/animated-icon";
import { QrDialog } from "@/components/box/qr-dialog";
import { buttonVariants } from "@/components/base/button";
import { CopyLinkButton } from "@/components/copy-link-button";
import { useIsTouch } from "@/hooks/use-is-touch";

// Page-level box actions, beside the breadcrumbs. Shared by the owner and console
// box pages. Same three actions everywhere; on touch the QR drops its label so
// Copy link and Open box keep full-width halves on a narrow row. Three buttons
// never fit beside a breadcrumb, so this is the one page action bar that claims
// the whole width on a narrow screen (PageTemplate keeps actions inline).
export function BoxActionsBar({ runtimeUrl }: { runtimeUrl: string }) {
	const [qrOpen, setQrOpen] = useState(false);
	const isTouch = useIsTouch();

	return (
		<>
			{isTouch ? (
				<div className="grid w-full grid-cols-[1fr_1fr_auto] gap-2 sm:w-auto">
					<CopyLinkButton value={runtimeUrl} />
					<AnimatedIconAnchor
						className={buttonVariants()}
						href={runtimeUrl}
						icon="arrow-up-right"
						rel="noreferrer"
						target="_blank"
					>
						Open box
					</AnimatedIconAnchor>
					<AnimatedIconButton
						aria-label="Show QR"
						icon="scan-text"
						onClick={() => setQrOpen(true)}
						size="icon"
						variant="outline"
					/>
				</div>
			) : (
				<div className="flex flex-wrap gap-2">
					<CopyLinkButton value={runtimeUrl} />
					<AnimatedIconButton
						icon="scan-text"
						iconPosition="start"
						onClick={() => setQrOpen(true)}
						variant="outline"
					>
						Show QR
					</AnimatedIconButton>
					<AnimatedIconAnchor
						className={buttonVariants()}
						href={runtimeUrl}
						icon="arrow-up-right"
						rel="noreferrer"
						target="_blank"
					>
						Open box
					</AnimatedIconAnchor>
				</div>
			)}
			<QrDialog
				onOpenChange={setQrOpen}
				open={qrOpen}
				runtimeUrl={runtimeUrl}
			/>
		</>
	);
}
