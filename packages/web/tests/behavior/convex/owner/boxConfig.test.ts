import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "@/convex/_generated/api";
import { SECRET_CONFIG_KEYS } from "@/convex/boxes/configuration";

import {
	boxOperations,
	seedBox,
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// The owner's own settings page. Two things here are not like the rest of the
// owner API. A secret an owner types in - a GitHub token - is written once and
// must never come back out: the page is told that one is set, never what it is,
// because anything returned lands in a browser cache, a screenshot, and every
// error report that renders the page. And the operation this starts is read by
// staff, so the same value must not be smuggled out through its metadata
// instead.
//
// What a value is allowed to be is `normalizeRuntimeConfig`, tested next door in
// convex/boxes/configuration.test.ts. What this file decides is who may ask,
// what comes back, and what is recorded.
const NOW = Date.UTC(2026, 2, 3, 4, 5, 6);
const SECRET = SECRET_CONFIG_KEYS[0] ?? "COMPOSERY_GITHUB_TOKEN";

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

async function twoOwners(t: Harness) {
	const mine = await seedUser(t, {
		clerkUserId: "owner",
		email: "owner@example.com"
	});
	const theirs = await seedUser(t, {
		clerkUserId: "stranger",
		email: "stranger@example.com"
	});
	return { mine, theirs };
}

function configuredBox(
	t: Harness,
	clerkUserId: string,
	runtime_config?: Record<string, string>
) {
	return seedBox(t, {
		user_id: clerkUserId,
		slug: "atlas",
		status: "running",
		...(runtime_config ? { runtime_config } : {})
	});
}

describe("reading the configuration", () => {
	test("sends the field definitions with the values, from one source", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		await configuredBox(t, mine.clerkUserId, {
			COMPOSERY_DISABLE_FILE_DOWNLOADS: "1"
		});

		const result = await mine.as.query(api.owner.boxConfig.get, {
			slug: "atlas"
		});

		expect(result?.values).toMatchObject({
			COMPOSERY_DISABLE_FILE_DOWNLOADS: "1"
		});
		// The page renders its controls from these, so an allowlisted variable
		// appears without a second edit to the interface.
		expect(result?.fields.map((field) => field.key)).toContain(
			"COMPOSERY_DISABLE_FILE_DOWNLOADS"
		);
	});

	// The one that matters. A secret is write-only: the page learns that one
	// exists so it can say "set" rather than showing an empty box, and never
	// learns what it is.
	test("says a secret is set without ever sending it back", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		await configuredBox(t, mine.clerkUserId, { [SECRET]: "ghp_realtoken" });

		const result = await mine.as.query(api.owner.boxConfig.get, {
			slug: "atlas"
		});

		expect(result?.secretsSet).toEqual([SECRET]);
		expect(result?.values[SECRET]).toBe("");
		expect(JSON.stringify(result)).not.toContain("ghp_realtoken");
	});

	test("reports whether the box can take a change right now", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		await configuredBox(t, mine.clerkUserId);

		expect(
			(await mine.as.query(api.owner.boxConfig.get, { slug: "atlas" }))
				?.canConfigure
		).toBe(true);
	});

	// Indistinguishable from "no such box": anything else confirms the box
	// exists to someone who is only guessing slugs.
	test("hides the configuration from everyone but the owner", async () => {
		const t = testConvex();
		const { mine, theirs } = await twoOwners(t);
		await configuredBox(t, mine.clerkUserId, { [SECRET]: "ghp_realtoken" });

		expect(
			await theirs.as.query(api.owner.boxConfig.get, { slug: "atlas" })
		).toBeNull();
		expect(
			await mine.as.query(api.owner.boxConfig.get, { slug: "nonexistent" })
		).toBeNull();
	});
});

describe("saving a configuration", () => {
	test("starts one change operation carrying the new configuration", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await configuredBox(t, mine.clerkUserId);

		await mine.as.mutation(api.owner.boxConfig.save, {
			slug: "atlas",
			config: { COMPOSERY_DISABLE_FILE_DOWNLOADS: "1" }
		});

		expect(await boxOperations(t, boxId)).toMatchObject([
			{ type: "change_config", trigger: "owner" }
		]);
	});

	// An operation record is staff-readable, so the keys are recorded but never
	// the values - the secret would otherwise leak through the audit trail it
	// was kept out of the page for.
	test("records which variables changed, never a secret's value", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await configuredBox(t, mine.clerkUserId);

		await mine.as.mutation(api.owner.boxConfig.save, {
			slug: "atlas",
			config: {
				[SECRET]: "ghp_realtoken",
				COMPOSERY_DISABLE_FILE_DOWNLOADS: "1"
			}
		});

		const [operation] = await boxOperations(t, boxId);
		expect(operation?.metadata).toEqual({
			keys: ["COMPOSERY_DISABLE_FILE_DOWNLOADS"]
		});
		expect(JSON.stringify(operation?.metadata)).not.toContain("ghp_realtoken");
	});

	// That a secret the page could not round-trip is kept rather than cleared is
	// `applySecretIntent`, covered in convex/boxes/configuration.test.ts. It
	// cannot be asserted from here: the configuration is handed to the workflow,
	// and a workflow's arguments are not observable - the reason is written out
	// in tests/support/convex.ts.

	test("refuses a configuration for somebody else's box", async () => {
		const t = testConvex();
		const { mine, theirs } = await twoOwners(t);
		const boxId = await configuredBox(t, mine.clerkUserId);

		await expect(
			theirs.as.mutation(api.owner.boxConfig.save, {
				slug: "atlas",
				config: { COMPOSERY_DISABLE_FILE_DOWNLOADS: "1" }
			})
		).rejects.toThrow("Box not found.");
		expect(await boxOperations(t, boxId)).toEqual([]);
	});

	// Told which variable is wrong while the form is still on screen, rather
	// than failing later when the env file is rendered onto the host.
	test("names the variable that is wrong instead of failing later", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await configuredBox(t, mine.clerkUserId);

		await expect(
			mine.as.mutation(api.owner.boxConfig.save, {
				slug: "atlas",
				config: { NOT_A_COMPOSERY_SETTING: "1" }
			})
		).rejects.toThrow(/NOT_A_COMPOSERY_SETTING/);
		expect(await boxOperations(t, boxId)).toEqual([]);
	});

	test("refuses a second change while one is still being applied", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		await configuredBox(t, mine.clerkUserId);
		const save = () =>
			mine.as.mutation(api.owner.boxConfig.save, {
				slug: "atlas",
				config: { COMPOSERY_DISABLE_FILE_DOWNLOADS: "1" }
			});
		await save();

		await expect(save()).rejects.toThrow(
			"This box is already applying a configuration."
		);
	});
});
