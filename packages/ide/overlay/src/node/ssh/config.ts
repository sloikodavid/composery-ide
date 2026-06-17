// What the instance's SSH surface is allowed to do, read from the environment its
// owner controls.
//
// Separate from the automation API's config on purpose. SSH is a different
// surface with a different protocol, a different credential and a different
// audience; sharing a settings module is how two things start being described as
// one. The clamping rule is the same one every owner-settable bound here follows:
// the owner is root on their own instance, so each value is bounded rather than
// trusted, and nothing may silently turn a limit off.
import { volumeRoot } from "../volume"

const MAX_CERTIFICATE_DAYS = 3650
const MAX_ENROLLMENT_TTL_SEC = 60 * 60

function int(name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Math.floor(Number(raw))
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback
}

export const sshConfig = {
  dataRoot: volumeRoot(),
  // Ninety days, with revocation as the lever that actually protects an instance.
  // Short-lived certificates are the textbook answer, but they make somebody who
  // wanted a working laptop re-run setup every few hours; a serial that can be
  // revoked the moment a device is lost is both kinder and faster than waiting
  // for an expiry. The expiry is the backstop for credentials nobody revisits.
  certificateDays: int("COMPOSERY_SSH_CERTIFICATE_DAYS", 90, MAX_CERTIFICATE_DAYS),
  // Long enough to paste a prompt and let an agent work, short enough that a
  // token seen in a chat log is worthless by the time anybody reads it.
  enrollmentTtlSec: int("COMPOSERY_SSH_ENROLLMENT_TTL", 600, MAX_ENROLLMENT_TTL_SEC),
}
