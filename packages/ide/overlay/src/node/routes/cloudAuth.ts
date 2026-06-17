import * as crypto from "crypto"
import { Router, type Request, type Response } from "express"
import { AuthType } from "../cli"
import { cloudConfig } from "../cloud"
import { constructRedirectPath, getCookieOptions, redirect } from "../http"
import { setSessionCookie } from "../session"
import { renderAuthPage, returnPath } from "./authPage"
import { hasPassword } from "./passwordConfig"

const AUTHORIZATION_COOKIE = "composery-cloud-authorization"
const SETUP_COOKIE = "composery-cloud-setup"
// Composery Cloud publishes every instance's workbench at this mount; the website
// refuses any other redirect target (see IDE_PATH in packages/shared).
const CLOUD_CALLBACK_PATH = "/ide/_composery/cloud/callback"
// Long enough to survive a Clerk sign-in (or sign-up) on the cloud side;
// PKCE keeps a lingering transaction cookie harmless.
const AUTHORIZATION_MAX_AGE_MS = 10 * 60_000
const SETUP_MAX_AGE_MS = 10 * 60_000
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/

type AuthorizationType = "password" | "session"

export const router = Router()

router.use((req, res, next) => {
  // Neither cloud capability has work to do when sign-in is disabled: a local
  // session gates nothing, while setting a password would imply protection this
  // Composery is not applying. Land on the workbench the operator already opened.
  if (req.args.auth !== AuthType.Password) {
    return redirect(req, res, "")
  }
  next()
})

function randomToken() {
  return crypto.randomBytes(32).toString("base64url")
}

function challenge(verifier: string) {
  return crypto.createHash("sha256").update(verifier).digest("base64url")
}

type AuthorizationTransaction = {
  state: string
  to: string
  type: AuthorizationType
  verifier: string
}

function isAuthorizationType(value: unknown): value is AuthorizationType {
  return value === "password" || value === "session"
}

function authorizationTransactions(req: Request): AuthorizationTransaction[] {
  const encoded = req.cookies?.[AUTHORIZATION_COOKIE]
  if (typeof encoded !== "string" || encoded.length > 4096) return []
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value): AuthorizationTransaction[] => {
      if (value === null || typeof value !== "object") return []
      const transaction = value as Partial<AuthorizationTransaction>
      if (
        !TOKEN_PATTERN.test(transaction.state ?? "") ||
        !TOKEN_PATTERN.test(transaction.verifier ?? "") ||
        !isAuthorizationType(transaction.type)
      ) {
        return []
      }
      return [
        {
          state: transaction.state as string,
          to: transaction.type === "session" ? returnPath(transaction.to) : "/",
          type: transaction.type,
          verifier: transaction.verifier as string,
        },
      ]
    })
  } catch {
    return []
  }
}

function setAuthorizationTransactions(req: Request, res: Response, transactions: AuthorizationTransaction[]) {
  if (transactions.length === 0) {
    res.clearCookie(AUTHORIZATION_COOKIE, getCookieOptions(req))
    return
  }
  res.cookie(AUTHORIZATION_COOKIE, Buffer.from(JSON.stringify(transactions)).toString("base64url"), {
    ...getCookieOptions(req),
    maxAge: AUTHORIZATION_MAX_AGE_MS,
  })
}

function callbackUrl(req: Request) {
  const host = req.headers.host
  if (!host) throw new Error("Missing request host")
  return `https://${host}${CLOUD_CALLBACK_PATH}`
}

export function hasCloudSetupGrant(req: Request) {
  const value = req.cookies?.[SETUP_COOKIE]
  return typeof value === "string" && TOKEN_PATTERN.test(value)
}

export function clearCloudSetupGrant(req: Request, res: Response) {
  res.clearCookie(SETUP_COOKIE, getCookieOptions(req))
}

router.get("/authorize", (req, res) => {
  if (!cloudConfig) {
    res.status(404).send("Not found")
    return
  }
  const type = req.query.type ?? "password"
  if (!isAuthorizationType(type)) {
    res.status(400).send("Invalid authorization type")
    return
  }
  const to = type === "session" ? returnPath(req.query.to) : "/"
  // A cloud session is signed by the password, so an instance that has not
  // created one yet must finish the password capability first.
  if (type === "session" && !hasPassword(req.args)) {
    return redirect(req, res, "_composery/cloud/authorize", {
      type: "password",
      to: undefined,
    })
  }
  const verifier = randomToken()
  const state = randomToken()
  setAuthorizationTransactions(req, res, [...authorizationTransactions(req), { state, to, type, verifier }].slice(-4))
  const authorization = new URL("/boxes/authorize", cloudConfig.origin)
  authorization.searchParams.set("box_id", cloudConfig.boxId)
  authorization.searchParams.set("code_challenge", challenge(verifier))
  authorization.searchParams.set("state", state)
  authorization.searchParams.set("type", type)
  authorization.searchParams.set("redirect_uri", callbackUrl(req))
  res.setHeader("Cache-Control", "no-store")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.redirect(authorization.toString())
})

router.get("/callback", async (req, res) => {
  if (!cloudConfig) {
    res.status(404).send("Not found")
    return
  }
  const code = typeof req.query.code === "string" ? req.query.code : ""
  const state = typeof req.query.state === "string" ? req.query.state : ""
  const transactions = authorizationTransactions(req)
  const transaction = transactions.find((candidate) => candidate.state === state)
  setAuthorizationTransactions(
    req,
    res,
    transactions.filter((candidate) => candidate.state !== state),
  )
  if (
    !TOKEN_PATTERN.test(code) ||
    !TOKEN_PATTERN.test(state) ||
    !transaction ||
    !TOKEN_PATTERN.test(transaction.verifier)
  ) {
    redirect(req, res, "_composery/cloud/error")
    return
  }
  const verifier = transaction.verifier

  try {
    const response = await fetch(new URL("/api/cloud/auth/exchange", cloudConfig.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        boxId: cloudConfig.boxId,
        code,
        codeVerifier: verifier,
        redirectUri: callbackUrl(req),
        type: transaction.type,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await response.json()) as {
      grant?: unknown
      type?: unknown
    }
    if (!response.ok || body.type !== transaction.type) throw new Error()
    res.setHeader("Cache-Control", "no-store")
    if (transaction.type === "session") {
      setSessionCookie(req, res, getCookieOptions(req))
      res.redirect(constructRedirectPath(req, {}, transaction.to))
      return
    }
    if (typeof body.grant !== "string") throw new Error()
    res.cookie(SETUP_COOKIE, body.grant, {
      ...getCookieOptions(req),
      maxAge: SETUP_MAX_AGE_MS,
    })
    redirect(req, res, "register")
  } catch {
    redirect(req, res, "_composery/cloud/error")
  }
})

router.get("/error", async (req, res) => {
  res.setHeader("Cache-Control", "no-store")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.status(503).send(
    await renderAuthPage(req, {
      page: "cloud-error",
      title: "Cloud authorization unavailable",
      formLabel: "Cloud authorization",
      error: "Cloud authorization could not finish.",
    }),
  )
})

// Records a password this Composery already changed for itself, authorised by the
// hash it is replacing. Keeps the website in step so the next bootstrap does
// not restore the old password; no setup grant, so no website account needed.
export async function changeCloudPassword(currentRuntimeAuthHash: string, runtimeAuthHash: string) {
  if (!cloudConfig) throw new Error("Cloud authentication is not configured")
  const response = await fetch(new URL("/api/cloud/auth/password", cloudConfig.origin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      boxId: cloudConfig.boxId,
      currentRuntimeAuthHash,
      runtimeAuthHash,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error("Cloud password change failed")
}

export async function installCloudPassword(req: Request, runtimeAuthHash: string) {
  if (!cloudConfig) throw new Error("Cloud authentication is not configured")
  const grant = req.cookies?.[SETUP_COOKIE]
  if (typeof grant !== "string" || !TOKEN_PATTERN.test(grant)) {
    throw new Error("Missing cloud setup grant")
  }
  const response = await fetch(new URL("/api/cloud/auth/password", cloudConfig.origin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      boxId: cloudConfig.boxId,
      grant,
      runtimeAuthHash,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error("Cloud password setup failed")
}
