import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import { z } from "zod"

import { MCP_CONFIG } from "../config.js"
import type { ToolboxRegistry } from "../toolbox/registry.js"

const entrySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  name: z.string().min(1),
  description: z.string().min(1),
  kind: z.literal("toolbox"),
  bundle: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
})
const catalogSchema = z.object({ entries: z.array(entrySchema) })
const stateSchema = z.object({
  installed: z.record(
    z.string(),
    z.object({
      installedAt: z.string(),
      targetPath: z.string(),
    })
  ),
})
const WHITESPACE_RE = /\s+/u

export type StoreEntry = z.infer<typeof entrySchema> & {
  installed: boolean
  installedAt?: string
}

interface StoreState {
  installed: Record<string, { installedAt: string; targetPath: string }>
}

export class CapabilityStoreService {
  private readonly statePath: string

  constructor(
    private readonly catalogPath: string,
    private readonly bundleRoot: string,
    private readonly toolboxRoot = MCP_CONFIG.toolboxes.root,
    private readonly toolboxRegistry?: ToolboxRegistry,
    stateDir = MCP_CONFIG.stateDir
  ) {
    this.statePath = join(stateDir, "capability-store.json")
  }

  async list(): Promise<StoreEntry[]> {
    const [catalog, state] = await Promise.all([this.loadCatalog(), this.loadState()])
    return catalog.entries.map((entry) => {
      const installed = state.installed[entry.id]
      return {
        ...entry,
        installed: Boolean(installed),
        ...(installed ? { installedAt: installed.installedAt } : {}),
      }
    })
  }

  async search(query: string): Promise<StoreEntry[]> {
    const terms = query.toLowerCase().split(WHITESPACE_RE).filter(Boolean)
    const entries = await this.list()
    if (terms.length === 0) return entries
    return entries.filter((entry) => {
      const haystack = [entry.id, entry.name, entry.description, ...entry.tags]
        .join(" ")
        .toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }

  async install(id: string): Promise<StoreEntry> {
    const catalog = await this.loadCatalog()
    const entry = catalog.entries.find((candidate) => candidate.id === id)
    if (!entry) throw new Error(`Unknown Capability Store entry ${JSON.stringify(id)}.`)
    const state = await this.loadState()
    if (state.installed[id])
      throw new Error(`Capability ${JSON.stringify(id)} is already installed.`)

    const source = this.bundlePath(entry.bundle)
    const target = join(this.toolboxRoot, entry.id)
    if (await pathExists(target))
      throw new Error(`Cannot install ${JSON.stringify(id)} because ${target} already exists.`)

    await mkdir(this.toolboxRoot, { recursive: true })
    await cp(source, target, { recursive: true, errorOnExist: true, force: false })
    const installedAt = new Date().toISOString()
    state.installed[id] = { installedAt, targetPath: target }
    await this.saveState(state)
    await this.toolboxRegistry?.reload()
    return { ...entry, installed: true, installedAt }
  }

  async uninstall(id: string): Promise<void> {
    const state = await this.loadState()
    const installed = state.installed[id]
    if (!installed) throw new Error(`Capability ${JSON.stringify(id)} is not installed.`)
    const expected = resolve(this.toolboxRoot, id)
    if (resolve(installed.targetPath) !== expected)
      throw new Error(
        `Refusing to remove unexpected Capability Store path ${installed.targetPath}.`
      )
    await rm(expected, { recursive: true, force: true })
    delete state.installed[id]
    await this.saveState(state)
    await this.toolboxRegistry?.reload()
  }

  private async loadCatalog() {
    return catalogSchema.parse(JSON.parse(await readFile(this.catalogPath, "utf8")))
  }

  private async loadState(): Promise<StoreState> {
    try {
      return stateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")))
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { installed: {} }
      }
      throw error
    }
  }

  private async saveState(state: StoreState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
  }

  private bundlePath(bundle: string): string {
    if (basename(bundle) !== bundle)
      throw new Error("Capability Store bundle names cannot contain paths.")
    return join(this.bundleRoot, bundle)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}
