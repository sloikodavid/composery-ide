// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Downloading a brand asset, and the two ways it can fail.
//
// The download half of this module is the part somebody outside the company
// touches - a press kit, a conference deck - and it is all DOM work, so nothing
// had run it. Both failure paths end in a toast, because a click that produces
// no file and no message reads as a broken page.

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

const { BRAND_ASSETS, downloadPng, downloadSvg } =
	await import("@/lib/brand-assets");

let clicked: { download: string; href: string }[] = [];
let revoked: string[] = [];

beforeEach(() => {
	clicked = [];
	revoked = [];
	vi.clearAllMocks();
	vi.stubGlobal("URL", {
		...URL,
		createObjectURL: vi.fn(() => "blob:asset"),
		revokeObjectURL: vi.fn((url: string) => revoked.push(url))
	});
	vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
		if (tag === "a") {
			const anchor = { download: "", href: "", click: () => {} };
			anchor.click = () =>
				clicked.push({ download: anchor.download, href: anchor.href });
			return anchor as unknown as HTMLElement;
		}
		if (tag === "canvas") {
			return {
				width: 0,
				height: 0,
				getContext: () => ({ drawImage: vi.fn() }),
				toBlob: (callback: (blob: Blob | null) => void) =>
					callback(new Blob(["png"], { type: "image/png" }))
			} as unknown as HTMLElement;
		}
		return document.createElementNS("http://www.w3.org/1999/xhtml", tag);
	}) as typeof document.createElement);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const asset = BRAND_ASSETS.light.logo;

describe("downloading the vector asset", () => {
	test("saves it under the name it was asked for", () => {
		downloadSvg(asset, "composery-logo");

		expect(clicked).toEqual([
			{ download: "composery-logo.svg", href: "blob:asset" }
		]);
	});

	// The object URL is a live handle on the blob; leaving it behind keeps the
	// data alive for the life of the document.
	test("releases the object URL it created", () => {
		downloadSvg(asset, "composery-logo");

		expect(revoked).toEqual(["blob:asset"]);
	});
});

// The image is rasterised through an <img> that jsdom will not load, so the load
// and error paths are driven directly - which is the only way either has ever
// been executed.
function withImage(outcome: "load" | "error") {
	class StubImage {
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		set src(_value: string) {
			queueMicrotask(() =>
				outcome === "load" ? this.onload?.() : this.onerror?.()
			);
		}
	}
	vi.stubGlobal("Image", StubImage);
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("downloading the raster asset", () => {
	test("saves a PNG scaled from the asset's own size", async () => {
		const settled = withImage("load");
		downloadPng(asset, 2, "composery-logo");
		await settled;

		expect(clicked).toEqual([
			{ download: "composery-logo.png", href: "blob:asset" }
		]);
		expect(toastError).not.toHaveBeenCalled();
	});

	// A click that produces no file and says nothing is a page that looks broken.
	test("says so when the asset will not rasterise", async () => {
		const settled = withImage("error");
		downloadPng(asset, 1, "composery-logo");
		await settled;

		expect(clicked).toEqual([]);
		expect(toastError).toHaveBeenCalledWith("Couldn't render PNG");
		// Still released: the failure path leaks the handle otherwise.
		expect(revoked).toEqual(["blob:asset"]);
	});
});
