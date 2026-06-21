# Composery Themes

Composery Light and Composery Dark color themes are generated from the shared
theme in `packages/shared/theme.json`.

This ships as a builtin extension inside the Composery IDE release. The
path (`packages/ide/overlay/lib/vscode/extensions/`) is copied straight into the
release tree during the build, so the themes are available with no Dockerfile or
`product.json` changes.

## Layout

- `themes/composery-dark.json`, `themes/composery-light.json` - VS Code
  Dark/Light Modern retints with Composery-specific workbench and syntax colors.
  Diagnostics, Git, diff, and matching ANSI colors share the website's semantic
  status roles.
  Do not edit these files directly; `packages/shared/scripts/theme.mjs`
  generates them.
- The first-paint color snapshot in
  `packages/ide/patches/brand.diff` mirrors these theme files so browser
  startup does not flash stale colors. The same generator updates both.

## Local Testing

1. Press `F5` (the **Test Composery theme** launch config) to open an Extension
   Development Host with this extension loaded.
2. In that window: `Ctrl+K Ctrl+T` -> pick **Composery Dark** or
   **Composery Light**.
3. Edit `packages/shared/theme.json`, run `pnpm fix:assets`, then `Ctrl+R`
   (reload window) to see changes.

Note: with this installed, users who already set `workbench.colorTheme` keep
their chosen theme.
