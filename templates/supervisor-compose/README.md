# Composery - supervisor, no bundled proxy

Single container with the default supervisor init, HTTP on `8080`. Quick trial, or behind
your own reverse proxy. Also the `docker run` quickstart.

```bash
docker compose up -d        # then reach http://<host>:8080/ide/
```

Do not expose `8080` to the public internet without TLS in front.

**-> [VPS](../../docs/self-hosting/vps.md)**
