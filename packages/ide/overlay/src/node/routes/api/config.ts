import * as path from "path"

import { envFlag } from "../../envFlag"
import { volumeRoot } from "../../volume"

export const MAX_TERMINAL_TIMEOUT_SEC = 24 * 60 * 60
const MAX_TERMINAL_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_RATE_RPS = 1000
const MAX_RATE_BURST = 10_000
const MAX_SESSIONS = 500
const MAX_AUTH_FAIL_PER_MIN = 1000

function num(name: string, def: number, max: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return def
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : def
}

function int(name: string, def: number, max: number): number {
  const value = Math.floor(num(name, def, max))
  return value > 0 ? value : def
}

export const apiConfig = {
  enabled: !envFlag("COMPOSERY_DISABLE_API"),
  shell: process.env.SHELL || "/bin/bash",
  home: process.env.HOME,
  terminalTimeoutSec: num("COMPOSERY_API_TERMINAL_TIMEOUT", 60, MAX_TERMINAL_TIMEOUT_SEC),
  terminalMaxOutput: int("COMPOSERY_API_TERMINAL_MAX_OUTPUT", 10 * 1024 * 1024, MAX_TERMINAL_OUTPUT_BYTES),
  rateRps: num("COMPOSERY_API_RATE_RPS", 50, MAX_RATE_RPS),
  rateBurst: int("COMPOSERY_API_RATE_BURST", 200, MAX_RATE_BURST),
  maxSessions: int("COMPOSERY_API_MAX_SESSIONS", 50, MAX_SESSIONS),
  authFailPerMin: int("COMPOSERY_API_AUTH_FAIL_PER_MIN", 20, MAX_AUTH_FAIL_PER_MIN),
}

// Cross-language contract: volume root, `api/keys.json` path, and JSON shape must match Rust keystore.rs.
export function keysPath(): string {
  return path.join(volumeRoot(), "api", "keys.json")
}
