// Deep links into the third-party dashboards the console sends staff to.
//
// One module because all four answer the same question the same way: read the
// coordinates this deployment was configured with, and return `null` - never a
// half-built URL - when it has none. `OpenIn` renders nothing for a null, so an
// unconfigured provider is a link that is simply absent rather than one that
// 404s. They were four files repeating that rule four times.
//
// Every coordinate is a `NEXT_PUBLIC_` variable, so these run in the browser.
import { nextEnv } from "./env";

// A URL, or null when the deployment did not name the account it belongs to.
type DashboardUrl = string | null;

function join(base: DashboardUrl, path: string): DashboardUrl {
	return base === null ? null : `${base}/${path}`;
}

// --- Convex -----------------------------------------------------------------

// The deployment name is the first label of the client URL the browser already
// connects to, so nothing has to be configured twice.
const CONVEX_DEPLOYMENT = (() => {
	const url = nextEnv.NEXT_PUBLIC_CONVEX_URL;
	if (!url) return null;
	try {
		return new URL(url).hostname.split(".")[0];
	} catch {
		return null;
	}
})();

// The dashboard decodes `filters` as base64url(JSON.stringify(FilterExpression))
// where each clause is { op, field, value, enabled, id }. See get-convex/convex-
// backend system-udfs filters.ts; changing this shape silently breaks the link.
function base64Url(input: string) {
	const bytes = new TextEncoder().encode(input);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export function convexTableUrl(table: string): DashboardUrl {
	if (!CONVEX_DEPLOYMENT) return null;
	return `https://dashboard.convex.dev/d/${CONVEX_DEPLOYMENT}/data?table=${table}`;
}

export function convexFilterUrl(
	table: string,
	value: string,
	field = "_id"
): DashboardUrl {
	const base = convexTableUrl(table);
	if (base === null) return null;
	const expression = {
		clauses: [{ op: "eq", field, value, enabled: true, id: field }]
	};
	return `${base}&filters=${base64Url(JSON.stringify(expression))}`;
}

// --- Hetzner ----------------------------------------------------------------

const HETZNER_PROJECT = nextEnv.NEXT_PUBLIC_HETZNER_PROJECT_ID
	? `https://console.hetzner.com/projects/${nextEnv.NEXT_PUBLIC_HETZNER_PROJECT_ID}`
	: null;

export function hetznerServersUrl(): DashboardUrl {
	return join(HETZNER_PROJECT, "servers");
}

export function hetznerServerUrl(
	serverId: number | null | undefined
): DashboardUrl {
	if (!serverId) return null;
	return join(HETZNER_PROJECT, `servers/${serverId}/overview`);
}

// --- Polar ------------------------------------------------------------------

// Polar runs its sandbox on a host of its own, so the environment picks the
// host rather than a path. An unrecognised value names no dashboard at all -
// including the typo that would otherwise send staff to the wrong catalogue.
const POLAR_HOST =
	nextEnv.NEXT_PUBLIC_POLAR_ENVIRONMENT === "production"
		? "polar.sh"
		: nextEnv.NEXT_PUBLIC_POLAR_ENVIRONMENT === "sandbox"
			? "sandbox.polar.sh"
			: null;

const POLAR_ORGANIZATION =
	POLAR_HOST && nextEnv.NEXT_PUBLIC_POLAR_ORGANIZATION_SLUG
		? `https://${POLAR_HOST}/dashboard/${nextEnv.NEXT_PUBLIC_POLAR_ORGANIZATION_SLUG}`
		: null;

export function polarCustomersUrl(): DashboardUrl {
	return join(POLAR_ORGANIZATION, "customers");
}

export function polarCustomerUrl(
	customerId: string | null | undefined
): DashboardUrl {
	if (!customerId) return null;
	return join(POLAR_ORGANIZATION, `customers/${customerId}`);
}

export function polarSubscriptionUrl(
	subscriptionId: string | null | undefined
): DashboardUrl {
	if (!subscriptionId) return null;
	return join(POLAR_ORGANIZATION, `sales/subscriptions/${subscriptionId}`);
}

// --- Vercel -----------------------------------------------------------------

// The project URL is pasted from the Vercel dashboard, where it is as likely to
// be copied with a trailing slash as without one.
const VERCEL_PROJECT =
	nextEnv.NEXT_PUBLIC_VERCEL_PROJECT_URL?.replace(/\/+$/, "") || null;

export type VercelView = "analytics" | "speed-insights" | "overview";

export function vercelDashboardUrl(view: VercelView = "analytics") {
	if (VERCEL_PROJECT === null) return null;
	return view === "overview" ? VERCEL_PROJECT : join(VERCEL_PROJECT, view);
}
