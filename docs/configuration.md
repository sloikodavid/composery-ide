---
title: Configuration
description: Runtime environment variables for Composery.
---

Composery does not wrap upstream runtime settings - you configure it with environment
variables. Every switch below documented as "set to `1` or `true`" is read the same
way: the value is trimmed and matched case-insensitively, so `1`, `true` and `TRUE`
all turn it on and everything else - `0`, `false`, `yes`, a typo, an empty value -
leaves it off. In the Compose examples, set them in `composery.env`; Compose loads that file
into the container (`env_file`). Other hosting providers use their own environment-variable
UI.

The init system is selected by `COMPOSERY_INIT`, set in the compose service's
`environment:` block (not in `composery.env`). The default is `supervisor`; use `systemd`
on hosts that allow privileged containers and host cgroups.

The persistence engine is selected the same way by `COMPOSERY_PERSISTENCE`. The default is
`auto`, which works on every deployment target. See [Persistence](persistence.md#engines).

On a Composery Cloud instance there is no `composery.env` to edit: its environment is
rendered from its configuration on the website, so set these from your instance's
Configuration page instead. The variables that select the init system, the persistence engine, the ports,
and the volume root are part of that deployment's contract and are not configurable there;
the password is changed from the IDE's own **Change Password** page (or recovered from your
instance's page on the website) rather than set as a variable.

## Variables

| Variable                                                 | Use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPOSERY_PASSWORD`                                     | Sets a plaintext IDE password. Skips first-visit registration, and overrides a password registered earlier - set it and restart if you forget yours.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `COMPOSERY_HASHED_PASSWORD`                              | Sets an argon2 hashed password and takes precedence over `COMPOSERY_PASSWORD`. Single-quote values containing `$` in `composery.env`. A value that is not an argon2 hash stops the IDE at start, because nothing could ever match it and Composery would look configured while refusing every sign-in.                                                                                                                                                                                                                                                                                  |
| `COMPOSERY_REMOVE_PASSWORD`                              | Set to `1` or `true` to delete the registered password on **every** boot, leaving the instance open for anyone who reaches it to claim. Unset it as soon as you have registered a new password. See [Forgotten password](self-hosting/index.md#forgotten-password).                                                                                                                                                                                                                                                                                                                     |
| `COMPOSERY_DISABLE_AUTH`                                 | Set to `1` or `true` to serve the IDE with no sign-in at all: anyone who can reach it gets a root-capable terminal, so only use it behind a gate of your own (a private network, an SSO proxy). Removes the sign-in, registration and password-change pages along with the Sign Out and Change Password commands, and ignores any password set above. API keys are unaffected - use `COMPOSERY_DISABLE_API` for those.                                                                                                                                                                  |
| `COMPOSERY_SESSION_LIFETIME`                             | Sets the absolute lifetime of a signed IDE session: `browser`, `8h` (default), `1d`, `7d`, or `30d`. `browser` asks again for each browser session and carries no persistent-cookie expiry, but the server still rejects it after 30 days. An unsupported value stops the IDE instead of silently weakening or tightening the policy.                                                                                                                                                                                                                                                   |
| `PORT`                                                   | Changes the container's HTTP port (default `8080`). Also update `expose`, health checks, or platform routing when you change it.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `COMPOSERY_IDE_PORT`                                     | Changes the loopback port Caddy proxies the IDE on (default `8081`). It must differ from `PORT`; the container refuses to start if they match.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `COMPOSERY_PROXY_URI`                                    | Controls links in the Ports panel, e.g. `https://{{port}}.dev.example.com`. The default path proxy works without setting this, and `COMPOSERY_DISABLE_PROXY` turns the routes off whatever this says.                                                                                                                                                                                                                                                                                                                                                                                   |
| `COMPOSERY_SSH_AUTHORIZED_KEYS`                          | Public keys allowed to reach this instance over SSH, in `authorized_keys` format (one key per line, `#` comments allowed). Kept apart from the account's own `~/.ssh/authorized_keys`, so neither can overwrite the other. Rewritten on every boot, including when you unset it - removing a key here removes its access at the next restart. Multi-line values need a form your platform supports: a YAML block scalar under compose `environment:`, or the platform's secret editor. `composery.env` cannot hold newlines, so use `environment:` for more than one key.               |
| `COMPOSERY_DISABLE_SSH`                                  | Set to `1` or `true` to stop the SSH service from starting. sshd listens on port 22 **inside** the container and reaches nothing until your deployment publishes it, so leaving SSH on does not expose it - the port mapping is the opt-in.                                                                                                                                                                                                                                                                                                                                             |
| `COMPOSERY_DISABLE_DOCKER`                               | Set to `1` or `true` to stop the bundled Docker daemon from starting. Docker also stays down, with the reason in the container log, wherever the container has no `CAP_SYS_ADMIN`. See [Persistence](persistence.md).                                                                                                                                                                                                                                                                                                                                                                   |
| `COMPOSERY_DISABLE_FILE_DOWNLOADS`                       | Set to `1` or `true` to block browser file downloads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `COMPOSERY_DISABLE_FILE_UPLOADS`                         | Set to `1` or `true` to block browser file uploads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `COMPOSERY_DISABLE_PROXY`                                | Set to `1` or `true` to disable the IDE's port proxy routes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `COMPOSERY_EXTENSIONS_GALLERY`                           | Points the IDE at a custom VS Code Extension Gallery API using the JSON shape expected by VS Code `product.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `COMPOSERY_LOG_LEVEL`                                    | Sets IDE logging to `trace`, `debug`, `info`, `warn`, or `error`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `COMPOSERY_GITHUB_TOKEN`                                 | Supplies the IDE's GitHub auth token. Treat it as a secret; the IDE removes it from the child-process environment at start.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `COMPOSERY_CONFIG`                                       | Overrides the IDE YAML config path. Keep it on persisted storage, or the registered password is gone after every restart.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `COMPOSERY_DOCKER_VOLUME_PATH`                           | Overrides the persistent volume root (default `/data`). The mount target in your compose/platform config must match; the container warns at start when nothing is mounted there.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `COMPOSERY_PERSISTENCE`                                  | Selects the persistence engine: `auto` (default), `overlay`, or `copy`. `auto` probes the volume with a real overlay mount and uses `overlay` when it succeeds, falling back to `copy` otherwise. `overlay` names the kernel-maintained engine and needs a privileged container (`CAP_SYS_ADMIN`); when the probe cannot be satisfied it stops the container with the probe's own error rather than quietly running `copy`. `copy` is the universal engine and works on every target. An unsupported value stops the container with exit 64. See [Persistence](persistence.md#engines). |
| `COMPOSERY_COOKIE_SUFFIX`                                | Adds a suffix to the session cookie's name. The cookie is scoped to the whole origin, so set this when two Composery instances share one hostname or they will sign each other out.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `COMPOSERY_RECONNECTION_GRACE_TIME`                      | Overrides reconnection grace time in seconds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `COMPOSERY_IDLE_TIMEOUT_SECONDS`                         | Asks the IDE to exit after an idle period. Both init systems restart it immediately, so it drops sessions rather than freeing the instance.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `COMPOSERY_DISABLE_GETTING_STARTED_OVERRIDE`             | Set to `1` or `true` to disable the IDE's Getting Started override.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy` | Sets an outbound HTTP(S) proxy for IDE update and extension-related requests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `LANG`                                                   | Overrides the locale. Defaults to `C.UTF-8`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## IDE sessions

A successful password sign-in and **Continue with Composery** both create the
same local, signed IDE session. Newly issued sessions contain an opaque signed
token rather than the configured password hash. Changing the password
therefore revokes every session without a separate revocation list.

The session cookie is scoped to the whole origin the instance is served on, not
to the path the workbench happens to be mounted at, because the port proxy at
`/proxy/<port>/` is authenticated by the same session and sits outside that
mount. The proxy strips the cookie again before forwarding a request to your
own port, so an app you run on your instance never sees it.

The lifetime is absolute rather than sliding: activity does not extend it.
Changing `COMPOSERY_SESSION_LIFETIME` affects sessions created after the IDE
restarts; it does not rewrite cookies already issued. Once a session expires,
the next authenticated HTTP request or reconnect asks for sign-in. An already
established workbench WebSocket is not cut in the middle of an operation.

`browser` means "every browser session," not "authenticate every HTTP request."
The cookie has no `Max-Age` or `Expires`, so the browser drops it
when that browser session ends. Its signed token still has a 30-day server-side
ceiling in case a client retains session cookies longer than expected.

On a Composery Cloud instance, **Continue with Composery** redirects through the
website so the signed-in owner can prove access, then returns a one-time,
PKCE-bound authorization code to the instance. The website session is never
copied to it, and the code can create only a local IDE session. Password recovery
uses a separately typed code that can create only a one-time password-setup
grant. Self-hosted instances continue to use their own password.

## API

Composery serves a small [automation API](api.mdx) on the same port. It is off in
practice until you mint a key with `composery api key create`; with no keys, every
endpoint returns 401. The key store lives at `<volume>/api/keys.json`, on the persistent
volume shared with persistence (`/data` by default; see `COMPOSERY_DOCKER_VOLUME_PATH`).

| Variable                            | Default    | Use                                                                                                              |
| ----------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `COMPOSERY_DISABLE_API`             | unset      | Set to `1` or `true` to disable the API entirely (every endpoint returns 404).                                   |
| `COMPOSERY_API_TERMINAL_TIMEOUT`    | `60`       | Default timeout in seconds when `POST /_composery/api/v1/terminals` uses `wait: true`. The websocket is unbound. |
| `COMPOSERY_API_TERMINAL_MAX_OUTPUT` | `10485760` | Raw merged pty-output byte cap for a one-shot wait before truncation (10 MiB).                                   |
| `COMPOSERY_API_RATE_RPS`            | `50`       | Sustained requests per second per key.                                                                           |
| `COMPOSERY_API_RATE_BURST`          | `200`      | Burst request capacity per key.                                                                                  |
| `COMPOSERY_API_MAX_SESSIONS`        | `50`       | Concurrent one-shot waits and WebSocket terminal attachments per key.                                            |
| `COMPOSERY_API_AUTH_FAIL_PER_MIN`   | `20`       | Failed-auth attempts per minute per IP before throttling.                                                        |

Invalid numeric values fall back to the defaults. Extreme numeric values are
clamped to guardrail caps: 24h one-shot timeout, 64 MiB one-shot output, 1000 RPS,
10000 burst, 500 concurrent terminal streams, and 1000
failed-auth attempts/min/IP.

Rate limits are abuse rails, not DDoS defense - that is handled by the platform in front
of the instance.

## HTTP routes

The container includes Caddy as its single HTTP entrypoint. `/etc/caddy/Caddyfile` is its
complete, persistent configuration; it is not a generated file or a Composery-specific
fragment. The initial configuration strips the public `/ide/` mount before sending
workbench traffic to the loopback IDE. It keeps `/proxy/*` and `/absproxy/*` at the origin
root so installed PWAs do not capture port applications. The health endpoint,
automation API, and `robots.txt`/`security.txt` files also stay at root; other
root paths return `404`, except `/`, which redirects to `/ide/`.

Add an application handler above the final not-found handler:

```text
handle /hooks/linear* {
	reverse_proxy 127.0.0.1:3000
}
```

Use Caddy's standard commands to check and apply changes in either runtime profile:

```bash
caddy validate --config /etc/caddy/Caddyfile
caddy reload --config /etc/caddy/Caddyfile
```

An invalid reload leaves the running configuration in place. An invalid configuration
at cold start prevents Caddy from starting, just as it would on a VPS. Composery never
replaces the file automatically.

This internal Caddy does not require Caddy at the outer edge. A VPS, ingress controller,
load balancer, tunnel, or another reverse proxy can publish port `8080` directly. The
Compose recipes that include a second Caddy use it only for public TLS and domains.

## SSH

An instance's SSH service is separate from the [API](#api): a different protocol, a
different credential, and settings of its own. See [SSH](ssh.md).

| Variable                         | Default | Use                                                                                                                                                               |
| -------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPOSERY_SSH_CERTIFICATE_DAYS` | `90`    | How long an issued SSH certificate stays valid. Revoking one takes effect at once, so this is the backstop for credentials nobody revisits, not the main control. |
| `COMPOSERY_SSH_ENROLLMENT_TTL`   | `600`   | Seconds an enrollment token stays redeemable. Each token works once.                                                                                              |
