#!/usr/bin/env bash
# Reset the demo instance between captures: a fresh Claude conversation, no
# resumed history, no editor extension, and the workspace back to its committed
# state. Run via `bash -c` (NOT `bash -lc`) so the `pkill -f 'bash -l'` below
# does not match - and kill - this very shell.
#
#   docker exec -u user <container> bash /tmp/reset.sh
#
# No `-e`, unlike the other scripts here: every teardown step below is expected
# to fail on an already-clean instance (pkill exits 1 when nothing matched), and
# a reset that stopped at the first of those would leave the rest of the state
# behind.
set -uo pipefail

pkill -9 -f claude 2>/dev/null
pkill -9 -f 'bash -l' 2>/dev/null   # the server-side ptys Composery keeps alive
sleep 2

rm -rf "$HOME/.claude/projects" "$HOME/.claude/sessions" \
       "$HOME/.claude/history.jsonl" "$HOME/.claude/todos"
python3 - <<'PY'
import json
p = "/home/user/.claude.json"
d = json.load(open(p))
d["projects"] = {}
json.dump(d, open(p, "w"))
PY

rm -rf "$HOME/.local/share/composery/extensions/anthropic.claude-code-"*
echo "[]" > "$HOME/.local/share/composery/extensions/extensions.json"
rm -rf "$HOME/.local/share/composery/User/workspaceStorage"

cd "$HOME/workspace" || exit 1
rm -rf drafts
git clean -qfd
git checkout -- .
echo "reset ok"
