# Composery - systemd, no bundled proxy

Composery with systemd as PID 1, with HTTP on `8080`. Use it behind your own reverse
proxy on a host that allows a privileged container with host cgroup access.

```bash
docker compose up -d        # then reach http://<host>:8080/ide/
```

Do not expose `8080` to the public internet without TLS in front.

**-> [VPS](../../docs/self-hosting/vps.md)**
