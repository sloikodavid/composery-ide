import { Router } from "express"
import { RateLimiter } from "limiter"

// Server-side k-anonymity relay for the client breach check. The browser sends
// only the 5-hex SHA-1 prefix (and still matches the returned suffixes locally);
// the server makes the actual range request to the breach API. This is why the
// check no longer hangs: the auth page talks only to its own origin, so it does
// not depend on the user's browser reaching a third-party API cross-origin
// (blocked or dropped behind strict networks and insecure contexts). The server
// has reliable egress; one that genuinely cannot reach the API answers 502
// and the client proceeds unchecked. Mounted at /_composery/pwned alongside the
// pages that use it, so it exists exactly when they do.
const RANGE_PREFIX = /^[A-F0-9]{5}$/
const rangeLimit = new RateLimiter({
  tokensPerInterval: 120,
  interval: "minute",
})

export const router = Router()

router.get("/:prefix", async (req, res) => {
  const prefix = req.params.prefix.toUpperCase()
  if (!RANGE_PREFIX.test(prefix)) {
    return res.status(400).end()
  }
  if (!rangeLimit.tryRemoveTokens(1)) {
    return res.status(429).end()
  }
  try {
    const upstream = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true" },
      signal: AbortSignal.timeout(6000),
    })
    if (!upstream.ok) {
      return res.status(502).end()
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("Referrer-Policy", "no-referrer")
    return res.send(await upstream.text())
  } catch {
    return res.status(502).end()
  }
})
