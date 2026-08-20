---
title: Fly.io
description: Deploy Composery on Fly.io with one volume behind Fly's HTTPS proxy.
---

Fly provides the public HTTPS edge through its proxy, and a Fly Volume gives Composery a
persistent `/data`. No Caddy.

Recipe: [templates/fly](https://github.com/sloikodavid/composery-ide/tree/main/templates/fly)
(`fly.toml`).

## Deploy

```bash
# from the templates/fly directory
fly apps create composery            # or: fly launch --no-deploy --copy-config
fly volumes create composery_data --size 10 --region iad
fly deploy
```

Open `https://composery.fly.dev/ide/`. Register the initial password in the browser, or set one
as a secret:

```bash
fly secrets set COMPOSERY_PASSWORD=example
```

## Notes

- A Fly Volume is pinned to a single Machine. Run **one** Machine - do not scale this app
  horizontally against the same volume (`persistence` is a single writer).
- `auto_stop_machines` is `off` so an idle editor session is not stopped mid-use. Set it to
  `"stop"` with `min_machines_running = 0` if you prefer scale-to-zero and accept cold starts.
- The volume and `app` name must match what you create; edit `fly.toml` if you rename either.
- Take a volume snapshot before major image upgrades.
