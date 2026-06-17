import { Router } from "express"
import { cloudConfig } from "../cloud"
import { ensureOrigin, getCookieOptions, redirect } from "../http"
import { setSessionCookie } from "../session"
import { hash, sanitizeString } from "../util"
import { authErrorMessage } from "./authErrors"
import { renderAuthPage } from "./authPage"
import { changeCloudPassword } from "./cloudAuth"
import { loginRateLimit, loginSource } from "./loginRateLimit"
import { hasPassword, isEnvPasswordManaged, isPasswordValid, writeHashedPassword } from "./passwordConfig"

export const router = Router()

router.use(async (req, res, next) => {
  // Cloud instances change their password here too, on the same terms as
  // self-hosted: prove the current one. The grant flow stays the recovery
  // path for a password you cannot produce, reached from the link this page
  // renders, so holding the password never requires a website account.
  if (isEnvPasswordManaged(req.args)) {
    res.status(404).send("Not found")
    return
  }

  if (!hasPassword(req.args)) {
    return redirect(req, res, "register", { error: undefined })
  }

  // No session required: proving the current password below is a stronger
  // credential than the session cookie it would mint anyway.
  next()
})

router.get("/", async (req, res) => {
  const error = authErrorMessage("change-password", req.query.error)
  res.send(
    await renderAuthPage(req, {
      page: "change-password",
      title: "Change password",
      formLabel: "Change password",
      error,
    }),
  )
})

// Answers the current-password step where the user is standing, instead of
// taking three stages of input and only rejecting at the final POST. Spends
// login's own per-source budget, because a guess here is the same oracle as a
// guess at /login and must not be a way around its rate limit.
// Answers with an explicit result body rather than a bare status: unrelated
// middleware also answers 401/404, and a client keying "wrong password" off a
// status alone would reject on any of them. Only { valid: false } from here is
// a rejection.
router.post("/verify", ensureOrigin, async (req, res) => {
  const currentPassword = sanitizeString(req.body?.currentPassword)
  const source = loginSource(req)
  res.setHeader("Cache-Control", "no-store")
  if (!loginRateLimit.canTry(source)) {
    return res.json({ valid: false, reason: "rate-limit" })
  }
  if (!currentPassword) {
    return res.json({ valid: false, reason: "missing" })
  }
  if (!(await isPasswordValid(req.args, currentPassword))) {
    // Only failures consume a token, mirroring login.
    loginRateLimit.recordFailure(source)
    return res.json({ valid: false, reason: "incorrect" })
  }
  return res.json({ valid: true })
})

router.post("/", ensureOrigin, async (req, res) => {
  const currentPassword = sanitizeString(req.body?.currentPassword)
  const newPassword = sanitizeString(req.body?.newPassword)
  const confirmPassword = sanitizeString(req.body?.confirmPassword)
  const source = loginSource(req)
  if (!loginRateLimit.canTry(source)) {
    return redirect(req, res, "change-password", { error: "rate-limit" })
  }

  if (!currentPassword) {
    return redirect(req, res, "change-password", { error: "missing-current" })
  }

  if (!(await isPasswordValid(req.args, currentPassword))) {
    // Only failures consume a token, mirroring login.
    loginRateLimit.recordFailure(source)
    return redirect(req, res, "change-password", { error: "incorrect-current" })
  }

  if (!newPassword) {
    return redirect(req, res, "change-password", { error: "missing-new" })
  }

  if (newPassword !== confirmPassword) {
    return redirect(req, res, "change-password", { error: "mismatch" })
  }
  const hashedPassword = await hash(newPassword)
  // Tell the website before writing locally. If it refuses, we keep the
  // password Convex still believes in, instead of holding one the next
  // bootstrap would silently restore over. It refuses when the hash held here
  // is not the one Convex does - which is how an owner-supplied
  // COMPOSERY_HASHED_PASSWORD on a cloud instance stops the change here.
  if (cloudConfig) {
    const currentHash = req.args["hashed-password"]
    try {
      await changeCloudPassword(currentHash ?? "", hashedPassword)
    } catch {
      return redirect(req, res, "change-password", { error: "unavailable" })
    }
  }
  await writeHashedPassword(req.args, hashedPassword, { allowExisting: true })
  setSessionCookie(req, res, getCookieOptions(req))
  return redirect(req, res, "", { error: undefined })
})
