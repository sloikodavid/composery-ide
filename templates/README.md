# Hosting Composery

Runnable deployment recipes - each folder holds the config you deploy. The guides live in
the docs.

**-> [Self-hosting guide](../docs/self-hosting/index.md)** - how to choose a target, the
persistence requirement, the not-viable platforms, and per-provider instructions.

| Folder                                                                                       | Guide                                                                                     |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `systemd-caddy-compose`, `systemd-compose`, `supervisor-caddy-compose`, `supervisor-compose` | [VPS](../docs/self-hosting/vps.md)                                                        |
| `user-data`                                                                                  | [DigitalOcean](../docs/self-hosting/digitalocean.md) / [VPS](../docs/self-hosting/vps.md) |
| `fly`                                                                                        | [Fly.io](../docs/self-hosting/fly.md)                                                     |
| `render`                                                                                     | [Render](../docs/self-hosting/render.md)                                                  |
| `railway`                                                                                    | [Railway](../docs/self-hosting/railway.md)                                                |
| `kubernetes`                                                                                 | [Kubernetes](../docs/self-hosting/kubernetes.md)                                          |

`user-data` is an optional shortcut, not an extra step: a cloud-init file that auto-runs the
`supervisor-caddy-compose` recipe on a fresh server's first boot, so you skip the SSH steps.
Use it _instead of_ one of the compose recipes - every other method ignores it.

Platforms with no config file to commit are documented, not foldered: [Koyeb](../docs/self-hosting/koyeb.md)
(CLI/dashboard) and the [other PaaS & self-hosted hosts](../docs/self-hosting/other-platforms.md)
(Coolify, Dokploy, CapRover, Northflank, Sliplane, PikaPods, Elestio).
