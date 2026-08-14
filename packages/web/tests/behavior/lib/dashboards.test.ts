import { afterEach, describe, expect, test, vi } from "vitest";

// The console's deep links into Convex, Hetzner, Polar and Vercel. Every one of
// them is built from a `NEXT_PUBLIC_` coordinate, and every one has to answer
// `null` when that coordinate is missing - `OpenIn` renders nothing for a null,
// so an unconfigured provider is an absent link rather than a broken one. That
// shared rule is why they live in one module, and the last suite here is what
// pins it for all four at once.

const NAMES = [
	"NEXT_PUBLIC_CONVEX_URL",
	"NEXT_PUBLIC_HETZNER_PROJECT_ID",
	"NEXT_PUBLIC_POLAR_ENVIRONMENT",
	"NEXT_PUBLIC_POLAR_ORGANIZATION_SLUG",
	"NEXT_PUBLIC_VERCEL_PROJECT_URL"
] as const;

const previous = new Map(NAMES.map((name) => [name, process.env[name]]));

async function load(env: Partial<Record<(typeof NAMES)[number], string>>) {
	for (const name of NAMES) {
		const value = env[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	vi.resetModules();
	return await import("@/lib/dashboards");
}

afterEach(() => {
	for (const name of NAMES) {
		const value = previous.get(name);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	vi.resetModules();
});

describe("Convex dashboard links", () => {
	// The deployment name is derived from the client URL rather than configured
	// separately, and the row filter is base64url(JSON) in the shape the
	// dashboard's own system UDF decodes - a wrong one opens the table unfiltered
	// instead of failing, which is the kind of mistake nobody reports.
	const CONVEX = {
		NEXT_PUBLIC_CONVEX_URL: "https://blessed-mammoth-42.convex.cloud"
	};

	function decodeFilters(url: string | null) {
		const encoded = new URL(url ?? "").searchParams.get("filters") ?? "";
		// base64url: the three characters standard base64 would have used.
		expect(encoded).not.toMatch(/[+/=]/);
		return JSON.parse(
			Buffer.from(
				encoded.replaceAll("-", "+").replaceAll("_", "/"),
				"base64"
			).toString("utf8")
		) as { clauses: Record<string, unknown>[] };
	}

	test("names the deployment from the client URL's first label", async () => {
		const { convexTableUrl } = await load(CONVEX);

		expect(convexTableUrl("boxes")).toBe(
			"https://dashboard.convex.dev/d/blessed-mammoth-42/data?table=boxes"
		);
	});

	test("encodes a filter the way the dashboard decodes it", async () => {
		// Decoding it back asserts the contract rather than today's output string.
		const { convexFilterUrl } = await load(CONVEX);

		expect(decodeFilters(convexFilterUrl("boxes", "abc123")).clauses).toEqual([
			{ op: "eq", field: "_id", value: "abc123", enabled: true, id: "_id" }
		]);
	});

	test("filters on a named field when given one", async () => {
		const { convexFilterUrl } = await load(CONVEX);

		expect(
			decodeFilters(convexFilterUrl("boxes", "user_1", "owner_id")).clauses[0]
		).toMatchObject({ field: "owner_id", id: "owner_id" });
	});

	test("hides the link rather than guessing when the URL is unusable", async () => {
		for (const value of [undefined, "", "not a url"]) {
			const { convexTableUrl, convexFilterUrl } = await load({
				NEXT_PUBLIC_CONVEX_URL: value
			});
			expect(convexTableUrl("boxes"), String(value)).toBeNull();
			expect(convexFilterUrl("boxes", "abc"), String(value)).toBeNull();
		}
	});
});

describe("Hetzner console links", () => {
	// Every link is scoped to one project id, so a wrong or missing one sends an
	// operator to someone else's project rather than failing.
	test("scopes every link to the configured project", async () => {
		const { hetznerServersUrl, hetznerServerUrl } = await load({
			NEXT_PUBLIC_HETZNER_PROJECT_ID: "123456"
		});

		expect(hetznerServersUrl()).toBe(
			"https://console.hetzner.com/projects/123456/servers"
		);
		expect(hetznerServerUrl(99)).toBe(
			"https://console.hetzner.com/projects/123456/servers/99/overview"
		);
	});

	test("hides a server link when the box has no server yet", async () => {
		// A box that has not been provisioned, or one whose server was destroyed,
		// carries no id - and `0` is not a Hetzner server id either.
		const { hetznerServerUrl } = await load({
			NEXT_PUBLIC_HETZNER_PROJECT_ID: "123456"
		});

		expect(hetznerServerUrl(null)).toBeNull();
		expect(hetznerServerUrl(undefined)).toBeNull();
		expect(hetznerServerUrl(0)).toBeNull();
	});
});

describe("Polar dashboard links", () => {
	test("uses the production dashboard only when production is configured", async () => {
		const { polarCustomerUrl, polarCustomersUrl, polarSubscriptionUrl } =
			await load({
				NEXT_PUBLIC_POLAR_ENVIRONMENT: "production",
				NEXT_PUBLIC_POLAR_ORGANIZATION_SLUG: "composery"
			});

		expect(polarCustomersUrl()).toBe(
			"https://polar.sh/dashboard/composery/customers"
		);
		expect(polarCustomerUrl("cus_123")).toBe(
			"https://polar.sh/dashboard/composery/customers/cus_123"
		);
		expect(polarSubscriptionUrl("sub_123")).toBe(
			"https://polar.sh/dashboard/composery/sales/subscriptions/sub_123"
		);
	});

	test("uses sandbox only when sandbox is configured", async () => {
		const { polarCustomersUrl } = await load({
			NEXT_PUBLIC_POLAR_ENVIRONMENT: "sandbox",
			NEXT_PUBLIC_POLAR_ORGANIZATION_SLUG: "composery"
		});

		expect(polarCustomersUrl()).toBe(
			"https://sandbox.polar.sh/dashboard/composery/customers"
		);
	});

	test("names no dashboard for an environment Polar does not have", async () => {
		// Fail towards no link: an unrecognised environment - a typo, a value from
		// a Polar plan that does not exist - must not fall back to production,
		// where staff would act on the wrong catalogue.
		const { polarCustomersUrl } = await load({
			NEXT_PUBLIC_POLAR_ENVIRONMENT: "Production",
			NEXT_PUBLIC_POLAR_ORGANIZATION_SLUG: "composery"
		});

		expect(polarCustomersUrl()).toBeNull();
	});

	test("hides links when the environment or slug is missing", async () => {
		expect(
			(
				await load({
					NEXT_PUBLIC_POLAR_ENVIRONMENT: "",
					NEXT_PUBLIC_POLAR_ORGANIZATION_SLUG: "composery"
				})
			).polarCustomersUrl()
		).toBeNull();

		expect(
			(
				await load({
					NEXT_PUBLIC_POLAR_ENVIRONMENT: "production",
					NEXT_PUBLIC_POLAR_ORGANIZATION_SLUG: ""
				})
			).polarCustomersUrl()
		).toBeNull();
	});
});

describe("Vercel dashboard links", () => {
	// The value is a dashboard URL somebody pastes out of the address bar, so it
	// is normalised rather than trusted to be tidy.
	test("appends the view, and treats overview as the project root", async () => {
		const { vercelDashboardUrl } = await load({
			NEXT_PUBLIC_VERCEL_PROJECT_URL: "https://vercel.com/acme/site"
		});

		expect(vercelDashboardUrl()).toBe("https://vercel.com/acme/site/analytics");
		expect(vercelDashboardUrl("speed-insights")).toBe(
			"https://vercel.com/acme/site/speed-insights"
		);
		expect(vercelDashboardUrl("overview")).toBe("https://vercel.com/acme/site");
	});

	test("tolerates a pasted URL with trailing slashes", async () => {
		const { vercelDashboardUrl } = await load({
			NEXT_PUBLIC_VERCEL_PROJECT_URL: "https://vercel.com/acme/site///"
		});

		expect(vercelDashboardUrl()).toBe("https://vercel.com/acme/site/analytics");
	});
});

describe("an unconfigured provider", () => {
	test("hides every link it would have built", async () => {
		// The one rule the four providers share, asked of all of them at once so a
		// fifth cannot be added with a half-built URL for its empty case.
		const dashboards = await load({});

		expect(
			Object.entries(dashboards)
				// Every export is a URL builder; the arguments below are the widest
				// each one takes, so none of them can return null for the wrong reason.
				.map(([name, build]) => [
					name,
					(build as (...args: unknown[]) => unknown)("boxes", "abc", "_id")
				])
				.filter(([, url]) => url !== null)
		).toEqual([]);
	});
});
