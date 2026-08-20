---
title: Railway
description: Deploy Composery on Railway as an image service with a volume at /data.
---

Railway provides the public HTTPS edge and a persistent volume, so Composery runs as a
single service with the volume mounted at `/data`. No Caddy.

Railway provisions volumes and the image source at the service level (in the dashboard or a
published template), not from a repo file. `railway.json` only carries the deploy settings
Railway reads as config-as-code (health check, restart policy, single replica).

Recipe: [templates/railway](https://github.com/sloikodavid/composery-ide/tree/main/templates/railway)
(`railway.json`).

## Deploy from the image

1. **New Project -> Deploy from Docker Image** and enter
   `ghcr.io/sloikodavid/composery:latest`.
2. Right-click the service -> **Attach Volume**, mount path `/data`.
3. Set service variables: `PORT=8080` (register the password in the browser, or set
   `COMPOSERY_PASSWORD` / `COMPOSERY_HASHED_PASSWORD`).
4. **Settings -> Networking -> Generate Domain**, target port `8080`.
5. Open `/ide/` on the generated domain.

## Notes

- Run a single replica; `persistence` is a single writer for one `/data` volume.
- Railway volumes are attached at runtime - after first boot, confirm persistence with
  `composery persistence status --json` in the service shell.
