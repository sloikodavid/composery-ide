import { logger } from "@coder/logger"
import * as crypto from "crypto"
import * as express from "express"
import * as path from "path"
import Websocket from "ws"
import { Router as WsRouter, type WebsocketRequest } from "../../wsRouter"
import { ensureVSCodeLoaded, ptyService } from "../vscode"
import { authenticate, type ApiRequest } from "./auth"
import { apiConfig, MAX_TERMINAL_TIMEOUT_SEC } from "./config"
import { apiBasePath } from "./constants"
import { sessions } from "./ratelimit"

// Workspace of a terminal created outside any editor window. The API has no
// editor and so no workspace to belong to; a terminal carrying this belongs to
// whichever window asks for its layout. Must equal API_TERMINAL_WORKSPACE_ID in
// lib/vscode/src/vs/platform/terminal/node/ptyService.ts (api.diff);
// a test pins the two together.
export const API_TERMINAL_WORKSPACE_ID = "composery-api-terminal"
export const TERMINAL_VIEWPORT_PROTOCOL = "composery-terminal-v1"
const terminalWebsocketServer = new Websocket.Server({
  noServer: true,
  handleProtocols: (protocols) => (protocols.has(TERMINAL_VIEWPORT_PROTOCOL) ? TERMINAL_VIEWPORT_PROTOCOL : false),
})

// TitleEventSource.Api in lib/vscode/src/vs/platform/terminal/common/terminal.ts.
// Declared rather than imported, like the service shape below, and it is the
// only source that survives: setTitle keeps an Api title as the external one, so
// any other value is quietly overwritten by the next process title update.
const TITLE_SOURCE_API = 0

export interface Disposable {
  dispose(): void
}

export type Event<T> = (listener: (event: T) => void) => Disposable

export interface ShellLaunchConfig {
  name?: string
  executable?: string
  args?: string[] | string
  cwd?: string
  env?: Record<string, string | null | undefined>
  hideFromUser?: boolean
}

export interface TerminalProcessOptions {
  shellIntegration: { enabled: boolean; suggestEnabled: boolean; nonce: string }
  windowsUseConptyDll: boolean
  environmentVariableCollections: undefined
  workspaceFolder: undefined
  isScreenReaderOptimized: boolean
}

export interface TerminalLaunchError {
  message: string
  code?: number
}

export interface TerminalIcon {
  id: string
  color?: { id: string }
}

export interface TerminalProcessDetails {
  id: number
  pid: number
  title: string
  cwd: string
  workspaceId: string
  workspaceName: string
  isOrphan: boolean
  icon?: TerminalIcon
  color?: string
  hideFromUser?: boolean
}

export interface ProcessReplayEvent {
  events: Array<{ cols: number; rows: number; data: string }>
  commands: unknown
}

interface SerializedTerminalState {
  version: number
  state: Array<{ id: number; replayEvent: ProcessReplayEvent }>
}

export interface PtyService {
  readonly onProcessData: Event<{ id: number; event: string | { data: string } }>
  readonly onProcessReplay: Event<{ id: number; event: ProcessReplayEvent }>
  readonly onProcessExit: Event<{ id: number; event: number | undefined }>

  createProcess(
    shellLaunchConfig: ShellLaunchConfig,
    cwd: string,
    cols: number,
    rows: number,
    unicodeVersion: "6" | "11",
    env: Record<string, string | undefined>,
    executableEnv: Record<string, string | undefined>,
    options: TerminalProcessOptions,
    shouldPersist: boolean,
    workspaceId: string,
    workspaceName: string,
  ): Promise<number>
  listProcesses(includeAttached?: boolean): Promise<TerminalProcessDetails[]>
  start(id: number): Promise<TerminalLaunchError | { injectedArgs: string[] } | undefined>
  input(id: number, data: string): Promise<void>
  sendSignal(id: number, signal: string): Promise<void>
  resize(id: number, cols: number, rows: number): Promise<void>
  clearBuffer(id: number): Promise<void>
  registerTerminalClient(id: number, clientId: string): Promise<void>
  unregisterTerminalClient(id: number, clientId: string): Promise<void>
  activateTerminalViewport(id: number, clientId: string, cols: number, rows: number): Promise<void>
  acknowledgeDataEvent(id: number, charCount: number, clientId: string): Promise<void>
  updateTitle(id: number, title: string, titleSource: number): Promise<void>
  updateIcon(id: number, userInitiated: boolean, icon: unknown, color?: string): Promise<void>
  serializeTerminalState(ids: number[], checkOrphan?: boolean): Promise<string>
  shutdown(id: number, immediate: boolean): Promise<void>
}

interface CreateTerminalBody {
  command?: string
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  title?: string
  hidden?: boolean
  wait?: boolean
  timeout?: number
}

interface PatchTerminalBody {
  title?: string
  icon?: string
  color?: string
  cols?: number
  rows?: number
}

interface TerminalDetails {
  id: number
  title: string
  cwd: string
  pid: number
  workspaceId: string
  running: boolean
}

interface WaitResult {
  output: string
  exit_code: number
  timed_out: boolean
  truncated: boolean
}

interface CreateResponse {
  status: number
  result: TerminalDetails | WaitResult
}

interface IdempotencyEntry {
  at: number
  fingerprint: string
  response: CreateResponse
}

interface InFlightCreate {
  fingerprint: string
  promise: Promise<CreateResponse>
}

interface OutputBuffer {
  chunks: Buffer[]
  length: number
}

interface TerminalViewportResize {
  type: "resize"
  cols: number
  rows: number
}

interface ResolvedCreate {
  command?: string
  cwd: string
  env?: Record<string, string>
  cols: number
  rows: number
  title?: string
  hidden: boolean
  wait: boolean
  timeoutSec: number
}

export const router = express.Router()
export const wsRouter = WsRouter()

const idempotency = new Map<string, IdempotencyEntry>()
const inFlight = new Map<string, InFlightCreate>()
const IDEMPOTENCY_TTL_MS = 5 * 60_000
const IDEMPOTENCY_MAX_RESULTS = 1024

function terminalEnv(env?: Record<string, string>): Record<string, string | undefined> {
  return { ...process.env, TERM_PROGRAM: "vscode", COLORTERM: "truecolor", ...env }
}

function resolveDimension(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error("cols and rows must be integers from 1 to 1000")
  }
  return value
}

function optionalWebsocketDimensions(req: WebsocketRequest): { cols: number; rows: number } | undefined {
  const params = new URL(req.url || "", "http://localhost").searchParams
  const cols = params.get("cols")
  const rows = params.get("rows")
  if (cols === null && rows === null) return undefined
  if (cols === null || rows === null) throw new Error("cols and rows must be provided together")
  return {
    cols: resolveDimension(Number(cols), 80),
    rows: resolveDimension(Number(rows), 24),
  }
}

export function parseTerminalViewportMessage(data: string): TerminalViewportResize {
  let message: unknown
  try {
    message = JSON.parse(data)
  } catch {
    throw new Error("terminal viewport control messages must be valid JSON")
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("terminal viewport control message must be an object")
  }
  const value = message as Record<string, unknown>
  if (value.type !== "resize") {
    throw new Error('terminal viewport control message type must be "resize"')
  }
  return {
    type: "resize",
    cols: resolveDimension(value.cols, 80),
    rows: resolveDimension(value.rows, 24),
  }
}

function resolveCwd(cwd: unknown): string {
  const fallback = apiConfig.home || process.cwd()
  if (typeof cwd !== "string" || !cwd.trim()) return fallback
  const value = cwd.trim()
  if (value === "~") return fallback
  if (value.startsWith("~/")) return path.join(fallback, value.slice(2))
  return value
}

function resolveTimeoutSec(timeout: unknown): number {
  const value =
    typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : apiConfig.terminalTimeoutSec
  return Math.min(value, MAX_TERMINAL_TIMEOUT_SEC)
}

function resolveEnv(env: unknown): Record<string, string> | undefined {
  if (env === undefined) return undefined
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("env must be an object with string values")
  }
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      throw new Error("env must be an object with string values")
    }
    resolved[key] = value
  }
  return resolved
}

function resolveCreate(body: CreateTerminalBody): ResolvedCreate {
  if (body.command !== undefined && (typeof body.command !== "string" || !body.command)) {
    throw new Error("command must be a non-empty string")
  }
  if (body.title !== undefined && typeof body.title !== "string") {
    throw new Error("title must be a string")
  }
  if (body.hidden !== undefined && typeof body.hidden !== "boolean") {
    throw new Error("hidden must be a boolean")
  }
  if (body.wait !== undefined && typeof body.wait !== "boolean") {
    throw new Error("wait must be a boolean")
  }
  return {
    command: body.command,
    cwd: resolveCwd(body.cwd),
    env: resolveEnv(body.env),
    cols: resolveDimension(body.cols, 80),
    rows: resolveDimension(body.rows, 24),
    title: body.title,
    hidden: body.hidden ?? false,
    wait: body.wait ?? false,
    timeoutSec: resolveTimeoutSec(body.timeout),
  }
}

function requestFingerprint(create: ResolvedCreate): string {
  const sortedEnv = create.env
    ? Object.fromEntries(Object.entries(create.env).sort(([left], [right]) => left.localeCompare(right)))
    : undefined
  return JSON.stringify({ ...create, env: sortedEnv })
}

function rememberResponse(key: string, fingerprint: string, response: CreateResponse): void {
  const now = Date.now()
  for (const [existing, entry] of idempotency) {
    if (now - entry.at >= IDEMPOTENCY_TTL_MS) idempotency.delete(existing)
  }
  idempotency.set(key, { at: now, fingerprint, response })
  while (idempotency.size > IDEMPOTENCY_MAX_RESULTS) {
    const oldest = idempotency.keys().next().value
    if (!oldest) break
    idempotency.delete(oldest)
  }
}

function canRespond(res: express.Response): boolean {
  return !res.destroyed && !res.writableEnded
}

function parseTerminalId(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : undefined
}

function toDetails(terminal: TerminalProcessDetails): TerminalDetails {
  return {
    id: terminal.id,
    title: terminal.title,
    cwd: terminal.cwd,
    pid: terminal.pid,
    workspaceId: terminal.workspaceId,
    running: terminal.pid > 0,
  }
}

async function allTerminals(pty: PtyService): Promise<TerminalProcessDetails[]> {
  return pty.listProcesses(true)
}

async function findTerminal(pty: PtyService, id: number): Promise<TerminalProcessDetails | undefined> {
  return (await allTerminals(pty)).find((terminal) => terminal.id === id)
}

function service(res: express.Response): PtyService | undefined {
  const pty: PtyService | undefined = ptyService()
  if (!pty) res.status(503).json({ message: "Editor not ready" })
  return pty
}

function dataOf(event: string | { data: string }): string {
  return typeof event === "string" ? event : event.data
}

async function allocateProcess(pty: PtyService, create: ResolvedCreate): Promise<number> {
  return pty.createProcess(
    {
      name: create.title ?? create.command,
      executable: apiConfig.shell,
      args: create.command ? ["-l", "-c", create.command] : ["-l"],
      cwd: create.cwd,
      env: create.env,
      hideFromUser: create.hidden,
    },
    create.cwd,
    create.cols,
    create.rows,
    "11",
    terminalEnv(create.env),
    { ...process.env },
    {
      shellIntegration: { enabled: true, suggestEnabled: false, nonce: crypto.randomUUID() },
      windowsUseConptyDll: false,
      environmentVariableCollections: undefined,
      workspaceFolder: undefined,
      isScreenReaderOptimized: false,
    },
    true,
    API_TERMINAL_WORKSPACE_ID,
    "",
  )
}

function appendOutput(target: OutputBuffer, data: string): boolean {
  const chunk = Buffer.from(data, "utf8")
  const remaining = apiConfig.terminalMaxOutput - target.length
  if (remaining <= 0) return true
  if (chunk.length > remaining) {
    target.chunks.push(chunk.subarray(0, remaining))
    target.length += remaining
    return true
  }
  target.chunks.push(chunk)
  target.length += chunk.length
  return false
}

// SIGTERM, escalating to a hard shutdown - both best effort. By the time either
// lands the pty may be gone: VS Code deletes it from its map *before* it fires
// the exit event, and shutdown throws for an id it no longer holds. That is the
// ordinary case, not an exceptional one - every stopped terminal reaches it - so
// an unhandled rejection here would take the server down on a routine timeout.
function stopTerminal(pty: PtyService, id: number): void {
  const force = () => void pty.shutdown(id, true).catch(() => {})
  void pty.sendSignal(id, "SIGTERM").catch(force)
  setTimeout(force, 2000).unref()
}

async function waitForExit(
  pty: PtyService,
  id: number,
  timeoutSec: number,
  cancelOnClose?: express.Response,
): Promise<WaitResult> {
  const clientId = `api-wait:${crypto.randomUUID()}`
  const output: OutputBuffer = { chunks: [], length: 0 }
  let timedOut = false
  let truncated = false
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined

  return new Promise<WaitResult>((resolve, reject) => {
    const listeners = [
      pty.onProcessData(({ id: from, event }) => {
        if (from !== id) return
        const data = dataOf(event)
        truncated = appendOutput(output, data) || truncated
        void pty.acknowledgeDataEvent(id, data.length, clientId).catch((error) => {
          if (!settled) finish(undefined, error)
        })
      }),
      pty.onProcessExit(({ id: from, event }) => {
        if (from === id) finish(event ?? -1)
      }),
    ]
    const onResponseClose = () => {
      if (!settled) stopTerminal(pty, id)
    }
    const finish = (exitCode?: number, error?: unknown) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      cancelOnClose?.off("close", onResponseClose)
      for (const listener of listeners) listener.dispose()
      void pty.unregisterTerminalClient(id, clientId).catch(() => {})
      if (error) {
        reject(error)
        return
      }
      resolve({
        output: Buffer.concat(output.chunks, output.length).toString("utf8"),
        exit_code: exitCode ?? -1,
        timed_out: timedOut,
        truncated,
      })
    }

    cancelOnClose?.on("close", onResponseClose)
    void pty
      .registerTerminalClient(id, clientId)
      .then(async () => {
        const launch = await pty.start(id)
        if (launch && "message" in launch) {
          await pty.shutdown(id, true)
          throw new Error(launch.message)
        }
        if (settled) return
        timer = setTimeout(() => {
          timedOut = true
          stopTerminal(pty, id)
        }, timeoutSec * 1000)
      })
      .catch((error) => {
        void pty.shutdown(id, true)
        finish(undefined, error)
      })
  })
}

async function createTerminal(
  pty: PtyService,
  create: ResolvedCreate,
  keyId: string,
  cancelOnClose?: express.Response,
): Promise<CreateResponse> {
  let acquired = false
  if (create.wait) {
    if (!sessions.tryAcquire(keyId)) {
      throw Object.assign(new Error("Too many concurrent terminal streams"), { status: 429 })
    }
    acquired = true
  }
  try {
    const id = await allocateProcess(pty, create)
    if (create.wait) {
      return { status: 200, result: await waitForExit(pty, id, create.timeoutSec, cancelOnClose) }
    }
    const allocated = await findTerminal(pty, id)
    if (!allocated) throw new Error(`Terminal ${id} disappeared before launch`)
    const launch = await pty.start(id)
    if (launch && "message" in launch) {
      await pty.shutdown(id, true)
      throw new Error(launch.message)
    }
    const terminal = await findTerminal(pty, id)
    return {
      status: 201,
      result: terminal ? toDetails(terminal) : { ...toDetails(allocated), pid: -1, running: false },
    }
  } finally {
    if (acquired) {
      sessions.release(keyId)
    }
  }
}

router.post("/terminals", ensureVSCodeLoaded, async (req, res) => {
  const pty = service(res)
  if (!pty) return

  let create: ResolvedCreate
  try {
    create = resolveCreate((req.body || {}) as CreateTerminalBody)
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : String(error) })
    return
  }

  const idemHeader = req.headers["idempotency-key"]
  const idemKey = typeof idemHeader === "string" && idemHeader ? idemHeader : undefined
  const fingerprint = requestFingerprint(create)
  if (idemKey) {
    const hit = idempotency.get(idemKey)
    if (hit && Date.now() - hit.at >= IDEMPOTENCY_TTL_MS) {
      idempotency.delete(idemKey)
    } else if (hit) {
      if (hit.fingerprint !== fingerprint) {
        res.status(409).json({ message: "Idempotency-Key already used for a different request" })
        return
      }
      res.status(hit.response.status).json(hit.response.result)
      return
    }
    const running = inFlight.get(idemKey)
    if (running) {
      if (running.fingerprint !== fingerprint) {
        res.status(409).json({ message: "Idempotency-Key already used for a different request" })
        return
      }
      try {
        const response = await running.promise
        if (canRespond(res)) res.status(response.status).json(response.result)
      } catch (error) {
        const status = Number((error as { status?: unknown })?.status) || 500
        if (canRespond(res)) {
          res.status(status).json({ message: error instanceof Error ? error.message : String(error) })
        }
      }
      return
    }
  }

  const promise = createTerminal(pty, create, (req as ApiRequest).apiKeyId!, idemKey ? undefined : res)
  if (idemKey) {
    inFlight.set(idemKey, { fingerprint, promise })
    void promise
      .then((response) => rememberResponse(idemKey, fingerprint, response))
      .finally(() => {
        if (inFlight.get(idemKey)?.promise === promise) inFlight.delete(idemKey)
      })
      .catch(() => {})
  }
  try {
    const response = await promise
    if (canRespond(res)) res.status(response.status).json(response.result)
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status) || 500
    if (canRespond(res)) {
      res.status(status).json({ message: error instanceof Error ? error.message : String(error) })
    }
  }
})

router.get("/terminals", ensureVSCodeLoaded, async (_req, res) => {
  const pty = service(res)
  if (!pty) return
  res.json((await allTerminals(pty)).map(toDetails))
})

router.get("/terminals/:id", ensureVSCodeLoaded, async (req, res) => {
  const pty = service(res)
  if (!pty) return
  const id = parseTerminalId(req.params.id)
  const terminal = id && (await findTerminal(pty, id))
  if (!terminal) {
    res.status(404).json({ message: "Terminal not found" })
    return
  }
  res.json(toDetails(terminal))
})

router.get("/terminals/:id/buffer", ensureVSCodeLoaded, async (req, res) => {
  const pty = service(res)
  if (!pty) return
  const id = parseTerminalId(req.params.id)
  if (!id || !(await findTerminal(pty, id))) {
    res.status(404).json({ message: "Terminal not found" })
    return
  }
  // checkOrphan: false - the orphan question asks every renderer and waits on a
  // 4s barrier for an answer no API caller needs, and this route only reads the
  // buffer. Reading scrollback must not cost four seconds.
  const serialized = JSON.parse(await pty.serializeTerminalState([id], false)) as SerializedTerminalState
  // A terminal that has never written anything is not serialized at all, so an
  // empty replay is the honest answer rather than a 404.
  res.json(
    serialized.state.find((terminal) => terminal.id === id)?.replayEvent ?? {
      events: [],
      commands: { commands: [] },
    },
  )
})

router.patch("/terminals/:id", ensureVSCodeLoaded, async (req, res) => {
  const pty = service(res)
  if (!pty) return
  const id = parseTerminalId(req.params.id)
  const terminal = id && (await findTerminal(pty, id))
  if (!id || !terminal) {
    res.status(404).json({ message: "Terminal not found" })
    return
  }
  // Everything is validated before anything is applied: a bad `cols` used to be
  // caught after the rename had already landed, leaving the terminal half
  // updated by a request that answered 400.
  const body = (req.body || {}) as PatchTerminalBody
  let dimensions: { cols: number; rows: number } | undefined
  let icon: TerminalIcon | undefined
  try {
    for (const field of ["title", "icon", "color"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "string") {
        throw new Error(`${field} must be a string`)
      }
    }
    if ((body.cols === undefined) !== (body.rows === undefined)) {
      throw new Error("cols and rows must be provided together")
    }
    if (body.cols !== undefined && body.rows !== undefined) {
      dimensions = { cols: resolveDimension(body.cols, 80), rows: resolveDimension(body.rows, 24) }
    }
    if (body.icon !== undefined || body.color !== undefined) {
      icon = body.icon ? { id: body.icon } : terminal.icon
      if (!icon) throw new Error("icon is required when setting color on a terminal without an icon")
    }
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : String(error) })
    return
  }

  if (body.title !== undefined) await pty.updateTitle(id, body.title, TITLE_SOURCE_API)
  if (icon) await pty.updateIcon(id, true, icon, body.color ?? terminal.color)
  if (dimensions) await pty.resize(id, dimensions.cols, dimensions.rows)
  const updated = await findTerminal(pty, id)
  res.json(updated ? toDetails(updated) : toDetails(terminal))
})

router.post("/terminals/:id/input", ensureVSCodeLoaded, async (req, res) => {
  const pty = service(res)
  if (!pty) return
  const id = parseTerminalId(req.params.id)
  if (!id || !(await findTerminal(pty, id))) {
    res.status(404).json({ message: "Terminal not found" })
    return
  }
  if (typeof req.body?.data !== "string") {
    res.status(400).json({ message: "data must be a string" })
    return
  }
  await pty.input(id, req.body.data)
  res.status(204).end()
})

router.post("/terminals/:id/signal", ensureVSCodeLoaded, async (req, res) => {
  const pty = service(res)
  if (!pty) return
  const id = parseTerminalId(req.params.id)
  if (!id || !(await findTerminal(pty, id))) {
    res.status(404).json({ message: "Terminal not found" })
    return
  }
  if (typeof req.body?.signal !== "string" || !req.body.signal) {
    res.status(400).json({ message: "signal must be a non-empty string" })
    return
  }
  await pty.sendSignal(id, req.body.signal)
  res.status(204).end()
})

router.post("/terminals/:id/clear", ensureVSCodeLoaded, async (req, res) => {
  const pty = service(res)
  if (!pty) return
  const id = parseTerminalId(req.params.id)
  if (!id || !(await findTerminal(pty, id))) {
    res.status(404).json({ message: "Terminal not found" })
    return
  }
  await pty.clearBuffer(id)
  res.status(204).end()
})

router.delete("/terminals/:id", ensureVSCodeLoaded, async (req, res) => {
  const pty = service(res)
  if (!pty) return
  const id = parseTerminalId(req.params.id)
  if (!id || !(await findTerminal(pty, id))) {
    res.status(404).json({ message: "Terminal not found" })
    return
  }
  await pty.shutdown(id, false)
  res.status(204).end()
})

// Every route above can reject the same way: a terminal can exit between the
// existence check and the call, and the pty host throws for an id it no longer
// holds. Left alone, Express answers those with the editor's own error page -
// HTML, and nothing like this API's shape. One handler here is the whole class,
// so no route needs a try/catch of its own.
router.use(((error, _req, res, next) => {
  if (res.headersSent) {
    next(error)
    return
  }
  res.status(500).json({ message: error instanceof Error ? error.message : String(error) })
}) as express.ErrorRequestHandler)

function endWithStatus(req: WebsocketRequest, status: number, message: string): void {
  req.ws.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`)
}

wsRouter.ws(`${apiBasePath}/terminals/:id`, ensureVSCodeLoaded, async (req: WebsocketRequest) => {
  const auth = await authenticate(req)
  if (!auth.id) {
    endWithStatus(req, auth.status ?? 401, auth.message ?? "Unauthorized")
    return
  }
  const pty: PtyService | undefined = ptyService()
  if (!pty) {
    endWithStatus(req, 503, "Editor Not Ready")
    return
  }
  const id = parseTerminalId(req.params.id)
  if (!id || !(await findTerminal(pty, id))) {
    endWithStatus(req, 404, "Terminal Not Found")
    return
  }
  const protocolHeader = req.headers["sec-websocket-protocol"]
  const requestedProtocols =
    typeof protocolHeader === "string"
      ? protocolHeader.split(",").map((protocol) => protocol.trim())
      : (protocolHeader ?? [])
  if (!requestedProtocols.includes(TERMINAL_VIEWPORT_PROTOCOL)) {
    endWithStatus(req, 400, "Terminal Protocol Required")
    return
  }
  if (!sessions.tryAcquire(auth.id)) {
    endWithStatus(req, 429, "Too Many Terminal Streams")
    return
  }
  let initialDimensions: { cols: number; rows: number } | undefined
  try {
    initialDimensions = optionalWebsocketDimensions(req)
  } catch (error) {
    sessions.release(auth.id)
    endWithStatus(req, 400, error instanceof Error ? error.message : "Bad Request")
    return
  }

  let released = false
  const release = () => {
    if (released) return
    released = true
    sessions.release(auth.id!)
  }

  try {
    terminalWebsocketServer.handleUpgrade(req, req.ws, req.head, (ws) => {
      const clientId = `api-ws:${crypto.randomUUID()}`
      let stopped = false
      const stopStreaming = () => {
        if (stopped) return
        stopped = true
        release()
        for (const listener of listeners) listener.dispose()
        void pty.unregisterTerminalClient(id, clientId).catch(() => {})
      }
      const send = (data: string, acknowledge: boolean) => {
        ws.send(Buffer.from(data, "utf8"), (error) => {
          if (error) {
            stopStreaming()
            return
          }
          if (acknowledge) {
            void pty.acknowledgeDataEvent(id, data.length, clientId).catch(stopStreaming)
          }
        })
      }
      // Subscribe to replay before start: start(id) emits onProcessReplay for an
      // existing persistent terminal. Without this listener an attach is only a
      // live tail and silently omits the terminal's scrollback.
      const listeners = [
        pty.onProcessReplay(({ id: from, event }) => {
          if (from !== id) return
          for (const replay of event.events) send(replay.data, false)
        }),
        pty.onProcessData(({ id: from, event }) => {
          if (from === id) send(dataOf(event), true)
        }),
        pty.onProcessExit(({ id: from, event }) => {
          if (from !== id) return
          try {
            ws.send(JSON.stringify({ exit: { code: event ?? -1 } }))
            ws.close()
          } catch {}
        }),
      ]

      let ready: Promise<unknown>
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        void ready
          .then(() => {
            if (isBinary) {
              return pty.input(id, data.toString("utf8"))
            }
            const message = parseTerminalViewportMessage(data.toString("utf8"))
            return pty.activateTerminalViewport(id, clientId, message.cols, message.rows)
          })
          .catch((error) => {
            logger.warn(`API terminal viewport message rejected: ${error instanceof Error ? error.message : error}`)
            try {
              ws.close(1003, "Invalid terminal viewport message")
            } catch {}
            stopStreaming()
          })
      })
      ws.on("close", stopStreaming)
      ws.on("error", stopStreaming)

      ready = pty
        .registerTerminalClient(id, clientId)
        .then(async () => {
          if (stopped) {
            await pty.unregisterTerminalClient(id, clientId)
            return
          }
          if (initialDimensions) {
            await pty.activateTerminalViewport(id, clientId, initialDimensions.cols, initialDimensions.rows)
          }
        })
        .then(() => (stopped ? undefined : pty.start(id)))
        .then((result) => {
          if (result && "message" in result) throw new Error(result.message)
        })
        .catch((error) => {
          logger.error(`API terminal attach failed: ${error instanceof Error ? error.message : error}`)
          try {
            ws.close(1011, "Terminal unavailable")
          } catch {}
          stopStreaming()
        })

      req.ws.resume()
    })
  } catch {
    release()
    try {
      endWithStatus(req, 500, "Terminal unavailable")
    } catch {}
  }
})
