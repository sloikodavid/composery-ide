import * as express from "express"

import {
  authorityPublicKey,
  hostFingerprint,
  isValidPublicKey,
  issueCertificate,
  redeemEnrollment,
} from "../ssh/certificates"

// SSH is not the automation API, and this is the whole of its HTTP surface.
//
// Everything else about SSH - minting an enrollment token, listing certificates,
// revoking one - happens on the instance through the `composery` CLI, because
// being able to open the editor is already the authorization. Exactly one step
// cannot be done on the instance: a machine that is not yet trusted asking to
// become trusted. That is this route, and it is why SSH gets its own namespace
// rather than a corner of a key-authenticated API it has nothing to do with.
export const sshBasePath = "/_composery/ssh"

export const router = express.Router()

// The one route with no API key in front of it. The single-use token IS the
// credential, and the caller has none yet - that is the entire point of it.
//
// The response is data. It carries an account name, an authority and a
// fingerprint; it never carries anything meant to be executed, because the
// clients redeeming it are agents acting on somebody's own machine.
router.post("/enroll", async (req, res) => {
  const { token, publicKey } = (req.body ?? {}) as Record<string, unknown>
  const enrollment = await redeemEnrollment(token)
  if (!enrollment) {
    res.status(401).json({ message: "Enrollment token is invalid, used, or expired" })
    return
  }
  if (!isValidPublicKey(publicKey)) {
    res.status(400).json({ message: "publicKey must be an OpenSSH public key" })
    return
  }
  const { certificate, record } = await issueCertificate(publicKey, enrollment.name)
  res.status(201).json({
    certificate,
    serial: record.serial,
    name: record.name,
    expires_at: record.expires_at,
    user: "user",
    authority: await authorityPublicKey(),
    fingerprint: await hostFingerprint(),
  })
})
