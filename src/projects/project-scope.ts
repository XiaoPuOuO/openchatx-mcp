import { isAbsolute, relative, resolve, sep } from "node:path"

import {
  consumeAgentProjectExternalAccess,
  getAgentIdentity,
  setAgentProjectId,
  setAgentProjectRoutingPending,
} from "../agent/context.js"
import { MCP_CONFIG } from "../config.js"
import { ToolError } from "../mcp/tool-error.js"
import type { RuntimeControlService } from "../runtime/runtime-control.js"
import {
  type ProjectPermission,
  type ProjectRegistry,
  projectRoots,
  type RegisteredProject,
} from "./project-registry.js"

export interface ResolvedProjectPath {
  path: string
  project?: RegisteredProject
}

export class ProjectScope {
  private workspaceActivator?: (projectId: string) => Promise<void>

  constructor(
    private readonly projects: ProjectRegistry,
    private readonly runtimeControl?: RuntimeControlService
  ) {}

  setWorkspaceActivator(activator: (projectId: string) => Promise<void>): void {
    this.workspaceActivator = activator
  }

  async list(): Promise<RegisteredProject[]> {
    return this.projects.list()
  }

  async current(): Promise<RegisteredProject | undefined> {
    const projectId = getAgentIdentity()?.projectId
    if (!projectId) return undefined
    try {
      return await this.projects.get(projectId)
    } catch {
      setAgentProjectRoutingPending()
      return undefined
    }
  }

  async use(projectId: string | undefined): Promise<RegisteredProject | undefined> {
    if (!projectId) {
      setAgentProjectId(undefined)
      return undefined
    }
    const project = await this.projects.get(projectId)
    await this.workspaceActivator?.(project.id)
    setAgentProjectId(project.id)
    return project
  }

  async resolvePath(
    input: string | undefined,
    permission: ProjectPermission,
    explicitProjectId?: string
  ): Promise<ResolvedProjectPath> {
    const fullAccess = (await this.runtimeControl?.snapshot())?.accessMode === "full-access"
    return fullAccess
      ? this.resolveTrustedPath(input, explicitProjectId)
      : this.resolveRestrictedPath(input, permission, explicitProjectId)
  }

  private async resolveTrustedPath(
    input: string | undefined,
    explicitProjectId?: string
  ): Promise<ResolvedProjectPath> {
    const active = await this.current()
    if (explicitProjectId) {
      const project = await this.projects.get(explicitProjectId)
      return { path: resolveProjectInputPath(project.path, input), project }
    }
    if (!input)
      return active ? { path: active.path, project: active } : { path: MCP_CONFIG.defaultCwd }
    if (!isAbsolute(input)) {
      return active
        ? { path: resolve(active.path, input), project: active }
        : { path: resolve(MCP_CONFIG.defaultCwd, input) }
    }
    const path = resolve(input)
    if (active) return { path, project: active }
    const matching = await this.projects.findForPath(path)
    return matching ? { path, project: matching } : { path }
  }

  private async resolveRestrictedPath(
    input: string | undefined,
    permission: ProjectPermission,
    explicitProjectId?: string
  ): Promise<ResolvedProjectPath> {
    const active = await this.current()
    const explicit = explicitProjectId
      ? await this.projects.resolve(explicitProjectId, permission)
      : undefined

    if (active && explicit && active.id !== explicit.id) {
      throw new ToolError(
        "PROJECT_SWITCH_REQUIRED",
        `Project ${JSON.stringify(explicit.id)} is not the active Project. Call project_manage with action="use" and project_id=${JSON.stringify(explicit.id)}.`
      )
    }
    if (explicit) {
      const path = resolveProjectInputPath(explicit.path, input)
      ensureInsideProjectOrAuthorized(path, explicit)
      return { path, project: explicit }
    }
    if (!input) {
      if (!active) return { path: MCP_CONFIG.defaultCwd }
      ensurePermission(active, permission)
      return { path: active.path, project: active }
    }
    if (!isAbsolute(input)) {
      if (!active) return { path: resolve(MCP_CONFIG.defaultCwd, input) }
      ensurePermission(active, permission)
      const path = resolve(active.path, input)
      ensureInsideProjectOrAuthorized(path, active)
      return { path, project: active }
    }

    const path = resolve(input)
    if (active) {
      ensurePermission(active, permission)
      ensureInsideProjectOrAuthorized(path, active)
      return { path, project: active }
    }
    const matching = await this.projects.findForPath(path)
    if (!matching) return { path }
    ensurePermission(matching, permission)
    return { path, project: matching }
  }
}

function resolveProjectInputPath(projectRoot: string, input: string | undefined): string {
  if (!input) return projectRoot
  return isAbsolute(input) ? resolve(input) : resolve(projectRoot, input)
}

function ensurePermission(project: RegisteredProject, permission: ProjectPermission): void {
  if (!project.permissions[permission]) {
    throw new Error(
      `Project ${JSON.stringify(project.id)} does not grant ${JSON.stringify(permission)} permission.`
    )
  }
}

function ensureInsideProjectOrAuthorized(path: string, project: RegisteredProject): void {
  if (projectRoots(project).some((root) => containsPath(root, path))) return
  if (consumeAgentProjectExternalAccess(path)) return
  throw new ToolError(
    "PROJECT_EXTERNAL_ACCESS_REQUIRED",
    `Path ${JSON.stringify(path)} is outside active Project ${JSON.stringify(project.id)}. Ask the user for permission before accessing it. If approved once, call project_manage with action="grant_once" and this path. Only if the user explicitly grants unrestricted access for this session, use action="grant_all_session".`
  )
}

function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
