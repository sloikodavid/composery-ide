import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { BRAND_ASSETS, copyHex, copySvg } from "@/lib/brand-assets";
import { copyToClipboard } from "@/lib/clipboard";

// Copying is one helper because the failure half kept being written differently,
// and the failure half is what these check: the clipboard API rejects on an
// insecure origin, on an unfocused document, and wherever the permission is
// denied, so "it threw" is a state every caller has to survive and none of them
// may report as success.

const success = vi.fn();
const error = vi.fn();

vi.mock("sonner", () => ({
	toast: {
		error: (...args: unknown[]) => error(...args),
		success: (...args: unknown[]) => success(...args)
	}
}));

function arrangeClipboard(writeText: (value: string) => Promise<void>) {
	vi.stubGlobal("navigator", { clipboard: { writeText } });
}

beforeEach(() => {
	success.mockReset();
	error.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("copyToClipboard", () => {
	test("writes the value and says so", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		arrangeClipboard(writeText);

		await expect(copyToClipboard("value", "Copied")).resolves.toBe(true);

		expect(writeText).toHaveBeenCalledWith("value");
		expect(success).toHaveBeenCalledWith("Copied");
		expect(error).not.toHaveBeenCalled();
	});

	// The half that matters. A caller that took a rejection for a copy would show
	// a check mark over a clipboard that still holds whatever was in it before.
	test("reports a refusal rather than the message it was going to show", async () => {
		arrangeClipboard(vi.fn().mockRejectedValue(new Error("not allowed")));

		await expect(copyToClipboard("value", "Copied")).resolves.toBe(false);

		expect(success).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith("Couldn't copy");
	});
});

describe("the brand page's copy actions", () => {
	test("put the asset's own SVG and the hex on the clipboard", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		arrangeClipboard(writeText);

		await copySvg(BRAND_ASSETS.light.logo);
		await copyHex("#101010");

		expect(writeText).toHaveBeenNthCalledWith(1, BRAND_ASSETS.light.logo.svg);
		expect(writeText).toHaveBeenNthCalledWith(2, "#101010");
		expect(success).toHaveBeenNthCalledWith(1, "SVG copied");
		// The colour names itself, so a page of swatches says which one landed.
		expect(success).toHaveBeenNthCalledWith(2, "#101010 copied");
	});

	test("go through the one helper, so a refusal reads the same everywhere", async () => {
		arrangeClipboard(vi.fn().mockRejectedValue(new Error("not allowed")));

		await expect(copySvg(BRAND_ASSETS.dark.icon)).resolves.toBe(false);
		await expect(copyHex("#101010")).resolves.toBe(false);

		expect(error).toHaveBeenCalledTimes(2);
		expect(success).not.toHaveBeenCalled();
	});
});
