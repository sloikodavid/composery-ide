"use client";

import { useId } from "react";
import { ICON_SVG, ICON_VIEWBOX } from "shared";

// The Composery icon itself - unrelated to components/icons, which is the
// @lucide-animated glyph set.
export function BrandIcon({ className }: { className?: string }) {
	const holesId = useId().replace(/[^A-Za-z0-9_-]/g, "");
	const inner = ICON_SVG.replaceAll("composery-icon-holes", holesId);

	return (
		<svg
			className={className}
			dangerouslySetInnerHTML={{ __html: inner }}
			fill="none"
			viewBox={ICON_VIEWBOX}
			xmlns="http://www.w3.org/2000/svg"
		/>
	);
}
