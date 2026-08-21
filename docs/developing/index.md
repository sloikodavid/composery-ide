---
title: Developing
description: Runbooks for working on the Composery repository itself.
---

Everything under this section is for people working on the Composery repository,
not for running an instance. If you want to deploy Composery, start at
[Self-hosting](../self-hosting/index.md).

- **[Repository](repository.md)** - fresh-clone setup, workspace layout, commands,
  generated files, test gates, and the normal change/release workflow.
- **[Services](services/index.md)** - repository-level external services, starting
  with [GitHub](services/github.md): repo settings, rulesets, Actions, ghcr,
  releases, community intake, CLA, and Renovate.
- **[IDE](ide.md)** - the editor fork in `packages/ide`: shared theme sources and
  the upstream / VS Code bump runbook.
- **[Web](web/index.md)** - the Next.js website and cloud backend in `packages/web`,
  with nested service setup pages for Convex, Clerk, Polar, Hetzner, Cloudflare,
  Resend, and Vercel.

Repository-wide commands live in the root `package.json`: `pnpm dev` runs the
web, Convex, Docker, and theme-editor dev processes together, and
`pnpm check` runs every typecheck, lint, format, and test gate CI runs.
