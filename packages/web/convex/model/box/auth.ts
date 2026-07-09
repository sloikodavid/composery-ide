// The wire shapes of the box authorization flow.
//
// One home because both ends check them: the Next routes under `app/api/cloud/`
// and `app/boxes/authorize/`, which turn a malformed request into a 400 rather
// than a Convex exception, and the Convex actions in `convex/instance/auth.ts`,
// which are the boundary that actually decides. Those two lists of literals had
// drifted into four spellings of "43 characters of base64url" and three of
// "an argon2id hash, at most 512 bytes", so tightening one could only ever
// tighten one.
//
// The predicates below are the shared form, and every caller uses one - the
// constants are exported for the tests that pin them and for nothing else.
// Importing `ARGON2ID_HASH` and `MAX_HASH_LENGTH` to write
// `regex.test(x) || x.length > max` at the call site is how a fifth spelling
// gets written, which is exactly what `convex/instance/auth.ts` had done at all
// four of its entry points.
//
// Every secret in this flow - the authorization code, its PKCE verifier and
// challenge, the setup grant - is 32 random bytes or a SHA-256 digest rendered
// as unpadded base64url, which is exactly 43 characters. That is why one
// constant covers all of them.
export const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;

// An argon2id encoded hash, never a password. The website is never sent one
// either way: the box hashes locally and sends only this.
export const ARGON2ID_HASH = /^\$argon2id\$/;
export const MAX_HASH_LENGTH = 512;

// A Convex document id: base32 over a bounded length. The bound is generous
// because the id is Convex's to shape, and the pattern is what the authorize
// route already required of it - the exchange and password routes accepted any
// string of that length instead, which is the third spelling this module exists
// to remove.
const BOX_ID = /^[a-z0-9]{1,64}$/;

// The `state` a box hands us and expects back untouched. Unlike the secrets
// above it is the box's own value, not one we mint, so it is bounded rather
// than pinned to a length.
const OAUTH_STATE = /^[A-Za-z0-9_-]{43,128}$/;

// A redirect the box hands back to itself. A bound, not a format -
// `isBoxIdeRedirect` is what decides a redirect is this box's own.
export const MAX_REDIRECT_URI_LENGTH = 512;

// What a box may be authorized for: the password it will be set up with, or a
// session on it. `convex/schema.ts` builds the stored column from this list, so
// the wire check and the database cannot admit different sets.
export const AUTHORIZATION_TYPES = ["password", "session"] as const;

export type AuthorizationType = (typeof AUTHORIZATION_TYPES)[number];

export function isFlowSecret(value: unknown): value is string {
	return typeof value === "string" && BASE64URL_SHA256.test(value);
}

export function isPasswordHash(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= MAX_HASH_LENGTH &&
		ARGON2ID_HASH.test(value)
	);
}

export function isBoxIdString(value: unknown): value is string {
	return typeof value === "string" && BOX_ID.test(value);
}

export function isOauthState(value: unknown): value is string {
	return typeof value === "string" && OAUTH_STATE.test(value);
}

export function isAuthorizationType(
	value: unknown
): value is AuthorizationType {
	return AUTHORIZATION_TYPES.includes(value as AuthorizationType);
}

export function isRedirectUri(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_REDIRECT_URI_LENGTH;
}

// Nothing in this flow may be cached or leak its query string onward: the URLs
// carry one-time codes, and the responses carry the grant they exchange for.
export const CLOUD_AUTH_HEADERS = {
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer"
} as const;
