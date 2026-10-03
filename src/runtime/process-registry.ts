import { randomUUID } from "node:crypto"

export type RuntimeProcessKind = "sandbox" | "mcp" | "job" | "shell" | "tunnel" | "runtime"
export type RuntimeProcessStatus = "starting" | "running" | "stopped" | "failed" | "backoff"

export interface RuntimeProcessSnapshot {
  id: string
  kind: RuntimeProcessKind
  label: string
  status: RuntimeProcessStatus
  startedAt: string
  updatedAt: string
  pid?: number
  threadId?: number
  restartCount: number
  detail?: string
  canStop: boolean
  canRestart: boolean
}

interface RuntimeProcessRecord {
  snapshot: RuntimeProcessSnapshot
  stop?: () => void | Promise<void>
  restart?: () => void | Promise<void>
}

export class RuntimeProcessRegistry {
  private readonly records = new Map<string, RuntimeProcessRecord>()

  register(input: {
    kind: RuntimeProcessKind
    label: string
    pid?: number
    threadId?: number
    restartCount?: number
    detail?: string
    stop?: () => void | Promise<void>
    restart?: () => void | Promise<void>
  }): string {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.records.set(id, {
      snapshot: {
        id,
        kind: input.kind,
        label: input.label,
        status: "running",
        startedAt: now,
        updatedAt: now,
        ...(input.pid ? { pid: input.pid } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        restartCount: input.restartCount ?? 0,
        ...(input.detail ? { detail: input.detail } : {}),
        canStop: input.stop !== undefined,
        canRestart: input.restart !== undefined,
      },
      ...(input.stop ? { stop: input.stop } : {}),
      ...(input.restart ? { restart: input.restart } : {}),
    })
    return id
  }

  update(
    id: string,
    update: Partial<
      Pick<RuntimeProcessSnapshot, "status" | "detail" | "restartCount" | "pid" | "threadId">
    >
  ): void {
    const record = this.records.get(id)
    if (!record) return
    record.snapshot = {
      ...record.snapshot,
      ...update,
      updatedAt: new Date().toISOString(),
    }
  }

  remove(id: string): void {
    this.records.delete(id)
  }

  list(): RuntimeProcessSnapshot[] {
    return [...this.records.values()]
      .map(({ snapshot }) => ({ ...snapshot }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async stop(id: string): Promise<boolean> {
    const record = this.records.get(id)
    if (!record?.stop) return false
    await record.stop()
    this.update(id, { status: "stopped" })
    return true
  }

  async restart(id: string): Promise<boolean> {
    const record = this.records.get(id)
    if (!record?.restart) return false
    this.update(id, { status: "starting" })
    await record.restart()
    return true
  }
}

export const runtimeProcessRegistry = new RuntimeProcessRegistry()
