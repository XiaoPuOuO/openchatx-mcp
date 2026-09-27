import { spawn } from "node:child_process"
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import process from "node:process"
import { setTimeout as delay } from "node:timers/promises"

import { z } from "zod"

import { childProcessEnvironment } from "../child-environment.js"
import { MCP_CONFIG } from "../config.js"
import { isProcessRunning, shellCommandArgs, signalProcessTree } from "../host-platform.js"

export type JobStatus = "running" | "completed" | "failed" | "cancelled"

export interface DurableJob {
  id: string
  label: string
  command: string
  cwd: string
  projectId?: string
  pid: number
  status: JobStatus
  createdAt: string
  updatedAt: string
  exitCode?: number
  timedOut?: boolean
  killAfterAt?: string
  logPath: string
}

const jobSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  cwd: z.string(),
  projectId: z.string().optional(),
  pid: z.number().int().positive(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  exitCode: z.number().int().optional(),
  timedOut: z.boolean().optional(),
  killAfterAt: z.string().optional(),
  logPath: z.string(),
})
const jobStateSchema = z.object({ jobs: z.array(jobSchema) })

const MAX_LOG_BYTES = 128 * 1024

export interface DurableJobLogSlice {
  job: DurableJob
  output: string
  truncated: boolean
  nextCursor: number
}

export class JobManager {
  private readonly jobs = new Map<string, DurableJob>()
  private readonly ownedRunningPids = new Set<number>()
  private readonly killTimers = new Map<string, NodeJS.Timeout>()
  private loadPromise?: Promise<void>
  private persistChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly root = join(MCP_CONFIG.stateDir, "jobs"),
    private readonly statePath = join(root, "jobs.json")
  ) {}

  async start(
    label: string,
    command: string,
    cwd = MCP_CONFIG.defaultCwd,
    projectId?: string,
    killAfterMs?: number
  ): Promise<DurableJob> {
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
        env: childProcessEnvironment(),
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", handle.fd, handle.fd],
      })
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit) => {
          child.once("exit", (code, signal) => resolveExit({ code, signal }))
        }
      )
      await new Promise<void>((resolvePromise, reject) => {
        child.once("error", reject)
        child.once("spawn", resolvePromise)
      })
      if (!child.pid) throw new Error("Durable job started without a process id.")
      const childPid = child.pid
      const job: DurableJob = {
        id,
        label,
        command,
        cwd: resolvedCwd,
        ...(projectId ? { projectId } : {}),
        pid: childPid,
        status: "running",
        createdAt,
        updatedAt: createdAt,
        ...(killAfterMs ? { killAfterAt: new Date(Date.now() + killAfterMs).toISOString() } : {}),
        logPath,
      }
      this.jobs.set(id, job)
      this.ownedRunningPids.add(childPid)
      await this.persist()
      this.scheduleKill(job)
      void exit.then(async ({ code, signal }) => {
        this.ownedRunningPids.delete(childPid)
        this.clearKillTimer(id)
        const current = this.jobs.get(id)
        if (current?.status !== "running") return
        current.status = code === 0 ? "completed" : "failed"
        current.exitCode = code ?? (signal ? -1 : 1)
        current.updatedAt = new Date().toISOString()
        await this.persist()
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

  async readLogFrom(id: string, cursor = 0, maxBytes = 16 * 1024): Promise<DurableJobLogSlice> {
    const job = await this.get(id)
    const limit = Math.min(Math.max(maxBytes, 1), MAX_LOG_BYTES)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(job.logPath, "r")
      const size = (await handle.stat()).size
      const boundedCursor = Math.min(Math.max(cursor, 0), size)
      const unread = size - boundedCursor
      const truncated = unread > limit
      const start = truncated ? size - limit : boundedCursor
      const length = size - start
      const buffer = Buffer.alloc(length)
      if (length > 0) await handle.read(buffer, 0, length, start)
      return {
        job,
        output: buffer.toString("utf8"),
        truncated,
        nextCursor: size,
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      return { job, output: "", truncated: false, nextCursor: 0 }
    } finally {
      await handle?.close()
    }
  }

  async wait(
    id: string,
    waitMs: number,
    cursor = 0,
    maxBytes = 16 * 1024,
    signal?: AbortSignal
  ): Promise<DurableJobLogSlice> {
    const deadline = Date.now() + Math.max(waitMs, 0)
    let job = await this.get(id)
    while (job.status === "running" && Date.now() < deadline) {
      const remaining = deadline - Date.now()
      await delay(Math.min(250, remaining), undefined, { signal })
      job = await this.get(id)
    }
    return this.readLogFrom(id, cursor, maxBytes)
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
    this.clearKillTimer(id)
    await this.persist()
    return { ...job }
  }

  async close(): Promise<void> {
    for (const id of this.killTimers.keys()) this.clearKillTimer(id)
    await this.persist()
  }

  async initialize(): Promise<void> {
    await this.ensureLoaded()
  }

  async forget(id: string): Promise<void> {
    await this.ensureLoaded()
    const job = this.jobs.get(id)
    if (!job) return
    if (job.status === "running") throw new Error("Cannot forget a running durable job.")
    this.clearKillTimer(id)
    this.jobs.delete(id)
    await this.persist()
    await rm(job.logPath, { force: true })
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
    for (const job of this.jobs.values()) this.scheduleKill(job)
  }

  private async reconcile(): Promise<void> {
    let changed = false
    for (const job of this.jobs.values()) {
      if (job.status === "running" && this.deadlineExpired(job)) {
        this.timeoutJob(job)
        changed = true
        continue
      }
      if (
        job.status !== "running" ||
        this.ownedRunningPids.has(job.pid) ||
        isProcessRunning(job.pid)
      )
        continue
      job.status = "failed"
      job.updatedAt = new Date().toISOString()
      changed = true
    }
    if (changed) await this.persist()
  }

  private scheduleKill(job: DurableJob): void {
    this.clearKillTimer(job.id)
    if (job.status !== "running" || !job.killAfterAt) return
    const delayMs = new Date(job.killAfterAt).getTime() - Date.now()
    if (delayMs <= 0) {
      this.timeoutJob(job)
      void this.persist()
      return
    }
    const timer = setTimeout(() => {
      this.killTimers.delete(job.id)
      const current = this.jobs.get(job.id)
      if (current?.status !== "running") return
      this.timeoutJob(current)
      void this.persist()
    }, delayMs)
    timer.unref()
    this.killTimers.set(job.id, timer)
  }

  private deadlineExpired(job: DurableJob): boolean {
    return Boolean(job.killAfterAt && Date.now() >= new Date(job.killAfterAt).getTime())
  }

  private timeoutJob(job: DurableJob): void {
    if (isProcessRunning(job.pid)) {
      try {
        signalProcessTree(job.pid, "SIGTERM")
      } catch {
        // Process may have exited between the liveness check and signal delivery.
      }
    }
    this.ownedRunningPids.delete(job.pid)
    job.status = "failed"
    job.timedOut = true
    job.exitCode = -1
    job.updatedAt = new Date().toISOString()
  }

  private clearKillTimer(id: string): void {
    const timer = this.killTimers.get(id)
    if (timer) clearTimeout(timer)
    this.killTimers.delete(id)
  }

  private async persist(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const payload = { jobs: [...this.jobs.values()] }
    const serialized = `${JSON.stringify(payload, null, 2)}\n`
    const pending = this.persistChain
      .catch(() => undefined)
      .then(() =>
        writeFile(this.statePath, serialized, {
          encoding: "utf8",
          mode: 0o600,
        })
      )
    this.persistChain = pending
    await pending
  }
}
