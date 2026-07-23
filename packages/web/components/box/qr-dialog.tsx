"use client";

import { QRCodeSVG } from "qrcode.react";
import { BRAND_THEME } from "shared";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle
} from "@/components/base/dialog";
import { CopyLinkButton } from "@/components/copy-link-button";

// QR of the box URL, for opening the box on a phone.
//
// A QR is dark modules on a light field, and a reader that does not try the
// inverse is the one you meet in the wild - so the card keeps the light
// palette's paper and ink in both themes rather than following the current one.
// That is the palette rather than an exception to it: in light mode the card is
// the dialog's own surface, so the code reads as drawn straight onto it, and in
// dark mode it is the same warm paper. A flat white card was neither.
const PAPER = BRAND_THEME.light.card;
const INK = BRAND_THEME.light.foreground;

export function QrDialog({
	runtimeUrl,
	open,
	onOpenChange
}: {
	runtimeUrl: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Scan to open on your phone</DialogTitle>
					<DialogDescription>
						Scan with your phone&apos;s camera to open this box in the browser.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col items-center gap-4">
					{/* The spec's four-module quiet zone lives inside the SVG
					    (`marginSize`), where it scales with the code. This padding must
					    not add a second one - that is what made the code look small in
					    its card - so it is only what `rounded-lg` would otherwise take
					    out of the quiet zone at the corners. */}
					<div
						className="w-full max-w-[312px] rounded-lg p-3"
						style={{ background: PAPER }}
					>
						<QRCodeSVG
							bgColor={PAPER}
							className="block h-auto w-full"
							fgColor={INK}
							level="M"
							marginSize={4}
							size={288}
							title={`QR code for ${runtimeUrl}`}
							value={runtimeUrl}
						/>
					</div>
					{/* Outside the card, so the address takes the dialog's own text
					    colour in both themes rather than a second light-theme one. */}
					<div className="flex max-w-full items-center gap-1">
						<a
							className="link break-all text-center text-sm"
							href={runtimeUrl}
							rel="noreferrer"
							target="_blank"
						>
							{runtimeUrl}
						</a>
						<CopyLinkButton
							aria-label="Copy link"
							className="text-muted-foreground"
							label=""
							size="icon-xs"
							value={runtimeUrl}
							variant="ghost"
						/>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
