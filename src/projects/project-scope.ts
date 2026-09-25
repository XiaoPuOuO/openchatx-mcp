import { isAbsolute, relative, resolve, sep } from "node:path"

import {
  consumeAgentProjectExternalAccess,
  getAgentIdentity,
  setAgentProjectId,
} from "../agent/context.js"
import { MCP_CONFIG } from "../config.js"
import { ToolError } from "../mcp/tool-error.js"
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
  constructor(private readonly projects: ProjectRegistry) {}

  async list(): Promise<RegisteredProject[]> {
    return this.projects.list()
  }

  async current(): Promise<RegisteredProject | undefined> {
    const projectId = getAgentIdentity()?.projectId
    if (!projectId) return undefined
    try {
      return await this.projects.get(projectId)
    } catch {
      setAgentProjectId(undefined)
      return undefined
    }
  }

  async use(projectId: string | undefined): Promise<RegisteredProject | undefined> {
    if (!projectId) {
      setAgentProjectId(undefined)
      return undefined
    }
    const project = await this.projects.get(projectId)
    setAgentProjectId(project.id)
    return project
  }

  async resolvePath(
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
        `Project ${JSON.stringify(explicit.id)} is not the active Project for this session. Call project_use to switch workspaces before accessing it.`
      )
    }

    if (explicit) {
      let path = explicit.path
      if (input) path = isAbsolute(input) ? resolve(input) : resolve(explicit.path, input)
      ensureInsideProjectOrAuthorized(path, explicit)
      return { path, project: explicit }
    }

    if (!input) {
      if (active) {
        ensurePermission(active, permission)
        return { path: active.path, project: active }
      }
      return { path: MCP_CONFIG.defaultCwd }
    }

    if (!isAbsolute(input)) {
      if (active) {
        ensurePermission(active, permission)
        const path = resolve(active.path, input)
        ensureInsideProjectOrAuthorized(path, active)
        return { path, project: active }
      }
      return { path: resolve(MCP_CONFIG.defaultCwd, input) }
    }

    const path = resolve(input)
    if (active) {
      ensurePermission(active, permission)
      ensureInsideProjectOrAuthorized(path, active)
      return { path, project: active }
    }
    const matching = await this.projects.findForPath(path)
    if (matching) {
      ensurePermission(matching, permission)
      return { path, project: matching }
    }
    return { path }
  }
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
    `Path ${JSON.stringify(path)} is outside active Project ${JSON.stringify(project.id)}. Ask the user for permission before accessing it. If the user approves this access once, call project_access with action="grant_once" and this path, then retry. Only if the user explicitly says not to ask again or grants unrestricted access for this session, call project_access with action="grant_all_session".`
  )
}

function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
