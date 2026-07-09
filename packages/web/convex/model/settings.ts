// The bounds a staff setting is read and written against - the words both
// planes speak about `convex/settings.ts`, which holds the reads and writes
// themselves. Here rather than there because the console's settings cards
// validate against them, and `convex/settings.ts` also defines Convex functions,
// which the browser may not import.

// Legit buyers rarely juggle more than a couple of pending purchases; the
// default caps concurrent active checkout reservations so one account can't hog
// slugs it never pays for. Staff-tunable via the console, up to the maximum.
export const DEFAULT_MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER = 3;
export const MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER = 50;
