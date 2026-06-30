import { describe, expect, test } from "vitest";

import {
	APP_DESCRIPTION,
	APP_TAGLINE,
	BRAND_COLORS,
	BRAND_IDE_THEME,
	BRAND_NAME,
	BRAND_THEME,
	CONTAINER_IMAGE,
	ICON_HEIGHT,
	ICON_SVG,
	ICON_VIEWBOX,
	ICON_WIDTH,
	ICON_XML,
	IDE_PATH,
	LOGO_TEXT,
	OWNER,
	REPO,
	SOCIAL,
	WEBSITE_DOMAIN,
	WEBSITE_ORIGIN,
	centeredIconSvg,
	iconInner,
	iconSvg,
	iconTileSvg,
	ideTheme,
	theme
} from "../../index.ts";

const ICON =
	'<g transform="translate(-0.7004597831639893 -0.7004597831639893) scale(1.1352670715785889) rotate(135 12 12)"><clipPath id="composery-icon-holes"><path clip-rule="evenodd" d="M0 0H24V24H0Z M10.95 11.55653 L10.95 3.6 A1.05 1.05 0 0 1 13.05 3.6 L13.05 11.55653 A3.6 3.6 0 1 1 10.95 11.55653 Z"/></clipPath><path d="M12 5 L17.6 14.6 C20.6 19.8 19.2 19.8 15.6 19.8 L8.4 19.8 C4.8 19.8 3.4 19.8 6.4 14.6 Z" fill="currentColor" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.6" clip-path="url(#composery-icon-holes)"/></g>';

describe("shared brand identity", () => {
	test("exposes one exact identity and palette to every product surface", () => {
		expect({
			APP_DESCRIPTION,
			APP_TAGLINE,
			BRAND_NAME,
			CONTAINER_IMAGE,
			IDE_PATH,
			LOGO_TEXT,
			OWNER,
			REPO,
			SOCIAL,
			WEBSITE_DOMAIN,
			WEBSITE_ORIGIN
		}).toEqual({
			APP_DESCRIPTION:
				"Composery is an always-on cloud IDE: VS Code in the browser or on your phone, self-hosted on your own server or managed in Composery Cloud, and made for long-running AI agents.",
			APP_TAGLINE:
				"A secure cloud computer with a powerful UI, usable from any phone or browser.",
			BRAND_NAME: "Composery",
			CONTAINER_IMAGE: "ghcr.io/sloikodavid/composery",
			IDE_PATH: "/ide/",
			LOGO_TEXT: "Composery",
			OWNER: {
				legalName: "David Sloiko",
				tradingName: "Composery",
				jurisdiction: "Ireland",
				address:
					"20 Templegreen, Newcastle West, Co. Limerick, V42 AH01, Ireland",
				email: "support@composery.io"
			},
			REPO: { owner: "sloikodavid", name: "composery", branch: "main" },
			SOCIAL: { x: "sloikodavid", linkedin: "composery" },
			WEBSITE_DOMAIN: "composery.io",
			WEBSITE_ORIGIN: "https://www.composery.io"
		});
		expect(BRAND_COLORS).toEqual({
			icon: {
				light: "#2b2b2b",
				dark: "#e2e2e2",
				muted: "#5f5f5f",
				tileStroke: "#e2e2e2"
			},
			surface: {
				ink: "#2b2b2b",
				paper: "#e2e2e2",
				canvas: "#f6f6f6",
				border: "#d6d6d6",
				lightText: "#2b2b2b",
				darkText: "#e2e2e2",
				tile: "#1f1f1f",
				splash: "#f6f6f6",
				splashDark: "#171717"
			},
			state: {
				success: "#2e7a44",
				warning: "#8f6f21",
				destructive: "#b03a30",
				info: "#2d6fa8"
			}
		});
		expect(BRAND_THEME).toBe(theme);
		expect(BRAND_IDE_THEME).toBe(ideTheme);
	});
});

describe("shared icon builders", () => {
	test("draws the canonical fitted icon with stable geometry", () => {
		expect({ ICON_HEIGHT, ICON_VIEWBOX, ICON_WIDTH }).toEqual({
			ICON_HEIGHT: 20,
			ICON_VIEWBOX: "0 0 20 20",
			ICON_WIDTH: 20
		});
		expect(iconInner()).toBe(ICON);
		expect(ICON_SVG).toBe(ICON);
		expect(ICON_XML).toBe(
			`<svg width="256" height="256" viewBox="0 0 20 20" fill="none" color="#2b2b2b" xmlns="http://www.w3.org/2000/svg">${ICON}</svg>`
		);
	});

	test("applies caller dimensions, colors, crop, and unique clip identifiers", () => {
		const inner = iconInner({ fill: "#445566", holesId: "fixture-holes" });

		expect(inner).toBe(
			ICON.replaceAll("composery-icon-holes", "fixture-holes").replaceAll(
				"currentColor",
				"#445566"
			)
		);
		expect(
			iconSvg({
				color: "#abcdef",
				fill: "#445566",
				height: 32,
				viewBox: "1 2 3 4",
				width: 48
			})
		).toBe(
			`<svg width="48" height="32" viewBox="1 2 3 4" fill="none" color="#abcdef" xmlns="http://www.w3.org/2000/svg">${ICON.replaceAll(
				"currentColor",
				"#445566"
			)}</svg>`
		);
	});

	test("centers bare and tiled icons at the requested scale", () => {
		expect(
			iconTileSvg({
				background: "#112233",
				fill: "#445566",
				radius: 12,
				scale: 0.5,
				size: 64
			})
		).toBe(
			`<svg width="64" height="64" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="256" height="256" rx="12" fill="#112233"/><g transform="translate(128 128) scale(6.4) translate(-10 -10)">${ICON.replaceAll(
				"currentColor",
				"#445566"
			)}</g></svg>`
		);
		expect(
			centeredIconSvg({
				color: "#abcdef",
				fill: "#123456",
				scale: 0.5,
				size: 64
			})
		).toBe(
			`<svg width="64" height="64" viewBox="0 0 256 256" fill="none" color="#abcdef" xmlns="http://www.w3.org/2000/svg"><g transform="translate(128 128) scale(6.4) translate(-10 -10)">${ICON.replaceAll(
				"currentColor",
				"#123456"
			)}</g></svg>`
		);
	});

	test("omits a tile radius when the caller requests square corners", () => {
		expect(iconTileSvg({ radius: 0 })).not.toContain(" rx=");
	});

	test("uses the canonical stroke and dimensions for a centered icon by default", () => {
		expect(centeredIconSvg()).toContain(
			'<svg width="20" height="20" viewBox="0 0 256 256" fill="none" color="#2b2b2b"'
		);
		expect(centeredIconSvg()).toContain(
			'fill="currentColor" stroke="currentColor"'
		);
	});
});
