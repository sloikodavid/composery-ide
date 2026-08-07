// Every environment variable the Next plane reads, declared once - the
// counterpart to `convex/env.ts` for the other plane.
//
// It is shaped differently on purpose. Convex's registry reads through
// `process.env[name]`, which is fine on a server. Next inlines a
// `NEXT_PUBLIC_` variable into the client bundle by substituting the literal
// text `process.env.NEXT_PUBLIC_X` at build time; a dynamic lookup is not
// substituted and reads `undefined` in the browser. So the door here is this
// module rather than a function, and every read below stays literal.
//
// Keying the record by the variable's own name is what makes `NEXT_ENV_NAMES`
// derived rather than a second copy: "the code reads it" and "the list names
// it" are the same fact, which is the property that makes the Convex checklist
// trustworthy. `tests/invariants/next-env-example.test.ts` compares that list
// against `.env.example.next.*` and fails if anything else in the plane touches
// `process.env`.
//
// Add a variable here and to both example files, with a comment there saying
// where the value comes from. Nothing else enumerates them.
export const nextEnv = {
	// Convex - the deployment the browser client connects to. `convex deploy`
	// injects it into the production build.
	NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
	// Clerk - which origins may present a session to the middleware.
	CLERK_AUTHORIZED_PARTIES: process.env.CLERK_AUTHORIZED_PARTIES,
	// Console deep links. Each is optional; the link hides when unset.
	NEXT_PUBLIC_HETZNER_PROJECT_ID: process.env.NEXT_PUBLIC_HETZNER_PROJECT_ID,
	NEXT_PUBLIC_POLAR_ORGANIZATION_SLUG:
		process.env.NEXT_PUBLIC_POLAR_ORGANIZATION_SLUG,
	NEXT_PUBLIC_POLAR_ENVIRONMENT: process.env.NEXT_PUBLIC_POLAR_ENVIRONMENT,
	NEXT_PUBLIC_VERCEL_PROJECT_URL: process.env.NEXT_PUBLIC_VERCEL_PROJECT_URL
} as const;

export const NEXT_ENV_NAMES = Object.keys(nextEnv) as (keyof typeof nextEnv)[];
