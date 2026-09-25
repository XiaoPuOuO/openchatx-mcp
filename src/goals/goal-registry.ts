import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { z } from "zod"

import { MCP_CONFIG } from "../config.js"

export const goalStatusSchema = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
])

const goalSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  title: z.string().min(1),
  description: z.string().optional(),
  projectId: z.string().min(1).optional(),
  status: goalStatusSchema.default("pending"),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
})

const stateSchema = z.object({ goals: z.array(goalSchema) })

export type GoalStatus = z.infer<typeof goalStatusSchema>
export type RegisteredGoal = z.infer<typeof goalSchema>

export class GoalRegistry {
  private readonly goals = new Map<string, RegisteredGoal>()
  private loadPromise?: Promise<void>

  constructor(private readonly statePath = resolve(MCP_CONFIG.stateDir, "goals.json")) {}

  async list(
    filter: { projectId?: string | null; status?: GoalStatus } = {}
  ): Promise<RegisteredGoal[]> {
    await this.ensureLoaded()
    return [...this.goals.values()]
      .filter(
        (goal) =>
          filter.projectId === undefined || goal.projectId === (filter.projectId ?? undefined)
      )
      .filter((goal) => !filter.status || goal.status === filter.status)
      .map(cloneGoal)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async get(id: string): Promise<RegisteredGoal> {
    await this.ensureLoaded()
    const goal = this.goals.get(id)
    if (!goal) throw new Error(`Unknown goal ${JSON.stringify(id)}.`)
    return cloneGoal(goal)
  }

  async upsert(input: {
    id: string
    title: string
    description?: string
    projectId?: string
    status?: GoalStatus
  }): Promise<RegisteredGoal> {
    await this.ensureLoaded()
    const now = new Date().toISOString()
    const previous = this.goals.get(input.id)
    const status = input.status ?? previous?.status ?? "pending"
    let completedAt: string | undefined
    if (status === "completed") {
      completedAt = previous?.status === "completed" ? previous.completedAt : now
    }
    const goal = goalSchema.parse({
      id: input.id,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      status,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      ...(completedAt ? { completedAt } : {}),
    })
    this.goals.set(goal.id, goal)
    await this.persist()
    return cloneGoal(goal)
  }

  async update(
    id: string,
    input: {
      title?: string
      description?: string | null
      projectId?: string | null
      status?: GoalStatus
    }
  ): Promise<RegisteredGoal> {
    const current = await this.get(id)
    return this.upsert({
      id,
      title: input.title ?? current.title,
      description:
        input.description === null ? undefined : (input.description ?? current.description),
      projectId: input.projectId === null ? undefined : (input.projectId ?? current.projectId),
      status: input.status ?? current.status,
    })
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded()
    if (!this.goals.delete(id)) throw new Error(`Unknown goal ${JSON.stringify(id)}.`)
    await this.persist()
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    await this.loadPromise
  }

  private async load(): Promise<void> {
    try {
      const state = stateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")))
      for (const goal of state.goals) this.goals.set(goal.id, goal)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    await writeFile(
      this.statePath,
      `${JSON.stringify({ goals: [...this.goals.values()] }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    )
  }
}

function cloneGoal(goal: RegisteredGoal): RegisteredGoal {
  return { ...goal }
}
