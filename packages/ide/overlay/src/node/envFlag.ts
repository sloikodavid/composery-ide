/**
 * One reading of a boolean environment variable, for every switch Composery
 * documents as "set to 1 or true".
 *
 * There were four of these before this module: upstream's bare
 * `?.match(/^(1|true)$/)` on the inherited disable flags, a trimming and
 * case-folding `disabled()` in the API config, a third copy in the API
 * extension, and a fourth in shell. `COMPOSERY_DISABLE_API=TRUE` turned the API
 * off while `COMPOSERY_DISABLE_AUTH=TRUE` quietly left sign-in required - one
 * sentence in docs/configuration.md, four answers.
 *
 * Trimmed and case-insensitive, because `TRUE` and a value that picked up a
 * space from an env file are the operator saying yes, not a typo. Everything
 * else - `yes`, `0`, `on`, `t rue`, empty - is off, so a value nobody meant
 * fails towards leaving the instance as it was rather than towards flipping a
 * switch on its own.
 *
 * Anything that cannot import this module carries the same rule spelled out at
 * its own site: the API extension ships into the VS Code extension host, and
 * rootfs/opt/composery/remove-password.sh is shell. Those two copies are pinned
 * back to this one by packages/ide/tests/invariants/env-flags.test.ts and
 * tests/invariants/runtime-init.test.ts respectively.
 */
export function envFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  return raw === "1" || raw === "true"
}
