#!/usr/bin/env bash
# Regenerate every marketing screenshot. Assumes the container is already
# prepared (demo/workspace.sh + demo/prepare.sh) and Claude Code is
# authenticated. See README.md for the one-time setup.
#
#   bash screenshots/run.sh [container-name]
set -euo pipefail
cd "$(dirname "$0")"
export MSYS_NO_PATHCONV=true   # keep git-bash from mangling the container :/tmp path
C="${1:-composery-shots}"

docker cp demo/reset.sh "$C:/tmp/reset.sh"
reset() { docker exec -u user "$C" bash /tmp/reset.sh >/dev/null 2>&1; sleep 2; }

for theme in dark light; do
	reset; node capture-desktop.mjs "$theme"
	reset; node capture-mobile.mjs "$theme"
done

node frame.mjs
node finalize.mjs
echo "marketing assets regenerated in packages/web/public/marketing/"
