import { createHash } from "node:crypto"
import { statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import process from "node:process"
import { MCP_CONFIG } from "../../config.js"
import { formatOutputBlock } from "../../server/tool-output.js"
import { positiveInteger, utf8Chunk } from "../../utils.js"
import {
  createParallelCommandScheduler,
  DEFAULT_PARALLEL_COMMAND_TIMEOUT_MS,
  executeParallelCommand,
  ParallelCommandAbortedError,
  type ParallelCommandExecutionResult,
  type ParallelCommandSpec,
  type ParallelCommandStatus,
} from "./parallel-runner.js"
import type {
  ShellCommandStatus,
  ShellPollInput,
  ShellResetInput,
  ShellResetOutput,
  ShellRunInput,
} from "./shell-contracts.js"
import {
  createShellProcess,
  type ShellProcessCommandResult,
  type ShellProcessContext,
  type ShellRecoverableState,
} from "./shell-process.js"
import { createTranscriptBuffer, type TranscriptBuffer } from "./transcript.js"
import { createUpdateSignal } from "./update-signal.js"

const LINE_SEPARATOR = /\r?\n/u

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

interface ParallelRunRecord {
  run: number
  command: string
  path: string
  cwd: string
  status: ParallelCommandStatus
  exitCode: number | null
  droppedOutputBytes: number
}

interface ParallelBatchRecord {
  requestId: string
  commandHash: string
  cwd: string
  transcript: TranscriptBuffer
  endCursor: number | null
  status: Extract<ShellCommandStatus, "running" | "completed" | "reset">
  runs: ParallelRunRecord[]
  remainingRuns: number
  abortController: AbortController
  tasks: Promise<void>[]
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Session operations intentionally close over one shared shell state machine; splitting the factory would widen mutable state ownership.
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
  const scheduleParallelCommand = createParallelCommandScheduler()
  const records = new Map<string, CommandRecord>()
  const parallelRecords = new Map<string, ParallelBatchRecord>()
  const updates = createUpdateSignal()

  let active: CommandRecord | null = null
  let activeParallel: ParallelBatchRecord | null = null
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
      activeParallel !== null ||
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

    const existingParallel = parallelRecords.get(input.request_id)
    if (existingParallel) {
      if (existingParallel.commandHash !== commandHash) {
        throw new ShellSessionError(
          "request_conflict",
          `request_id ${JSON.stringify(input.request_id)} was already used for a different command.`
        )
      }
      if (existingParallel.status === "running") {
        await waitForResult(existingParallel, input.yield_time_ms, input.signal)
      }
      return parallelSnapshot(existingParallel, 0, maxOutputTokens)
    }

    if (resetInFlight) throw new ShellSessionError("busy", "The shell is being reset.")
    if (active || activeParallel || processController.hasActiveOperation) {
      const requestId =
        active?.requestId ?? activeParallel?.requestId ?? "an internal shell operation"
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
      return runParallelCommands({
        input: commandCwd === input.cwd ? input : { ...input, cwd: commandCwd },
        commands: parallelCommands,
        commandHash,
        maxOutputTokens,
      })
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
    const parallelRecord = parallelRecords.get(input.request_id)
    if (!record && !parallelRecord) {
      throw new ShellSessionError(
        "request_not_found",
        `No command exists for request_id ${JSON.stringify(input.request_id)}.`
      )
    }

    if (parallelRecord) {
      const maxOutputTokens = input.max_output_tokens
      if (parallelRecord.status === "running") {
        await waitForResult(parallelRecord, input.yield_time_ms, input.signal)
      }
      return parallelSnapshot(parallelRecord, input.cursor, maxOutputTokens)
    }

    if (!record)
      throw new ShellSessionError(
        "request_not_found",
        `No command exists for request_id ${JSON.stringify(input.request_id)}.`
      )
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

  async function runParallelCommands(parallelOptions: {
    input: RunCommandInput
    commands: ParallelCommandSpec[]
    commandHash: string
    maxOutputTokens: number
  }): Promise<ShellSnapshot> {
    const rootCwd = parallelOptions.input.cwd ?? processController.currentCwd
    validateWorkingDirectory(rootCwd)
    const runs: ParallelRunRecord[] = parallelOptions.commands.map((command, index) => {
      const cwd = resolve(rootCwd, command.path)
      validateWorkingDirectory(cwd)
      return {
        run: index + 1,
        command: command.command,
        path: command.path,
        cwd,
        status: "queued",
        exitCode: null,
        droppedOutputBytes: 0,
      }
    })

    const record: ParallelBatchRecord = {
      requestId: parallelOptions.input.request_id,
      commandHash: parallelOptions.commandHash,
      cwd: rootCwd,
      transcript: createTranscriptBuffer(transcriptLimit),
      endCursor: null,
      status: "running",
      runs,
      remainingRuns: runs.length,
      abortController: new AbortController(),
      tasks: [],
    }

    pruneParallelRecords()
    parallelRecords.set(record.requestId, record)
    activeParallel = record

    let context: ShellProcessContext
    try {
      context = await processController.captureContext(parallelOptions.input.cwd)
    } catch (error) {
      if (record.status === "reset")
        return parallelSnapshot(record, 0, parallelOptions.maxOutputTokens)
      parallelRecords.delete(record.requestId)
      if (activeParallel === record) activeParallel = null
      updates.notify()
      throw shellSessionError(
        "shell_unavailable",
        `Could not capture the shell environment: ${errorMessage(error)}`,
        error
      )
    }

    record.cwd = context.cwd
    for (const run of record.runs) run.cwd = resolve(context.cwd, run.path)

    for (const run of record.runs) {
      const task = scheduleParallelCommand(async () => {
        if (record.status !== "running") throw new ParallelCommandAbortedError()
        run.status = "running"
        updates.notify()
        return executeParallelCommand({
          shellPath: processController.shellPath,
          command: run.command,
          cwd: run.cwd,
          env: context.env,
          outputLimitBytes: commandTranscriptBytes,
          timeoutMs: parallelCommandTimeoutMs,
          signal: record.abortController.signal,
        })
      }, record.abortController.signal).then(
        (result) => finishParallelRun(record, run, result),
        (error) =>
          finishParallelRun(record, run, {
            status:
              error instanceof ParallelCommandAbortedError || record.abortController.signal.aborted
                ? "reset"
                : "failed",
            exitCode: null,
            output: error instanceof ParallelCommandAbortedError ? "" : errorMessage(error),
            droppedOutputBytes: 0,
          })
      )
      record.tasks.push(task)
    }

    await waitForResult(record, parallelOptions.input.yield_time_ms, parallelOptions.input.signal)
    return parallelSnapshot(record, 0, parallelOptions.maxOutputTokens)
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

  function finishParallelRun(
    record: ParallelBatchRecord,
    run: ParallelRunRecord,
    result: ParallelCommandExecutionResult
  ): void {
    if (record.status === "reset" || run.status === "reset") return

    run.status = result.status
    run.exitCode = result.exitCode
    run.droppedOutputBytes = result.droppedOutputBytes
    record.transcript.append(formatParallelRunOutput(run, result.output))
    record.remainingRuns -= 1

    if (record.remainingRuns === 0) {
      record.status = "completed"
      record.endCursor = record.transcript.end
      if (activeParallel === record) activeParallel = null
    }
    updates.notify()
  }

  function parallelSnapshot(
    record: ParallelBatchRecord,
    cursor: number,
    maxOutputTokens: number
  ): ShellSnapshot {
    const read = record.transcript.read(cursor, maxOutputTokens, record.endCursor ?? undefined)
    const droppedOutputBytes = record.runs.reduce(
      (total, run) => Math.min(Number.MAX_SAFE_INTEGER, total + run.droppedOutputBytes),
      0
    )
    let exitCode: number | null = null
    if (record.status === "completed") {
      exitCode = record.runs.every((run) => run.status === "completed" && run.exitCode === 0)
        ? 0
        : 1
    }
    return {
      request_id: record.requestId,
      status: record.status,
      exit_code: exitCode,
      cwd: record.cwd,
      output: read.output,
      next_cursor: read.nextCursor,
      output_truncated: read.hasMore,
      cursor_expired: read.cursorExpired,
      output_dropped: droppedOutputBytes > 0,
      dropped_output_bytes: droppedOutputBytes,
      commands: record.runs.map((run) => ({
        run: run.run,
        command: batchCommandPreview(run.command),
        path: run.path,
        status: run.status,
        exit_code: run.exitCode,
        ...(run.droppedOutputBytes > 0
          ? { output_dropped: true as const, dropped_output_bytes: run.droppedOutputBytes }
          : {}),
      })),
    }
  }

  async function cancelActiveParallelBatch(): Promise<void> {
    const record = activeParallel
    if (record?.status !== "running") return
    record.status = "reset"
    for (const run of record.runs) {
      if (!isParallelTerminal(run.status)) {
        run.status = "reset"
        run.exitCode = null
        record.transcript.append(formatParallelRunOutput(run, ""))
      }
    }
    record.endCursor = record.transcript.end
    record.abortController.abort()
    if (activeParallel === record) activeParallel = null
    updates.notify()
    await Promise.allSettled(record.tasks)
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
    await cancelActiveParallelBatch()
    const generation = await processController.reset(reason)
    return { shell_generation: generation, state_lost: true, status: "ready" }
  }

  async function close(): Promise<void> {
    if (processController.closed) return
    await cancelActiveParallelBatch()
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
    record: CommandRecord | ParallelBatchRecord,
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

  function pruneParallelRecords(): void {
    while (parallelRecords.size >= recordLimit) {
      const oldestCompleted = [...parallelRecords.values()].find(
        (record) => record.status !== "running"
      )
      if (!oldestCompleted) return
      parallelRecords.delete(oldestCompleted.requestId)
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

function isParallelTerminal(status: ParallelCommandStatus): boolean {
  return status !== "queued" && status !== "running"
}

function batchCommandPreview(command: string): string {
  const firstLine =
    command
      .split(LINE_SEPARATOR)
      .find((line) => line.trim().length > 0)
      ?.trim()
      .replace(/\s+/gu, " ") ?? ""
  const characters = Array.from(firstLine)
  return characters.length <= 20 ? firstLine : `${characters.slice(0, 19).join("")}…`
}

function formatParallelRunOutput(run: ParallelRunRecord, output: string): string {
  const block = formatOutputBlock([`run=${run.run}`], output)
  return `${block}\n\n`
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
