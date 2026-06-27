#!/usr/bin/env bash
set -euo pipefail

# No logind here, so create the user's XDG_RUNTIME_DIR ourselves (systemd mode
# does this from ide.service instead).
install -d -m 0755 /run/user
install -d -m 0700 -o user -g user /run/user/1000
install -d -m 0700 -o user -g user /run/caddy

exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
