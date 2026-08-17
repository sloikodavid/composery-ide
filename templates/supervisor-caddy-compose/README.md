# Composery - supervisor + Caddy

Composery behind Caddy with automatic HTTPS, default supervisor init. For locked-down or
rootless hosts with a domain.

```bash
# edit Caddyfile (your domain) and optionally composery.env
docker compose up -d        # then open https://<your-domain>/ide/
```

**-> [VPS](../../docs/self-hosting/vps.md)**
