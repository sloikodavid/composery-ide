---
title: Koyeb
description: Deploy Composery on Koyeb from the image with a persistent volume at /data.
---

Koyeb runs the image on a Firecracker microVM behind its own HTTPS edge, and a Koyeb Volume
gives Composery a persistent `/data`. No Caddy. Koyeb has no repo config file (like
`fly.toml`); you deploy from the control panel or the `koyeb` CLI, so the recipe is the
commands below rather than a `templates/` folder.

## Constraints that fit Composery

Koyeb volumes have limits that happen to match Composery's single-writer `persistence`
model exactly - lean into them:

- **Regions:** volumes exist only in Washington, D.C. (`was`) and Frankfurt (`fra`). Deploy
  the service in the same region as its volume.
- **Scale of one:** a volume attaches only to a service scaled to a single instance. That
  is the only supported topology for Composery anyway.
- **Instance type:** free and `eco-*` instances cannot mount a volume. Use a `standard`
  instance; give it ~1 GB of RAM.
- **Size:** 1-10 GB.

## Deploy

1. **Volumes -> Create volume**: name `composery-data`, size `10` GB, region `fra` (or
   `was`).
2. Create the service from the image, in the same region, with the volume mounted at
   `/data`:

```bash
koyeb service create composery \
  --app composery \
  --docker ghcr.io/sloikodavid/composery:latest \
  --region fra \
  --instance-type small \
  --scale 1 \
  --port 8080:http \
  --env PORT=8080 \
  --checks 8080:http:/_composery/healthz \
  --volumes composery-data:/data
```

The same fields are available in the control panel (Docker image, port `8080`, an HTTP
health check on `/_composery/healthz`, and the volume at `/data`).

Open `/ide/` on the `.koyeb.app` URL Koyeb assigns. Register the initial password in the browser, or
set `COMPOSERY_PASSWORD` / `COMPOSERY_HASHED_PASSWORD` with another `--env` flag (or in the
control panel).

## Notes

- Keep the service at a single instance; `persistence` is a single writer for one `/data`
  volume.
- A Koyeb Volume is local with no redundancy - fault tolerance is on you. Redeploys remount
  the volume and cause brief downtime. Snapshot or back up before major image upgrades.
- Composery runs its default `supervisor` init here; `systemd` mode needs a privileged
  container with host cgroups, which Koyeb (like every managed platform) does not provide.
