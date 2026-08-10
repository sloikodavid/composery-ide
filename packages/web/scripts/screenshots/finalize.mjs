/** Build the iPhone trios and publish the framed marketing PNGs. */
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const destination = join(here, "..", "..", "public", "marketing");
const finalAssets = {
	ide: "composery-ide",
	welcome: "composery-welcome",
	editor: "composery-editor",
	mobile: "composery-mobile"
};

async function trio(scheme) {
	const names = ["mobile-welcome", "mobile-editor", "mobile-terminal"];
	const paths = names.map((name) => join(out, scheme, `${name}.png`));
	const [{ width, height }] = await Promise.all(
		paths.map(async (path) => sharp(path).metadata())
	);
	const step = width - Math.floor(width * 0.16);
	const composite = [0, 2, 1].map((index) => ({
		input: paths[index],
		left: step * [0, 2, 1][index],
		top: 0
	}));
	const target = join(out, scheme, "mobile.png");
	const composed = await sharp({
		create: {
			width: step * 2 + width,
			height,
			channels: 4,
			background: { r: 0, g: 0, b: 0, alpha: 0 }
		}
	})
		.composite(composite)
		.png()
		.toBuffer();
	await sharp(composed).resize({ width: 2000 }).png().toFile(target);
	return target;
}

await mkdir(destination, { recursive: true });
for (const name of await readdir(destination)) {
	if (name.startsWith("composery-") && name.endsWith(".png"))
		await rm(join(destination, name));
}
for (const scheme of ["dark", "light"]) {
	await trio(scheme);
	for (const [source, base] of Object.entries(finalAssets)) {
		await copyFile(
			join(out, scheme, `${source}.png`),
			join(destination, `${base}-${scheme}.png`)
		);
	}
}
