import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

import { z } from "zod"

import { MCP_CONFIG } from "../config.js"

const permissionSchema = z.object({
  read: z.boolean().default(true),
  write: z.boolean().default(true),
  shell: z.boolean().default(true),
})

const projectSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  name: z.string().min(1),
  path: z.string().min(1),
  permissions: permissionSchema.default({ read: true, write: true, shell: true }),
  description: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const stateSchema = z.object({ projects: z.array(projectSchema) })

export type ProjectPermission = keyof z.infer<typeof permissionSchema>
export type RegisteredProject = z.infer<typeof projectSchema>

export class ProjectRegistry {
  private readonly projects = new Map<string, RegisteredProject>()
  private loadPromise?: Promise<void>

  constructor(private readonly statePath = resolve(MCP_CONFIG.stateDir, "projects.json")) {}

  async list(): Promise<RegisteredProject[]> {
    await this.ensureLoaded()
    return [...this.projects.values()]
      .map((project) => ({ ...project, permissions: { ...project.permissions } }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async get(id: string): Promise<RegisteredProject> {
    await this.ensureLoaded()
    const project = this.projects.get(id)
    if (!project) throw new Error(`Unknown project ${JSON.stringify(id)}.`)
    return { ...project, permissions: { ...project.permissions } }
  }

  async upsert(input: {
    id: string
    name: string
    path: string
    description?: string
    permissions?: Partial<RegisteredProject["permissions"]>
  }): Promise<RegisteredProject> {
    await this.ensureLoaded()
    if (!isAbsolute(input.path)) throw new Error("Project paths must be absolute.")
    const root = resolve(input.path)
    const duplicate = [...this.projects.values()].find(
      (candidate) => candidate.id !== input.id && candidate.path === root
    )
    if (duplicate) {
      throw new Error(
        `Project path ${root} is already registered as ${JSON.stringify(duplicate.id)}.`
      )
    }
    const info = await stat(root)
    if (!info.isDirectory()) throw new Error(`Project path is not a directory: ${root}`)
    const now = new Date().toISOString()
    const previous = this.projects.get(input.id)
    const permissions = {
      read: input.permissions?.read ?? previous?.permissions.read ?? true,
      write: input.permissions?.write ?? previous?.permissions.write ?? true,
      shell: input.permissions?.shell ?? previous?.permissions.shell ?? true,
    }
    const project = projectSchema.parse({
      id: input.id,
      name: input.name,
      path: root,
      permissions,
      ...(input.description ? { description: input.description } : {}),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    })
    this.projects.set(project.id, project)
    await this.persist()
    return { ...project, permissions: { ...project.permissions } }
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded()
    if (!this.projects.delete(id)) throw new Error(`Unknown project ${JSON.stringify(id)}.`)
    await this.persist()
  }

  async resolve(id: string, permission: ProjectPermission): Promise<RegisteredProject> {
    const project = await this.get(id)
    if (!project.permissions[permission])
      throw new Error(
        `Project ${JSON.stringify(id)} does not grant ${JSON.stringify(permission)} permission.`
      )
    return project
  }

  async findForPath(path: string): Promise<RegisteredProject | undefined> {
    await this.ensureLoaded()
    const absolute = resolve(path)
    return [...this.projects.values()]
      .filter((project) => containsPath(project.path, absolute))
      .sort((left, right) => right.path.length - left.path.length)[0]
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    await this.loadPromise
  }

  private async load(): Promise<void> {
    try {
      const state = stateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")))
      for (const project of state.projects) this.projects.set(project.id, project)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    await writeFile(
      this.statePath,
      `${JSON.stringify({ projects: [...this.projects.values()] }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    )
  }
}

function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
