---
title: Services
description: Configure every external service used by the hosted web product.
---

These pages assume no external accounts, projects, credentials, domains, or
webhooks are configured. Follow the setup order in [Web](../index.md), creating
separate development and production resources where specified.

| Service                     | Responsibility                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------- |
| [Cloudflare](cloudflare.md) | Authoritative website/runtime DNS and per-box records                               |
| [Convex](convex.md)         | Database, backend functions, workflows, crons, and provider secrets                 |
| [Clerk](clerk.md)           | Customer authentication, legal consent, and account-deletion events                 |
| [Polar](polar.md)           | Checkout, subscriptions, tax, customer billing email, refunds, and billing webhooks |
| [Hetzner Cloud](hetzner.md) | Per-box servers, Primary IPs, firewall, SSH control, and snapshots                  |
| [Resend](resend.md)         | Operational alerts, box owner notices, and delivery tracking                        |
| [Vercel](vercel.md)         | Next.js production deployment and website domains                                   |

Each page identifies which values belong in Next/Vercel and which belong on the
matching Convex deployment. Do not treat environment examples as secret stores;
they document names and shapes only.
