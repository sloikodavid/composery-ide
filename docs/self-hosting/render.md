---
title: Render
description: Deploy Composery on Render as a Docker web service with a persistent disk.
---

Render provides the public HTTPS edge and an attachable persistent disk, so Composery runs
as a single Docker-image web service with the disk mounted at `/data`. No Caddy.

Recipe: [templates/render](https://github.com/sloikodavid/composery-ide/tree/main/templates/render)
(`render.yaml`).

## Deploy

1. Push a repository containing this `render.yaml` (or point Render at the repo).
2. In the Render dashboard, choose **New -> Blueprint** and select the repository.
3. Render reads `render.yaml`, creates the web service, and attaches the disk.

Open `/ide/` on the service URL Render assigns. Register the initial password in the browser, or set
`COMPOSERY_PASSWORD` / `COMPOSERY_HASHED_PASSWORD` as a service environment variable.

## Notes

- **A persistent disk requires a paid instance type.** Free web services have an ephemeral
  filesystem, so Composery state would not survive a redeploy.
- A service with a disk cannot be scaled past one instance - which matches Composery's
  single-writer `persistence` model.
- `PORT` is set to `8080`; Render routes to it and health-checks `/_composery/healthz`.
- Back up the disk before major image upgrades.
