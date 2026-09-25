import { spawn } from "node:child_process"
import { mkdir, open, readFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"

import { childProcessEnvironment } from "../../child-environment.js"
import { MCP_CONFIG } from "../../config.js"
import { isProcessRunning, shellCommandArgs, signalProcessTree } from "../../host-platform.js"

const MAX_READ_BYTES = 64 * 1024

export interface ManagedBashProcess {
  id: string
  pid: number
  command: string
  cwd: string
  logPath: string
  startedAt: string
  running: boolean
}

interface PersistedBashProcess {
  id: string
  pid: number
  command: string
  cwd: string
  logPath: string
  startedAt: string
}

export class BashProcessManager {
  private readonly records = new Map<string, PersistedBashProcess>()

  constructor(private readonly logDirectory = join(MCP_CONFIG.stateDir, "bash-processes")) {}

  async start(command: string, cwd: string): Promise<ManagedBashProcess> {
    await mkdir(this.logDirectory, { recursive: true, mode: 0o700 })
    const startedAt = new Date().toISOString()
    const logPath = join(this.logDirectory, `${Date.now()}-${process.pid}.log`)
    const handle = await open(logPath, "a", 0o600)
    try {
      const child = spawn(MCP_CONFIG.shell.path, shellCommandArgs(command), {
        cwd,
        env: childProcessEnvironment(),
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", handle.fd, handle.fd],
      })
      await new Promise<void>((resolvePromise, reject) => {
        child.once("error", reject)
        child.once("spawn", resolvePromise)
      })
      if (child.pid === undefined)
        throw new Error("Background command started without a process id.")
      child.unref()

      const record: PersistedBashProcess = {
        id: `bash-${child.pid}`,
        pid: child.pid,
        command,
        cwd,
        logPath,
        startedAt,
      }
      this.records.set(record.id, record)
      return { ...record, running: true }
    } finally {
      await handle.close()
    }
  }

  async list(): Promise<ManagedBashProcess[]> {
    return [...this.records.values()]
      .map((record) => ({ ...record, running: isProcessRunning(record.pid) }))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
  }

  async read(
    id: string,
    maxBytes = 16 * 1024
  ): Promise<{ process: ManagedBashProcess; output: string; truncated: boolean }> {
    const record = this.require(id)
    let data: Buffer
    try {
      data = await readFile(record.logPath)
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error
      data = Buffer.alloc(0)
    }
    const limit = Math.min(Math.max(maxBytes, 1), MAX_READ_BYTES)
    const truncated = data.length > limit
    const selected = truncated ? data.subarray(data.length - limit) : data
    return {
      process: { ...record, running: isProcessRunning(record.pid) },
      output: selected.toString("utf8"),
      truncated,
    }
  }

  async stop(id: string): Promise<ManagedBashProcess> {
    const record = this.require(id)
    if (isProcessRunning(record.pid)) signalProcessTree(record.pid, "SIGTERM")
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    return { ...record, running: isProcessRunning(record.pid) }
  }

  private require(id: string): PersistedBashProcess {
    const record = this.records.get(id)
    if (!record) throw new Error(`Unknown kept bash process: ${id}`)
    return record
  }

  async close(): Promise<void> {
    for (const record of this.records.values()) {
      if (!isProcessRunning(record.pid)) continue
      try {
        signalProcessTree(record.pid, "SIGTERM")
      } catch {
        // Process may have exited between the liveness check and signal delivery.
      }
    }
  }
}

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
