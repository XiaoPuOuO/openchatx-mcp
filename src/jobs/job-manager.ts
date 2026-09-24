import { spawn } from "node:child_process"
import { mkdir, open, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import process from "node:process"

import { z } from "zod"

import { MCP_CONFIG } from "../config.js"
import { isProcessRunning, shellCommandArgs, signalProcessTree } from "../host-platform.js"

export type JobStatus = "running" | "completed" | "failed" | "cancelled"

export interface DurableJob {
  id: string
  label: string
  command: string
  cwd: string
  pid: number
  status: JobStatus
  createdAt: string
  updatedAt: string
  exitCode?: number
  logPath: string
}

const jobSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  cwd: z.string(),
  pid: z.number().int().positive(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  exitCode: z.number().int().optional(),
  logPath: z.string(),
})
const jobStateSchema = z.object({ jobs: z.array(jobSchema) })

const MAX_LOG_BYTES = 128 * 1024

export class JobManager {
  private readonly jobs = new Map<string, DurableJob>()
  private loadPromise?: Promise<void>

  constructor(
    private readonly root = join(MCP_CONFIG.stateDir, "jobs"),
    private readonly statePath = join(root, "jobs.json")
  ) {}

  async start(label: string, command: string, cwd = MCP_CONFIG.defaultCwd): Promise<DurableJob> {
    await this.ensureLoaded()
    const resolvedCwd = resolve(cwd)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const createdAt = new Date().toISOString()
    const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const logPath = join(this.root, `${id}.log`)
    const handle = await open(logPath, "a", 0o600)
    try {
      const child = spawn(MCP_CONFIG.shell.path, shellCommandArgs(command), {
        cwd: resolvedCwd,
        env: process.env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", handle.fd, handle.fd],
      })
      await new Promise<void>((resolvePromise, reject) => {
        child.once("error", reject)
        child.once("spawn", resolvePromise)
      })
      if (!child.pid) throw new Error("Durable job started without a process id.")
      const job: DurableJob = {
        id,
        label,
        command,
        cwd: resolvedCwd,
        pid: child.pid,
        status: "running",
        createdAt,
        updatedAt: createdAt,
        logPath,
      }
      this.jobs.set(id, job)
      await this.persist()
      child.once("exit", (code, signal) => {
        const current = this.jobs.get(id)
        if (current?.status !== "running") return
        current.status = code === 0 ? "completed" : "failed"
        current.exitCode = code ?? (signal ? -1 : 1)
        current.updatedAt = new Date().toISOString()
        void this.persist()
      })
      child.unref()
      return { ...job }
    } finally {
      await handle.close()
    }
  }

  async list(): Promise<DurableJob[]> {
    await this.ensureLoaded()
    await this.reconcile()
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async get(id: string): Promise<DurableJob> {
    await this.ensureLoaded()
    await this.reconcile()
    const job = this.jobs.get(id)
    if (!job) throw new Error(`Unknown durable job ${JSON.stringify(id)}.`)
    return { ...job }
  }

  async readLog(
    id: string,
    maxBytes = 16 * 1024
  ): Promise<{ job: DurableJob; output: string; truncated: boolean }> {
    const job = await this.get(id)
    let data: Buffer
    try {
      data = await readFile(job.logPath)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      data = Buffer.alloc(0)
    }
    const limit = Math.min(Math.max(maxBytes, 1), MAX_LOG_BYTES)
    const truncated = data.length > limit
    return {
      job,
      output: (truncated ? data.subarray(data.length - limit) : data).toString("utf8"),
      truncated,
    }
  }

  async cancel(id: string): Promise<DurableJob> {
    await this.ensureLoaded()
    const job = this.jobs.get(id)
    if (!job) throw new Error(`Unknown durable job ${JSON.stringify(id)}.`)
    if (job.status === "running" && isProcessRunning(job.pid)) {
      try {
        signalProcessTree(job.pid, "SIGTERM")
      } catch {
        // The process may have exited between the liveness check and signal delivery.
      }
    }
    job.status = "cancelled"
    job.updatedAt = new Date().toISOString()
    await this.persist()
    return { ...job }
  }

  async close(): Promise<void> {
    await this.persist()
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    await this.loadPromise
  }

  private async load(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    try {
      const parsed = jobStateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")))
      for (const job of parsed.jobs) this.jobs.set(job.id, job)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
    await this.reconcile()
  }

  private async reconcile(): Promise<void> {
    let changed = false
    for (const job of this.jobs.values()) {
      if (job.status !== "running" || isProcessRunning(job.pid)) continue
      job.status = "failed"
      job.updatedAt = new Date().toISOString()
      changed = true
    }
    if (changed) await this.persist()
  }

  private async persist(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const payload = { jobs: [...this.jobs.values()] }
    await writeFile(this.statePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
  }
}
