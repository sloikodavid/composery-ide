---
title: Other platforms
description: Run Composery on Coolify, Dokploy, CapRover, Northflank, Sliplane, PikaPods, Elestio, and similar container hosts.
---

Most platforms people reach for to run apps like n8n are a GUI over "run this container image
with a persistent volume." Composery has no bespoke config file for any of them, because it
does not need one - give the platform these five things and it works:

| Setting           | Value                                      |
| ----------------- | ------------------------------------------ |
| Image             | `ghcr.io/sloikodavid/composery:latest`     |
| Port              | `8080` (set `PORT` if you change it)       |
| Health check      | HTTP `GET /_composery/healthz`             |
| Persistent volume | mounted at `/data`                         |
| Instances         | **one** (`persistence` is a single writer) |

Open `/ide/` on the service URL and register the password on first visit, or set `COMPOSERY_PASSWORD` /
`COMPOSERY_HASHED_PASSWORD`
(see [Configuration](../configuration.md)).

Everything below runs Composery's default `supervisor` init. `systemd` mode (closest to
Composery Cloud) needs a privileged container with host cgroups, so it is available only on
the platforms that put you on **your own Docker host** - Coolify, Dokploy, CapRover, and
Elestio - not on the fully managed hosts.

## Coolify

[Coolify](https://coolify.io) installs on a VPS you own and gives you a dashboard over
Docker with a built-in Traefik edge for HTTPS. Add Composery as a **Docker image** resource
(or paste a [VPS compose recipe](vps.md)), point it at the image, and add a persistent
volume mapped to `/data`. Because the host is yours, `systemd` mode works too.

## Dokploy

[Dokploy](https://dokploy.com) is the same idea - a self-hosted PaaS on your VPS - with a
template system and built-in volume backups. Add a Docker-image application and a volume at
`/data`.

## CapRover

[CapRover](https://caprover.com) runs on your server over Docker Swarm. Deploy Composery as
an app from the image and add a persistent directory mapped to `/data`.

## Northflank

[Northflank](https://northflank.com) is fully managed: create a deployment service from the
image and attach a volume. Mount it at `/data` **only** - Northflank sets volume ownership
from the image, so mounting just the path you need avoids permission surprises.

## Sliplane

[Sliplane](https://sliplane.io) is a managed container host that is popular for n8n. It
builds from a git Dockerfile, so use a one-line `FROM ghcr.io/sloikodavid/composery:latest`
repo, then add a volume at `/data`. Automatic volume backups are included.

## PikaPods and other one-click hosts

[PikaPods](https://www.pikapods.com) and similar one-click app hosts work if they let you run
a **custom image** with a mounted volume - use the five settings above.

## Elestio

[Elestio](https://elest.io) provisions a dedicated VM, runs your Docker Compose on it, and
manages SSL, backups, and updates. Deploy it with a [VPS recipe](vps.md); because you get a
real VM with SSH and privileged containers, the `systemd + Caddy` recipe works, or any of
the others.

## Koyeb

Koyeb is a managed platform with attachable volumes and its own edge. It has its own
[guide](koyeb.md) because of its region and single-instance volume rules.
