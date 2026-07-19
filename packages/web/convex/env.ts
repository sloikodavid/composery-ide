import { v } from "convex/values";
import { IDE_PATH } from "shared";

// Every environment variable the Convex plane reads, declared once.
//
// This list is the plane's environment surface, not a description of it: the
// readers below only accept a name from it, so a variable can be read here and
// nowhere else, and `tests/invariants/convex/envExample.test.ts` compares this
// registry against `.env.example.convex.*` directly. That replaces a scanner that
// went looking for `process.env.X` spellings across the source and could only
// find the ones written as literals - which is how the four `POLAR_BOX_*` ids
// stayed on the checklist by accident, matched through a tolerant read in
// `billing/polar.ts` rather than through the table that actually names them.
//
// Add a variable here and to both example files, with a comment there saying
// where the value comes from. Nothing else enumerates them.
export const CONVEX_ENV = {
	// Clerk
	CLERK_FRONTEND_API_URL: v.string(),
	CLERK_WEBHOOK_SIGNING_SECRET: v.string(),
	// Domains
	WEBSITE_ORIGIN: v.string(),
	CLOUD_DOMAIN: v.string(),
	// Polar
	POLAR_ORGANIZATION_TOKEN: v.string(),
	POLAR_WEBHOOK_SECRET: v.string(),
	POLAR_BOX_AIR_MONTHLY_PRODUCT_ID: v.string(),
	POLAR_BOX_AIR_ANNUAL_PRODUCT_ID: v.string(),
	POLAR_BOX_PRO_MONTHLY_PRODUCT_ID: v.string(),
	POLAR_BOX_PRO_ANNUAL_PRODUCT_ID: v.string(),
	POLAR_ENVIRONMENT: v.string(),
	// Hetzner
	HETZNER_CLOUD_TOKEN: v.string(),
	HETZNER_BOX_LOCATIONS: v.string(),
	HETZNER_BOX_IMAGE: v.string(),
	HETZNER_SSH_KEYS: v.string(),
	HETZNER_FIREWALL_ID: v.string(),
	// Cloudflare
	CLOUDFLARE_DNS_TOKEN: v.string(),
	CLOUDFLARE_ZONE_ID: v.string(),
	// Runtime container
	RUNTIME_IMAGE: v.string(),
	RUNTIME_PORT: v.string(),
	// Box SSH access
	HOST_SSH_USER: v.string(),
	HOST_SSH_PRIVATE_KEY: v.string(),
	// Resend. One sender per class of mail, named for what the mail is about:
	// an incident, one box, or the account itself. See convex/email.ts.
	//
	// Prefixed like every other provider here, and for a reason that only shows
	// up outside this file: a deployment's variables are read in an alphabetical
	// dashboard, where an unprefixed `ALERTS_FROM` sits under A, half a screen
	// from the key and webhook secret it is useless without. The prefix is what
	// keeps one provider's configuration in one place when somebody is looking
	// for what they have missed. `EMAIL` earns nothing after it - everything
	// Resend holds is email.
	RESEND_API_KEY: v.string(),
	RESEND_WEBHOOK_SECRET: v.string(),
	RESEND_ALERTS_FROM: v.string(),
	RESEND_NOTICES_FROM: v.string(),
	RESEND_ACCOUNTS_FROM: v.string()
} as const;

export const CONVEX_ENV_NAMES = Object.keys(CONVEX_ENV) as ConvexEnvName[];

export type ConvexEnvName = keyof typeof CONVEX_ENV;

export function normalizeDomain(value: string) {
	return value.replace(/^\.+|\.+$/g, "");
}

export function requiredEnv(name: ConvexEnvName) {
	const value = process.env[name];
	if (!value) throw new Error(`Missing Convex environment variable: ${name}.`);
	return value;
}

export function optionalEnv(name: ConvexEnvName) {
	const value = process.env[name];
	return value && value.trim() ? value.trim() : undefined;
}

export function runtimeDomain(slug: string) {
	return `${slug}.${normalizeDomain(requiredEnv("CLOUD_DOMAIN"))}`;
}

export function cloudUrl(slug: string) {
	return `https://${runtimeDomain(slug)}/`;
}

export function ideUrl(slug: string) {
	return new URL(IDE_PATH, cloudUrl(slug)).toString();
}

export function websiteOrigin() {
	return requiredEnv("WEBSITE_ORIGIN").replace(/\/+$/g, "");
}

// A link onto the website, or `undefined` where the origin is not configured -
// the difference from `websiteOrigin` above, which throws. Both callers put a
// link inside an email sent from a box lifecycle mutation, and a deployment
// missing its origin must lose the link rather than the deletion.
export function optionalWebsiteUrl(path: string) {
	const origin = optionalEnv("WEBSITE_ORIGIN")?.replace(/\/+$/g, "");
	return origin ? `${origin}${path}` : undefined;
}

// Where an alert sends the person reading it. Degrades to naming the page rather
// than dropping the sentence, for the same reason as `optionalWebsiteUrl`: a
// deployment missing its origin should lose the link, not the alert.
export function staffConsoleUrl(path = "/console") {
	return optionalWebsiteUrl(path) ?? `the staff console (${path})`;
}
