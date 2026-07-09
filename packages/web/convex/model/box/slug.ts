export const RESERVED_BOX_SLUGS = [
	"www",
	"api",
	"app",
	"admin",
	"auth",
	"login",
	"signin",
	"signup",
	"billing",
	"status",
	"support",
	"help",
	"docs",
	"mail",
	"dashboard",
	"console",
	"portal",
	"account",
	"settings",
	"cloud",
	"box",
	"boxes",
	"workspace",
	"workspaces",
	"security",
	"trust",
	"legal",
	"privacy",
	"terms",
	"dev",
	"staging",
	"test",
	"qa",
	"prod",
	"production",
	"demo",
	"sandbox",
	"forum"
] as const;

const reservedBoxSlugSet = new Set<string>(RESERVED_BOX_SLUGS);

// A slug becomes a DNS label, which is where both bounds come from. The maximum
// is exported because the inputs that collect a slug have to state it
// themselves - `maxLength` is a browser rule, not one this module can enforce -
// and a second copy of "63" is exactly the kind that goes wrong quietly. The
// minimum has no such reader: nothing but `isValidSlugFormat` decides it.
const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 63;

export function sanitizeSlug(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "")
		.replace(/^-+/g, "")
		.slice(0, SLUG_MAX_LENGTH);
}

export function isReservedSlug(slug: string) {
	return reservedBoxSlugSet.has(slug);
}

export function isValidSlugFormat(slug: string) {
	// Length is already at least three and equality below requires a whole-string
	// match, so neither an optional body nor a start anchor carries information.
	const format = slug.match(/[a-z0-9](?:[a-z0-9-]*[a-z0-9])/);
	return (
		slug.length >= SLUG_MIN_LENGTH &&
		slug.length <= SLUG_MAX_LENGTH &&
		!slug.startsWith("xn--") &&
		format?.[0] === slug
	);
}

export function isValidSlug(slug: string) {
	return isValidSlugFormat(slug) && !isReservedSlug(slug);
}
