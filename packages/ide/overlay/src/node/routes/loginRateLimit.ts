import type { Request } from "express"
import { RateLimiter } from "limiter"

type SourceLimit = {
  hour: RateLimiter
  lastSeen: number
  minute: RateLimiter
}

class LoginRateLimit {
  private readonly sources = new Map<string, SourceLimit>()
  private readonly global = new RateLimiter({
    // A high instance-wide ceiling protects Argon2 capacity during a distributed
    // flood without letting one ordinary scanner lock the owner out.
    tokensPerInterval: 10_000,
    interval: "hour",
  })

  constructor() {
    setInterval(() => this.sweep(), 60 * 60_000).unref()
  }

  canTry(source: string) {
    const limit = this.source(source)
    return (
      limit.minute.getTokensRemaining() >= 1 &&
      limit.hour.getTokensRemaining() >= 1 &&
      this.global.getTokensRemaining() >= 1
    )
  }

  recordFailure(source: string) {
    const limit = this.source(source)
    limit.minute.tryRemoveTokens(1)
    limit.hour.tryRemoveTokens(1)
    this.global.tryRemoveTokens(1)
  }

  private source(key: string) {
    if (!this.sources.has(key) && this.sources.size >= 10_000) key = "overflow"
    let limit = this.sources.get(key)
    if (!limit) {
      limit = {
        minute: new RateLimiter({ tokensPerInterval: 5, interval: "minute" }),
        hour: new RateLimiter({ tokensPerInterval: 30, interval: "hour" }),
        lastSeen: Date.now(),
      }
      this.sources.set(key, limit)
    }
    limit.lastSeen = Date.now()
    return limit
  }

  private sweep() {
    const cutoff = Date.now() - 2 * 60 * 60_000
    for (const [source, limit] of this.sources) {
      if (limit.lastSeen < cutoff) this.sources.delete(source)
    }
  }
}

// One budget for every password guess, wherever we offer to check one:
// /login and the current-password step of /change-password are the same oracle,
// so a guess at either has to cost the same token.
export const loginRateLimit = new LoginRateLimit()

// Caddy is the only process able to reach the IDE loopback listener. It appends
// the connecting address to X-Forwarded-For, so the last value cannot be chosen
// by an internet client even if it supplies its own earlier values.
export function loginSource(req: Request) {
  const forwarded = req.headers["x-forwarded-for"]
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const last = value
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1)
  return last || req.socket.remoteAddress || "unknown"
}
