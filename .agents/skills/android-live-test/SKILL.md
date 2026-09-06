---
name: android-live-test
description: Drive the Composery PWA and other mobile-web interfaces in Android Chrome on a physical phone or emulator. Use for live UI reproduction, screenshots, taps, typing, swipes, rotation, accessibility inspection, browser lifecycle control, logs, screen recording, responsive IDE testing, and fix-and-retest loops.
---

# Android live testing

Use `node .agents/skills/android-live-test/scripts/android.mjs <command>` from the repository root. Run it without arguments for the command list.

## Workflow

1. Run `status`. If no device is connected, run `boot` for the installed emulator. For a physical phone, ask the user to enable Developer options and Wireless debugging, then use `pair` and `connect`; pairing requires values shown on the phone.
2. Start the local Composery instance or use a test instance, then open its HTTPS URL with `open-url <url>`.
3. Run `screenshot tmp/<name>.png`, then inspect the image. Use `dump tmp/<name>.xml` when semantic labels or bounds are useful.
4. Interact with `tap`, `swipe`, `text`, and `key`. Prefer accessibility labels and visible text from `dump` when available; use coordinates for browser content the Android hierarchy cannot expose.
5. Capture `logcat` around failures. Use `record` for motion, gesture, or timing bugs.
6. Implement the smallest fix, run relevant unit checks, reload Chrome, and repeat the exact interaction. Preserve before/after screenshots in `tmp/`.

## Persistent emulator browser updates

`boot` deliberately passes `-read-only`, so app installs, Play Store sign-in, and
Chrome updates made during a live-test instance are discarded when it exits.
Maintain the base AVD in a separate, normal writable emulator launch; after shutting
that launch down cleanly, later read-only test instances inherit the updated base.

Follow [EMULATOR-BROWSER.md](EMULATOR-BROWSER.md) to update the Google Play system
image and Chrome and to record the active version.
Never wipe the base AVD merely to update its browser stack.

## Surface selection

- Use direct Android control for system UI, Chrome, installed-PWA chrome, and the IDE inside the browser.
- Use the Codex in-app Browser for the IDE URL when browser DOM inspection, Playwright assertions, or fast responsive viewport coverage is more useful than Android fidelity.
- Test both surfaces for touch, keyboard, viewport inset, standalone display, clipboard, and back navigation.

## Guardrails

- Treat taps that submit, delete, purchase, publish, message, or change real external data as consequential actions and obtain confirmation when required.
- Use a local/test Composery instance and disposable data for destructive flows.
- Do not clear app data, uninstall apps, or reset a physical phone unless the user explicitly requests it.
- Do not commit screenshots, recordings, dumps, or logs; keep them under `tmp/`.
- Never assume a lone device. `status` shows serials; pass `--serial <serial>` (or set `ANDROID_SERIAL`) when multiple devices are attached.
- Parallel agents: one agent per device. `boot` is safe to run concurrently (it picks a free port; the same AVD can run multiple read-only instances) and prints the new serial - pass that serial to every later command. Never send input to a device you did not boot or were not assigned; other devices in `status` may belong to other agents.
