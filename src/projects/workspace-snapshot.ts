import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { z } from "zod"

import { MCP_CONFIG } from "../config.js"
import { loadExternalMcpConfig, saveExternalMcpConfig } from "../external-mcp/config.js"
import type { GoalRegistry, RegisteredGoal } from "../goals/goal-registry.js"
import { loadOperationalState, updateOperationalState } from "../recovery/operational-state.js"
import { loadSubagentConfig, saveSubagentConfig } from "../subagents/config.js"
import type { ToolboxRegistry, ToolboxSnapshot } from "../toolbox/registry.js"
import type { ProjectRegistry, RegisteredProject } from "./project-registry.js"

const workspaceSnapshotSchema = z.object({
  format: z.literal("openchatx-project-workspace"),
  version: z.literal(1),
  createdAt: z.string(),
  project: z.object({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    additionalPaths: z.array(z.string()),
    permissions: z.object({
      read: z.boolean(),
      write: z.boolean(),
      shell: z.boolean(),
    }),
    description: z.string().optional(),
  }),
  mcpServers: z.array(z.object({ id: z.string(), enabled: z.boolean() })),
  capabilityPermissions: z
    .record(z.string(), z.record(z.string(), z.enum(["ask", "allow", "deny"])))
    .default({}),
  environment: z
    .object({
      providers: z
        .array(
          z.object({
            id: z.string(),
            enabled: z.boolean(),
            baseUrl: z.string(),
          })
        )
        .default([]),
      models: z
        .array(
          z.object({
            id: z.string(),
            provider: z.string(),
            model: z.string(),
            name: z.string(),
            enabled: z.boolean(),
          })
        )
        .default([]),
    })
    .default({ providers: [], models: [] }),
  toolboxes: z.array(
    z.object({
      id: z.string(),
      enabled: z.boolean(),
      dynamic: z.boolean(),
      tools: z.array(z.object({ name: z.string(), enabled: z.boolean() })),
      skills: z.array(z.object({ name: z.string(), enabled: z.boolean() })),
      rules: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            globs: z.array(z.string()),
            alwaysApply: z.boolean(),
          })
        )
        .default([]),
    })
  ),
  goals: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      status: z.enum(["pending", "in_progress", "blocked", "completed", "cancelled"]),
    })
  ),
})
export type ProjectWorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>

export class ProjectWorkspaceService {
  private readonly snapshotsPath = join(MCP_CONFIG.stateDir, "project-workspaces.json")

  constructor(
    private readonly projects: ProjectRegistry,
    private readonly goals: GoalRegistry,
    private readonly toolboxes: ToolboxRegistry,
    private readonly externalMcpConfigPath = MCP_CONFIG.externalMcp.configFile,
    private readonly afterEnvironmentChange?: () => Promise<void>
  ) {}

  async snapshot(projectId: string): Promise<ProjectWorkspaceSnapshot> {
    const [project, goals, operationalState] = await Promise.all([
      this.projects.get(projectId),
      this.goals.list({ projectId }),
      loadOperationalState(),
    ])
    const snapshot = workspaceSnapshotSchema.parse({
      format: "openchatx-project-workspace",
      version: 1,
      createdAt: new Date().toISOString(),
      project: projectForExport(project),
      mcpServers: Object.entries(loadExternalMcpConfig(this.externalMcpConfigPath)).map(
        ([id, server]) => ({ id, enabled: server.enabled })
      ),
      capabilityPermissions: operationalState.capabilityPermissions,
      environment: this.environmentMetadata(),
      toolboxes: await Promise.all(
        this.toolboxes.snapshots().map((toolbox) => this.toolboxForExport(toolbox))
      ),
      goals: goals.map(goalForExport),
    })
    await this.persistSnapshot(snapshot)
    return snapshot
  }

  async latest(projectId: string): Promise<ProjectWorkspaceSnapshot | undefined> {
    const snapshots = await this.loadSnapshots()
    return snapshots
      .filter((snapshot) => snapshot.project.id === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  }

  async export(
    projectId: string,
    destination?: string
  ): Promise<{ path: string; snapshot: ProjectWorkspaceSnapshot }> {
    const snapshot = await this.snapshot(projectId)
    const path =
      destination ??
      join(
        MCP_CONFIG.stateDir,
        "exports",
        `${snapshot.project.id}-${snapshot.createdAt.replace(/[:.]/gu, "-")}.openchatx-project.json`
      )
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
    return { path, snapshot }
  }

  async import(path: string): Promise<{
    project: RegisteredProject
    restored: { mcpServers: string[]; toolboxes: string[]; goals: string[] }
    missing: { mcpServers: string[]; toolboxes: string[] }
  }> {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    const snapshot = workspaceSnapshotSchema.parse(value)
    const project = await this.projects.upsert(snapshot.project)
    const mcp = await this.restoreMcp(snapshot)
    const toolbox = await this.restoreToolboxes(snapshot)
    const restoredGoals = await this.restoreGoals(project.id, snapshot.goals)
    await this.restoreCapabilityPermissions(snapshot)
    this.restoreEnvironmentMetadata(snapshot)
    await this.afterEnvironmentChange?.()
    await this.persistSnapshot(snapshot)
    return {
      project,
      restored: {
        mcpServers: mcp.restored,
        toolboxes: toolbox.restored,
        goals: restoredGoals,
      },
      missing: {
        mcpServers: mcp.missing,
        toolboxes: toolbox.missing,
      },
    }
  }

  async activate(projectId: string): Promise<ProjectWorkspaceSnapshot | undefined> {
    const snapshot = await this.latest(projectId)
    if (!snapshot) return undefined
    await this.restoreMcp(snapshot)
    await this.restoreToolboxes(snapshot)
    await this.restoreCapabilityPermissions(snapshot)
    this.restoreEnvironmentMetadata(snapshot)
    await this.afterEnvironmentChange?.()
    return snapshot
  }

  private environmentMetadata(): ProjectWorkspaceSnapshot["environment"] {
    const config = loadSubagentConfig(MCP_CONFIG.subagents.configFile)
    return {
      providers: Object.entries(config.providers).map(([id, provider]) => ({
        id,
        enabled: provider.enabled,
        baseUrl: safeProviderBaseUrl(provider.base_url),
      })),
      models: Object.entries(config.models).map(([id, model]) => ({
        id,
        provider: model.provider,
        model: model.model,
        name: model.name,
        enabled: model.enabled,
      })),
    }
  }

  private restoreEnvironmentMetadata(snapshot: ProjectWorkspaceSnapshot): void {
    if (snapshot.environment.providers.length === 0 && snapshot.environment.models.length === 0)
      return

    const config = loadSubagentConfig(MCP_CONFIG.subagents.configFile)
    let changed = false
    for (const provider of snapshot.environment.providers) {
      const configured = config.providers[provider.id]
      if (!configured) continue
      configured.enabled = provider.enabled
      configured.base_url = provider.baseUrl
      changed = true
    }
    for (const model of snapshot.environment.models) {
      const configured = config.models[model.id]
      if (!configured || !config.providers[model.provider]) continue
      configured.enabled = model.enabled
      configured.provider = model.provider
      configured.model = model.model
      configured.name = model.name
      changed = true
    }
    if (changed) saveSubagentConfig(MCP_CONFIG.subagents.configFile, config)
  }

  private async restoreCapabilityPermissions(snapshot: ProjectWorkspaceSnapshot): Promise<void> {
    await updateOperationalState((state) => {
      state.capabilityPermissions = structuredClone(snapshot.capabilityPermissions)
    })
  }

  private async restoreMcp(snapshot: ProjectWorkspaceSnapshot) {
    const config = loadExternalMcpConfig(this.externalMcpConfigPath)
    const restored: string[] = []
    const missing: string[] = []
    for (const server of snapshot.mcpServers) {
      const configured = config[server.id]
      if (!configured) {
        missing.push(server.id)
        continue
      }
      configured.enabled = server.enabled
      restored.push(server.id)
    }
    saveExternalMcpConfig(this.externalMcpConfigPath, config)
    return { restored, missing }
  }

  private async restoreToolboxes(snapshot: ProjectWorkspaceSnapshot) {
    const existing = new Set(this.toolboxes.snapshots().map((toolbox) => toolbox.id))
    const restored: string[] = []
    const missing: string[] = []
    for (const toolbox of snapshot.toolboxes) {
      if (!existing.has(toolbox.id)) {
        missing.push(toolbox.id)
        continue
      }
      await this.toolboxes.setToolboxDynamic(toolbox.id, toolbox.dynamic)
      await this.toolboxes.setToolboxEnabled(toolbox.id, toolbox.enabled)
      for (const tool of toolbox.tools) {
        await this.toolboxes
          .setToolEnabled(toolbox.id, tool.name, tool.enabled)
          .catch(() => undefined)
      }
      for (const skill of toolbox.skills) {
        await this.toolboxes
          .setSkillEnabled(toolbox.id, skill.name, skill.enabled)
          .catch(() => undefined)
      }
      for (const rule of toolbox.rules) {
        await this.toolboxes
          .ruleCatalog(toolbox.id)
          .edit(rule.name, {
            ...(rule.description ? { description: rule.description } : {}),
            globs: rule.globs,
            alwaysApply: rule.alwaysApply,
          })
          .catch(() => undefined)
      }
      restored.push(toolbox.id)
    }
    return { restored, missing }
  }

  private async toolboxForExport(toolbox: ToolboxSnapshot) {
    const rules = await this.toolboxes.listRules(toolbox.id)
    return {
      id: toolbox.id,
      enabled: toolbox.enabled,
      dynamic: toolbox.dynamic,
      tools: toolbox.tools.map((tool) => ({ name: tool.name, enabled: tool.enabled })),
      skills: toolbox.skills.map((skill) => ({ name: skill.name, enabled: skill.enabled })),
      rules: rules.map((rule) => ({
        name: rule.name,
        ...(rule.description ? { description: rule.description } : {}),
        globs: [...rule.globs],
        alwaysApply: rule.alwaysApply,
      })),
    }
  }

  private async restoreGoals(
    projectId: string,
    goals: ProjectWorkspaceSnapshot["goals"]
  ): Promise<string[]> {
    const restored: string[] = []
    for (const goal of goals) {
      await this.goals.upsert({ ...goal, projectId })
      restored.push(goal.id)
    }
    return restored
  }

  private async persistSnapshot(snapshot: ProjectWorkspaceSnapshot): Promise<void> {
    const snapshots = await this.loadSnapshots()
    snapshots.push(snapshot)
    const bounded = snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100)
    await mkdir(dirname(this.snapshotsPath), { recursive: true, mode: 0o700 })
    await writeFile(this.snapshotsPath, `${JSON.stringify({ snapshots: bounded }, null, 2)}\n`, {
      mode: 0o600,
    })
  }

  private async loadSnapshots(): Promise<ProjectWorkspaceSnapshot[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.snapshotsPath, "utf8"))
      if (
        !value ||
        typeof value !== "object" ||
        !("snapshots" in value) ||
        !Array.isArray(value.snapshots)
      )
        return []
      return value.snapshots.map((snapshot) => workspaceSnapshotSchema.parse(snapshot))
    } catch (error) {
      if (isEnoent(error)) return []
      throw error
    }
  }
}

function projectForExport(project: RegisteredProject) {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    additionalPaths: [...project.additionalPaths],
    permissions: { ...project.permissions },
    ...(project.description ? { description: project.description } : {}),
  }
}

function goalForExport(goal: RegisteredGoal) {
  return {
    id: goal.id,
    title: goal.title,
    ...(goal.description ? { description: goal.description } : {}),
    status: goal.status,
  }
}

function safeProviderBaseUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    return url.toString()
  } catch {
    return value
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
