import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { z } from "zod"

import { MCP_CONFIG } from "../config.js"
import type { SubagentRunInput, SubagentRunResult } from "../subagents/runtime.js"

const memberSchema = z.object({
  profile: z.string().min(1),
  role: z.string().min(1),
  instructions: z.string().min(1).optional(),
})

const teamSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  members: z.array(memberSchema).min(1).max(12),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const stateSchema = z.object({ teams: z.array(teamSchema) })

export type AgentTeam = z.infer<typeof teamSchema>

export interface TeamExecutor {
  run(input: SubagentRunInput, signal?: AbortSignal): Promise<SubagentRunResult>
  profiles(): Array<{ id: string }>
}

export interface TeamRunResult {
  team: { id: string; name: string }
  task: string
  results: Array<{
    profile: string
    role: string
    content?: string
    usage?: SubagentRunResult["usage"]
    error?: string
  }>
}

export class AgentTeamService {
  private readonly teams = new Map<string, AgentTeam>()
  private loadPromise?: Promise<void>

  constructor(
    private readonly executor: TeamExecutor,
    private readonly statePath = resolve(MCP_CONFIG.stateDir, "agent-teams.json")
  ) {}

  async list(): Promise<AgentTeam[]> {
    await this.ensureLoaded()
    return [...this.teams.values()]
      .map((team) => ({ ...team, members: team.members.map((member) => ({ ...member })) }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async upsert(input: {
    id: string
    name: string
    description?: string
    members: Array<{ profile: string; role: string; instructions?: string }>
  }): Promise<AgentTeam> {
    await this.ensureLoaded()
    const availableProfiles = new Set(this.executor.profiles().map((profile) => profile.id))
    const missing = input.members.find((member) => !availableProfiles.has(member.profile))
    if (missing)
      throw new Error(
        `Team member profile ${JSON.stringify(missing.profile)} is not configured or enabled.`
      )
    const now = new Date().toISOString()
    const previous = this.teams.get(input.id)
    const team = teamSchema.parse({
      ...input,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    })
    this.teams.set(team.id, team)
    await this.persist()
    return team
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded()
    if (!this.teams.delete(id)) throw new Error(`Unknown agent team ${JSON.stringify(id)}.`)
    await this.persist()
  }

  async run(id: string, task: string, signal?: AbortSignal): Promise<TeamRunResult> {
    await this.ensureLoaded()
    const team = this.teams.get(id)
    if (!team) throw new Error(`Unknown agent team ${JSON.stringify(id)}.`)

    const results = await Promise.all(
      team.members.map(async (member) => {
        const system = [
          `You are the ${member.role} member of the OpenChatX agent team ${team.name}.`,
          member.instructions,
          "Return your own findings/work product. The main ChatGPT agent will integrate the team results.",
        ]
          .filter(Boolean)
          .join("\n\n")
        try {
          const result = await this.executor.run(
            { profileId: member.profile, task, system },
            signal
          )
          return {
            profile: member.profile,
            role: member.role,
            content: result.content,
            usage: result.usage,
          }
        } catch (error) {
          return {
            profile: member.profile,
            role: member.role,
            error: error instanceof Error ? error.message : "Agent team member failed.",
          }
        }
      })
    )

    return { team: { id: team.id, name: team.name }, task, results }
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    await this.loadPromise
  }

  private async load(): Promise<void> {
    try {
      const state = stateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")))
      for (const team of state.teams) this.teams.set(team.id, team)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    await writeFile(
      this.statePath,
      `${JSON.stringify({ teams: [...this.teams.values()] }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    )
  }
}
