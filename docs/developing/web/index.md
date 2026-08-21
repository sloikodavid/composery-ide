---
title: Web
description: Next.js app, providers, and the per-step setup runbook for a fresh clone.
---

`packages/web` is the Next.js app behind `https://www.<website-domain>`: the
marketing pages, the boxes dashboard, the staff console, and the Fumadocs-rendered
documentation at `/docs` (this repo's `docs/` directory). It has a backend -
Convex, Clerk auth, and Polar billing - all configured through environment
variables in `packages/web/.env.example.*` and the nested [Services](services/index.md)
runbooks. This page assumes none of those accounts or resources exist yet and
is the end-to-end setup path from source checkout to a working deployment.

Stack: Next.js on Vercel, Convex (functions, database, HTTP actions, crons, auth
config, `@convex-dev/polar`, `@convex-dev/workflow`), Clerk, Polar, Hetzner Cloud
(per-box VPS), Cloudflare DNS (per-box `A`/`AAAA`), a public runtime container
image, Caddy in each box for HTTPS, and Hetzner snapshots for restore points.
Namecheap remains the registrar; Cloudflare is authoritative DNS for both
`composery.io` and `composery.cloud`.
Periodic work is handled by Convex crons - no separate Layer, Headless, or Poller
service.

## Environment model

This is a solo project with two long-lived backends and no preview/staging tier:

| Purpose     | Git branch | Vercel                | Convex                | Clerk                      | Polar            | Infra                                          |
| ----------- | ---------- | --------------------- | --------------------- | -------------------------- | ---------------- | ---------------------------------------------- |
| Development | local only | `pnpm run dev`        | dev deployment        | development Clerk instance | Polar sandbox    | dev Hetzner project and Cloudflare namespace   |
| Production  | `main`     | Production deployment | production deployment | production Clerk instance  | Polar production | production Hetzner project and Cloudflare zone |

**Two config planes**, set in different places. Each plane's variables live in
one place - its `.env.example.*` files - and the rest of these docs point there
instead of repeating the list:

- _Frontend env_ is read by Next.js (and the Convex and Clerk CLIs). It lives in
  `.env.local` locally and in Vercel Production. The full, authoritative list is
  `packages/web/.env.example.next.dev` (local) and `.env.example.next.prod`
  (Vercel); [Vercel](services/vercel.md) covers setting it.
- _Convex deployment env_ is read by Convex functions, actions, auth, and crons.
  A human sets it per deployment in the Convex dashboard (Deployment Settings ->
  Environment Variables); it lives on the deployment, not on your machine. The
  full, authoritative list is `packages/web/.env.example.convex.dev` and
  `.env.example.convex.prod`; [Convex](services/convex.md) covers setting it.

The planes are disjoint, with no exceptions: putting a Convex deployment var in
`.env.local`, or a frontend var on the deployment, does nothing at runtime, and
each plane reads only its own store.

Domain split:

- Production website: `https://www.<website-domain>` (checkout success URLs).
  Production canonicalizes on `www`: the apex `<website-domain>` redirects to
  `https://www.<website-domain>`, so only the `www` origin serves the app and
  only it is listed in `CLERK_AUTHORIZED_PARTIES`.
- Production runtime boxes: `https://<slug>.<cloud-domain>`.
- Development website: `http://localhost:3000`.
- Development runtime boxes: `https://<slug>.dev.<cloud-domain>` (only if you
  provision in dev; see [Cloudflare](services/cloudflare.md)).

`WEBSITE_ORIGIN` is a full origin (scheme + host, plus a port in dev) because it
builds website URLs and dev runs on `http://localhost:3000`. `CLOUD_DOMAIN` is a
bare host because it is only ever a DNS suffix in `<slug>.<CLOUD_DOMAIN>`. Two
different things, not two spellings of one domain.

## Order of operations

1. Delegate both domains from Namecheap and configure the website and runtime
   zones in [Cloudflare](services/cloudflare.md).
2. Create the [Convex](services/convex.md) deployments - their URLs must exist first
   (Polar webhook target `CONVEX_SITE_URL`, Clerk JWT issuer).
3. Set up each provider ([Clerk](services/clerk.md), [Polar](services/polar.md),
   [Hetzner](services/hetzner.md), [Cloudflare](services/cloudflare.md)). Each page names the
   value/variable it produces; some need the Convex URLs from step 1.
4. Configure [Resend](services/resend.md) and its delivery webhook for
   production staff alerts, box owner notices and account legal notices, and
   Cloudflare Email Routing for the support address
   ([Cloudflare](services/cloudflare.md), "Support mail"). Polar, not Resend,
   sends customer billing email.
5. Enter the collected values into the Convex deployment env per deployment
   ([Convex](services/convex.md) - "Set Convex environment variables").
6. Configure [Vercel](services/vercel.md) (frontend env, prod deploy key, build
   settings) and deploy.
7. Sign in once, bootstrap the first application administrator, configure the
   deployment's Hetzner allocations, and complete the launch checks in
   [Operations](operations.md). Checkout deliberately remains unavailable
   until both allocations are set.

## Prerequisites

- The Node.js version pinned in `.nvmrc`, pnpm through Corepack, and Vercel CLI.
- Access to the Vercel team/project, Convex team/project, Clerk apps, Polar
  organization, Hetzner Cloud project, Cloudflare zone, and container registry.

From a fresh clone:

```bash
git clone https://github.com/<github-user>/<repo>.git
cd <repo>
corepack enable
pnpm install
cp packages/web/.env.example.next.dev packages/web/.env.local
```

## Local development

`.env.local` holds frontend-plane values only; it is your copy of
`packages/web/.env.example.next.dev`. `convex dev` writes the [Convex](services/convex.md)
identifiers; you fill the dev [Clerk](services/clerk.md) keys. The Convex-plane values
live on the dev deployment (set them in [Convex](services/convex.md) - "Set Convex
environment variables"), not in `.env.local`.

```bash
pnpm run dev
```

This runs `convex dev` (pushing functions and schema to the dev deployment) and
`next dev` together. Open `http://localhost:3000`. Local UI work runs without
real [Polar](services/polar.md)/[Hetzner](services/hetzner.md)/[Cloudflare](services/cloudflare.md)
credentials until you test checkout or provisioning.

## Production deploy

`packages/web/vercel.json` pins the framework preset and the install command
(`pnpm install` from the repo root, so the workspace resolves). The full Vercel
project, env-var, and build-command setup is in [Vercel](services/vercel.md); the short
version:

1. From `packages/web` run `vercel link`. Set the two project-level settings
   `vercel.json` cannot encode (Vercel dashboard -> Project -> Settings):
   - **Root Directory** = `packages/web`.
   - **Include source files outside of the Root Directory in the Build Step** =
     Enabled. The build reads `docs/` and the root `pnpm-lock.yaml` /
     `pnpm-workspace.yaml`, all outside the package.
2. Add `www.<website-domain>` under Settings -> Domains. The documentation is
   served at `/docs` on that same origin - there is no separate docs subdomain.
3. Push to `main`. Every production [Convex](services/convex.md) and Vercel
   environment name must be in place first, and `CLERK_FRONTEND_API_URL` must be
   non-empty; see [Vercel](services/vercel.md) for the checklist.

Environment drift is reported inside those deploys, with no separate audit
login. Before either provider changes, the Vercel build compares both live name
sets with their production examples. A missing example name blocks the whole
deployment. Only the Convex plane logs additional names as drift - every Convex
name is set by hand, so an addition is actionable; the Vercel plane cannot split
its merged build namespace, so it checks presence only. Neither check requests,
compares, or prints configured values, and an empty value counts as present.
Existing explicit semantic checks can still reject an
empty value, as Convex auth does for `CLERK_FRONTEND_API_URL`.
