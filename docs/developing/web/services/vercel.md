---
title: Vercel
description: Configure and deploy the Next.js app to Vercel Production, plus cookieless analytics.
---

Production deploys from `main`, and nothing in this repository re-checks the
commit on the way: the `Protect main` ruleset
([GitHub](../../services/github.md#ruleset-protect-main)) refuses any merge that
has not passed the fail-closed `all checks` result, so every commit on `main` is
already a validated commit. Local development never goes through Vercel; it uses
`pnpm run dev` with `.env.local` (see
[index](../index.md#local-development)). So Vercel only needs Production
configuration.

## Link the project

```bash
cd packages/web
vercel link
```

Project settings:

- Framework preset: Next.js.
- Install command: `pnpm install`.
- Build command override: disabled. `packages/web/vercel.json` owns the build
  command: it runs the environment check, deploys [Convex](convex.md),
  injects the correct `NEXT_PUBLIC_CONVEX_URL`, then builds the frontend. This
  repository-owned order means missing environment names stop the build before
  either provider changes; a post-build check is insufficient.

- Project Settings -> Environments -> Production -> Branch Tracking: production
  branch = `main`.
- Project Settings -> Build and Deployment -> Ignored Build Step = **Only build
  production**. There is no preview Convex backend, so any other branch has
  nowhere correct to point.

`packages/web/vercel.json` also sets `git.deploymentEnabled` to `true` only for
`main` and `false` for `*`. This is the executable half of the boundary: pull
request branches and every other ref cannot start a Vercel or Convex deployment
even if a dashboard branch setting is changed accidentally. It also sets
`github.silent` because there is no preview deployment for a pull-request
comment to announce; the GitHub check remains the visible record that Vercel
correctly ignored the branch.

**Enabling previews is not a one-line change.** The build command runs
`pnpm env:deploy && npx convex deploy`, and `packages/web/scripts/env.mjs`
targets Vercel Production and Convex Production only - it has no `VERCEL_ENV`
branch. A preview build would therefore check a preview environment against the
production example file and, holding a `prod:` `CONVEX_DEPLOY_KEY`, deploy
functions and schema to the production Convex deployment from a pull-request
branch. Previews need a Convex preview deploy key and a preview target in
`env.mjs` before the `*` entry above may be widened.

Plus the two project-level settings `packages/web/vercel.json` cannot encode
(covered in [index](../index.md#production-deploy)): **Root Directory** = `packages/web`, and
**Include source files outside of the Root Directory in the Build Step** =
Enabled, so the build can read `docs/` and the workspace manifests.

## Domains

Add both `composery.io` and `www.composery.io` to the project and make
`www.composery.io` canonical. Run `vercel domains inspect` for each, then
create the exact records it reports in the `composery.io` Cloudflare zone.
Cloudflare is external DNS, so do not use `vercel dns add`. Verify the apex
redirect, `www` TLS certificate, and that no `vercel.app` preview origin is
listed in `CLERK_AUTHORIZED_PARTIES`.

## Production environment variables

`packages/web/.env.example.next.prod` is the authoritative list of Vercel
Production env vars (frontend plane); add every key it lists. Most values come
from the service page that produces them ([Clerk](clerk.md), [Polar](polar.md),
[Hetzner](hetzner.md)), and the `NEXT_PUBLIC_*` dashboard-link vars are
optional. The few with a non-obvious value or flag:

| Variable                   | Production value / handling                                             |
| -------------------------- | ----------------------------------------------------------------------- |
| `CONVEX_DEPLOY_KEY`        | the `prod:` deploy key from the [Convex](convex.md) step; `--sensitive` |
| `CLERK_SECRET_KEY`         | Production Clerk secret key; `--sensitive`                              |
| `CLERK_AUTHORIZED_PARTIES` | `https://www.<website-domain>` (exact origins, comma separated)         |

Set each with `vercel env add <NAME> production`, adding `--sensitive` for the
two secrets above:

```bash
vercel env add CONVEX_DEPLOY_KEY production --sensitive
vercel env add CLERK_SECRET_KEY production --sensitive
vercel env add CLERK_AUTHORIZED_PARTIES production
```

After changing Vercel env vars, redeploy - Vercel does not apply env changes to
old deployments. Check the `CONVEX_DEPLOY_KEY` shape before saving: it must
start with `prod:<production-deployment-name>|`. A `dev:` key or a raw
`<deployment-name>|...` admin key makes Vercel deploy to your dev backend. The
deploy log must name the production Convex URL; if it names the deployment that
local `.env.local` calls `CONVEX_DEPLOYMENT`, the wrong key was pasted.

The repository-owned build command runs `pnpm env:deploy` first. A name absent
from `.env.example.next.prod` blocks the entire Vercel and Convex deployment.
The check enumerates properties only: it never reads or prints values, and an
empty value counts as present.

The Vercel plane checks the blocking direction only. Vercel exposes configured
variables in the same process namespace as its system variables and the build
container's own names, and no check can split that merged namespace without a
separately authenticated Vercel API request. The injected names also cannot be
configured away, so a reported extra would be noise nobody can act on. The
Convex plane - read with the same `CONVEX_DEPLOY_KEY`, through
`convex env list --names-only` - reports both directions: a missing example
name blocks, and an additional name is logged as drift the dashboard can act
on, because every Convex name is set by hand there. Neither check reads or
prints values.

## Analytics & privacy

Two planes of observability, no third-party tracker and no new env vars:

- **Web traffic & performance.** `@vercel/analytics` and `@vercel/speed-insights`
  are mounted in `app/layout.tsx`. They need no env - Vercel injects the
  `/_vercel/insights` and `/_vercel/speed-insights` endpoints at the edge. Enable
  **Web Analytics** and **Speed Insights** for the project in the Vercel
  dashboard (Project -> Analytics / Speed Insights -> Enable). They no-op off
  Vercel and only log (no beacon) in development. To surface a one-click "Open in
  Vercel" link on `/console` (the in-app pointer to those dashboards), set
  `NEXT_PUBLIC_VERCEL_PROJECT_URL` to the project's dashboard URL
  (`https://vercel.com/<team>/<project>`) in the Next env; `ui/lib/dashboards.ts`
  reads it and the link hides when it is unset.
- **Product/fleet KPIs.** Derived on demand in `convex/staff/stats.ts`
  (`api.staff.stats.overview`) from existing tables - no separate analytics
  store, no per-pageview writes. Surfaced on `/console` (staff only). Snapshot
  tiles read per-status via the `boxes.status` index; funnel/trend numbers read a
  trailing window via the `created_at` indexes, so cost tracks recent volume, not
  total table size.

**Cookies / privacy.** Vercel says Web Analytics stores anonymized data without
cookies and resets its request-derived visitor hash daily; Speed Insights is not
tied to a visitor or IP address. The only cookies are Clerk's necessary
authentication cookies, so there is no optional-storage consent banner. Adding
cross-site or cookie-based tracking changes that decision: update the legal
pages and add controls before enabling it. Clerk's Legal setting must point to
the Terms and Privacy pages and require express consent in both instances.

## References

- Vercel environment variables: https://vercel.com/docs/environment-variables
- Vercel system environment variables: https://vercel.com/docs/environment-variables/system-environment-variables
- Vercel repository configuration: https://vercel.com/docs/project-configuration/vercel-json
- Vercel env CLI: https://vercel.com/docs/cli/env
- Vercel custom domains: https://vercel.com/docs/domains/set-up-custom-domain
- Vercel Git deployment configuration: https://vercel.com/docs/project-configuration/git-configuration
- Next.js environment variables: https://nextjs.org/docs/app/guides/environment-variables
- Vercel Web Analytics privacy: https://vercel.com/docs/analytics
- Vercel Speed Insights privacy: https://vercel.com/docs/speed-insights/privacy-policy
