/**
 * Frame raw Composery captures in Apple device artwork.
 *
 * Chromium draws the chrome (real SF Pro and SF Symbols from the OTFs fonts.sh
 * fetches) and sharp does every resample, because canvas `drawImage` downscales
 * bilinearly and turns captured UI text to mush. Source art is pre-resized to
 * exactly the size the page composites it at, so each pixel takes one Lanczos
 * pass and no more.
 *
 * Corners are CIRCULAR everywhere: superellipse fits against Apple's own
 * renders (iPhone 17 Pro, Safari window, MacBook display corner) all land on
 * exponent 2.0. `roundRect` draws true arcs - a quadratic Bezier corner reads
 * ~15% tight and a squircle reads as a brick.
 */
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const raw = join(here, "raw");
const out = join(here, "out");

// Shared by both planes: Node sizes the source art from these, the page lays
// the chrome out in the same points, so the two never drift.
const layout = {
	scale: { macbook: 2, iphone: 3 },
	screen: { width: 1512, height: 982 }, // 14" MacBook Pro display, pt
	contentWidth: 1248, // Safari content column, pt
	final: { macbook: 2600, iphone: 780 }
};

const desktopShots = ["ide", "welcome", "editor"];
const mobileShots = ["mobile-welcome", "mobile-editor", "mobile-terminal"];

const contentPx = Math.round(layout.contentWidth * layout.scale.macbook);
const screenPx = {
	width: Math.round(layout.screen.width * layout.scale.macbook),
	height: Math.round(layout.screen.height * layout.scale.macbook)
};

const fonts = {
	regular: join(here, "fonts", "SF-Pro-Text-Regular.otf"),
	semibold: join(here, "fonts", "SF-Pro-Text-Semibold.otf"),
	symbols: join(here, "fonts", "SF-Symbols.otf")
};

const symbols = {
	wifi: 0x100647,
	"battery.100": 0x1006e8,
	cellularbars: 0x100b67,
	"chevron.left": 0x100189,
	"chevron.right": 0x10018a,
	plus: 0x10017c,
	"square.and.arrow.up": 0x100203,
	"square.on.square": 0x1003e7,
	"sidebar.left": 0x1003da,
	"lock.fill": 0x1003a1,
	"chevron.down": 0x100188,
	"arrow.clockwise": 0x10037f,
	"shield.fill": 0x100667,
	magnifyingglass: 0x1002ab,
	"switch.2": 0x10070a,
	shift: 0x10019d,
	"delete.left": 0x10019b,
	return: 0x100147,
	mic: 0x1002b0
};

// The Apple menu logo is regular Unicode PUA in every Apple text font.
const appleLogo = 0xf8ff;

/**
 * Crop the square Apple wallpaper to the display aspect the way macOS fills
 * the screen.
 *
 * `ignoreIcc` is load-bearing. Apple ships these tagged Display P3 and the
 * marketing PNGs are untagged sRGB, so converting clips the out-of-gamut cyans
 * onto the sRGB boundary: the desktop turns electric and the gradient flattens.
 * Reading the numbers as sRGB is what the published shots have always done.
 */
async function wallpaper(scheme) {
	const path = join(here, "wallpapers", `tahoe-${scheme}.png`);
	const { width, height } = await sharp(path).metadata();
	const cropHeight = Math.round((width * screenPx.height) / screenPx.width);
	return sharp(path, { ignoreIcc: true })
		.extract({
			left: 0,
			top: Math.floor((height - cropHeight) / 2),
			width,
			height: cropHeight
		})
		.resize(screenPx.width, screenPx.height, { kernel: "lanczos3" })
		.png()
		.toBuffer();
}

/** Desktop captures land in a 1248 pt window; phone captures are already 1:1. */
async function capture(scheme, name) {
	const path = join(raw, scheme, `${name}.png`);
	if (!desktopShots.includes(name)) return readFileSync(path);
	return sharp(path)
		.resize({ width: contentPx, kernel: "lanczos3", withoutEnlargement: true })
		.png()
		.toBuffer();
}

const staticFiles = new Map([
	[
		"/fonts/SF-Pro-Text-Regular.otf",
		{ body: readFileSync(fonts.regular), contentType: "font/otf" }
	],
	[
		"/fonts/SF-Pro-Text-Semibold.otf",
		{ body: readFileSync(fonts.semibold), contentType: "font/otf" }
	],
	[
		"/fonts/SF-Symbols.otf",
		{ body: readFileSync(fonts.symbols), contentType: "font/otf" }
	]
]);
for (const scheme of ["dark", "light"]) {
	staticFiles.set(`/wallpapers/tahoe-${scheme}.png`, {
		body: await wallpaper(scheme),
		contentType: "image/png"
	});
	for (const name of [...desktopShots, ...mobileShots]) {
		staticFiles.set(`/raw/${scheme}/${name}.png`, {
			body: await capture(scheme, name),
			contentType: "image/png"
		});
	}
}

const server = createServer((request, response) => {
	const file = staticFiles.get(
		new URL(request.url, "http://localhost").pathname
	);
	if (!file) {
		response.writeHead(404).end();
		return;
	}
	response
		.writeHead(200, {
			"Content-Type": file.contentType,
			"Cache-Control": "no-store"
		})
		.end(file.body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true });
try {
	// Big enough for the largest composite in both axes - the lid is the widest
	// (~3320) and a phone with the keyboard the tallest (~3020). `clip` silently
	// crops to the viewport, so the render is checked against it below.
	const viewport = { width: 3900, height: 3900 };
	const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
	await page.goto(origin);
	await page.setContent(
		"<style>html,body{margin:0;background:transparent}</style><main></main>"
	);
	await page.evaluate(
		async ({ symbols, appleLogo, layout }) => {
			const faces = [
				new FontFace(
					"Composery SF Pro",
					'url("/fonts/SF-Pro-Text-Regular.otf")',
					{ weight: "400" }
				),
				new FontFace(
					"Composery SF Pro",
					'url("/fonts/SF-Pro-Text-Semibold.otf")',
					{ weight: "600" }
				),
				new FontFace("Composery SF Symbols", 'url("/fonts/SF-Symbols.otf")')
			];
			await Promise.all(
				faces.map(async (face) => document.fonts.add(await face.load()))
			);

			// 14" MacBook Pro, in points (@2x, 254 ppi). Display and notch geometry
			// measured off Apple's straight-on macOS Tahoe render.
			//
			//   display        1512x982 pt, top corners r 20.5 pt, bottom square
			//   menu bar band  37 pt - the area beside the notch
			//   notch          208x37 pt, bottom corners r 9 pt
			//   bezel          3.5 mm = 17.5 pt, Apple's own keynote figure
			//   chin           60 pt
			//   lid corner     concentric with the display: 20.5 + 17.5 = 38 pt
			const MBP_W = layout.screen.width;
			const MBP_H = layout.screen.height;
			const MENU = 37;
			const MBP_DISPLAY_R = 20.5;
			const MBP_BEZEL = 17.5;
			const MBP_CHIN = 60;
			const LID_R = MBP_DISPLAY_R + MBP_BEZEL;
			const NOTCH_W = 208;
			const NOTCH_R = 9;
			// macOS window corner, measured off Apple's own Safari screenshot using
			// the traffic lights (12 pt each) as the ruler: circular, r = 22.5 pt.
			const WINDOW_R = 22;
			// iPhone 17 Pro glass front, in points (@3x): the display and its black
			// bezel, no aluminium shell. Apple's full body border is 16 pt but only
			// 1.44 mm of it is bezel; drawing the rail made it a phone-shaped brick.
			const DISPLAY_R = 62;
			const BEZEL = 8.7;
			const BODY_R = DISPLAY_R + BEZEL;
			const KB_H = 339;

			// Drop shadows, tuned per object because they are not the same object.
			// Both frames end as a hard black border on the page, so both want a
			// grounding shadow rather than a halo.
			const SHADOW = true;
			const MACBOOK_SHADOW = { pad: 56, blur: 30, dy: 12, alpha: 48 };
			const PHONE_SHADOW = { pad: 52, blur: 22, dy: 12, alpha: 55 };
			// The Safari window floats on the wallpaper with macOS's own big soft
			// window shadow - baked into the screen, not the page shadow round the lid.
			const DESKTOP_WINDOW = { blur: 26, dy: 10, alpha: 105 };

			const lights = [
				[255, 95, 87],
				[254, 188, 46],
				[40, 200, 64]
			];
			const lightRings = [
				[224, 70, 62],
				[222, 160, 25],
				[26, 170, 45]
			];
			// Safari 26 (macOS Tahoe, "Liquid Glass"): translucent toolbar with
			// floating rounded capsules. Sampled from Apple's own screenshots.
			const safari = {
				light: {
					bar: [242, 242, 245],
					sep: [0, 0, 0, 18],
					cap: [255, 255, 255],
					capEdge: [0, 0, 0, 20],
					text: [29, 29, 31],
					icon: [44, 44, 48],
					iconDim: [178, 178, 184],
					border: [0, 0, 0, 45]
				},
				dark: {
					bar: [35, 36, 40],
					sep: [255, 255, 255, 16],
					cap: [54, 56, 62],
					capEdge: [255, 255, 255, 22],
					text: [232, 232, 236],
					icon: [226, 226, 231],
					iconDim: [110, 112, 119],
					border: [255, 255, 255, 30]
				}
			};
			// Light colours are direct samples from Apple's iOS 26 shot. Apple
			// publishes no dark keyboard reference, so dark uses the matching iOS
			// semantic materials with the same measured geometry.
			const keyboardMaterials = {
				light: {
					bg: [227, 228, 232],
					key: [255, 255, 255],
					ink: [0, 0, 0],
					rim: [255, 255, 255, 150],
					shadow: [0, 0, 0, 28]
				},
				dark: {
					bg: [31, 31, 33],
					key: [104, 104, 108],
					ink: [255, 255, 255],
					rim: [255, 255, 255, 22],
					shadow: [0, 0, 0, 90]
				}
			};

			const imageCache = new Map();
			const color = ([red, green, blue, alpha = 255]) =>
				`rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
			const glyph = (name) => String.fromCodePoint(symbols[name]);
			const apple = String.fromCodePoint(appleLogo);
			const canvas = (width, height) =>
				Object.assign(document.createElement("canvas"), {
					width: Math.round(width),
					height: Math.round(height)
				});
			const font = (size, weight = 400) =>
				`${weight} ${size}px "Composery SF Pro"`;
			const symbolFont = (size) => `${size}px "Composery SF Symbols"`;

			async function image(url) {
				if (!imageCache.has(url)) {
					imageCache.set(
						url,
						new Promise((resolve, reject) => {
							const value = new Image();
							value.addEventListener("load", () => resolve(value), {
								once: true
							});
							value.addEventListener(
								"error",
								() => reject(new Error(`Cannot load ${url}`)),
								{ once: true }
							);
							value.src = url;
						})
					);
				}
				return imageCache.get(url);
			}

			function roundedPath(
				context,
				x,
				y,
				width,
				height,
				radius,
				corners = [true, true, true, true]
			) {
				context.beginPath();
				context.roundRect(
					x,
					y,
					width,
					height,
					corners.map((enabled) => (enabled ? radius : 0))
				);
			}

			function fillRounded(
				context,
				x,
				y,
				width,
				height,
				radius,
				fill,
				corners
			) {
				roundedPath(context, x, y, width, height, radius, corners);
				context.fillStyle = color(fill);
				context.fill();
			}

			function strokeRounded(
				context,
				x,
				y,
				width,
				height,
				radius,
				stroke,
				lineWidth,
				corners
			) {
				roundedPath(context, x, y, width, height, radius, corners);
				context.strokeStyle = color(stroke);
				context.lineWidth = lineWidth;
				context.stroke();
			}

			function clipRounded(context, x, y, width, height, radius, corners) {
				roundedPath(context, x, y, width, height, radius, corners);
				context.clip();
			}

			function text(context, value, x, y, typeface, fill, align = "center") {
				context.font = typeface;
				context.textAlign = align;
				context.textBaseline = "middle";
				context.fillStyle = color(fill);
				context.fillText(value, x, y);
			}

			function textWidth(context, value, typeface) {
				context.font = typeface;
				return context.measureText(value).width;
			}

			function symbol(context, name, x, y, size, fill, align = "center") {
				text(context, glyph(name), x, y, symbolFont(size), fill, align);
			}

			function shadow(source, scale, config, radius) {
				const pad = Math.round(config.pad * scale);
				const blur = Math.round(config.blur * scale);
				const dy = Math.round(config.dy * scale);
				const target = canvas(
					source.width + pad * 2,
					source.height + pad * 2 + dy
				);
				const context = target.getContext("2d");
				if (SHADOW) {
					context.save();
					context.filter = `blur(${blur}px)`;
					fillRounded(
						context,
						pad,
						pad + dy,
						source.width,
						source.height,
						radius,
						[0, 0, 0, config.alpha]
					);
					context.restore();
				}
				context.drawImage(source, pad, pad);
				return target;
			}

			/**
			 * A faint top-lit rim on the frame's outer edge, dark UI only. The dark
			 * shots sit on near-black pages where a black bezel has no silhouette and
			 * a drop shadow does nothing - the same reason Apple's own dark-background
			 * renders carry an edge highlight. Light shots let the shadow separate.
			 */
			function addRim(source, radius, scale, dark) {
				if (!dark) return source;
				const target = canvas(source.width, source.height);
				const context = target.getContext("2d");
				context.drawImage(source, 0, 0);
				const width = Math.max(1, Math.round(0.8 * scale));
				const rim = canvas(source.width, source.height);
				const rimContext = rim.getContext("2d");
				const gradient = rimContext.createLinearGradient(
					0,
					0,
					0,
					source.height
				);
				gradient.addColorStop(0, "rgba(255,255,255,0.251)");
				gradient.addColorStop(1, "rgba(255,255,255,0.071)");
				rimContext.fillStyle = gradient;
				rimContext.fillRect(0, 0, source.width, source.height);
				rimContext.globalCompositeOperation = "destination-in";
				fillRounded(
					rimContext,
					0,
					0,
					source.width,
					source.height,
					radius,
					[0, 0, 0, 255]
				);
				rimContext.globalCompositeOperation = "destination-out";
				fillRounded(
					rimContext,
					width,
					width,
					source.width - width * 2,
					source.height - width * 2,
					Math.max(0, radius - width),
					[0, 0, 0, 255]
				);
				context.drawImage(rim, 0, 0);
				return target;
			}

			/** A macOS Tahoe Safari 26 window, rebuilt against Apple's screenshots. */
			async function safariWindow(name, scheme, scale) {
				const materials = safari[scheme];
				// Already sized to the content column by sharp.
				const source = await image(`raw/${scheme}/${name}.png`);
				const bar = 56 * scale;
				const win = canvas(source.width, source.height + bar);
				const context = win.getContext("2d");
				context.fillStyle = color([...materials.bar, 255]);
				context.fillRect(0, 0, win.width, win.height);
				context.drawImage(source, 0, bar);

				const chrome = canvas(win.width, win.height);
				const draw = chrome.getContext("2d");
				draw.strokeStyle = color(materials.sep);
				draw.lineWidth = Math.max(1, scale);
				draw.beginPath();
				draw.moveTo(0, bar - 1);
				draw.lineTo(win.width, bar - 1);
				draw.stroke();
				const cy = bar / 2;
				const capsuleHeight = 32 * scale;
				const iconSize = Math.round(17 * scale);
				const capsule = (x0, x1) => {
					fillRounded(
						draw,
						x0,
						cy - capsuleHeight / 2,
						x1 - x0,
						capsuleHeight,
						capsuleHeight / 2,
						[...materials.cap, 255]
					);
					strokeRounded(
						draw,
						x0,
						cy - capsuleHeight / 2,
						x1 - x0,
						capsuleHeight,
						capsuleHeight / 2,
						materials.capEdge,
						Math.max(1, scale)
					);
				};

				let x = 20 * scale;
				const lightRadius = 6 * scale;
				for (let index = 0; index < lights.length; index += 1) {
					draw.beginPath();
					draw.arc(x, cy, lightRadius, 0, Math.PI * 2);
					draw.fillStyle = color([...lights[index], 255]);
					draw.fill();
					draw.strokeStyle = color([...lightRings[index], 255]);
					draw.lineWidth = Math.max(1, Math.floor(scale / 2));
					draw.stroke();
					x += 20 * scale;
				}

				// sidebar capsule: sidebar.left + chevron.down
				capsule(86 * scale, 136 * scale);
				symbol(draw, "sidebar.left", 103 * scale, cy, iconSize, materials.icon);
				symbol(
					draw,
					"chevron.down",
					123 * scale,
					cy,
					10 * scale,
					materials.icon
				);

				// back / forward capsule, with a divider
				capsule(146 * scale, 208 * scale);
				symbol(
					draw,
					"chevron.left",
					165 * scale,
					cy,
					15 * scale,
					materials.icon
				);
				draw.strokeStyle = color(materials.capEdge);
				draw.lineWidth = Math.max(1, scale);
				draw.beginPath();
				draw.moveTo(177 * scale, cy - 8 * scale);
				draw.lineTo(177 * scale, cy + 8 * scale);
				draw.stroke();
				symbol(
					draw,
					"chevron.right",
					190 * scale,
					cy,
					15 * scale,
					materials.iconDim
				);

				// privacy shield (circular glass button)
				const shieldCenter = 230 * scale;
				draw.beginPath();
				draw.arc(shieldCenter, cy, capsuleHeight / 2, 0, Math.PI * 2);
				draw.fillStyle = color([...materials.cap, 255]);
				draw.fill();
				draw.strokeStyle = color(materials.capEdge);
				draw.lineWidth = Math.max(1, scale);
				draw.stroke();
				symbol(
					draw,
					"shield.fill",
					shieldCenter,
					cy,
					15 * scale,
					materials.icon
				);

				// address pill: domain centred, reload inside on the right
				const addressWidth = Math.floor(win.width * 0.42);
				const addressHeight = 34 * scale;
				const addressX = Math.floor((win.width - addressWidth) / 2);
				fillRounded(
					draw,
					addressX,
					cy - addressHeight / 2,
					addressWidth,
					addressHeight,
					addressHeight / 2,
					[...materials.cap, 255]
				);
				strokeRounded(
					draw,
					addressX,
					cy - addressHeight / 2,
					addressWidth,
					addressHeight,
					addressHeight / 2,
					materials.capEdge,
					Math.max(1, scale)
				);
				text(
					draw,
					"my-box.composery.cloud",
					win.width / 2,
					cy - 1,
					font(15 * scale),
					[...materials.text, 255]
				);
				symbol(
					draw,
					"arrow.clockwise",
					addressX + addressWidth - 14 * scale,
					cy,
					14 * scale,
					materials.iconDim,
					"right"
				);

				// right capsule: share, new tab, tab overview
				const rightStart = win.width - 140 * scale;
				capsule(rightStart, win.width - 20 * scale);
				symbol(
					draw,
					"square.and.arrow.up",
					rightStart + 22 * scale,
					cy - scale,
					iconSize,
					materials.icon
				);
				symbol(
					draw,
					"plus",
					rightStart + 60 * scale,
					cy,
					18 * scale,
					materials.icon
				);
				symbol(
					draw,
					"square.on.square",
					rightStart + 98 * scale,
					cy,
					iconSize,
					materials.icon
				);

				context.drawImage(chrome, 0, 0);

				// Blend the hairline edge in, then round the window off.
				const radius = Math.round(WINDOW_R * scale);
				const ringWidth = Math.max(1, scale);
				const border = canvas(win.width, win.height);
				const borderContext = border.getContext("2d");
				fillRounded(
					borderContext,
					0,
					0,
					win.width,
					win.height,
					radius,
					materials.border
				);
				borderContext.globalCompositeOperation = "destination-out";
				fillRounded(
					borderContext,
					ringWidth,
					ringWidth,
					win.width - ringWidth * 2,
					win.height - ringWidth * 2,
					radius - ringWidth,
					[0, 0, 0, 255]
				);
				context.drawImage(border, 0, 0);

				const clipped = canvas(win.width, win.height);
				const clippedContext = clipped.getContext("2d");
				clippedContext.save();
				clipRounded(clippedContext, 0, 0, win.width, win.height, radius);
				clippedContext.drawImage(win, 0, 0);
				clippedContext.restore();
				return { image: clipped, radius };
			}

			/**
			 * The Tahoe menu bar: no background at all, white SF Pro text and real SF
			 * Symbols straight on the wallpaper, with the soft legibility shadow macOS
			 * puts under them. Gaps measured off Apple's Control Center shot.
			 */
			function menuBar(scale) {
				const width = Math.round(MBP_W * scale);
				const height = Math.round(MENU * scale);
				const glyphs = canvas(width, height);
				const draw = glyphs.getContext("2d");
				const cy = height / 2;
				const white = [255, 255, 255, 242];
				const regular = font(13 * scale);
				const semibold = font(13 * scale, 600);
				const appleFont = font(14 * scale);
				let x = 16 * scale;
				text(draw, apple, x, cy, appleFont, white, "left");
				x += textWidth(draw, apple, appleFont) + 21 * scale;
				for (const [index, item] of [
					"Safari",
					"File",
					"Edit",
					"View",
					"History",
					"Bookmarks",
					"Window",
					"Help"
				].entries()) {
					const typeface = index === 0 ? semibold : regular;
					text(draw, item, x, cy, typeface, white, "left");
					x += textWidth(draw, item, typeface) + 21 * scale;
				}

				// Status items, right-to-left: clock, Control Center, Spotlight,
				// Wi-Fi, battery - the stock Tahoe set, in Apple's own order.
				x = width - 16 * scale;
				const clock = "Tue Jul 14  9:41 AM";
				text(draw, clock, x, cy, regular, white, "right");
				x -= textWidth(draw, clock, regular) + 22 * scale;
				for (const [name, size] of [
					["switch.2", 16],
					["magnifyingglass", 15],
					["wifi", 16],
					["battery.100", 21]
				]) {
					const typeface = symbolFont(size * scale);
					text(draw, glyph(name), x, cy, typeface, white, "right");
					x -= textWidth(draw, glyph(name), typeface) + 22 * scale;
				}

				const target = canvas(width, height);
				const context = target.getContext("2d");
				context.save();
				context.globalAlpha = 90 / 255;
				context.filter = `blur(${1.5 * scale}px)`;
				context.drawImage(glyphs, 0, 0.5 * scale);
				context.restore();
				context.drawImage(glyphs, 0, 0);
				return target;
			}

			/** The full 14" MacBook Pro glass front around a Tahoe desktop. */
			async function macbook(name, scheme) {
				const scale = layout.scale.macbook;
				const screenWidth = Math.round(MBP_W * scale);
				const screenHeight = Math.round(MBP_H * scale);
				// Already cropped and resized to the display by sharp.
				const screen = canvas(screenWidth, screenHeight);
				const context = screen.getContext("2d");
				context.drawImage(await image(`wallpapers/tahoe-${scheme}.png`), 0, 0);

				const win = await safariWindow(name, scheme, scale);
				const windowX = Math.floor((screenWidth - win.image.width) / 2);
				const windowY =
					Math.round(MENU * scale) +
					Math.floor(
						(screenHeight - Math.round(MENU * scale) - win.image.height) / 2
					);
				context.save();
				context.filter = `blur(${DESKTOP_WINDOW.blur * scale}px)`;
				fillRounded(
					context,
					windowX,
					windowY + DESKTOP_WINDOW.dy * scale,
					win.image.width,
					win.image.height,
					win.radius,
					[0, 0, 0, DESKTOP_WINDOW.alpha]
				);
				context.restore();
				context.drawImage(win.image, windowX, windowY);
				context.drawImage(menuBar(scale), 0, 0);

				// The notch: square into the bezel on top, 9 pt rounded corners into
				// the menu bar band, camera as a barely-there darker disc.
				const notchWidth = Math.round(NOTCH_W * scale);
				const notchX = Math.floor((screenWidth - notchWidth) / 2);
				fillRounded(
					context,
					notchX,
					0,
					notchWidth,
					Math.round(MENU * scale),
					NOTCH_R * scale,
					[10, 10, 12, 255],
					[false, false, true, true]
				);
				context.beginPath();
				context.arc(screenWidth / 2, 18.5 * scale, 4.5 * scale, 0, Math.PI * 2);
				context.fillStyle = color([17, 17, 20, 255]);
				context.fill();

				// Display corners: round on top, square at the bottom.
				const displayRadius = Math.round(MBP_DISPLAY_R * scale);
				const display = canvas(screenWidth, screenHeight);
				const displayContext = display.getContext("2d");
				displayContext.save();
				clipRounded(
					displayContext,
					0,
					0,
					screenWidth,
					screenHeight,
					displayRadius,
					[true, true, false, false]
				);
				displayContext.drawImage(screen, 0, 0);
				displayContext.restore();

				// The lid: one black glass border, thin around the display, tall at
				// the chin, nothing else - same treatment as the iPhone.
				const bezel = Math.round(MBP_BEZEL * scale);
				const chin = Math.round(MBP_CHIN * scale);
				const lidRadius = Math.round(LID_R * scale);
				const lid = canvas(
					screenWidth + bezel * 2,
					screenHeight + bezel + chin
				);
				const lidContext = lid.getContext("2d");
				fillRounded(
					lidContext,
					0,
					0,
					lid.width,
					lid.height,
					lidRadius,
					[10, 10, 12, 255]
				);
				lidContext.save();
				clipRounded(lidContext, 0, 0, lid.width, lid.height, lidRadius);
				lidContext.drawImage(display, bezel, bezel);
				lidContext.restore();
				return shadow(
					addRim(lid, lidRadius, scale, scheme === "dark"),
					scale,
					MACBOOK_SHADOW,
					lidRadius
				);
			}

			/** iOS status bar: SF Pro Text time + real SF Symbols glyphs. */
			function statusBar(width, scale, textColor) {
				const target = canvas(width, Math.round(62 * scale));
				const context = target.getContext("2d");
				const cy = Math.round(30 * scale);
				const ink = [...textColor, 255];
				text(context, "9:41", 68 * scale, cy, font(17 * scale, 600), ink);
				// Right cluster, laid out right-to-left, advancing by each glyph's
				// measured width so they never collide.
				let x = width - 30 * scale;
				for (const [name, size] of [
					["battery.100", 17],
					["wifi", 16],
					["cellularbars", 16]
				]) {
					const typeface = symbolFont(size * scale);
					text(context, glyph(name), x, cy, typeface, ink, "right");
					x -= textWidth(context, glyph(name), typeface) + 5 * scale;
				}
				return target;
			}

			/** The keyboard's grinning emoji face (UIKit artwork, not an SF Symbol). */
			function smiley(context, centerX, centerY, scale, ink) {
				context.beginPath();
				context.arc(centerX, centerY, 11.1 * scale, 0, Math.PI * 2);
				context.strokeStyle = color(ink);
				context.lineWidth = Math.round(2.2 * scale);
				context.stroke();
				for (const dx of [-4.3, 4.3]) {
					context.beginPath();
					context.arc(
						centerX + dx * scale,
						centerY - 3.4 * scale,
						1.7 * scale,
						0,
						Math.PI * 2
					);
					context.fillStyle = color(ink);
					context.fill();
				}
				// open smile: dark mouth, white teeth band across its top
				context.beginPath();
				context.ellipse(
					centerX,
					centerY + 4.5 * scale,
					6.4 * scale,
					4.1 * scale,
					0,
					0,
					Math.PI,
					false
				);
				context.fillStyle = color(ink);
				context.fill();
				context.beginPath();
				context.ellipse(
					centerX,
					centerY + 2.7 * scale,
					4.6 * scale,
					2.25 * scale,
					0,
					0,
					Math.PI,
					false
				);
				context.fillStyle = "white";
				context.fill();
				context.beginPath();
				context.ellipse(
					centerX,
					centerY + 4.9 * scale,
					4.6 * scale,
					1.85 * scale,
					0,
					0,
					Math.PI,
					false
				);
				context.fillStyle = color(ink);
				context.fill();
			}

			/**
			 * The current public iOS 26 keyboard, cross-checked against Apple's iOS 26
			 * UI kit and measured from Apple's full-resolution iPhone 17 Pro press shot
			 * at the phone's native 3x scale:
			 *
			 *   panel        339 pt tall, edge-to-edge, 26 pt rounded top corners
			 *   strip        50 pt QuickType area; empty because xterm's helper
			 *                textarea sets autocorrect, autocapitalize and spellcheck
			 *                off - so the terminal correctly shows lowercase keys and
			 *                no suggestions
			 *   letter keys  33x45 pt, corner r 7.5, 6 pt gaps, 9 pt outside margins;
			 *                rows start at y 50 / 106 / 162 / 218
			 *   modifiers    shift + backspace 45 pt; 123 / space / return are
			 *                91 / 190 / 91 pt - the space bar is unlabeled in iOS 26
			 *   below panel  emoji + mic glyphs centred at x 42 / 360 and y 296
			 */
			async function keyboard(scale, scheme) {
				const materials = keyboardMaterials[scheme];
				// Drawn at 2x and resampled down. Not for the corners - canvas
				// antialiases those - but so every key edge and legend lands on a
				// whole pixel of the grid before the resample; laying them out on
				// fractional pixels at 1x is measurably softer.
				const S = scale * 2;
				const image = canvas(402 * S, KB_H * S);
				const context = image.getContext("2d");
				const panelRadius = Math.round(26 * S);

				// Panel: rounded top corners, bottom bleeds off the canvas, a bright
				// hairline along the top edge (the Liquid Glass rim).
				fillRounded(
					context,
					0,
					0,
					image.width,
					image.height + panelRadius,
					panelRadius,
					[...materials.bg, 255]
				);
				context.save();
				clipRounded(
					context,
					0,
					0,
					image.width,
					image.height + panelRadius,
					panelRadius
				);
				const rimGradient = context.createLinearGradient(0, 0, 0, image.height);
				rimGradient.addColorStop(0, color(materials.rim));
				rimGradient.addColorStop(1, "rgba(255,255,255,0)");
				context.strokeStyle = rimGradient;
				context.lineWidth = Math.max(1, Math.floor(S / 2));
				roundedPath(
					context,
					0,
					0,
					image.width,
					image.height + panelRadius,
					panelRadius
				);
				context.stroke();
				context.restore();

				const key = (x, y, width, height = 45) => {
					// UIKit's key shadow is a crisp one-point grounding edge, not a soft
					// drop shadow.
					fillRounded(
						context,
						Math.round(x * S),
						Math.round((y + 1) * S),
						Math.round(width * S),
						Math.round(height * S),
						Math.round(7.5 * S),
						materials.shadow
					);
					fillRounded(
						context,
						Math.round(x * S),
						Math.round(y * S),
						Math.round(width * S),
						Math.round(height * S),
						Math.round(7.5 * S),
						[...materials.key, 255]
					);
					return [(x + width / 2) * S, (y + height / 2) * S];
				};
				const ink = [...materials.ink, 255];
				const rows = [50, 106, 162, 218];
				const letterFont = font(23.5 * S);
				for (const [index, character] of [..."qwertyuiop"].entries())
					text(
						context,
						character,
						...key(9 + index * 39, rows[0], 33),
						letterFont,
						ink
					);
				for (const [index, character] of [..."asdfghjkl"].entries())
					text(
						context,
						character,
						...key(28.5 + index * 39, rows[1], 33),
						letterFont,
						ink
					);
				for (const [index, character] of [..."zxcvbnm"].entries())
					text(
						context,
						character,
						...key(67.5 + index * 39, rows[2], 33),
						letterFont,
						ink
					);

				const keySymbol = (name, position, size) =>
					symbol(context, name, ...position, size * S, ink);
				keySymbol("shift", key(9, rows[2], 45), 25);
				keySymbol("delete.left", key(348, rows[2], 45), 25);
				text(context, "123", ...key(9, rows[3], 91), font(18 * S), ink);
				key(106, rows[3], 190); // space: unlabeled in iOS 26
				keySymbol("return", key(302, rows[3], 91), 25);

				// Below the panel: emoji + mic, no keys.
				smiley(context, 42 * S, 296 * S, S, ink);
				symbol(context, "mic", 360 * S, 296 * S, 27 * S, ink);

				// createImageBitmap's "high" resampler, not drawImage's bilinear.
				return createImageBitmap(image, {
					resizeWidth: Math.round(402 * scale),
					resizeHeight: Math.round(KB_H * scale),
					resizeQuality: "high"
				});
			}

			async function iphone(name, scheme) {
				const scale = layout.scale.iphone;
				const source = await image(`raw/${scheme}/${name}.png`);
				const dark = scheme === "dark";
				const textColor = dark ? [255, 255, 255] : [22, 22, 24];

				// The status bar and home indicator sit over the app, not beside it:
				// an edge-to-edge iPhone app owns the full display and its background
				// runs behind both. So those strips take the capture's own edge row -
				// its median, which is the exact colour on a uniform row and ignores
				// the stray content pixels the welcome screen has on its last one.
				const edgeColor = (edge) => {
					const strip = canvas(source.width, 1);
					const stripContext = strip.getContext("2d", {
						willReadFrequently: true
					});
					stripContext.drawImage(
						source,
						0,
						edge === "top" ? 0 : source.height - 1,
						source.width,
						1,
						0,
						0,
						source.width,
						1
					);
					const { data } = stripContext.getImageData(0, 0, source.width, 1);
					const channel = (offset) => {
						const values = [];
						for (let i = offset; i < data.length; i += 4) values.push(data[i]);
						return values.sort((a, b) => a - b)[values.length >> 1];
					};
					return [channel(0), channel(1), channel(2), 255];
				};

				// The terminal shot is captured at the keyboard-open viewport (473 pt)
				// and gets the measured iOS 26 keyboard composited below it, exactly
				// where iOS puts it. The others keep the 34 pt bottom safe area.
				const statusHeight = Math.round(62 * scale);
				const keys =
					name === "mobile-terminal" ? await keyboard(scale, scheme) : null;
				const screen = canvas(
					source.width,
					statusHeight +
						source.height +
						(keys ? keys.height : Math.round(34 * scale))
				);
				const context = screen.getContext("2d");
				context.fillStyle = color(edgeColor("top"));
				context.fillRect(0, 0, screen.width, statusHeight);
				context.drawImage(source, 0, statusHeight);
				const belowApp = statusHeight + source.height;
				// The app's background runs behind the keyboard as well, so its rounded
				// top corners reveal the app, not a transparent notch. Fill the strip
				// below the capture with its bottom edge whether or not keys sit on it.
				context.fillStyle = color(edgeColor("bottom"));
				context.fillRect(0, belowApp, screen.width, screen.height - belowApp);
				if (keys) context.drawImage(keys, 0, belowApp);
				context.drawImage(statusBar(screen.width, scale, textColor), 0, 0);

				const islandWidth = Math.round(125 * scale);
				const islandHeight = Math.round(37.33 * scale);
				const islandX = Math.floor((screen.width - islandWidth) / 2);
				const islandY = Math.round(11 * scale);
				fillRounded(
					context,
					islandX,
					islandY,
					islandWidth,
					islandHeight,
					islandHeight / 2,
					[0, 0, 0, 255]
				);
				context.beginPath();
				context.arc(
					islandX + islandWidth - 21 * scale,
					islandY + islandHeight / 2,
					4.5 * scale,
					0,
					Math.PI * 2
				);
				context.fillStyle = color([17, 17, 21, 255]);
				context.fill();
				fillRounded(
					context,
					Math.floor((screen.width - 140 * scale) / 2),
					screen.height - Math.round(9 * scale) - Math.round(5 * scale),
					140 * scale,
					5 * scale,
					2.5 * scale,
					dark ? [255, 255, 255, 150] : [0, 0, 0, 140]
				);

				const display = canvas(screen.width, screen.height);
				const displayContext = display.getContext("2d");
				displayContext.save();
				clipRounded(
					displayContext,
					0,
					0,
					display.width,
					display.height,
					Math.round(DISPLAY_R * scale)
				);
				displayContext.drawImage(screen, 0, 0);
				displayContext.restore();

				// One uniform black bezel - nothing else. On a black iPhone the
				// aluminium rail is black too, so the border reads as a single band;
				// a separate tinted rail just looks like a second frame.
				const bezel = Math.round(BEZEL * scale);
				const bodyRadius = Math.round(BODY_R * scale);
				const body = canvas(
					display.width + bezel * 2,
					display.height + bezel * 2
				);
				const bodyContext = body.getContext("2d");
				fillRounded(
					bodyContext,
					0,
					0,
					body.width,
					body.height,
					bodyRadius,
					[10, 10, 12, 255]
				);
				bodyContext.save();
				clipRounded(bodyContext, 0, 0, body.width, body.height, bodyRadius);
				bodyContext.drawImage(display, bezel, bezel);
				bodyContext.restore();
				return shadow(
					addRim(body, bodyRadius, scale, dark),
					scale,
					PHONE_SHADOW,
					bodyRadius
				);
			}

			window.renderMarketingFrame = async ({ name, scheme, type }) => {
				const image =
					type === "macbook"
						? await macbook(name, scheme)
						: await iphone(name, scheme);
				document.querySelector("main").replaceChildren(image);
				return { width: image.width, height: image.height };
			};
		},
		{ symbols, appleLogo, layout }
	);

	for (const scheme of ["dark", "light"]) {
		await mkdir(join(out, scheme), { recursive: true });
		for (const [type, names] of [
			["macbook", desktopShots],
			["iphone", mobileShots]
		]) {
			for (const name of names) {
				const size = await page.evaluate(
					async (options) => window.renderMarketingFrame(options),
					{ name, scheme, type }
				);
				if (size.width > viewport.width || size.height > viewport.height)
					throw new Error(
						`${name} renders ${size.width}x${size.height}, larger than the ${viewport.width}x${viewport.height} viewport - screenshot would crop it`
					);
				// Grab the composite at full scale, then let sharp do the one
				// downscale to the published width - canvas would do it bilinearly.
				const composite = await page.screenshot({
					clip: { x: 0, y: 0, ...size },
					omitBackground: true
				});
				await sharp(composite)
					.resize({
						width: layout.final[type],
						kernel: "lanczos3",
						withoutEnlargement: true
					})
					.png()
					.toFile(join(out, scheme, `${name}.png`));
				console.log(type, scheme, name);
			}
		}
	}
} finally {
	await browser.close();
	await new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve()))
	);
}
