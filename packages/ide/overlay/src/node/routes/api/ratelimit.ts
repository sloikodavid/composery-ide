import { apiConfig } from "./config"

class TokenBucket {
  private tokens: number
  private last: number
  private lastSeen: number
  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    const now = Date.now()
    this.tokens = burst
    this.last = now
    this.lastSeen = now
  }
  private refill(now: number): void {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate)
    this.last = now
  }
  allow(cost = 1): boolean {
    const now = Date.now()
    this.refill(now)
    this.lastSeen = now
    if (this.tokens >= cost) {
      this.tokens -= cost
      return true
    }
    return false
  }
  isIdle(now: number, idleMs: number): boolean {
    this.refill(now)
    return now - this.lastSeen >= idleMs && this.tokens >= this.burst
  }
}

class KeyedRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>()
  private readonly idleMs = 5 * 60_000
  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    setInterval(() => this.sweep(), 60_000).unref()
  }
  allow(key: string): boolean {
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = new TokenBucket(this.rate, this.burst)
      this.buckets.set(key, bucket)
    }
    return bucket.allow()
  }
  private sweep(): void {
    const now = Date.now()
    for (const [key, bucket] of this.buckets) {
      if (bucket.isIdle(now, this.idleMs)) this.buckets.delete(key)
    }
  }
}

class FailWindow {
  private readonly hits = new Map<string, number[]>()
  // A timer sweeps expired entries so distinct source IPs can't accumulate forever.
  constructor(private readonly perMinute: number) {
    setInterval(() => this.sweep(), 60_000).unref()
  }
  private recentFor(ip: string): number[] {
    return (this.hits.get(ip) || []).filter((t) => Date.now() - t < 60_000)
  }
  private sweep(): void {
    for (const ip of [...this.hits.keys()]) {
      const recent = this.recentFor(ip)
      if (recent.length === 0) this.hits.delete(ip)
      else this.hits.set(ip, recent)
    }
  }
  allow(ip: string): boolean {
    return this.recentFor(ip).length < this.perMinute
  }
  record(ip: string): void {
    const recent = this.recentFor(ip)
    recent.push(Date.now())
    this.hits.set(ip, recent)
  }
}

class SlotLimiter {
  private readonly counts = new Map<string, number>()
  constructor(private readonly max: number) {}
  tryAcquire(key = "global"): boolean {
    const current = this.counts.get(key) || 0
    if (current >= this.max) return false
    this.counts.set(key, current + 1)
    return true
  }
  release(key = "global"): void {
    const current = this.counts.get(key) || 0
    if (current <= 1) this.counts.delete(key)
    else this.counts.set(key, current - 1)
  }
}

export const rateLimit = new KeyedRateLimiter(apiConfig.rateRps, apiConfig.rateBurst)
export const authFail = new FailWindow(apiConfig.authFailPerMin)
export const sessions = new SlotLimiter(apiConfig.maxSessions)
