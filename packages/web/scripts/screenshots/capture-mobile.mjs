// Mobile captures at the iPhone 17 Pro content viewport (402pt wide @3x; the
// frame draws the 62pt status bar and everything below the web viewport).
// Welcome, the overnight brief, and Claude Code with a prompt being typed.
// The terminal shot is captured at the keyboard-open viewport height - iOS
// resizes the visual viewport to 874 - 62 (status) - 339 (keyboard) = 473pt -
// and the frame composites the measured iOS 26 keyboard below it. Run per
// theme:
//   node screenshots/capture-mobile.mjs dark
//   node screenshots/capture-mobile.mjs light
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launch, login, RAW } from "./lib.mjs";

const scheme = process.argv[2] === "light" ? "light" : "dark";
const dir = path.join(RAW, scheme);
mkdirSync(dir, { recursive: true });

{
	const { browser, page } = await launch({
		width: 402,
		height: 778,
		dsf: 3,
		mobile: true,
		scheme
	});
	await login(page);
	const shot = (name) =>
		page.screenshot({ path: path.join(dir, `${name}.png`) });

	// 1) Welcome on a phone.
	await page.waitForTimeout(1500);
	await shot("mobile-welcome");

	// 2) Editor: the overnight results brief - what the agents did while the
	//    user slept. Close Welcome first so the brief is the only tab. Mobile UA
	//    is Mac-like, so shortcuts use Meta; retry until the tab exists.
	await page.keyboard.press("Meta+KeyW");
	await page.waitForTimeout(1200);
	const tab = page
		.locator(".tabs-container .tab", { hasText: "overnight" })
		.first();
	for (const combo of ["Meta+KeyP", "Meta+KeyP", "Control+KeyP"]) {
		if (await tab.count()) break;
		await page.keyboard.press(combo);
		await page.waitForTimeout(1200);
		await page.keyboard.type("brief/overnight");
		await page.waitForTimeout(1500);
		await page.keyboard.press("Enter");
		await page.waitForTimeout(2500);
	}
	await tab.waitFor({ timeout: 15000 });
	await page.keyboard.press("Meta+Shift+KeyV"); // Markdown: Open Preview (Mac UA)
	await page.waitForTimeout(4500);
	await shot("mobile-editor");
	await browser.close();
}

// 3) Claude Code on the phone, keyboard open: the user typing a handoff. The
//    prompt is typed but not sent - reads clean, needs no model quota.
{
	const { browser, page } = await launch({
		width: 402,
		height: 473,
		dsf: 3,
		mobile: true,
		scheme
	});
	await login(page);
	await page.keyboard.press("Control+Backquote");
	await page.waitForTimeout(3500);
	await page.keyboard.type(
		"cd ~/workspace && rm -rf drafts && git clean -qfd && git checkout -- . && clear"
	);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(1500);

	await page.keyboard.type("claude");
	await page.keyboard.press("Enter");
	await page.waitForTimeout(18000);
	await page.keyboard.press("Enter"); // trust this folder
	await page.waitForTimeout(8000);

	await page.keyboard.type(
		"Draft this week's client update from my commits and calendar"
	);
	await page.waitForTimeout(2500);
	await page.screenshot({ path: path.join(dir, "mobile-terminal.png") });
	await browser.close();
}

console.log(`mobile ${scheme} shots done`);
