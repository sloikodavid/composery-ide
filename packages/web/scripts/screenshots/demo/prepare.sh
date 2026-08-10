#!/usr/bin/env bash
# Capture-only tweaks applied INSIDE the container. None of this ships to real
# users - it just makes a throwaway demo instance shoot cleanly. Product-level
# fixes (terminal lineHeight, the narrow-viewport title-bar logo) live in the
# repo proper (rootfs/ and packages/ide/overlay/).
#
# Assumes Claude Code is installed and authenticated (see screenshots/README.md).
#
#   docker cp screenshots/demo/prepare.sh <container>:/tmp/prepare.sh
#   docker exec -u user <container> bash /tmp/prepare.sh
set -euo pipefail

WB="$HOME/.local/share/composery/User/settings.json"
python3 - "$WB" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
# Headless Chromium at 2x/3x makes xterm double-apply devicePixelRatio; the DOM
# renderer sidesteps it. (Real users keep the default GPU renderer.)
d["terminal.integrated.gpuAcceleration"] = "off"
# The Welcome page is ours; hide VS Code's own onboarding walkthroughs.
d["workbench.welcomePage.walkthroughs.openOnInstall"] = False
d["workbench.welcomePage.hiddenCategories"] = ["Setup", "SetupWeb", "Beginner"]
json.dump(d, open(p, "w"), indent="\t")
print("workbench settings updated")
PY

CC="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"
[ -f "$CC" ] || echo '{}' > "$CC"
python3 - "$CC" <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
s["model"] = "claude-fable-5"          # bare `claude` runs Fable 5, no flag
s["tui"] = "fullscreen"                # fill the terminal pane
s["autoConnectIde"] = False
s["autoInstallIdeExtension"] = False   # keep Claude in the terminal, not the editor
s["diffTool"] = "terminal"
s.setdefault("env", {})["CLAUDE_CODE_AUTO_CONNECT_IDE"] = "0"
# No fetched startup announcements (usage-limit promos crowd the phone shot).
s["env"]["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
s.setdefault("permissions", {})["allow"] = [
    "Read(//home/user/workspace/**)",
    "Write(//home/user/workspace/**)",
    "Edit(//home/user/workspace/**)",
    "Bash",
]
json.dump(s, open(p, "w"), indent=2)
print("claude settings updated")
PY

# Even with autoInstallIdeExtension off, `claude` shells out to
# `code --install-extension` when it detects VS Code. Shadow `code` to drop that
# one call (the clipboard bridge uses `code` for everything else).
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/code" <<'EOF'
#!/usr/bin/env bash
for arg in "$@"; do [ "$arg" = "--install-extension" ] && exit 0; done
exec /usr/local/bin/code "$@"
EOF
chmod +x "$HOME/.local/bin/code"

# Clean shell prompt, and hide the VS Code env from Claude so it stays terminal-only.
if ! grep -q "COMPOSERY_DEMO" "$HOME/.bashrc"; then
cat >> "$HOME/.bashrc" <<'EOF'

# COMPOSERY_DEMO (capture-only)
export PATH="$HOME/.local/bin:$PATH"
export PS1="\[\033[38;5;75m\]user@composery\[\033[0m\]:\[\033[38;5;248m\]\w\[\033[0m\]\$ "
unset TERM_PROGRAM TERM_PROGRAM_VERSION VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE \
      VSCODE_GIT_ASKPASS_MAIN VSCODE_GIT_ASKPASS_NODE VSCODE_INJECTION VSCODE_NONCE
EOF
fi

rm -rf "$HOME/.local/share/composery/extensions/anthropic.claude-code-"*
echo "[]" > "$HOME/.local/share/composery/extensions/extensions.json"
echo "prepared"
