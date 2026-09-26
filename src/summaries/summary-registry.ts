import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { z } from "zod"

import { MCP_CONFIG } from "../config.js"

const summarySchema = z.object({
  uuid: z.uuid(),
  content: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const stateSchema = z.object({
  summaries: z.array(summarySchema).default([]),
})

export type TemporarySummary = z.infer<typeof summarySchema>

export class SummaryRegistry {
  private readonly summaries = new Map<string, TemporarySummary>()
  private loadPromise?: Promise<void>

  constructor(private readonly statePath = join(MCP_CONFIG.stateDir, "summaries.json")) {}

  async list(): Promise<TemporarySummary[]> {
    await this.ensureLoaded()
    return [...this.summaries.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneSummary)
  }

  async create(content: string): Promise<TemporarySummary> {
    await this.ensureLoaded()
    const text = normalizeContent(content)
    const now = new Date().toISOString()
    const summary = summarySchema.parse({
      uuid: randomUUID(),
      content: text,
      createdAt: now,
      updatedAt: now,
    })
    this.summaries.set(summary.uuid, summary)
    await this.persist()
    return cloneSummary(summary)
  }

  async get(uuid: string): Promise<TemporarySummary> {
    await this.ensureLoaded()
    const summary = this.summaries.get(normalizeUuid(uuid))
    if (!summary) throw new Error(`Unknown summary UUID ${JSON.stringify(uuid)}.`)
    return cloneSummary(summary)
  }

  async update(uuid: string, content: string): Promise<TemporarySummary> {
    await this.ensureLoaded()
    const id = normalizeUuid(uuid)
    const existing = this.summaries.get(id)
    if (!existing) throw new Error(`Unknown summary UUID ${JSON.stringify(uuid)}.`)
    const summary = summarySchema.parse({
      ...existing,
      content: normalizeContent(content),
      updatedAt: new Date().toISOString(),
    })
    this.summaries.set(id, summary)
    await this.persist()
    return cloneSummary(summary)
  }

  async remove(uuid: string): Promise<void> {
    await this.ensureLoaded()
    const id = normalizeUuid(uuid)
    if (!this.summaries.delete(id)) throw new Error(`Unknown summary UUID ${JSON.stringify(uuid)}.`)
    await this.persist()
  }

  async consume(uuid: string): Promise<TemporarySummary> {
    await this.ensureLoaded()
    const id = normalizeUuid(uuid)
    const summary = this.summaries.get(id)
    if (!summary) throw new Error(`Unknown summary UUID ${JSON.stringify(uuid)}.`)
    this.summaries.delete(id)
    await this.persist()
    return cloneSummary(summary)
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    await this.loadPromise
  }

  private async load(): Promise<void> {
    try {
      const state = stateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")))
      for (const summary of state.summaries) this.summaries.set(summary.uuid, summary)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    await writeFile(
      this.statePath,
      `${JSON.stringify({ summaries: [...this.summaries.values()] }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    )
  }
}

function normalizeContent(content: string): string {
  const text = content.trim()
  if (!text) throw new Error("Summary content is required.")
  return text
}

function normalizeUuid(uuid: string): string {
  return z.uuid().parse(uuid.trim())
}

function cloneSummary(summary: TemporarySummary): TemporarySummary {
  return { ...summary }
}
