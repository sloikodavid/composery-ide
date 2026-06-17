import * as crypto from "crypto"
import { constants, promises as fs } from "fs"
import { keysPath } from "./config"

// Cross-language contract: path, JSON shape, and "sha256:" + hex hashing must stay identical to Rust keystore.rs.

interface KeyRecord {
  id: string
  name: string
  prefix: string
  hash: string
  created_at: number
}

interface KeyStore {
  version: number
  keys: KeyRecord[]
}

function hashSecret(secret: string): string {
  return "sha256:" + crypto.createHash("sha256").update(secret).digest("hex")
}

let cache: { store: KeyStore; mtimeMs: number; size: number } | undefined

function parseStore(contents: string): KeyStore {
  const value = JSON.parse(contents) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("key store must be an object")
  }
  const store = value as Partial<KeyStore>
  if (typeof store.version !== "number" || !Array.isArray(store.keys)) {
    throw new Error("key store has invalid shape")
  }
  for (const key of store.keys) {
    if (
      !key ||
      typeof key !== "object" ||
      Array.isArray(key) ||
      typeof key.id !== "string" ||
      typeof key.name !== "string" ||
      typeof key.prefix !== "string" ||
      typeof key.hash !== "string" ||
      typeof key.created_at !== "number"
    ) {
      throw new Error("key store has invalid key record")
    }
  }
  return store as KeyStore
}

async function readStore(): Promise<KeyStore> {
  const file = keysPath()
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error("key store must be a real file")
      if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
        return cache.store
      }
      const store = parseStore(await handle.readFile("utf8"))
      cache = { store, mtimeMs: stat.mtimeMs, size: stat.size }
      return store
    } finally {
      await handle.close()
    }
  } catch (error: any) {
    if (error.code === "ENOENT") {
      cache = undefined
      return { version: 1, keys: [] }
    }
    throw error
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export async function verifyKey(secret: string): Promise<string | undefined> {
  if (!secret) return undefined
  const presented = hashSecret(secret)
  const store = await readStore()
  for (const key of store.keys) {
    if (timingSafeEqualStr(key.hash, presented)) {
      return key.id
    }
  }
  return undefined
}
