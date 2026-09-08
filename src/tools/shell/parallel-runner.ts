import { spawn, type ChildProcess } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

import { utf8Chunk } from "../../utils.js"
import type { ParallelCommandStatus } from "./shell-contracts.js"
import { prepareShellCommand } from "./rtk.js"

export type { ParallelCommandStatus } from "./shell-contracts.js"

const PARALLEL_COMMAND_LIMIT = 8
export const DEFAULT_PARALLEL_COMMAND_TIMEOUT_MS = 30 * 60 * 1000

const STOP_GRACE_MS = 500

export interface ParallelCommandSpec {
  command: string
  path: string
}

export interface ParallelCommandExecutionResult {
  status: Extract<ParallelCommandStatus, "completed" | "timed_out" | "failed" | "reset">
  exitCode: number | null
  output: string
  droppedOutputBytes: number
}

export interface ExecuteParallelCommandInput {
  shellPath: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  outputLimitBytes: number
  timeoutMs: number
  signal: AbortSignal
}

interface QueuedTask<T> {
  task: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export function createParallelCommandScheduler() {
  let active = 0
  const queue: QueuedTask<unknown>[] = []

  function schedule<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new ParallelCommandAbortedError())

    return new Promise<T>((resolve, reject) => {
      const queued: QueuedTask<T> = {
        task,
        resolve,
        reject,
        signal,
      }
      if (signal) {
        queued.onAbort = () => {
          const index = queue.indexOf(queued as QueuedTask<unknown>)
          if (index < 0) return
          queue.splice(index, 1)
          reject(new ParallelCommandAbortedError())
        }
        signal.addEventListener("abort", queued.onAbort, { once: true })
      }
      queue.push(queued as QueuedTask<unknown>)
      pump()
    })
  }

  function pump(): void {
    while (active < PARALLEL_COMMAND_LIMIT && queue.length > 0) {
      const queued = queue.shift()!
      if (queued.onAbort) queued.signal?.removeEventListener("abort", queued.onAbort)
      if (queued.signal?.aborted) {
        queued.reject(new ParallelCommandAbortedError())
        continue
      }

      active += 1
      void queued
        .task()
        .then(queued.resolve, queued.reject)
        .finally(() => {
          active -= 1
          pump()
        })
    }
  }

  return schedule
}

export class ParallelCommandAbortedError extends Error {
  constructor() {
    super("Parallel command was aborted before it could run.")
    this.name = "ParallelCommandAbortedError"
  }
}

export function executeParallelCommand(input: ExecuteParallelCommandInput): Promise<ParallelCommandExecutionResult> {
  if (input.signal.aborted) {
    return Promise.resolve({ status: "reset", exitCode: null, output: "", droppedOutputBytes: 0 })
  }

  return new Promise((resolve) => {
    const output = createBoundedOutput(input.outputLimitBytes)
    const stdoutDecoder = new StringDecoder("utf8")
    const stderrDecoder = new StringDecoder("utf8")
    let child: ChildProcess
    let settled = false
    let timeoutRequested = false
    let resetRequested = false
    let forceTimer: NodeJS.Timeout | null = null
    let timeoutTimer: NodeJS.Timeout | null = null

    const finish = (status: ParallelCommandExecutionResult["status"], exitCode: number | null) => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (forceTimer) clearTimeout(forceTimer)
      input.signal.removeEventListener("abort", onAbort)
      const stdoutTail = stdoutDecoder.end()
      const stderrTail = stderrDecoder.end()
      if (stdoutTail) output.append(stdoutTail)
      if (stderrTail) output.append(stderrTail)
      resolve({ status, exitCode, output: output.value, droppedOutputBytes: output.droppedBytes })
    }

    const stop = () => {
      killProcessGroup(child, "SIGTERM")
      if (forceTimer) clearTimeout(forceTimer)
      forceTimer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL")
        finish(resetRequested ? "reset" : "timed_out", null)
      }, STOP_GRACE_MS)
      forceTimer.unref()
    }

    const onAbort = () => {
      resetRequested = true
      stop()
    }

    try {
      const executionCommand = prepareShellCommand(input.command, input.cwd, input.env)
      child = spawn(input.shellPath, ["-f", "-c", executionCommand], {
        cwd: input.cwd,
        env: input.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      resolve({
        status: "failed",
        exitCode: null,
        output: error instanceof Error ? error.message : String(error),
        droppedOutputBytes: 0,
      })
      return
    }

    child.stdout?.on("data", (chunk: Buffer) => output.append(stdoutDecoder.write(chunk)))
    child.stderr?.on("data", (chunk: Buffer) => output.append(stderrDecoder.write(chunk)))
    child.once("error", (error) => {
      output.append(error.message)
      killProcessGroup(child, "SIGKILL")
      finish(resetRequested ? "reset" : timeoutRequested ? "timed_out" : "failed", null)
    })
    child.once("exit", () => {
      // The shell may exit while background descendants still hold its stdio
      // pipes open. Kill the process group here instead of waiting for close.
      killProcessGroup(child, "SIGKILL")
    })
    child.once("close", (code) => {
      finish(resetRequested ? "reset" : timeoutRequested ? "timed_out" : "completed", resetRequested || timeoutRequested ? null : code)
    })

    input.signal.addEventListener("abort", onAbort, { once: true })
    if (input.signal.aborted) onAbort()
    timeoutTimer = setTimeout(() => {
      timeoutRequested = true
      stop()
    }, input.timeoutMs)
    timeoutTimer.unref()
  })
}

function createBoundedOutput(maxBytes: number) {
  let value = ""
  let capturedBytes = 0
  let droppedBytes = 0

  function append(chunk: string): void {
    if (chunk.length === 0) return
    const remaining = Math.max(0, maxBytes - capturedBytes)
    const bounded = utf8Chunk(chunk, 0, remaining)
    const captured = bounded.value
    const dropped = chunk.slice(bounded.nextOffset)
    if (captured.length > 0) {
      value += captured
      capturedBytes += Buffer.byteLength(captured, "utf8")
    }
    if (dropped.length > 0) {
      droppedBytes = Math.min(Number.MAX_SAFE_INTEGER, droppedBytes + Buffer.byteLength(dropped, "utf8"))
    }
  }

  return {
    append,
    get value() {
      return value
    },
    get droppedBytes() {
      return droppedBytes
    },
  }
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    // Child cleanup is best effort for the same reason as persistent-shell cleanup.
  }
}
