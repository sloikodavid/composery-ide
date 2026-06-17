import { Router } from "express"
import { cloudConfig } from "../cloud"
import { ensureOrigin, getCookieOptions, redirect } from "../http"
import { setSessionCookie } from "../session"
import { hash, sanitizeString } from "../util"
import { authErrorMessage } from "./authErrors"
import { renderAuthPage, returnPath } from "./authPage"
import { clearCloudSetupGrant, hasCloudSetupGrant, installCloudPassword } from "./cloudAuth"
import { hasPassword, isEnvPasswordManaged, writeHashedPassword } from "./passwordConfig"

export const router = Router()

router.use((req, res, next) => {
  // A cloud setup grant proves ownership, so it may set the password
  // even when one exists: that is the cloud change/recovery flow.
  if (cloudConfig && hasCloudSetupGrant(req)) {
    // Cloud owners control their own host, so they can set
    // COMPOSERY_PASSWORD on a cloud instance. It outranks whatever the grant
    // would write here and takes back over at the next restart, so say so
    // rather than store a password that silently stops working.
    if (isEnvPasswordManaged(req.args)) {
      return redirect(req, res, "login", { error: "env-managed" })
    }
    return next()
  }
  if (isEnvPasswordManaged(req.args) || hasPassword(req.args)) {
    return redirect(req, res, "login", { error: undefined })
  }
  if (cloudConfig) {
    return redirect(req, res, "_composery/cloud/authorize", {
      error: undefined,
    })
  }

  next()
})

router.get("/", async (req, res) => {
  const error = authErrorMessage("register", req.query.error)
  const title = hasPassword(req.args) ? "Change password" : "Create password"
  res.send(
    await renderAuthPage(req, {
      page: "register",
      title,
      formLabel: title,
      error,
    }),
  )
})

// ensureOrigin: without it a malicious page can form-POST a drive-by
// registration at an unclaimed workspace (worst on localhost binds).
router.post("/", ensureOrigin, async (req, res) => {
  const password = sanitizeString(req.body?.password)
  const confirmPassword = sanitizeString(req.body?.confirmPassword)
  if (!password) {
    return redirect(req, res, "register", { error: "missing" })
  }

  if (password !== confirmPassword) {
    return redirect(req, res, "register", { error: "mismatch" })
  }
  const to = returnPath(req.query.to)
  const hashedPassword = await hash(password)
  if (cloudConfig) {
    try {
      await installCloudPassword(req, hashedPassword)
    } catch {
      // The grant is spent either way, so the owner has to start the cloud
      // flow again - and the page that says so is the one the callback
      // failure already uses. /authorize renders nothing, so an error code
      // sent there is discarded and the owner is walked back around the
      // loop with no idea anything went wrong.
      clearCloudSetupGrant(req, res)
      return redirect(req, res, "_composery/cloud/error")
    }
  }
  // The cloud setup grant authorizes overwriting an existing password (the
  // change/recovery flow); self-hosted first-run registration must not.
  const didWritePassword = await writeHashedPassword(req.args, hashedPassword, {
    allowExisting: !!cloudConfig,
  })
  if (!didWritePassword) {
    return redirect(req, res, "login", { to, error: "configured" })
  }

  setSessionCookie(req, res, getCookieOptions(req))
  if (cloudConfig) clearCloudSetupGrant(req, res)
  return redirect(req, res, to, { to: undefined, error: undefined })
})
