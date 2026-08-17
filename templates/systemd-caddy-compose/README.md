# Composery - systemd + Caddy

Composery behind Caddy with automatic HTTPS, with systemd as PID 1. Use it on a VPS that
allows a privileged container with host cgroup access.

```bash
# edit Caddyfile (your domain) and optionally composery.env
docker compose up -d        # then open https://<your-domain>/ide/
```

**-> [VPS](../../docs/self-hosting/vps.md)**
