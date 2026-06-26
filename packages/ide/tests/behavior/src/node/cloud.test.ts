import { describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../support/overlay.ts";

type Cloud = {
	cloudConfig: { boxId: string; origin: string } | undefined;
};

// Whether this Composery belongs to a Composery Cloud account. Almost everything
// downstream branches on it - which auth pages are offered, whether a password
// can be recovered through the website, what the update notifier trusts - so
// what matters is that it is never *half* true.
//
// Read at import time, so each case loads the module afresh with its own
// environment. That is also the only way to reach the throwing paths: a module
// that threw on load would take the whole server down, which is the point.

function load(env: Record<string, string | undefined>) {
	return loadOverlayModule<Cloud>({
		source: new URL("../../../../overlay/src/node/cloud.ts", import.meta.url),
		globals: { process: { env }, URL }
	}).exports;
}

describe("cloud configuration", () => {
	test("is absent on a self-hosted instance", () => {
		expect(load({}).cloudConfig).toBeUndefined();
	});

	// Blank is not configured. An operator who exports the names but leaves them
	// empty gets the self-hosted answer rather than a box id of "".
	test("treats blank values as not configured", () => {
		expect(
			load({
				COMPOSERY_CLOUD_BOX_ID: "  ",
				COMPOSERY_CLOUD_ORIGIN: "  "
			}).cloudConfig
		).toBeUndefined();
	});

	test("reads a configured pair, keeping only the origin", () => {
		expect(
			load({
				COMPOSERY_CLOUD_BOX_ID: "j57box",
				COMPOSERY_CLOUD_ORIGIN: "https://www.composery.io"
			}).cloudConfig
		).toEqual({ boxId: "j57box", origin: "https://www.composery.io" });
	});

	test("trims what an operator exported", () => {
		expect(
			load({
				COMPOSERY_CLOUD_BOX_ID: " j57box ",
				COMPOSERY_CLOUD_ORIGIN: " https://www.composery.io "
			}).cloudConfig?.boxId
		).toBe("j57box");
	});

	// Half-configured is the dangerous state: a box id with nowhere to call home,
	// or an origin with no identity to present. Either would make the cloud paths
	// look available and fail later, so it fails now instead.
	test("refuses one half of the pair without the other", () => {
		expect(() => load({ COMPOSERY_CLOUD_BOX_ID: "j57box" })).toThrow(
			/must be configured together/
		);
		expect(() =>
			load({ COMPOSERY_CLOUD_ORIGIN: "https://www.composery.io" })
		).toThrow(/must be configured together/);
	});

	// The origin is where a box sends an owner to prove ownership, so it carries
	// the password-recovery flow. Plain HTTP would put that on the wire.
	test("refuses an origin that is not HTTPS", () => {
		expect(() =>
			load({
				COMPOSERY_CLOUD_BOX_ID: "j57box",
				COMPOSERY_CLOUD_ORIGIN: "http://www.composery.io"
			})
		).toThrow(/HTTPS origin/);
	});

	// An origin, not a URL: a path, query or fragment here would be silently
	// dropped when the box builds its callback, so it is refused rather than
	// quietly ignored.
	test("refuses anything carrying more than an origin", () => {
		for (const value of [
			"https://www.composery.io/boxes",
			"https://www.composery.io/?a=1",
			"https://www.composery.io/#x"
		]) {
			expect(() =>
				load({
					COMPOSERY_CLOUD_BOX_ID: "j57box",
					COMPOSERY_CLOUD_ORIGIN: value
				})
			).toThrow(/HTTPS origin/);
		}
	});

	test("refuses something that is not a URL at all", () => {
		expect(() =>
			load({
				COMPOSERY_CLOUD_BOX_ID: "j57box",
				COMPOSERY_CLOUD_ORIGIN: "not-a-url"
			})
		).toThrow();
	});
});
