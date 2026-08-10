// Shared Playwright helpers for the marketing capture scripts.
import path from "node:path";
import { chromium } from "playwright";

export const RAW = path.join(import.meta.dirname, "raw");
// 9911 by default: the dev IDE owns 8080, so the capture instance gets its own
// port and both can run at once.
export const BASE = process.env.COMPOSERY_URL ?? "http://localhost:9911";
export const PASSWORD = process.env.COMPOSERY_PASSWORD ?? "example123";
export const FOLDER = "/home/user/workspace";

export async function launch({
	width,
	height,
	dsf = 2,
	mobile = false,
	scheme = "dark"
} = {}) {
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({
		viewport: { width, height },
		// A real browser window is smaller than the screen. Headless Chromium
		// reports screen == viewport, which makes the workbench think it is
		// fullscreen (shrinking the narrow hamburger, hiding the logo). Report a
		// bigger screen so desktop and phone both render like reality.
		screen: { width: width + 320, height: height + 200 },
		deviceScaleFactor: dsf,
		colorScheme: scheme,
		isMobile: mobile,
		hasTouch: mobile,
		userAgent: mobile
			? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
			: undefined
	});
	const page = await context.newPage();
	return { browser, page };
}

export async function login(page, folder = FOLDER) {
	await page.goto(BASE + "/ide/", { waitUntil: "domcontentloaded" });
	// Register (password + confirm) or log in (password) - fill whatever is there.
	const pws = page.locator('input[type="password"]');
	const n = await pws.count();
	for (let i = 0; i < n; i++) await pws.nth(i).fill(PASSWORD);
	if (n) {
		await page.locator('button[type="submit"]').first().click();
		await page.waitForLoadState("domcontentloaded");
		await page.waitForTimeout(3000);
	}
	const url = folder
		? `${BASE}/ide/?folder=${encodeURIComponent(folder)}`
		: BASE + "/ide/";
	await page.goto(url, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
	await page.waitForTimeout(6000);
}
