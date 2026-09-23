import { resolve } from "node:path"

import { formatOutputBlock } from "../../mcp/tool-output.js"
import {
  createParallelCommandScheduler,
  executeParallelCommand,
  ParallelCommandAbortedError,
  type ParallelCommandExecutionResult,
  type ParallelCommandSpec,
  type ParallelCommandStatus,
} from "./parallel-runner.js"
import type { ShellCommandStatus } from "./shell-contracts.js"
import type { ShellProcessContext } from "./shell-process.js"
import { createTranscriptBuffer, type TranscriptBuffer } from "./transcript.js"

const LINE_SEPARATOR = /\r?\n/u

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

interface ParallelBatchSnapshot extends Record<string, unknown> {
  request_id: string
  status: Extract<ShellCommandStatus, "running" | "completed" | "reset">
  exit_code: number | null
  cwd: string
  output: string
  next_cursor: number
  output_truncated: boolean
  cursor_expired: boolean
  output_dropped: boolean
  dropped_output_bytes: number
  commands: Array<{
    run: number
    command: string
    path: string
    status: ParallelCommandStatus
    exit_code: number | null
    output_dropped?: true
    dropped_output_bytes?: number
  }>
}

interface CreateParallelSessionOptions {
  transcriptLimit: number
  commandTranscriptBytes: number
  recordLimit: number
  commandTimeoutMs: number
  onUpdate: () => void
  waitForResult: (
    record: { status: ShellCommandStatus },
    waitMs: number,
    signal?: AbortSignal
  ) => Promise<void>
}

interface ParallelRetryInput {
  requestId: string
  commandHash: string
  waitMs: number
  maxOutputTokens: number
  signal?: AbortSignal
}

interface ParallelStartInput {
  requestId: string
  commandHash: string
  rootCwd: string
  commands: ParallelCommandSpec[]
  shellPath: string
  captureContext: () => Promise<ShellProcessContext>
  waitMs: number
  maxOutputTokens: number
  signal?: AbortSignal
}

interface ParallelPollInput {
  requestId: string
  cursor: number
  waitMs: number
  maxOutputTokens: number
  signal?: AbortSignal
}

export function createParallelSession(options: CreateParallelSessionOptions) {
  const scheduleParallelCommand = createParallelCommandScheduler()
  const records = new Map<string, ParallelBatchRecord>()
  let active: ParallelBatchRecord | null = null

  async function retry(
    input: ParallelRetryInput
  ): Promise<
    { kind: "missing" } | { kind: "conflict" } | { kind: "found"; snapshot: ParallelBatchSnapshot }
  > {
    const record = records.get(input.requestId)
    if (!record) return { kind: "missing" }
    if (record.commandHash !== input.commandHash) return { kind: "conflict" }
    if (record.status === "running") {
      await options.waitForResult(record, input.waitMs, input.signal)
    }
    return { kind: "found", snapshot: snapshot(record, 0, input.maxOutputTokens) }
  }

  async function start(
    input: ParallelStartInput
  ): Promise<
    | { kind: "started"; snapshot: ParallelBatchSnapshot }
    | { kind: "capture_failed"; error: unknown }
  > {
    const runs: ParallelRunRecord[] = input.commands.map((command, index) => ({
      run: index + 1,
      command: command.command,
      path: command.path,
      cwd: resolve(input.rootCwd, command.path),
      status: "queued",
      exitCode: null,
      droppedOutputBytes: 0,
    }))
    const record: ParallelBatchRecord = {
      requestId: input.requestId,
      commandHash: input.commandHash,
      cwd: input.rootCwd,
      transcript: createTranscriptBuffer(options.transcriptLimit),
      endCursor: null,
      status: "running",
      runs,
      remainingRuns: runs.length,
      abortController: new AbortController(),
      tasks: [],
    }

    pruneRecords()
    records.set(record.requestId, record)
    active = record

    let context: ShellProcessContext
    try {
      context = await input.captureContext()
    } catch (error) {
      if (record.status === "reset") {
        return { kind: "started", snapshot: snapshot(record, 0, input.maxOutputTokens) }
      }
      records.delete(record.requestId)
      if (active === record) active = null
      options.onUpdate()
      return { kind: "capture_failed", error }
    }

    record.cwd = context.cwd
    for (const run of record.runs) run.cwd = resolve(context.cwd, run.path)

    for (const run of record.runs) {
      const task = scheduleParallelCommand(async () => {
        if (record.status !== "running") throw new ParallelCommandAbortedError()
        run.status = "running"
        options.onUpdate()
        return executeParallelCommand({
          shellPath: input.shellPath,
          command: run.command,
          cwd: run.cwd,
          env: context.env,
          outputLimitBytes: options.commandTranscriptBytes,
          timeoutMs: options.commandTimeoutMs,
          signal: record.abortController.signal,
        })
      }, record.abortController.signal).then(
        (result) => finishRun(record, run, result),
        (error) =>
          finishRun(record, run, {
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

    await options.waitForResult(record, input.waitMs, input.signal)
    return { kind: "started", snapshot: snapshot(record, 0, input.maxOutputTokens) }
  }

  async function poll(input: ParallelPollInput): Promise<ParallelBatchSnapshot | undefined> {
    const record = records.get(input.requestId)
    if (!record) return undefined
    if (record.status === "running") {
      await options.waitForResult(record, input.waitMs, input.signal)
    }
    return snapshot(record, input.cursor, input.maxOutputTokens)
  }

  async function cancelActive(): Promise<void> {
    const record = active
    if (record?.status !== "running") return
    record.status = "reset"
    for (const run of record.runs) {
      if (!isTerminal(run.status)) {
        run.status = "reset"
        run.exitCode = null
        record.transcript.append(formatRunOutput(run, ""))
      }
    }
    record.endCursor = record.transcript.end
    record.abortController.abort()
    if (active === record) active = null
    options.onUpdate()
    await Promise.allSettled(record.tasks)
  }

  function finishRun(
    record: ParallelBatchRecord,
    run: ParallelRunRecord,
    result: ParallelCommandExecutionResult
  ): void {
    if (record.status === "reset" || run.status === "reset") return

    run.status = result.status
    run.exitCode = result.exitCode
    run.droppedOutputBytes = result.droppedOutputBytes
    record.transcript.append(formatRunOutput(run, result.output))
    record.remainingRuns -= 1

    if (record.remainingRuns === 0) {
      record.status = "completed"
      record.endCursor = record.transcript.end
      if (active === record) active = null
    }
    options.onUpdate()
  }

  function snapshot(
    record: ParallelBatchRecord,
    cursor: number,
    maxOutputTokens: number
  ): ParallelBatchSnapshot {
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
        command: commandPreview(run.command),
        path: run.path,
        status: run.status,
        exit_code: run.exitCode,
        ...(run.droppedOutputBytes > 0
          ? { output_dropped: true as const, dropped_output_bytes: run.droppedOutputBytes }
          : {}),
      })),
    }
  }

  function pruneRecords(): void {
    while (records.size >= options.recordLimit) {
      const oldestCompleted = [...records.values()].find((record) => record.status !== "running")
      if (!oldestCompleted) return
      records.delete(oldestCompleted.requestId)
    }
  }

  return {
    get hasActiveWork() {
      return active !== null
    },
    get activeRequestId() {
      return active?.requestId
    },
    retry,
    start,
    poll,
    cancelActive,
  }
}

function isTerminal(status: ParallelCommandStatus): boolean {
  return status !== "queued" && status !== "running"
}

function commandPreview(command: string): string {
  const firstLine =
    command
      .split(LINE_SEPARATOR)
      .find((line) => line.trim().length > 0)
      ?.trim()
      .replace(/\s+/gu, " ") ?? ""
  const characters = Array.from(firstLine)
  return characters.length <= 20 ? firstLine : `${characters.slice(0, 19).join("")}…`
}

function formatRunOutput(run: ParallelRunRecord, output: string): string {
  const block = formatOutputBlock([`run=${run.run}`], output)
  return `${block}\n\n`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
