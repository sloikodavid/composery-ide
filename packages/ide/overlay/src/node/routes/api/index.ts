import * as express from "express"
import { httpAuth } from "./auth"
import { apiConfig } from "./config"
import { apiBasePath } from "./constants"
import { router as sshRouter, sshBasePath } from "../ssh"
import { router as terminalRouter, wsRouter as terminalWsRouter } from "./terminals"

// This module is the instance's machine-endpoint mount, and it deliberately
// mounts two unrelated surfaces at two unrelated namespaces:
//
//   /_composery/api/v1  - the automation API. Terminals, API-key authenticated.
//   /_composery/ssh     - SSH enrollment. One route, token authenticated.
//
// They share a mount point because upstream's router is patched in one place,
// and nothing more. The paths are separate, the credentials are separate, the
// documentation is separate, and `COMPOSERY_DISABLE_API` turns off the API
// without touching SSH - which is the point, since an instance can perfectly well
// want one and not the other.
export const enabled = apiConfig.enabled
export const router = express.Router()
export const wsRouter = terminalWsRouter

router.use(sshBasePath, sshRouter)

if (apiConfig.enabled) {
  const v1 = express.Router()
  v1.use(httpAuth())
  v1.use(terminalRouter)
  router.use(apiBasePath, v1)
} else {
  router.use(apiBasePath, (_req, res) => {
    res.status(404).json({ message: "API disabled" })
  })
}
