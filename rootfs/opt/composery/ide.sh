#!/usr/bin/env bash
set -euo pipefail

workspace="${HOME:-/home/user}/Desktop"
mkdir -p "$workspace"

# Upstream gives these environment variables precedence over --bind-addr.
# They belong to the public ingress now; never let the IDE contend for that
# port or escape its loopback boundary.
unset PORT COMPOSERY_HOST

exec /usr/local/bin/ide \
  --bind-addr "127.0.0.1:${COMPOSERY_IDE_PORT:-8081}" \
  "$workspace"
