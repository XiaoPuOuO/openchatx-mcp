import { isAbsolute, relative, resolve, sep } from "node:path"

import { getAgentIdentity, setAgentProjectId } from "../agent/context.js"
import { MCP_CONFIG } from "../config.js"
import type { ProjectPermission, ProjectRegistry, RegisteredProject } from "./project-registry.js"

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

    if (explicit) {
      let path = explicit.path
      if (input) path = isAbsolute(input) ? resolve(input) : resolve(explicit.path, input)
      ensureInsideProject(path, explicit)
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
        ensureInsideProject(path, active)
        return { path, project: active }
      }
      return { path: resolve(MCP_CONFIG.defaultCwd, input) }
    }

    const path = resolve(input)
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

function ensureInsideProject(path: string, project: RegisteredProject): void {
  const rel = relative(project.path, path)
  if (rel === "") return
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `Path ${JSON.stringify(path)} is outside project ${JSON.stringify(project.id)} (${project.path}).`
    )
  }
}
