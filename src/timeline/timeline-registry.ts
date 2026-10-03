import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { z } from "zod"

import { MCP_CONFIG } from "../config.js"
import { redactSecrets, redactText } from "../security/redact.js"

const timelineEventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  type: z.enum([
    "tool-started",
    "tool-completed",
    "tool-failed",
    "tool-interrupted",
    "approval",
    "system",
    "project",
  ]),
  label: z.string(),
  detail: z.string().optional(),
  agentId: z.string().optional(),
  projectId: z.string().optional(),
  toolName: z.string().optional(),
  input: z.unknown().optional(),
})
export type TimelineEvent = z.infer<typeof timelineEventSchema>

const stateSchema = z.object({
  events: z.array(timelineEventSchema).default([]),
})

export class TimelineRegistry {
  private loadPromise?: Promise<void>
  private events: TimelineEvent[] = []
  private persistChain: Promise<void> = Promise.resolve()

  constructor(private readonly path = join(MCP_CONFIG.stateDir, "timeline.json")) {}

  async list(
    filter: {
      projectId?: string
      agentId?: string
      type?: TimelineEvent["type"]
      limit?: number
    } = {}
  ): Promise<TimelineEvent[]> {
    await this.ensureLoaded()
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000))
    return this.events
      .filter((event) => !filter.projectId || event.projectId === filter.projectId)
      .filter((event) => !filter.agentId || event.agentId === filter.agentId)
      .filter((event) => !filter.type || event.type === filter.type)
      .slice(-limit)
      .reverse()
      .map((event) => ({ ...event }))
  }

  async append(input: {
    type: TimelineEvent["type"]
    label: string
    detail?: string
    agentId?: string
    projectId?: string
    toolName?: string
    argumentsValue?: Record<string, unknown>
  }): Promise<TimelineEvent> {
    await this.ensureLoaded()
    const event = timelineEventSchema.parse({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: input.type,
      label: redactText(input.label),
      ...(input.detail ? { detail: redactText(input.detail) } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.argumentsValue ? { input: redactSecrets(input.argumentsValue) } : {}),
    })
    this.events.push(event)
    if (this.events.length > 1000) this.events.splice(0, this.events.length - 1000)
    await this.persist()
    return { ...event }
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    await this.loadPromise
  }

  private async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"))
      this.events = stateSchema.parse(value).events
    } catch (error) {
      if (!isEnoent(error)) throw error
    }
  }

  private async persist(): Promise<void> {
    const serialized = `${JSON.stringify({ events: this.events }, null, 2)}\n`
    const pending = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        await writeFile(this.path, serialized, { mode: 0o600 })
      })
    this.persistChain = pending
    await pending
  }
}

export const timelineRegistry = new TimelineRegistry()

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
