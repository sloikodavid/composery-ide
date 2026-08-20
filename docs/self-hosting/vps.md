---
title: VPS
description: Self-host Composery on your own Linux server with Docker Compose.
---

Run Composery on any Docker-capable Linux server - Hetzner (cheapest), a DigitalOcean
Droplet (the most common n8n choice), Hostinger, Vultr, Contabo, Linode, or your own server.
Install Docker, then choose two things: the **init** system, and whether Composery **owns
its TLS edge**.

For a dashboard over Docker instead of raw Compose (Coolify, Dokploy, CapRover) or a fully
managed VM (Elestio), see [Other PaaS & self-hosted platforms](other-platforms.md).

- **Init** - `systemd` runs as PID 1 and needs a privileged container with host cgroup
  access. `supervisor` works on any host,
  including rootless or locked-down ones). Selected by `COMPOSERY_INIT` in `compose.yaml`.
- **TLS** - bundle **Caddy** for automatic HTTPS when Composery owns the domain, or run
  with **no proxy** when your own reverse proxy or a platform terminates TLS.

That gives four recipes:

| Recipe                                                                                                      | When                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [systemd + Caddy](https://github.com/sloikodavid/composery-ide/tree/main/templates/systemd-caddy-compose)       | Recommended VPS with a domain and host cgroup access.                    |
| [systemd, no proxy](https://github.com/sloikodavid/composery-ide/tree/main/templates/systemd-compose)           | Privileged host where your own proxy terminates TLS.                     |
| [supervisor + Caddy](https://github.com/sloikodavid/composery-ide/tree/main/templates/supervisor-caddy-compose) | Locked-down or rootless host with a domain.                              |
| [supervisor, no proxy](https://github.com/sloikodavid/composery-ide/tree/main/templates/supervisor-compose)     | Quick trial, or behind your own proxy. Also the `docker run` quickstart. |

If unsure: a VPS with a domain wants a **Caddy** variant; use **systemd** when the host
allows privileged containers and host cgroups, otherwise **supervisor**.

## One-paste install (cloud-init)

To skip the SSH steps entirely, paste
[`templates/user-data/user-data.yaml`](https://github.com/sloikodavid/composery-ide/tree/main/templates/user-data)
into the server's **user data** field when you create it (DigitalOcean, Hetzner, Vultr,
Linode, ...). Point DNS at the server and set your domain in the file first; the server
boots with Composery behind Caddy over HTTPS. It installs Docker and runs the
`systemd + Caddy` recipe on first boot.

## Deploy (Caddy variants)

1. Point DNS `A`/`AAAA` records at the server; open inbound TCP `80` and `443`.
2. Install Docker Compose.
3. Copy the recipe folder, then edit `Caddyfile` (your domain) and, optionally,
   `composery.env` (pre-register a password).
4. `docker compose up -d`.

Open `https://<your-domain>/ide/`.

## Deploy (no-proxy variants)

```bash
docker compose up -d
```

This serves plaintext HTTP on `8080`. Do not expose it to the public internet without TLS
in front - either put a reverse proxy that terminates HTTPS ahead of `8080`, or bind it to
localhost only (`"127.0.0.1:8080:8080"` in `compose.yaml`) and route from your proxy.

For a one-off trial without Compose:

```bash
docker run -d --name composery -p 8080:8080 -v composery_data:/data \
  ghcr.io/sloikodavid/composery:latest
```

## Notes

- systemd variants require a privileged container with host cgroup access.
- State is stored in the `composery_data` Docker volume; Caddy certificate state in
  `caddy_data`.
- Register the initial password in the browser on first visit, or set
  `COMPOSERY_PASSWORD` / `COMPOSERY_HASHED_PASSWORD` in `composery.env`
  (single-quote values containing `$`). See
  [Configuration](../configuration.md).
- Upgrade with `docker compose pull && docker compose up -d`. Back up `composery_data`
  before major upgrades.
