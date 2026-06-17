import { execFile } from "child_process"
import * as crypto from "crypto"
import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"

import { sshConfig } from "./config"

const run = promisify(execFile)

// Cross-language contract: these paths are created and owned by ssh.sh at boot.
// Nothing here creates the CA - an instance that has not booted its SSH service
// has no authority to sign with, and inventing one here would produce
// certificates sshd was never told to trust.
export function sshDir(): string {
  return path.join(sshConfig.dataRoot, "ssh")
}
export function caPath(): string {
  return path.join(sshDir(), "ca")
}
export function certificatesPath(): string {
  return path.join(sshDir(), "certificates.json")
}

export interface CertificateRecord {
  serial: number
  name: string
  created_at: number
  expires_at: number
  revoked_at?: number
}

interface CertificateStore {
  version: number
  certificates: CertificateRecord[]
}

const EMPTY_STORE: CertificateStore = { version: 1, certificates: [] }

// A public key as OpenSSH writes it. Anchored and length-bounded because this
// value reaches ssh-keygen through a file: execFile takes no shell, so the risk is
// not injection but a caller storing arbitrary bytes in the instance's own state.
const PUBLIC_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/]+={0,3}(\s+\S.*)?$/

// The certificate's key id, which is what a person reads when deciding what to
// revoke. Kept to characters that survive a log line and ssh-keygen's own -I.
const NAME = /^[A-Za-z0-9 ._@-]{1,64}$/

export function isValidPublicKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && PUBLIC_KEY.test(value.trim())
}

export function isValidName(value: unknown): value is string {
  return typeof value === "string" && NAME.test(value.trim())
}

export function parseStore(contents: string): CertificateStore {
  const value = JSON.parse(contents) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("certificate store must be an object")
  }
  const store = value as Partial<CertificateStore>
  if (typeof store.version !== "number" || !Array.isArray(store.certificates)) {
    throw new Error("certificate store has invalid shape")
  }
  return store as CertificateStore
}

async function readStore(): Promise<CertificateStore> {
  try {
    return parseStore(await fs.readFile(certificatesPath(), "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_STORE, certificates: [] }
    throw error
  }
}

async function writeStore(store: CertificateStore): Promise<void> {
  const file = certificatesPath()
  const temporary = `${file}.${crypto.randomBytes(6).toString("hex")}`
  await fs.writeFile(temporary, JSON.stringify(store, null, 2), { mode: 0o600 })
  await fs.rename(temporary, file)
}

// Serials are the unit of revocation, so they must never be reused: a recycled
// serial would silently re-revoke a live certificate, or un-revoke a dead one.
// Taking one past the highest ever issued keeps that true even after a record is
// removed by hand.
export function nextSerial(certificates: readonly CertificateRecord[]): number {
  return certificates.reduce((highest, record) => Math.max(highest, record.serial), 0) + 1
}

export async function issueCertificate(
  publicKey: string,
  name: string,
  days: number = sshConfig.certificateDays,
): Promise<{ certificate: string; record: CertificateRecord }> {
  const store = await readStore()
  const serial = nextSerial(store.certificates)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "composery-ssh-"))
  const keyFile = path.join(directory, "id.pub")

  try {
    await fs.writeFile(keyFile, `${publicKey.trim()}\n`, { mode: 0o600 })
    await run("ssh-keygen", [
      "-q",
      "-s",
      caPath(),
      "-I",
      name.trim(),
      // The account every certificate is for. sshd matches this against the login
      // name, so a certificate cannot be replayed against another account even if
      // one is ever added.
      "-n",
      "user",
      "-V",
      `-5m:+${days}d`,
      "-z",
      String(serial),
      keyFile,
    ])
    const certificate = await fs.readFile(path.join(directory, "id-cert.pub"), "utf8")
    const now = Date.now()
    const record: CertificateRecord = {
      serial,
      name: name.trim(),
      created_at: now,
      expires_at: now + days * 24 * 60 * 60 * 1000,
    }
    await writeStore({ ...store, certificates: [...store.certificates, record] })
    return { certificate: certificate.trim(), record }
  } finally {
    await fs.rm(directory, { force: true, recursive: true })
  }
}

// Enrollment tokens, stored hashed on the volume.
//
// They have to be persisted, and the reason is structural rather than a
// preference: the editor's extension host mints one and the server process
// redeems it, and those are different processes. An in-memory map would mint a
// token nothing could ever redeem - a feature that looks implemented and works
// for nobody.
//
// Only the SHA-256 hash is written, exactly as the API key store does it, so the
// file holds no usable credential and a reader of the volume gains nothing. What
// survives a restart is therefore a claim check, not a secret.
interface Enrollment {
  expires_at: number
  name: string
}

interface EnrollmentRecord extends Enrollment {
  hash: string
}

export function enrollmentsPath(): string {
  return path.join(sshDir(), "enrollments.json")
}

export function hashToken(token: string): string {
  return "sha256:" + crypto.createHash("sha256").update(token).digest("hex")
}

async function readEnrollments(): Promise<EnrollmentRecord[]> {
  try {
    const value = JSON.parse(await fs.readFile(enrollmentsPath(), "utf8")) as unknown
    return Array.isArray(value) ? (value as EnrollmentRecord[]) : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

async function writeEnrollments(records: readonly EnrollmentRecord[]): Promise<void> {
  const file = enrollmentsPath()
  const temporary = `${file}.${crypto.randomBytes(6).toString("hex")}`
  await fs.writeFile(temporary, JSON.stringify(records), { mode: 0o600 })
  await fs.rename(temporary, file)
}

// Expired records are dropped on every read and write, so the file cannot grow
// without bound no matter how many prompts somebody copies.
export function liveEnrollments(records: readonly EnrollmentRecord[], now: number): EnrollmentRecord[] {
  return records.filter((record) => record.expires_at > now)
}

export async function mintEnrollment(
  name: string,
  now: number = Date.now(),
): Promise<{ token: string; expires_at: number }> {
  const token = `composery_ssh_${crypto.randomBytes(24).toString("base64url")}`
  const expires_at = now + sshConfig.enrollmentTtlSec * 1000
  const records = liveEnrollments(await readEnrollments(), now)
  await writeEnrollments([...records, { expires_at, hash: hashToken(token), name }])
  return { token, expires_at }
}

export async function redeemEnrollment(token: unknown, now: number = Date.now()): Promise<Enrollment | undefined> {
  if (typeof token !== "string" || !token) return undefined
  const records = liveEnrollments(await readEnrollments(), now)
  const hash = hashToken(token)
  const found = records.find((record) => record.hash === hash)
  // Written back without this record before anything downstream can fail. A token
  // that survived a failed issue would be a second chance for whoever intercepted
  // it, so the delete happens first and the caller retries with a fresh one.
  await writeEnrollments(records.filter((record) => record.hash !== hash))
  if (!found) return undefined
  return { expires_at: found.expires_at, name: found.name }
}

export async function hostFingerprint(): Promise<string> {
  const { stdout } = await run("ssh-keygen", ["-lf", "/etc/ssh/ssh_host_ed25519_key.pub"])
  return stdout.trim()
}

export async function authorityPublicKey(): Promise<string> {
  return (await fs.readFile(`${caPath()}.pub`, "utf8")).trim()
}
