import * as crypto from "crypto"

type PasswordArgs = {
  password?: string
  "hashed-password"?: string
}

export type SessionCookieOptions = {
  domain?: string
  httpOnly?: boolean
  maxAge?: number
  path?: string
  sameSite?: boolean | "lax" | "strict" | "none"
  secure?: boolean
}

type SessionRequest = {
  args: PasswordArgs
  cookieSessionName: string
}

type SessionResponse = {
  cookie: (name: string, value: string, options: SessionCookieOptions) => unknown
}

export const SESSION_LIFETIMES = {
  browser: { maxAgeSec: 30 * 24 * 60 * 60, persistent: false },
  "8h": { maxAgeSec: 8 * 60 * 60, persistent: true },
  "1d": { maxAgeSec: 24 * 60 * 60, persistent: true },
  "7d": { maxAgeSec: 7 * 24 * 60 * 60, persistent: true },
  "30d": { maxAgeSec: 30 * 24 * 60 * 60, persistent: true },
} as const

export type SessionLifetime = keyof typeof SESSION_LIFETIMES

export function readSessionLifetime(value = process.env.COMPOSERY_SESSION_LIFETIME): SessionLifetime {
  const lifetime = value?.trim() || "8h"
  if (Object.prototype.hasOwnProperty.call(SESSION_LIFETIMES, lifetime)) {
    return lifetime as SessionLifetime
  }
  throw new Error(`COMPOSERY_SESSION_LIFETIME must be one of ${Object.keys(SESSION_LIFETIMES).join(", ")}`)
}

export const sessionLifetime = readSessionLifetime()

function credential(args: PasswordArgs): string | undefined {
  return args["hashed-password"] || args.password
}

function signingKey(value: string): Buffer {
  return crypto.createHash("sha256").update("composery session\0").update(value).digest()
}

function signature(payload: string, value: string): string {
  return crypto.createHmac("sha256", signingKey(value)).update(payload).digest("base64url")
}

export function createSessionToken(
  args: PasswordArgs,
  now = Date.now(),
  nonce = crypto.randomBytes(32).toString("base64url"),
  lifetime = sessionLifetime,
): string {
  const value = credential(args)
  if (!value) throw new Error("Cannot create a session without a password")
  const issuedAt = Math.floor(now / 1000)
  const expiresAt = issuedAt + SESSION_LIFETIMES[lifetime].maxAgeSec
  const payload = `v1.${issuedAt}.${expiresAt}.${nonce}`
  return `${payload}.${signature(payload, value)}`
}

export function isSessionTokenValid(token: string, args: PasswordArgs, now = Date.now()): boolean {
  const value = credential(args)
  if (!value) return false
  const match = /^v1\.(\d{1,12})\.(\d{1,12})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(token)
  if (!match) return false

  const [, issuedAtValue, expiresAtValue, nonce, presentedSignature] = match
  if (!issuedAtValue || !expiresAtValue || !nonce || !presentedSignature) {
    return false
  }
  const issuedAt = Number(issuedAtValue)
  const expiresAt = Number(expiresAtValue)
  const nowSec = Math.floor(now / 1000)
  // A one-minute clock-skew allowance prevents a slightly fast issuer clock
  // from rejecting its own fresh token. Thirty days is the structural ceiling
  // for every policy, including a browser session that stays open indefinitely.
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt > nowSec + 60 ||
    expiresAt <= nowSec ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > SESSION_LIFETIMES["30d"].maxAgeSec
  ) {
    return false
  }

  const payload = `v1.${issuedAt}.${expiresAt}.${nonce}`
  const expected = Buffer.from(signature(payload, value), "base64url")
  const presented = Buffer.from(presentedSignature, "base64url")
  return expected.length === presented.length && crypto.timingSafeEqual(expected, presented)
}

export function setSessionCookie(req: SessionRequest, res: SessionResponse, baseOptions: SessionCookieOptions): void {
  res.cookie(req.cookieSessionName, createSessionToken(req.args), sessionCookieOptions(baseOptions))
}

export function sessionCookieOptions(
  baseOptions: SessionCookieOptions,
  lifetime = sessionLifetime,
): SessionCookieOptions {
  const policy = SESSION_LIFETIMES[lifetime]
  const options: SessionCookieOptions = {
    ...baseOptions,
    httpOnly: true,
  }
  if (policy.persistent) {
    options.maxAge = policy.maxAgeSec * 1000
  }
  return options
}
