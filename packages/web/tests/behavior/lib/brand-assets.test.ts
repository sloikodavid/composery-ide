import { describe, expect, test } from "vitest";
import { BRAND_COLORS, BRAND_THEME } from "shared";
import {
	BRAND_ASSETS,
	type BrandAssetScheme,
	type BrandAssetType
} from "@/lib/brand-assets";

const schemes: BrandAssetScheme[] = ["light", "dark"];
const types: BrandAssetType[] = ["logo", "icon"];

describe("brand assets", () => {
	test.each(schemes)(
		"%s assets and preview use the shared palette",
		(scheme) => {
			const assets = BRAND_ASSETS[scheme];
			const expectedColor =
				scheme === "light"
					? BRAND_COLORS.surface.ink
					: BRAND_COLORS.surface.paper;

			expect(assets.background).toBe(BRAND_THEME[scheme].background);
			expect(assets.checker).toBe(BRAND_THEME[scheme].muted);
			expect(assets.color).toBe(expectedColor);
			for (const type of types) {
				expect(assets[type].svg).toContain(expectedColor);
				expect(assets[type].svg).not.toContain("currentColor");
			}
		}
	);
});
