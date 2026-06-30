// Rasterizes the Composery icon into the editor and website PNG/ICO assets.
// Vector source: packages/shared/index.ts.
import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";
import sharp from "sharp";
import { BRAND_COLORS, iconSvg, iconTileSvg } from "../index.ts";

export async function generateIcons({
	root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
} = {}) {
	const ideMedia = join(
		root,
		"packages",
		"ide",
		"overlay",
		"src",
		"browser",
		"media"
	);
	const webApp = join(root, "packages", "web", "app");

	const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();
	const write = (path, buf) => writeFile(path, buf);
	const ico = (sizes) =>
		Promise.all(sizes.map((s) => png(iconSvg({ height: s, width: s })))).then(
			pngToIco
		);

	// Scales preserve the icon padding now that the shared icon fills its box flush
	// (see ICON_FIT in index.mjs): old effective fill was scale * 17.617/20.

	// Editor overlay: installable PWA icons on a solid tile (maskable variant unpadded
	// so the OS mask has room), plus a bare-icon favicon.
	const standard = { radius: 46, scale: 0.687 };
	const maskable = { radius: 0, scale: 0.546 };
	await write(
		join(ideMedia, "pwa-icon-192.png"),
		await png(
			iconTileSvg({
				...standard,
				background: BRAND_COLORS.surface.tile,
				size: 192
			})
		)
	);
	await write(
		join(ideMedia, "pwa-icon-512.png"),
		await png(
			iconTileSvg({
				...standard,
				background: BRAND_COLORS.surface.tile,
				size: 512
			})
		)
	);
	await write(
		join(ideMedia, "pwa-icon-maskable-192.png"),
		await png(
			iconTileSvg({
				...maskable,
				background: BRAND_COLORS.surface.tile,
				size: 192
			})
		)
	);
	await write(
		join(ideMedia, "pwa-icon-maskable-512.png"),
		await png(
			iconTileSvg({
				...maskable,
				background: BRAND_COLORS.surface.tile,
				size: 512
			})
		)
	);
	await write(join(ideMedia, "favicon.ico"), await ico([16, 32, 48]));

	// Web: apple-icon is a full-bleed tile (iOS rounds the corners itself); favicon.ico
	// is the bare icon at the classic legacy sizes.
	await write(
		join(webApp, "apple-icon.png"),
		await png(
			iconTileSvg({
				background: BRAND_COLORS.surface.tile,
				size: 180,
				scale: 0.7
			})
		)
	);
	await write(join(webApp, "favicon.ico"), await ico([16, 32, 48]));

	console.log("Wrote raster icons for the editor overlay and website.");
}

// Stryker disable next-line all: package scripts exercise this CLI dispatch; behavior tests call the generator directly so they can assert its outputs.
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
	await generateIcons();
