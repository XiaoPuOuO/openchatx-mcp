import { createHash } from "node:crypto"
import { statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import process from "node:process"
import { MCP_CONFIG } from "../../config.js"
import { positiveInteger, utf8Chunk } from "../../utils.js"
import { DEFAULT_PARALLEL_COMMAND_TIMEOUT_MS } from "./parallel-runner.js"
import { createParallelSession } from "./parallel-session.js"
import type {
  ParallelCommandStatus,
  ShellCommandStatus,
  ShellPollInput,
  ShellResetInput,
  ShellResetOutput,
  ShellRunInput,
} from "./shell-contracts.js"
import {
  createShellProcess,
  type ShellProcessCommandResult,
  type ShellRecoverableState,
} from "./shell-process.js"
import { createTranscriptBuffer } from "./transcript.js"
import { createUpdateSignal } from "./update-signal.js"

export type { ShellRecoverableState } from "./shell-process.js"

export interface ShellSnapshot extends Record<string, unknown> {
  request_id: string
  status: ShellCommandStatus
  exit_code: number | null
  cwd: string
  output: string
  next_cursor: number
  output_truncated: boolean
  cursor_expired: boolean
  output_dropped: boolean
  dropped_output_bytes: number
  commands?: ParallelCommandSnapshot[]
}

interface ParallelCommandSnapshot extends Record<string, unknown> {
  run: number
  command: string
  path: string
  status: ParallelCommandStatus
  exit_code: number | null
  output_dropped?: true
  dropped_output_bytes?: number
}

type RunCommandInput = Omit<ShellRunInput, "shell_id"> & { signal?: AbortSignal }
type PollCommandInput = Omit<ShellPollInput, "shell_id"> & { signal?: AbortSignal }
type ResetShellInput = Omit<ShellResetInput, "shell_id">

export interface ShellSessionOptions {
  shellPath?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  initialState?: ShellRecoverableState
  transcriptLimit?: number
  commandTranscriptBytes?: number
  recordLimit?: number
  parallelCommandTimeoutMs?: number
}

interface CommandRecord {
  requestId: string
  commandHash: string
  cwd: string
  startCursor: number
  endCursor: number | null
  status: ShellCommandStatus
  exitCode: number | null
  capturedOutputBytes: number
  droppedOutputBytes: number
}

type ResetResult = ShellResetOutput

export class ShellSessionError extends Error {
  constructor(
    readonly code:
      | "busy"
      | "closed"
      | "invalid_command"
      | "request_conflict"
      | "request_not_found"
      | "invalid_cursor"
      | "shell_limit_reached"
      | "protected_shell"
      | "shell_unavailable",
    message: string
  ) {
    super(message)
    this.name = "ShellSessionError"
  }
}

export interface ShellSession {
  readonly initialCwd: string
  readonly hasActiveWork: boolean
  start(): Promise<void>
  captureRecoverableState(): Promise<ShellRecoverableState>
  runCommand(input: RunCommandInput): Promise<ShellSnapshot>
  pollCommand(input: PollCommandInput): Promise<ShellSnapshot>
  reset(input: ResetShellInput): Promise<ResetResult>
  close(): Promise<void>
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: The session remains the cohesive owner of persistent-shell arbitration and single-command state; parallel batch lifecycle is isolated in parallel-session.ts.
export function createShellSession(options: ShellSessionOptions = {}): ShellSession {
  const transcriptLimit = positiveInteger(options.transcriptLimit, MCP_CONFIG.shell.transcriptChars)
  const transcript = createTranscriptBuffer(transcriptLimit)
  const commandTranscriptBytes = positiveInteger(
    options.commandTranscriptBytes,
    MCP_CONFIG.shell.commandTranscriptBytes
  )
  const recordLimit = positiveInteger(options.recordLimit, MCP_CONFIG.shell.recordLimit)
  const parallelCommandTimeoutMs = positiveInteger(
    options.parallelCommandTimeoutMs,
    DEFAULT_PARALLEL_COMMAND_TIMEOUT_MS
  )
  const records = new Map<string, CommandRecord>()
  const updates = createUpdateSignal()
  const parallelSession = createParallelSession({
    transcriptLimit,
    commandTranscriptBytes,
    recordLimit,
    commandTimeoutMs: parallelCommandTimeoutMs,
    onUpdate: updates.notify,
    waitForResult,
  })

  let active: CommandRecord | null = null
  let resetInFlight: Promise<ResetResult> | null = null

  const processController = createShellProcess({
    shellPath: options.shellPath ?? MCP_CONFIG.shell.path,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    initialState: options.initialState,
    onIdleOutput: appendTranscript,
    onUpdate: updates.notify,
  })

  function hasActiveWork(): boolean {
    return (
      active !== null ||
      parallelSession.hasActiveWork ||
      resetInFlight !== null ||
      processController.hasActiveOperation
    )
  }

  async function start(): Promise<void> {
    if (processController.closed)
      throw new ShellSessionError("closed", "The shell session is closed.")
    await processController.start()
  }

  async function captureRecoverableState(): Promise<ShellRecoverableState> {
    if (processController.closed)
      throw new ShellSessionError("closed", "The shell session is closed.")
    if (hasActiveWork())
      throw new ShellSessionError("busy", "The shell is busy and cannot capture recoverable state.")
    return processController.captureRecoverableState()
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Command dispatch is the session state machine and keeps request-id, parallel, and active-command invariants in one place.
  async function runCommand(input: RunCommandInput): Promise<ShellSnapshot> {
    if ((input.command === undefined) === (input.commands === undefined)) {
      throw new ShellSessionError("invalid_command", "Provide exactly one of command or commands.")
    }
    if (input.commands?.length === 0)
      throw new ShellSessionError("invalid_command", "commands must contain at least one command.")

    const maxOutputTokens = input.max_output_tokens
    const commandHash = hashCommand(input)
    const parallelCommands =
      input.commands?.map(({ command, cwd }) => ({ command, path: cwd ?? "." })) ?? null

    await start()
    const existing = records.get(input.request_id)
    if (existing) {
      if (existing.commandHash !== commandHash) {
        throw new ShellSessionError(
          "request_conflict",
          `request_id ${JSON.stringify(input.request_id)} was already used for a different command.`
        )
      }
      if (existing.status === "running")
        await waitForResult(existing, input.yield_time_ms, input.signal)
      return snapshot(existing, existing.startCursor, maxOutputTokens)
    }

    const parallelRetry = await parallelSession.retry({
      requestId: input.request_id,
      commandHash,
      waitMs: input.yield_time_ms,
      maxOutputTokens,
      signal: input.signal,
    })
    if (parallelRetry.kind === "conflict") {
      throw new ShellSessionError(
        "request_conflict",
        `request_id ${JSON.stringify(input.request_id)} was already used for a different command.`
      )
    }
    if (parallelRetry.kind === "found") return parallelRetry.snapshot

    if (resetInFlight) throw new ShellSessionError("busy", "The shell is being reset.")
    if (active || parallelSession.hasActiveWork || processController.hasActiveOperation) {
      const requestId =
        active?.requestId ?? parallelSession.activeRequestId ?? "an internal shell operation"
      throw new ShellSessionError(
        "busy",
        `The shell is busy with request_id ${JSON.stringify(requestId)}. Poll that request or reset the shell.`
      )
    }
    if (!processController.ready)
      throw new ShellSessionError("shell_unavailable", "The shell process is not ready.")

    const commandCwd =
      input.cwd === undefined ? undefined : resolve(processController.currentCwd, input.cwd)
    validateWorkingDirectory(commandCwd)

    if (parallelCommands) {
      const rootCwd = commandCwd ?? processController.currentCwd
      validateWorkingDirectory(rootCwd)
      for (const command of parallelCommands) {
        validateWorkingDirectory(resolve(rootCwd, command.path))
      }
      const started = await parallelSession.start({
        requestId: input.request_id,
        commandHash,
        rootCwd,
        commands: parallelCommands,
        shellPath: processController.shellPath,
        captureContext: () => processController.captureContext(commandCwd),
        waitMs: input.yield_time_ms,
        maxOutputTokens,
        signal: input.signal,
      })
      if (started.kind === "capture_failed") {
        throw shellSessionError(
          "shell_unavailable",
          `Could not capture the shell environment: ${errorMessage(started.error)}`,
          started.error
        )
      }
      return started.snapshot
    }

    if (input.command === undefined)
      throw new ShellSessionError("invalid_command", "Provide exactly one of command or commands.")

    const record: CommandRecord = {
      requestId: input.request_id,
      commandHash,
      cwd: commandCwd ?? processController.currentCwd,
      startCursor: transcript.end,
      endCursor: null,
      status: "running",
      exitCode: null,
      capturedOutputBytes: 0,
      droppedOutputBytes: 0,
    }

    pruneCommandRecords()
    records.set(record.requestId, record)
    active = record
    try {
      const running = await processController.beginCommand(input.command, commandCwd, (chunk) =>
        appendCommandOutput(record, chunk)
      )
      void running.completion.then((result) => finishCommand(record, result))
    } catch (error) {
      record.endCursor = transcript.end
      record.status = resetInFlight ? "reset" : "shell_exited"
      if (active === record) active = null
      updates.notify()
      throw shellSessionError(
        "shell_unavailable",
        `Could not write to the shell: ${errorMessage(error)}`,
        error
      )
    }

    await waitForResult(record, input.yield_time_ms, input.signal)
    return snapshot(record, record.startCursor, maxOutputTokens)
  }

  async function pollCommand(input: PollCommandInput): Promise<ShellSnapshot> {
    const record = records.get(input.request_id)
    if (record) {
      if (input.cursor < record.startCursor)
        throw new ShellSessionError(
          "invalid_cursor",
          "cursor is before the requested command's output."
        )

      const maxOutputTokens = input.max_output_tokens
      if (record.status === "running") {
        await waitForResult(record, input.yield_time_ms, input.signal)
      }
      return snapshot(record, input.cursor, maxOutputTokens)
    }

    const parallel = await parallelSession.poll({
      requestId: input.request_id,
      cursor: input.cursor,
      waitMs: input.yield_time_ms,
      maxOutputTokens: input.max_output_tokens,
      signal: input.signal,
    })
    if (parallel) return parallel
    throw new ShellSessionError(
      "request_not_found",
      `No command exists for request_id ${JSON.stringify(input.request_id)}.`
    )
  }

  function finishCommand(record: CommandRecord, result: ShellProcessCommandResult): void {
    if (record.status !== "running") return
    record.endCursor = transcript.end
    record.exitCode = result.exitCode
    record.cwd = result.cwd
    record.status = result.status
    if (active === record) active = null
    updates.notify()
  }

  async function reset(input: ResetShellInput): Promise<ResetResult> {
    if (processController.closed)
      throw new ShellSessionError("closed", "The shell session is closed.")
    if (resetInFlight) throw new ShellSessionError("busy", "The shell is already being reset.")

    const promise = performReset(input.reason)
    resetInFlight = promise
    void promise.then(
      () => {
        if (resetInFlight === promise) resetInFlight = null
      },
      () => {
        if (resetInFlight === promise) resetInFlight = null
      }
    )
    return promise
  }

  async function performReset(reason?: string): Promise<ResetResult> {
    await parallelSession.cancelActive()
    const generation = await processController.reset(reason)
    return { shell_generation: generation, state_lost: true, status: "ready" }
  }

  async function close(): Promise<void> {
    if (processController.closed) return
    await parallelSession.cancelActive()
    await processController.close()
    updates.notify()
  }

  function snapshot(record: CommandRecord, cursor: number, maxOutputTokens: number): ShellSnapshot {
    const read = transcript.read(cursor, maxOutputTokens, record.endCursor ?? undefined)
    return {
      request_id: record.requestId,
      status: record.status,
      exit_code: record.exitCode,
      cwd: record.cwd,
      output: read.output,
      next_cursor: read.nextCursor,
      output_truncated: read.hasMore,
      cursor_expired: read.cursorExpired,
      output_dropped: record.droppedOutputBytes > 0,
      dropped_output_bytes: record.droppedOutputBytes,
    }
  }

  async function waitForResult(
    record: { status: ShellCommandStatus },
    waitMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    const deadline = Date.now() + waitMs
    // Output pagination is independent of execution: a full page must not shorten the requested wait.
    while (record.status === "running" && !signal?.aborted) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) return
      await updates.wait(updates.version, remainingMs, signal)
    }
  }

  function pruneCommandRecords(): void {
    while (records.size >= recordLimit) {
      const oldestCompleted = [...records.values()].find((record) => record.status !== "running")
      if (!oldestCompleted) return
      records.delete(oldestCompleted.requestId)
    }
  }

  function appendTranscript(chunk: string): void {
    if (chunk.length === 0) return
    transcript.append(chunk)
    updates.notify()
  }

  function appendCommandOutput(record: CommandRecord, chunk: string): void {
    if (chunk.length === 0) return

    const remaining = Math.max(0, commandTranscriptBytes - record.capturedOutputBytes)
    const bounded = utf8Chunk(chunk, 0, remaining)
    const captured = bounded.value
    const dropped = chunk.slice(bounded.nextOffset)

    if (captured.length > 0) {
      record.capturedOutputBytes += Buffer.byteLength(captured, "utf8")
      appendTranscript(captured)
    }
    if (dropped.length > 0) {
      const wasTruncated = record.droppedOutputBytes > 0
      record.droppedOutputBytes = Math.min(
        Number.MAX_SAFE_INTEGER,
        record.droppedOutputBytes + Buffer.byteLength(dropped, "utf8")
      )
      if (!wasTruncated && captured.length === 0) updates.notify()
    }
  }

  return {
    get initialCwd() {
      return processController.initialCwd
    },
    get hasActiveWork() {
      return hasActiveWork()
    },
    start,
    captureRecoverableState,
    runCommand,
    pollCommand,
    reset,
    close,
  }
}

function hashCommand(input: Pick<RunCommandInput, "command" | "commands" | "cwd">): string {
  return createHash("sha256")
    .update(JSON.stringify([input.cwd ?? null, input.command ?? null, input.commands ?? null]))
    .digest("hex")
}

function validateWorkingDirectory(cwd: string | undefined): void {
  if (cwd === undefined) return
  if (!isAbsolute(cwd))
    throw new ShellSessionError("invalid_command", "cwd must be an absolute path.")

  try {
    const entry = statSync(cwd)
    if (!entry.isDirectory())
      throw new ShellSessionError(
        "invalid_command",
        `cwd is not a directory: ${JSON.stringify(cwd)}.`
      )
  } catch (error) {
    if (error instanceof ShellSessionError) throw error
    throw shellSessionError(
      "invalid_command",
      `cwd is not accessible: ${JSON.stringify(cwd)} (${errorMessage(error)}).`,
      error
    )
  }
}

function shellSessionError(
  code: ShellSessionError["code"],
  message: string,
  cause: unknown
): ShellSessionError {
  const error = new ShellSessionError(code, message)
  error.cause = cause
  return error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
