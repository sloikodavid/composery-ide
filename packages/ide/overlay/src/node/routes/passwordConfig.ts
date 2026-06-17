import { constants, promises as fs } from "fs"
import { dump, load } from "js-yaml"
import * as path from "path"
import safeCompare from "safe-compare"
import { cloudConfig } from "../cloud"
import { isHashMatch } from "../util"

type ConfigFile = {
  auth?: string
  password?: string
  "hashed-password"?: string
}

// Structural rather than `DefaultedArgs`, so cli.ts can ask these questions
// while it is still building that object - and so this file never has to
// import back into the module that imports it.
export type PasswordArgs = {
  config?: string
  password?: string
  "hashed-password"?: string
  usingEnvPassword?: boolean
  usingEnvHashedPassword?: boolean
}

export const hasPassword = (args: PasswordArgs): boolean => !!(args.password || args["hashed-password"])

// Whether a password written here would be overruled by the environment at the
// next restart. A cloud instance's COMPOSERY_HASHED_PASSWORD is not such a value:
// the website renders it from the hash it holds, and both local paths that
// write a password (register with a setup grant, change-password) record the
// new hash there first, so the reconcile carries the change back into the
// environment. Everything else in the environment - including a plaintext
// COMPOSERY_PASSWORD an owner sets on their own cloud instance - takes back over.
export const isEnvPasswordManaged = (args: PasswordArgs): boolean =>
  !!args.usingEnvPassword || !!(args.usingEnvHashedPassword && !cloudConfig)

/** Whether `password` is this Composery's configured password. */
export const isPasswordValid = async (args: PasswordArgs, password: string): Promise<boolean> => {
  const hashedPassword = args["hashed-password"]
  if (hashedPassword) {
    return await isHashMatch(password, hashedPassword)
  }
  return !!args.password && !!password && safeCompare(password, args.password)
}

let passwordConfigWriteQueue: Promise<void> = Promise.resolve()

const withPasswordConfigWriteLock = async <T>(write: () => Promise<T>): Promise<T> => {
  const previousWrite = passwordConfigWriteQueue
  let releaseWrite: (() => void) | undefined
  passwordConfigWriteQueue = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })

  await previousWrite
  try {
    return await write()
  } finally {
    releaseWrite?.()
  }
}

const readConfig = async (configPath: string): Promise<ConfigFile> => {
  let configFile = ""
  try {
    configFile = await fs.readFile(configPath, "utf8")
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }

  const config = configFile ? load(configFile, { filename: configPath }) : {}
  if (!config || typeof config === "string" || Array.isArray(config)) {
    throw new Error(`invalid config: ${config}`)
  }

  return config as ConfigFile
}

const writeConfigAtomically = async (configPath: string, config: ConfigFile): Promise<void> => {
  const tmpPath = `${configPath}.${process.pid}.tmp`
  let file: fs.FileHandle | undefined
  try {
    file = await fs.open(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await file.writeFile(dump(config, { lineWidth: -1 }))
    await file.sync()
    await file.close()
    file = undefined
    await fs.rename(tmpPath, configPath)
  } catch (error) {
    if (file) await file.close().catch(() => undefined)
    await fs.rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export const writeHashedPassword = async (
  args: PasswordArgs,
  hashedPassword: string,
  options?: { allowExisting?: boolean },
): Promise<boolean> => {
  const configPath = args.config
  if (!configPath) {
    throw new Error("Missing config path")
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true })
  return await withPasswordConfigWriteLock(async () => {
    const config = await readConfig(configPath)
    if ((config.password || config["hashed-password"]) && !options?.allowExisting) {
      return false
    }

    config.auth = "password"
    delete config.password
    config["hashed-password"] = hashedPassword
    // Write atomically so a crash mid-write can't corrupt the auth config.
    await writeConfigAtomically(configPath, config)

    args.password = undefined
    args["hashed-password"] = hashedPassword
    args.usingEnvPassword = false
    args.usingEnvHashedPassword = false
    return true
  })
}
