import { toast } from "sonner";
import { BRAND_COLORS, BRAND_THEME, ICON_SVG } from "shared";
import { copyToClipboard } from "@/lib/clipboard";
import {
	LOGO_HEIGHT,
	LOGO_INNER,
	LOGO_VIEWBOX,
	LOGO_WIDTH
} from "@/lib/logo-data";

// Concrete, font-free, self-contained SVGs of the Composery logo and icon,
// shared by the public /brand page and the logo right-click menu. The asset
// catalog owns the fixed artwork color and matching preview surface together,
// so callers cannot accidentally show or copy a different scheme.
export type BrandAsset = { height: number; svg: string; width: number };
export type BrandAssetScheme = "light" | "dark";
export type BrandAssetType = "logo" | "icon";

function iconAsset(fill: string): BrandAsset {
	return {
		svg: `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" fill="none">${ICON_SVG.replace(/currentColor/g, fill)}</svg>`,
		width: 256,
		height: 256
	};
}

function logoAsset(fill: string): BrandAsset {
	return {
		svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" viewBox="${LOGO_VIEWBOX}" fill="none">${LOGO_INNER.replace(/currentColor/g, fill)}</svg>`,
		width: LOGO_WIDTH,
		height: LOGO_HEIGHT
	};
}

// The SVGs are transparent. Preview colors derive from the same shared theme
// that generated their fills rather than restating approximations in /brand.
export const BRAND_ASSETS = {
	light: {
		background: BRAND_THEME.light.background,
		checker: BRAND_THEME.light.muted,
		color: BRAND_COLORS.surface.ink,
		icon: iconAsset(BRAND_COLORS.surface.ink),
		logo: logoAsset(BRAND_COLORS.surface.ink)
	},
	dark: {
		background: BRAND_THEME.dark.background,
		checker: BRAND_THEME.dark.muted,
		color: BRAND_COLORS.surface.paper,
		icon: iconAsset(BRAND_COLORS.surface.paper),
		logo: logoAsset(BRAND_COLORS.surface.paper)
	}
} as const satisfies Record<
	BrandAssetScheme,
	{
		background: string;
		checker: string;
		color: string;
		icon: BrandAsset;
		logo: BrandAsset;
	}
>;

// What someone writing about Composery needs to pick colours from: the two logo
// colours, the surfaces they belong on, and the status accents. Every value is
// read from the shared theme, so a palette change reaches this page on its own.
// Labels are written out rather than derived from the token names - the two
// vocabularies are separate, and "mutedForeground" is not a colour name.
export const BRAND_PALETTE: { hex: string; label: string }[] = [
	{ hex: BRAND_COLORS.surface.ink, label: "Logo on light" },
	{ hex: BRAND_COLORS.surface.paper, label: "Logo on dark" },
	{ hex: BRAND_THEME.light.background, label: "Light background" },
	{ hex: BRAND_THEME.dark.background, label: "Dark background" },
	{ hex: BRAND_THEME.light.mutedForeground, label: "Secondary text" },
	{ hex: BRAND_COLORS.state.success, label: "Success" },
	{ hex: BRAND_COLORS.state.warning, label: "Warning" },
	{ hex: BRAND_COLORS.state.destructive, label: "Danger" },
	{ hex: BRAND_COLORS.state.info, label: "Info" }
];

export function copySvg(asset: BrandAsset) {
	return copyToClipboard(asset.svg, "SVG copied");
}

export function copyHex(hex: string) {
	return copyToClipboard(hex, `${hex} copied`);
}

function save(href: string, name: string) {
	const anchor = document.createElement("a");
	anchor.href = href;
	anchor.download = name;
	anchor.click();
}

function saveBlob(blob: Blob, name: string) {
	const url = URL.createObjectURL(blob);
	save(url, name);
	URL.revokeObjectURL(url);
}

export function downloadSvg(asset: BrandAsset, name: string) {
	saveBlob(new Blob([asset.svg], { type: "image/svg+xml" }), `${name}.svg`);
}

// Rasterize the (font-free) asset SVG to a canvas at `scale`x its intrinsic size
// and save the PNG. No webfont is involved, so this is reliable across browsers.
export function downloadPng(
	{ height, svg, width }: BrandAsset,
	scale: number,
	name: string
) {
	const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
	const image = new Image();
	image.onload = () => {
		const canvas = document.createElement("canvas");
		canvas.width = Math.round(width * scale);
		canvas.height = Math.round(height * scale);
		canvas
			.getContext("2d")
			?.drawImage(image, 0, 0, canvas.width, canvas.height);
		URL.revokeObjectURL(url);
		canvas.toBlob((blob) => {
			if (blob) saveBlob(blob, `${name}.png`);
			else toast.error("Couldn't render PNG");
		}, "image/png");
	};
	image.onerror = () => {
		URL.revokeObjectURL(url);
		toast.error("Couldn't render PNG");
	};
	image.src = url;
}
