---
title: What is it?
description: Composery is a secure cloud computer with a powerful UI, usable from any phone or browser.
---

It's like VS Code, but it sits on a server, and is thus reachable from any browser or phone whenever. You get a real Linux system: install packages, edit system files, run agents, build projects - and that state survives restarts. The runtime is a container, so durable state comes from one volume mounted at `/data` (see [Persistence](persistence.md)).

## The environment

- You are `user`, a normal account with passwordless `sudo` - root whenever you need it.
- `cron` runs, so `crontab -e` schedules jobs.
- For incoming network requests, see [webhooks](api.mdx#webhooks).
- Reach it over [SSH](ssh.md), or connect your [AI agent](ai-agents.md) to it.
- **Outbound mail on port 25 will not work on most hosts.** Cloud providers block
  it to limit spam, and Hetzner - which Composery Cloud runs on - blocks **25 and
  465** by default. Port **587** is not blocked, so send through an authenticated
  relay (Resend, Postmark, SES, your own provider) rather than talking SMTP
  directly. This is the provider's policy, not Composery's, and no setting here
  changes it. On your own Hetzner account the block can be lifted by a limit
  request once the account has some history and a paid invoice.

Your changes persist across restarts through the [persistence](persistence.md) daemon,
which writes only your deltas to `/data`. Configure the runtime with
[environment variables](configuration.md).

## Running Composery

- **Self-host it** - [deployment guides](self-hosting/index.md) for Render, Railway, DigitalOcean, Fly.io, Koyeb, a VPS, Kubernetes, and other platforms (Coolify, Dokploy, Elestio, ...).
- **Composery Cloud** - the hosted offering at [composery.io](https://www.composery.io/pricing), running the same image, but managed for you.
