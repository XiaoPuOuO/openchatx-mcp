/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: Biome fails to track stopping across async lifecycle callbacks */
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { promisify } from "node:util"
import { MCP_CONFIG } from "../../config.js"
import { asRecord, finiteNumber as numberValue } from "../../utils.js"
import { encodeImageForMcp, ImageEncodingError } from "../image/image-encoding.js"

const execFileAsync = promisify(execFile)
const PID_APP_RE = /^PID:\d+$/u

interface PeekabooEnvelope {
  success: boolean
  data?: unknown
  summary?: unknown
  messages?: unknown
  error?: {
    code?: unknown
    message?: unknown
    details?: unknown
  }
}

export interface PeekabooResult {
  data?: unknown
  summary?: unknown
  messages?: string[]
}

export interface PeekabooObservation extends PeekabooResult {
  imageData: string
  mimeType: "image/jpeg"
  target?: PeekabooSnapshotTarget
}

export interface PeekabooSnapshotTarget {
  kind?: string
  app?: string
  windowId?: number
  windowTitle?: string
  screenIndex?: number
  bounds?: {
    x: number
    y: number
    width: number
    height: number
  }
}

export type PeekabooObservationTarget =
  | { kind: "frontmost" }
  | { kind: "screen"; screenIndex: number }
  | { kind: "app"; app: string }
  | { kind: "window"; windowId: number; app?: string }

export interface PeekabooObservationRequest {
  target: PeekabooObservationTarget
  annotate: boolean
  noWebFocus?: boolean
}

export interface PeekabooInspectRequest {
  snapshotId: string
  maxDepth: number
  maxElements: number
  maxChildren: number
}

export interface PeekabooExactWindowTarget {
  app?: string
  windowId: number
}

export interface PeekabooResolvedCoordinates {
  x: number
  y: number
  global: boolean
  targetArgs: string[]
  exactWindowTarget?: PeekabooExactWindowTarget
}

export interface PeekabooClientOptions {
  executable?: string
  baseArgs?: string[]
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxOutputBytes?: number
  localOnly?: boolean
}

export class PeekabooError extends Error {
  readonly code: string
  readonly details?: string

  constructor(code: string, message: string, details?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "PeekabooError"
    this.code = code
    this.details = details
  }
}

export class PeekabooClient {
  readonly executable: string

  private readonly baseArgs: string[]
  private readonly env: NodeJS.ProcessEnv
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private readonly localOnly: boolean
  private readonly shutdownController = new AbortController()
  private readonly snapshots = new Map<string, PeekabooSnapshotTarget>()

  private queue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(options: PeekabooClientOptions = {}) {
    this.executable = options.executable ?? MCP_CONFIG.peekaboo.executable
    this.baseArgs = options.baseArgs ?? []
    this.env = options.env ?? process.env
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024
    this.localOnly = options.localOnly ?? false
  }

  run(args: string[], signal?: AbortSignal): Promise<PeekabooResult> {
    return this.enqueue((requestSignal) => this.runNow(args, requestSignal), signal)
  }

  observe(request: PeekabooObservationRequest, signal?: AbortSignal): Promise<PeekabooObservation> {
    return this.enqueue((requestSignal) => this.observeNow(request, requestSignal), signal)
  }

  inspect(request: PeekabooInspectRequest, signal?: AbortSignal): Promise<PeekabooResult> {
    return this.enqueue((requestSignal) => this.inspectNow(request, requestSignal), signal)
  }

  runWithFreshLocalWindowSnapshot(
    target: PeekabooExactWindowTarget,
    args: string[],
    signal?: AbortSignal
  ): Promise<PeekabooResult> {
    return this.enqueue(async (requestSignal) => {
      const directory = await mkdtemp(join(tmpdir(), "peekaboo-mcp-receipt-"))
      const requestedPath = join(directory, "capture.png")

      try {
        const seeArgs = ["see"]
        if (target.app) seeArgs.push("--app", target.app)
        seeArgs.push(
          "--window-id",
          String(target.windowId),
          "--no-elements",
          "--path",
          requestedPath,
          "--no-remote"
        )
        const observation = await this.runNow(seeArgs, requestSignal)
        const snapshotId = stringValue(asRecord(observation.data)?.snapshot_id)
        if (!snapshotId) {
          throw new PeekabooError(
            "SNAPSHOT_MISSING",
            "Peekaboo did not return a snapshot ID for the exact window."
          )
        }
        return this.runNow([...args, "--snapshot", snapshotId, "--no-remote"], requestSignal)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }, signal)
  }

  getSnapshotTarget(snapshotId: string): PeekabooSnapshotTarget | undefined {
    return this.snapshots.get(snapshotId)
  }

  requireSnapshotTarget(snapshotId: string): PeekabooSnapshotTarget {
    const target = this.snapshots.get(snapshotId)
    if (target) return target
    throw new PeekabooError(
      "SNAPSHOT_TARGET_MISSING",
      "The observation target is no longer available. Call computer_observe again."
    )
  }

  requireExactWindowTarget(snapshotId: string, message: string): PeekabooExactWindowTarget {
    const target = this.requireSnapshotTarget(snapshotId)
    const exactWindow = exactWindowTarget(target)
    if (exactWindow) return exactWindow
    throw new PeekabooError("EXACT_WINDOW_REQUIRED", message)
  }

  resolveSnapshotCoordinates(
    snapshotId: string,
    x: number,
    y: number
  ): PeekabooResolvedCoordinates {
    const target = this.requireSnapshotTarget(snapshotId)
    const exactWindow = exactWindowTarget(target)
    const needsGlobalCoordinates =
      isScreenSnapshotTarget(target) || (target.windowId === undefined && !target.app)

    if (!needsGlobalCoordinates) {
      return {
        x,
        y,
        global: false,
        targetArgs: snapshotActionTargetArgs(target),
        ...(exactWindow ? { exactWindowTarget: exactWindow } : {}),
      }
    }
    if (!target.bounds) {
      throw new PeekabooError(
        "SNAPSHOT_BOUNDS_MISSING",
        "The observation bounds are unavailable. Call computer_observe again."
      )
    }
    return {
      x: x + target.bounds.x,
      y: y + target.bounds.y,
      global: true,
      targetArgs: snapshotActionTargetArgs(target),
      ...(exactWindow ? { exactWindowTarget: exactWindow } : {}),
    }
  }

  rememberSnapshotTarget(snapshotId: string, target: PeekabooSnapshotTarget): void {
    this.rememberSnapshot(snapshotId, target)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.shutdownController.abort()
    await this.queue
  }

  private enqueue<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const queued = async () => {
      if (this.closed) {
        throw new PeekabooError("PEEKABOO_CLOSED", "Computer Use is closed.")
      }
      const requestSignal = signal
        ? AbortSignal.any([signal, this.shutdownController.signal])
        : this.shutdownController.signal
      requestSignal.throwIfAborted()
      return operation(requestSignal)
    }

    const result = this.queue.then(queued, queued)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async observeNow(
    request: PeekabooObservationRequest,
    signal: AbortSignal
  ): Promise<PeekabooObservation> {
    const directory = await mkdtemp(join(tmpdir(), "peekaboo-mcp-"))
    const requestedPath = join(directory, "capture.png")
    const args = observationRequestArgs(request)

    try {
      const result = await this.runNow(
        ["see", ...args, "--path", requestedPath, ...(request.annotate ? ["--annotate"] : [])],
        signal
      )
      const data = asRecord(result.data)
      const snapshotId = stringValue(data?.snapshot_id)
      const target = await this.resolveObservationTarget(request.target, data, signal)
      if (snapshotId && target) this.rememberSnapshot(snapshotId, target)
      const imagePath = screenshotPath(data, requestedPath, request.annotate)

      try {
        const image = await readFile(imagePath)
        const encodedImage = await encodeImageForMcp(image)
        return {
          ...result,
          imageData: encodedImage.data,
          mimeType: encodedImage.mimeType,
          ...(target ? { target } : {}),
        }
      } catch (error) {
        if (error instanceof ImageEncodingError) {
          throw peekabooErrorWithCause(error.code, error.message, undefined, error)
        }
        throw peekabooErrorWithCause(
          "SCREENSHOT_READ_FAILED",
          "Peekaboo completed but its screenshot could not be read or encoded.",
          unknownErrorMessage(error),
          error
        )
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async inspectNow(
    request: PeekabooInspectRequest,
    signal: AbortSignal
  ): Promise<PeekabooResult> {
    const target = this.requireSnapshotTarget(request.snapshotId)
    const result = await this.runNow(
      [
        "see",
        ...snapshotObservationTargetArgs(target),
        "--tree",
        "--no-screenshot",
        "--depth",
        String(request.maxDepth),
        "--max-elements",
        String(request.maxElements),
        "--max-children",
        String(request.maxChildren),
      ],
      signal
    )
    const inspectedSnapshotId = stringValue(asRecord(result.data)?.snapshot_id)
    if (inspectedSnapshotId) this.rememberSnapshot(inspectedSnapshotId, target)
    return result
  }

  private async resolveObservationTarget(
    requestedTarget: PeekabooObservationTarget,
    data: Record<string, unknown> | undefined,
    signal: AbortSignal
  ): Promise<PeekabooSnapshotTarget | undefined> {
    let target = observationTarget(data)
    const requestedApp =
      requestedTarget.kind === "app" || requestedTarget.kind === "window"
        ? requestedTarget.app
        : undefined
    if (requestedApp !== undefined && PID_APP_RE.test(requestedApp)) {
      target = {
        ...target,
        app: requestedApp,
      }
    }
    const requestedWindowId =
      requestedTarget.kind === "window" ? requestedTarget.windowId : undefined
    if (requestedWindowId !== undefined && target?.windowId === undefined) {
      target = {
        ...target,
        kind: target?.kind ?? "window-id",
        windowId: requestedWindowId,
      }
    }

    const screenCapture = isScreenSnapshotTarget(target) || requestedTarget.kind === "screen"
    if (screenCapture) {
      const screenIndex = requestedTarget.kind === "screen" ? requestedTarget.screenIndex : 0
      target = { ...target, kind: target?.kind ?? "screen", screenIndex }
      if (!target.bounds) {
        const screens = await this.runNow(["screen", "list"], signal)
        const bounds = screenBounds(screens.data, screenIndex)
        if (bounds) {
          target = { ...target, bounds }
        }
      }
    }
    return target
  }

  private rememberSnapshot(snapshotId: string, target: PeekabooSnapshotTarget): void {
    this.snapshots.delete(snapshotId)
    this.snapshots.set(snapshotId, target)
    while (this.snapshots.size > 64) {
      const oldest = this.snapshots.keys().next()
      if (oldest.done) break
      this.snapshots.delete(oldest.value)
    }
  }

  private async runNow(args: string[], signal: AbortSignal): Promise<PeekabooResult> {
    const runtimeArgs =
      this.localOnly && !args.includes("--no-remote") ? [...args, "--no-remote"] : args
    const commandArgs = [...this.baseArgs, ...runtimeArgs, "--json"]
    let stdout: string
    let stderr: string

    try {
      const output = await execFileAsync(this.executable, commandArgs, {
        encoding: "utf8",
        env: this.env,
        maxBuffer: this.maxOutputBytes,
        signal,
        timeout: this.timeoutMs,
      })
      stdout = String(output.stdout)
      stderr = String(output.stderr)
    } catch (error) {
      stdout = processOutput(error, "stdout")
      stderr = processOutput(error, "stderr")
      const envelope = tryParseEnvelope(stdout)
      if (envelope?.success === false) throw envelopeError(envelope, error)

      if (errorCode(error) === "ENOENT") {
        throw peekabooErrorWithCause(
          "PEEKABOO_NOT_FOUND",
          `Peekaboo executable ${JSON.stringify(this.executable)} was not found. Run npm install.`,
          undefined,
          error
        )
      }

      const detail = unknownErrorMessage(error)
      throw peekabooErrorWithCause(
        "PEEKABOO_PROCESS_FAILED",
        `Peekaboo command failed: ${detail}`,
        stderr.trim().slice(-4096) || undefined,
        error
      )
    }

    const envelope = parseEnvelope(stdout, stderr)
    if (!envelope.success) throw envelopeError(envelope)

    return {
      ...(envelope.data === undefined ? {} : { data: envelope.data }),
      ...(envelope.summary === undefined ? {} : { summary: envelope.summary }),
      ...(Array.isArray(envelope.messages)
        ? {
            messages: envelope.messages.filter((item): item is string => typeof item === "string"),
          }
        : {}),
    }
  }
}

function parseEnvelope(stdout: string, stderr: string): PeekabooEnvelope {
  const envelope = tryParseEnvelope(stdout)
  if (envelope) return envelope

  throw new PeekabooError(
    "PEEKABOO_INVALID_JSON",
    "Peekaboo did not return its expected JSON response.",
    stderr.trim().slice(-4096) || stdout.trim().slice(-4096) || undefined
  )
}

function tryParseEnvelope(stdout: string): PeekabooEnvelope | null {
  try {
    const parsed = asRecord(JSON.parse(stdout.trim()))
    if (!parsed) return null
    const success = parsed.success
    if (typeof success !== "boolean") return null
    const parsedError = asRecord(parsed.error)
    return {
      success,
      ...("data" in parsed ? { data: parsed.data } : {}),
      ...("summary" in parsed ? { summary: parsed.summary } : {}),
      ...("messages" in parsed ? { messages: parsed.messages } : {}),
      ...(parsedError
        ? {
            error: {
              ...("code" in parsedError ? { code: parsedError.code } : {}),
              ...("message" in parsedError ? { message: parsedError.message } : {}),
              ...("details" in parsedError ? { details: parsedError.details } : {}),
            },
          }
        : {}),
    }
  } catch {
    return null
  }
}

function envelopeError(envelope: PeekabooEnvelope, cause?: unknown): PeekabooError {
  const code =
    typeof envelope.error?.code === "string" ? envelope.error.code : "PEEKABOO_COMMAND_FAILED"
  const message =
    typeof envelope.error?.message === "string"
      ? envelope.error.message
      : "Peekaboo reported a command failure."
  const details = typeof envelope.error?.details === "string" ? envelope.error.details : undefined
  return cause === undefined
    ? new PeekabooError(code, message, details)
    : peekabooErrorWithCause(code, message, details, cause)
}

function processOutput(error: unknown, field: "stdout" | "stderr"): string {
  const value = asRecord(error)?.[field]
  if (typeof value === "string") return value
  if (Buffer.isBuffer(value)) return value.toString("utf8")
  return ""
}

function screenshotPath(
  data: Record<string, unknown> | undefined,
  requestedPath: string,
  annotate: boolean
): string {
  if (annotate && typeof data?.screenshot_annotated === "string" && data.screenshot_annotated) {
    return data.screenshot_annotated
  }
  if (typeof data?.screenshot_raw === "string" && data.screenshot_raw) return data.screenshot_raw
  return requestedPath
}

function errorCode(error: unknown): string | undefined {
  const code = asRecord(error)?.code
  return typeof code === "string" ? code : undefined
}

function unknownErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error)
  }
  return "Unknown error"
}

function peekabooErrorWithCause(
  code: string,
  message: string,
  details: string | undefined,
  cause: unknown
): PeekabooError {
  return new PeekabooError(code, message, details, { cause })
}

function observationTarget(
  data: Record<string, unknown> | undefined
): PeekabooSnapshotTarget | undefined {
  if (!data) return undefined
  const observation = asRecord(data.observation)
  const target = asRecord(observation?.target)
  const bounds = rectangle(target?.bounds)
  const kind =
    stringValue(target?.resolvedKind) ??
    stringValue(target?.resolved_kind) ??
    stringValue(target?.requestedKind) ??
    stringValue(target?.requested_kind) ??
    stringValue(data.capture_mode)
  const stateSnapshot =
    asRecord(observation?.stateSnapshot) ?? asRecord(observation?.state_snapshot)
  const windowId =
    numberValue(target?.windowID) ??
    numberValue(target?.window_id) ??
    numberValue(stateSnapshot?.frontmostWindowID) ??
    numberValue(stateSnapshot?.frontmost_window_id)
  const app = stringValue(data.application_name)
  const windowTitle = stringValue(data.window_title)

  if (!kind && !windowId && !app && !windowTitle && !bounds) return undefined
  return {
    ...(kind ? { kind } : {}),
    ...(app ? { app } : {}),
    ...(windowId ? { windowId } : {}),
    ...(windowTitle ? { windowTitle } : {}),
    ...(bounds ? { bounds } : {}),
  }
}

function rectangle(value: unknown): PeekabooSnapshotTarget["bounds"] | undefined {
  if (Array.isArray(value)) {
    const origin = Array.isArray(value[0]) ? value[0] : []
    const size = Array.isArray(value[1]) ? value[1] : []
    const x = numberValue(origin[0])
    const y = numberValue(origin[1])
    const width = numberValue(size[0])
    const height = numberValue(size[1])
    return x !== undefined && y !== undefined && width !== undefined && height !== undefined
      ? { x, y, width, height }
      : undefined
  }
  const record = asRecord(value)
  if (!record) return undefined
  const origin = asRecord(record.origin)
  const size = asRecord(record.size)
  const x = numberValue(record.x) ?? numberValue(origin?.x)
  const y = numberValue(record.y) ?? numberValue(origin?.y)
  const width = numberValue(record.width) ?? numberValue(size?.width)
  const height = numberValue(record.height) ?? numberValue(size?.height)
  return x !== undefined && y !== undefined && width !== undefined && height !== undefined
    ? { x, y, width, height }
    : undefined
}

function screenBounds(
  data: unknown,
  screenIndex: number
): PeekabooSnapshotTarget["bounds"] | undefined {
  const screens = asRecord(data)?.screens
  if (!Array.isArray(screens)) return undefined
  const screen = screens.map(asRecord).find((item) => numberValue(item?.index) === screenIndex)
  return rectangle(screen?.bounds)
}

function observationRequestArgs(request: PeekabooObservationRequest): string[] {
  const args: string[] = []
  const target = request.target
  if (target.kind === "frontmost") {
    args.push("--mode", "frontmost")
  } else if (target.kind === "screen") {
    args.push("--mode", "screen", "--screen-index", String(target.screenIndex))
  } else if (target.kind === "app") {
    args.push("--app", target.app)
  } else {
    if (target.app) args.push("--app", target.app)
    args.push("--window-id", String(target.windowId))
  }
  if (request.noWebFocus) args.push("--no-web-focus")
  return args
}

function isScreenSnapshotTarget(target: PeekabooSnapshotTarget | undefined): boolean {
  return target?.kind?.toLowerCase().includes("screen") ?? false
}

function exactWindowTarget(target: PeekabooSnapshotTarget): PeekabooExactWindowTarget | undefined {
  if (isScreenSnapshotTarget(target) || target.windowId === undefined) return undefined
  return {
    ...(target.app ? { app: target.app } : {}),
    windowId: target.windowId,
  }
}

function snapshotActionTargetArgs(target: PeekabooSnapshotTarget): string[] {
  if (isScreenSnapshotTarget(target)) return []
  if (target.windowId !== undefined) return ["--window-id", String(target.windowId)]
  if (target.app) return ["--app", target.app]
  return []
}

function snapshotObservationTargetArgs(target: PeekabooSnapshotTarget): string[] {
  if (isScreenSnapshotTarget(target)) {
    return ["--mode", "screen", "--screen-index", String(target.screenIndex ?? 0)]
  }
  if (target.windowId !== undefined) {
    return [...(target.app ? ["--app", target.app] : []), "--window-id", String(target.windowId)]
  }
  if (target.app && target.windowTitle) {
    return ["--app", target.app, "--window-title", target.windowTitle]
  }
  if (target.app) return ["--app", target.app]
  return ["--mode", "frontmost"]
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}
