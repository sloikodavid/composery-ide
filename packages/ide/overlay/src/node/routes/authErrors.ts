import i18n from "../i18n"

/**
 * Why an auth page is showing an error.
 *
 * The pages redirect to each other - register sends an owner who already has a
 * password back to login, change-password sends an instance with no password to
 * register - so a code is not always rendered by the page that produced it, and
 * a page with no message for a code renders no error at all. That failure is
 * silent by construction: the user is bounced to a page that looks like they
 * asked for it.
 *
 * So every code every page can be sent lives here, in one table, beside a test
 * that walks the routes and fails when one of them redirects with a code the
 * receiving page cannot render.
 */

export type AuthPage = "login" | "register" | "change-password"

// Composery's own strings are literal; the three upstream already translates keep
// going through i18n. Both are read at render time, not at load: the request's
// locale is chosen per request, so a message resolved once would be the first
// visitor's language for everyone after.
const MESSAGES: Record<AuthPage, Record<string, () => string>> = {
  login: {
    missing: () => i18n.t("MISS_PASSWORD") as string,
    incorrect: () => i18n.t("INCORRECT_PASSWORD") as string,
    "rate-limit": () => i18n.t("LOGIN_RATE_LIMIT") as string,
    configured: () => "Password was already configured. Sign in instead.",
    "env-managed": () =>
      "COMPOSERY_PASSWORD is set on this Composery and takes precedence over a password set here. Change or remove that variable instead.",
  },
  register: {
    missing: () => "Enter a password",
    mismatch: () => "Passwords do not match",
  },
  "change-password": {
    "missing-current": () => "Enter your current password",
    "incorrect-current": () => "Current password is incorrect",
    "missing-new": () => "Enter a new password",
    mismatch: () => "Passwords do not match",
    "rate-limit": () => "Too many attempts. Try again later.",
    // True whether Composery could not be reached or refused the change (which
    // is what an owner-supplied COMPOSERY_HASHED_PASSWORD does).
    unavailable: () => "Composery did not record the change. Try again.",
  },
}

/** The codes `page` can render, for the test that pins them to what gets sent. */
export const authErrorCodes = (page: AuthPage): string[] => Object.keys(MESSAGES[page])

/** What `page` should tell the user about `code`, or nothing when it has none. */
export const authErrorMessage = (page: AuthPage, code: unknown): string | undefined =>
  typeof code === "string" ? MESSAGES[page][code]?.() : undefined
