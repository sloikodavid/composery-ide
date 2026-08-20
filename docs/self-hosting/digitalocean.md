---
title: DigitalOcean
description: Deploy Composery on a DigitalOcean Droplet with Docker Compose, or on DOKS.
---

DigitalOcean is one of the most common places people self-host apps like this. Composery
needs a persistent `/data`, so use a **Droplet** (a VPS you control) - not App Platform,
which has no attachable volumes.

## Droplet (recommended)

1. Create a Droplet. The **Docker on Ubuntu** Marketplace image ships Docker and Compose
   preinstalled; a plain Ubuntu Droplet works too (install Docker first). 2 GB RAM is a sane
   floor.
2. Point an `A`/`AAAA` record at the Droplet's (or a reserved) IP, and in the Droplet's
   firewall allow inbound TCP `80` and `443`.
3. SSH in, copy a [VPS recipe](vps.md), edit the `Caddyfile` with your domain, and
   `docker compose up -d`.

To skip the SSH step, paste
[`templates/user-data/user-data.yaml`](https://github.com/sloikodavid/composery-ide/tree/main/templates/user-data)
into the Droplet's **user data** field at creation - it installs Docker and brings Composery
up behind Caddy on first boot.

A Droplet is a full VM, so it allows privileged containers and host cgroups. Both the
`systemd + Caddy` and `supervisor + Caddy` recipes work.

Open `https://<your-domain>/ide/`. State lives in the `composery_data` volume; snapshot the
Droplet before major image upgrades.

## Managed Kubernetes (DOKS)

For a managed cluster instead of a single VM, follow the [Kubernetes](kubernetes.md) guide -
DOKS's default `do-block-storage` StorageClass backs the PVC.

## Not App Platform

App Platform has no persistent volumes - its local disk is ephemeral and capped at 4 GiB -
so Composery state would not survive a redeploy. Use a Droplet or DOKS.
