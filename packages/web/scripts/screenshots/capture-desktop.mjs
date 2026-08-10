// Desktop captures: welcome, a real automation in the editor, and the hero
// (morning brief + Claude Code working in the terminal). Run per theme:
//   node screenshots/capture-desktop.mjs dark
//   node screenshots/capture-desktop.mjs light
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launch, login, RAW } from "./lib.mjs";

const scheme = process.argv[2] === "light" ? "light" : "dark";
const dir = path.join(RAW, scheme);
mkdirSync(dir, { recursive: true });

const { browser, page } = await launch({ width: 1600, height: 1000, scheme });
await login(page);

const shot = (name) => page.screenshot({ path: path.join(dir, `${name}.png`) });

async function open(query) {
	await page.keyboard.press("Control+KeyP");
	await page.waitForTimeout(900);
	await page.keyboard.type(query);
	await page.waitForTimeout(1400);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(2500);
}

// 1) Welcome: pick an agent, get going.
await page.waitForTimeout(1500);
await shot("welcome");

// 2) Editor: a real automation. This frame exists to show breadth - the instance
//    is a full computer, so a whisper+ffmpeg video pipeline is as ordinary as a CSV.
await open("clips.py");
await page.keyboard.press("Escape");
await shot("editor");
await page.keyboard.press("Control+KeyW"); // close it again
await page.waitForTimeout(1200);

// 3) Hero: the morning brief as a document, Claude Code working beside it.
await open("2026-07-13");
await page.keyboard.press("Control+Shift+KeyV"); // Markdown: Open Preview
await page.waitForTimeout(3500);

await page.keyboard.press("Control+Backquote");
await page.waitForTimeout(3500);
const aux = await page.locator(".part.auxiliarybar").boundingBox();
if (aux) {
	const midY = aux.y + aux.height / 2;
	await page.mouse.move(aux.x, midY);
	await page.mouse.down();
	await page.mouse.move(aux.x - 300, midY, { steps: 16 });
	await page.mouse.up();
	await page.waitForTimeout(1200);
}
const term = await page
	.locator(".part.auxiliarybar .xterm-screen")
	.first()
	.boundingBox();
if (term) await page.mouse.click(term.x + term.width / 2, term.y + 60);
await page.waitForTimeout(400);

await page.keyboard.type(
	"cd ~/workspace && rm -rf drafts && git clean -qfd && git checkout -- . && clear"
);
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);

await page.keyboard.type("claude");
await page.keyboard.press("Enter");
await page.waitForTimeout(18000);
await page.keyboard.press("Enter"); // trust this folder
await page.waitForTimeout(9000);

await page.keyboard.type(
	"Flag any invoice more than five days overdue and draft a chase email."
);
await page.waitForTimeout(1200);
await page.keyboard.press("Enter");
await page.waitForTimeout(30000);
await shot("ide");

console.log(`desktop ${scheme} shots done`);
await browser.close();
