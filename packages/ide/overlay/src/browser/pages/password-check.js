;(() => {
  // The breach range request goes to this Composery's own origin (pwned.ts relays it
  // to the range API server-side), so the page never makes a cross-origin
  // request. The relative root comes from the auth shell, which is the only
  // thing that knows how deep the public mount put this page.
  const rangeBase = (typeof document !== "undefined" && document.querySelector(".page")?.dataset.base) || "."

  const commonParts = ["123456", "abcdef", "admin", "composery", "iloveyou", "letmein", "password", "qwerty", "welcome"]

  function checkStrength(password) {
    const normalized = password.toLowerCase()
    const categories = [
      /[a-z]/.test(password),
      /[A-Z]/.test(password),
      /\d/.test(password),
      /[^A-Za-z0-9]/.test(password),
    ].filter(Boolean).length
    const uniqueCharacters = new Set(password).size
    const hasCommonPart = commonParts.some((part) => normalized.includes(part))
    const hasLongRepeat = /(.)\1{3,}/.test(password)

    if (password.length < 12) {
      return { ok: false, message: "Too short" }
    }
    if (hasCommonPart) {
      return { ok: false, message: "Too common" }
    }
    if (hasLongRepeat || uniqueCharacters < 6) {
      return { ok: false, message: "Too repetitive" }
    }

    const ok =
      password.length >= 20 || (password.length >= 14 && categories >= 2) || (password.length >= 12 && categories >= 3)

    return {
      ok,
      message: ok ? "" : "A little weak",
    }
  }

  function hex(bytes) {
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  }

  // SHA-1 per FIPS 180-4, used only to derive the k-anonymity prefix for the
  // Pwned Passwords range API. crypto.subtle exists only in secure contexts,
  // so instances reached over plain HTTP (LAN IPs, TLS-less self-hosting) need
  // this fallback for the breach check to work at all.
  function sha1HexFallback(bytes) {
    const length = bytes.length
    const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6)
    padded.set(bytes)
    padded[length] = 0x80
    const view = new DataView(padded.buffer)
    view.setUint32(padded.length - 8, length >>> 29)
    view.setUint32(padded.length - 4, (length << 3) >>> 0)

    const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]
    const words = new Uint32Array(80)
    for (let block = 0; block < padded.length; block += 64) {
      for (let i = 0; i < 16; i++) words[i] = view.getUint32(block + i * 4)
      for (let i = 16; i < 80; i++) {
        const word = words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16]
        words[i] = (word << 1) | (word >>> 31)
      }
      let [a, b, c, d, e] = state
      for (let i = 0; i < 80; i++) {
        const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d
        const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6
        const next = (((a << 5) | (a >>> 27)) + f + e + k + words[i]) >>> 0
        e = d
        d = c
        c = ((b << 30) | (b >>> 2)) >>> 0
        b = a
        a = next
      }
      state[0] = (state[0] + a) >>> 0
      state[1] = (state[1] + b) >>> 0
      state[2] = (state[2] + c) >>> 0
      state[3] = (state[3] + d) >>> 0
      state[4] = (state[4] + e) >>> 0
    }
    return state
      .map((word) => word.toString(16).padStart(8, "0"))
      .join("")
      .toUpperCase()
  }

  async function sha1Hex(bytes) {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)))
    }
    return sha1HexFallback(bytes)
  }

  async function checkPwned(password, signal) {
    const hash = await sha1Hex(new TextEncoder().encode(password))
    const prefix = hash.slice(0, 5)
    const suffix = hash.slice(5)
    // Only the prefix leaves the browser; the server adds "Add-Padding" and does
    // the cross-origin fetch. Same-origin here means CSP 'self' is enough and
    // there is nothing to block or hang.
    const response = await fetch(`${rangeBase}/_composery/pwned/${prefix}`, {
      signal,
    })
    if (!response.ok) throw new Error("Pwned Passwords check failed")

    for (const line of (await response.text()).split("\n")) {
      const [candidate, count] = line.trim().split(":")
      if (candidate?.toUpperCase() === suffix) {
        return Number.parseInt(count ?? "0", 10) || 0
      }
    }
    return 0
  }

  window.composeryPasswordCheck = { checkPwned, checkStrength }
})()
