import type { JobManager } from "../jobs/job-manager.js"
import type { BashProcessManager } from "../tools/shell/bash-process-manager.js"
import type { InteractiveShellManager } from "../tools/shell/interactive-shell.js"
import { runtimeProcessRegistry } from "./process-registry.js"

export type UnifiedProcessKind =
  | "runtime"
  | "mcp"
  | "sandbox"
  | "job"
  | "bash"
  | "terminal"
  | "shell"
  | "tunnel"

export interface UnifiedProcessSnapshot {
  id: string
  kind: UnifiedProcessKind
  label: string
  status: string
  startedAt?: string
  updatedAt?: string
  pid?: number
  threadId?: number
  restartCount?: number
  detail?: string
  canStop: boolean
  canRestart: boolean
}

export class RuntimeProcessService {
  constructor(
    private readonly jobs: JobManager,
    private readonly bash: BashProcessManager,
    private readonly terminals: InteractiveShellManager
  ) {}

  async list(): Promise<UnifiedProcessSnapshot[]> {
    const [jobs, bash] = await Promise.all([this.jobs.list(), this.bash.list()])
    const terminal = this.terminals.list()
    const runningJobs = jobs.filter((job) => job.status === "running")
    const runningBash = bash.filter((process) => process.running)
    const runningTerminals = terminal.filter((session) => session.status === "running")

    return [
      ...runtimeProcessRegistry.list().map(
        (process): UnifiedProcessSnapshot => ({
          id: `registry:${process.id}`,
          kind: process.kind,
          label: process.label,
          status: process.status,
          startedAt: process.startedAt,
          updatedAt: process.updatedAt,
          ...(process.pid !== undefined ? { pid: process.pid } : {}),
          ...(process.threadId !== undefined ? { threadId: process.threadId } : {}),
          restartCount: process.restartCount,
          ...(process.detail ? { detail: process.detail } : {}),
          canStop: process.canStop,
          canRestart: process.canRestart,
        })
      ),
      ...runningJobs.map(
        (job): UnifiedProcessSnapshot => ({
          id: `job:${job.id}`,
          kind: "job" as const,
          label: job.label,
          status: job.status,
          startedAt: job.createdAt,
          updatedAt: job.updatedAt,
          pid: job.pid,
          restartCount: 0,
          detail: job.command,
          canStop: job.status === "running",
          canRestart: false,
        })
      ),
      ...runningBash.map(
        (process): UnifiedProcessSnapshot => ({
          id: `bash:${process.id}`,
          kind: "bash" as const,
          label: process.command,
          status: process.running ? "running" : "stopped",
          startedAt: process.startedAt,
          pid: process.pid,
          restartCount: 0,
          detail: process.cwd,
          canStop: process.running,
          canRestart: false,
        })
      ),
      ...runningTerminals.map(
        (session): UnifiedProcessSnapshot => ({
          id: `terminal:${session.session_id}`,
          kind: "terminal" as const,
          label: session.session_id,
          status: session.status,
          restartCount: 0,
          detail: session.cwd,
          canStop: session.status === "running",
          canRestart: false,
        })
      ),
    ].sort((left, right) =>
      (right.updatedAt ?? right.startedAt ?? "").localeCompare(
        left.updatedAt ?? left.startedAt ?? ""
      )
    )
  }

  async stop(id: string): Promise<boolean> {
    const parsed = parseUnifiedProcessId(id)
    if (parsed.kind === "registry") return runtimeProcessRegistry.stop(parsed.id)
    if (parsed.kind === "job") {
      await this.jobs.cancel(parsed.id)
      return true
    }
    if (parsed.kind === "bash") {
      await this.bash.stop(parsed.id)
      return true
    }
    if (parsed.kind === "terminal") {
      await this.terminals.closeSession(parsed.id)
      return true
    }
    return false
  }

  async restart(id: string): Promise<boolean> {
    const parsed = parseUnifiedProcessId(id)
    return parsed.kind === "registry" ? runtimeProcessRegistry.restart(parsed.id) : false
  }
}

function parseUnifiedProcessId(value: string): {
  kind: "registry" | "job" | "bash" | "terminal"
  id: string
} {
  const separator = value.indexOf(":")
  if (separator <= 0) throw new Error("Invalid process id.")
  const kind = value.slice(0, separator)
  const id = value.slice(separator + 1)
  if (!id) throw new Error("Invalid process id.")
  if (kind === "registry" || kind === "job" || kind === "bash" || kind === "terminal") {
    return { kind, id }
  }
  throw new Error("Unsupported process id.")
}
