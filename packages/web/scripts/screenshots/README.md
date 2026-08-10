# Marketing screenshots

Generates the product shots in
[`../../public/marketing/`](../../public/marketing) - used by the homepage and
the repo README. Each is captured from a real, running Composery instance, then
framed on a faithful **14" MacBook Pro** (desktop) or **iPhone 17 Pro** (mobile)
glass front and written out in a light and a dark UI variant.

```
composery-ide-{dark,light}.png       hero: morning brief + Claude Code working
composery-mobile-{dark,light}.png    phone trio: welcome, Claude Code being
                                     typed to over the iOS keyboard, the
                                     overnight results brief
composery-welcome-{dark,light}.png   the branded welcome / agent picker
composery-editor-{dark,light}.png    a real automation open in the editor
```

## How it works

1. **Capture** ([`capture-desktop.mjs`](capture-desktop.mjs),
   [`capture-mobile.mjs`](capture-mobile.mjs)) drive the instance with Playwright
   and screenshot the raw workbench into `raw/<theme>/`.
2. **Frame** ([`frame.mjs`](frame.mjs)) wraps each capture in a device front. All
   geometry is measured off Apple's own screenshots and specs - real SF Pro
   text, real SF Symbols glyphs. Desktop: a 14" MacBook Pro display (1512x982
   pt, notch, transparent Tahoe menu bar, the real Tahoe wallpaper) with the
   capture in a faithful Safari 26 window. Mobile: an iPhone 17 Pro (402x874 pt
   display, 62 pt corners, 1.44 mm bezel, Dynamic Island); the terminal shot
   adds the iOS 26 keyboard, measured key-by-key from Apple's own screenshot,
   below the keyboard-height viewport it was captured at.
3. **Finalize** ([`finalize.mjs`](finalize.mjs)) builds the phone trios and copies
   the eight named assets into `../../public/marketing/`.

The iPhone keyboard targets the current public iOS 26 design. Its geometry and
materials are cross-checked against Apple's iOS UI kit and native-scale iPhone
17 Pro press imagery. The terminal variant intentionally has lowercase legends
and an empty QuickType area because xterm disables autocorrection,
autocapitalization, and spellchecking on its helper textarea.

`raw/` is committed source material so the published screenshots can be rebuilt
from a fresh clone without reproducing the live IDE and agent session. `out/`
is generated and gitignored. The Apple-licensed `fonts/` and `wallpapers/` are
also gitignored and fetched on demand by `fonts.sh`.

Paths are resolved relative to this folder, so the commands below work from any
directory. They assume the capture instance is on `http://localhost:9911/ide/`
(override with `COMPOSERY_URL`) - its own port, so `pnpm dev:docker` (8080) can
keep running.

## One-time setup

- **Fonts + wallpapers.** `bash fonts.sh` fetches SF Pro + SF Symbols from
  Apple into `fonts/` and the Tahoe wallpaper into `wallpapers/`
  (Apple-licensed, so never committed). Needs 7-Zip.
- **Node + Chromium.** Run `pnpm install`, then `pnpm --filter web exec
playwright install chromium`. The latter downloads the Chromium revision
  pinned by the repository's Playwright dependency.
- **A demo instance** on `:9911` with a fresh volume:
  ```bash
  docker run -d --name composery-shots -p 9911:8080 \
    -v composery_shots_data:/data composery-composery:latest
  ```
  Open http://localhost:9911/ide/, register the password (`example123`, or set
  `COMPOSERY_PASSWORD`), then, from this folder:
  ```bash
  export MSYS_NO_PATHCONV=true   # git-bash only
  docker cp demo/workspace.sh composery-shots:/tmp/workspace.sh
  docker exec -u user composery-shots bash /tmp/workspace.sh
  docker cp demo/prepare.sh composery-shots:/tmp/prepare.sh
  docker exec -u user composery-shots bash /tmp/prepare.sh
  ```
- **Claude Code.** Install and authenticate it inside the instance (run `claude`
  in a terminal and sign in). The shots use Fable 5.

## Regenerate

To rebuild the committed marketing assets from the committed raw captures on a
fresh clone:

```bash
pnpm install
pnpm --filter web exec playwright install chromium
bash fonts.sh                      # once; downloads Apple-licensed frame assets
node frame.mjs
node finalize.mjs
```

To replace the raw captures from a prepared live instance and then rebuild the
marketing assets:

```bash
bash run.sh                        # all four devices x themes, then frame + finalize
```

Or a single frame while iterating on the framing:

```bash
node capture-desktop.mjs dark
node frame.mjs && node finalize.mjs
```

## What is capture-only vs shipped

The [`demo/`](demo) scripts shape a throwaway instance and **do not ship**: they
force the terminal's DOM renderer (a headless-capture DPI quirk), default Claude
to Fable 5, keep it in the terminal rather than the editor, and hide VS Code's
own onboarding walkthroughs.

Fixes found while shooting that _are_ real product improvements live in the repo
proper, not here: the terminal `lineHeight` that was clipping TUI block art
(`rootfs/.../settings.json`) and the narrow-viewport title-bar logo and Welcome
spacing (`packages/ide/overlay/.../narrow.css`).
