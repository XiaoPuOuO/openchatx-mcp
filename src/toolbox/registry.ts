import { type FSWatcher, watch } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { registerHooks, stripTypeScriptTypes } from "node:module"
import { basename, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import type { McpServer, ServerContext } from "@modelcontextprotocol/server"
import { z } from "zod"

import { isValidSkillName, MAX_SKILL_BYTES } from "../tools/skills/skill-catalog.js"
import type { Tool } from "./tool.js"

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const TOOL_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ts$/u
const TS_EXTENSION_RE = /\.ts$/u
const CUSTOM_TOOL_ID_RE = /^toolbox:([^:]+):(.+)$/u
const TOOLBOX_SDK_SPECIFIER = "openchatx-mcp/toolbox"
const TOOLBOX_ZOD_SPECIFIER = "zod"
const TOOLBOX_SDK_URL = new URL("./tool.js", import.meta.url).href
const TOOLBOX_ZOD_URL = import.meta.resolve("zod")

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === TOOLBOX_SDK_SPECIFIER) return { shortCircuit: true, url: TOOLBOX_SDK_URL }
    if (specifier === TOOLBOX_ZOD_SPECIFIER) return { shortCircuit: true, url: TOOLBOX_ZOD_URL }
    return nextResolve(specifier, context)
  },
})

const itemSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  description: z.string().optional(),
  required: z.boolean().default(false),
})

const manifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  builtin: z.string().optional(),
  tools: z.record(z.string(), itemSettingsSchema).default({}),
  skills: z.record(z.string(), itemSettingsSchema).default({}),
})

export type ToolboxManifest = z.infer<typeof manifestSchema>

export interface ToolboxItemSnapshot {
  name: string
  enabled: boolean
  required: boolean
  description?: string
  path?: string
  error?: string
}

export interface ToolboxSnapshot {
  id: string
  name: string
  description?: string
  enabled: boolean
  builtin?: string
  path: string
  tools: ToolboxItemSnapshot[]
  skills: ToolboxItemSnapshot[]
}

export interface CustomToolCatalogEntry {
  id: string
  toolbox: string
  name: string
  description: string
  inputSchema: unknown
}

interface LoadedToolbox {
  id: string
  path: string
  manifestPath: string
  manifest: ToolboxManifest
  customTools: Map<string, Tool>
  loadErrors: Map<string, string>
}

export class ToolboxRegistry {
  private toolboxes = new Map<string, LoadedToolbox>()
  private watcher?: FSWatcher
  private reloadTimer?: NodeJS.Timeout

  constructor(readonly root: string) {}

  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await this.reload()
    this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
      if (typeof filename === "string" && filename.endsWith(".openchatx.mjs")) return
      if (this.reloadTimer) clearTimeout(this.reloadTimer)
      this.reloadTimer = setTimeout(() => void this.reload(), 150)
      this.reloadTimer.unref()
    })
  }

  async close(): Promise<void> {
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.watcher?.close()
  }

  async reload(): Promise<void> {
    const previous = this.toolboxes
    const next = new Map<string, LoadedToolbox>()
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      if (!ID_PATTERN.test(entry.name)) continue
      const loaded = await this.loadToolbox(entry.name).catch((error) => {
        console.warn(
          `Toolbox ${entry.name}: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      if (loaded) next.set(entry.name, loaded)
    }
    await unloadCustomTools(previous)
    this.toolboxes = next
    await loadCustomToolHooks(next)
  }

  snapshots(): ToolboxSnapshot[] {
    return [...this.toolboxes.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((box) => this.snapshot(box))
  }

  isToolboxEnabled(id: string): boolean {
    return this.toolboxes.get(id)?.manifest.enabled ?? false
  }

  isToolEnabled(id: string, name: string): boolean {
    const box = this.toolboxes.get(id)
    if (!box?.manifest.enabled) return false
    const settings = box.manifest.tools[name]
    return settings?.required === true || settings?.enabled !== false
  }

  registerCustomTools(server: McpServer): void {
    for (const box of this.toolboxes.values()) {
      if (!box.manifest.enabled || box.manifest.builtin) continue
      for (const [name, tool] of box.customTools) {
        if (box.loadErrors.has(name)) continue
        if (!this.isToolEnabled(box.id, name)) continue
        const publicName = `${sanitizeName(box.id)}__${sanitizeName(tool.name)}`
        registerCustomTool(server, publicName, box.id, tool)
      }
    }
  }

  customToolCatalog(): CustomToolCatalogEntry[] {
    const result: CustomToolCatalogEntry[] = []
    for (const box of this.toolboxes.values()) {
      if (!box.manifest.enabled || box.manifest.builtin) continue
      for (const [name, tool] of box.customTools) {
        if (box.loadErrors.has(name) || !this.isToolEnabled(box.id, name)) continue
        result.push({
          id: `toolbox:${box.id}:${name}`,
          toolbox: box.id,
          name: `${sanitizeName(box.id)}__${sanitizeName(tool.name)}`,
          description: tool.description,
          inputSchema: z.toJSONSchema(tool.inputSchema),
        })
      }
    }
    return result.sort((a, b) => a.id.localeCompare(b.id))
  }

  async callCustomTool(
    id: string,
    args: Record<string, unknown>,
    context: ServerContext
  ): Promise<unknown> {
    const parsed = parseCustomToolId(id)
    const box = this.requireBox(parsed.toolbox)
    if (!box.manifest.enabled || box.manifest.builtin) {
      throw new Error(`Toolbox ${parsed.toolbox} is not an enabled custom toolbox.`)
    }
    if (!this.isToolEnabled(parsed.toolbox, parsed.tool)) {
      throw new Error(`Custom tool ${id} is disabled.`)
    }
    const tool = box.customTools.get(parsed.tool)
    if (!tool || box.loadErrors.has(parsed.tool))
      throw new Error(`Unknown custom tool ${JSON.stringify(id)}.`)
    const input = tool.inputSchema.parse(args)
    return tool.execute(input, {
      name: `${sanitizeName(box.id)}__${sanitizeName(tool.name)}`,
      toolboxId: box.id,
      signal: context.mcpReq.signal,
      mcp: context,
    })
  }

  listSkills(): Array<{ name: string; description?: string }> {
    const result: Array<{ name: string; description?: string }> = []
    for (const box of this.toolboxes.values()) {
      if (!box.manifest.enabled) continue
      for (const [name, settings] of Object.entries(box.manifest.skills)) {
        if (!settings.enabled) continue
        result.push({
          name: `${box.id}.${name}`,
          ...(settings.description ? { description: settings.description } : {}),
        })
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  async readSkill(name: string, signal?: AbortSignal): Promise<{ path: string; content: string }> {
    const separator = name.indexOf(".")
    if (separator <= 0) throw new Error(`Unknown toolbox skill ${JSON.stringify(name)}.`)
    const toolboxId = name.slice(0, separator)
    const skillName = name.slice(separator + 1)
    const box = this.toolboxes.get(toolboxId)
    if (!box?.manifest.enabled || !isValidSkillName(skillName))
      throw new Error(`Unknown toolbox skill ${JSON.stringify(name)}.`)
    const settings = box.manifest.skills[skillName]
    if (!settings?.enabled) throw new Error(`Toolbox skill ${JSON.stringify(name)} is disabled.`)
    const path = join(box.path, "skills", skillName, "SKILL.md")
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_SKILL_BYTES)
      throw new Error(`Invalid toolbox skill ${JSON.stringify(name)}.`)
    return { path, content: await readFile(path, { encoding: "utf8", signal }) }
  }

  async setToolboxEnabled(id: string, enabled: boolean): Promise<void> {
    const box = this.requireBox(id)
    if (!enabled && Object.values(box.manifest.tools).some((tool) => tool.required)) {
      throw new Error(`${box.manifest.name} contains required tools and cannot be disabled.`)
    }
    box.manifest.enabled = enabled
    await this.writeManifest(box)
    await this.reload()
  }

  async setToolEnabled(id: string, name: string, enabled: boolean): Promise<void> {
    const box = this.requireBox(id)
    const current = box.manifest.tools[name] ?? { enabled: true, required: false }
    if (current.required && !enabled) throw new Error(`${name} is required and cannot be disabled.`)
    box.manifest.tools[name] = { ...current, enabled }
    await this.writeManifest(box)
    await this.reload()
  }

  async setSkillEnabled(id: string, name: string, enabled: boolean): Promise<void> {
    const box = this.requireBox(id)
    const current = box.manifest.skills[name] ?? { enabled: true, required: false }
    box.manifest.skills[name] = { ...current, enabled }
    await this.writeManifest(box)
    await this.reload()
  }

  async createToolbox(id: string, name = id): Promise<void> {
    validateId(id, "toolbox")
    if (this.toolboxes.has(id)) throw new Error(`Toolbox ${id} already exists.`)
    const path = join(this.root, id)
    await mkdir(join(path, "tools"), { recursive: true })
    await mkdir(join(path, "skills"), { recursive: true })
    await writeFile(
      join(path, "toolbox.json"),
      `${JSON.stringify({ name, enabled: false, tools: {}, skills: {} }, null, 2)}\n`,
      "utf8"
    )
    await this.reload()
  }

  async deleteToolbox(id: string): Promise<void> {
    const box = this.requireBox(id)
    if (box.manifest.builtin) throw new Error("Built-in toolboxes cannot be deleted.")
    await rm(box.path, { recursive: true, force: true })
    await this.reload()
  }

  async createTool(toolboxId: string, name: string): Promise<string> {
    validateId(name, "tool")
    const box = this.requireBox(toolboxId)
    if (box.manifest.builtin) throw new Error("Built-in toolboxes cannot add source tools.")
    const path = join(box.path, "tools", `${name}.ts`)
    try {
      await stat(path)
      throw new Error(`Tool ${name} already exists.`)
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, toolTemplate(name), "utf8")
    box.manifest.tools[name] = { enabled: true, required: false }
    await this.writeManifest(box)
    await this.reload()
    return path
  }

  async createSkill(toolboxId: string, name: string): Promise<string> {
    if (!isValidSkillName(name)) throw new Error("Invalid skill name.")
    const box = this.requireBox(toolboxId)
    const path = join(box.path, "skills", name, "SKILL.md")
    await mkdir(dirname(path), { recursive: true })
    try {
      await stat(path)
      throw new Error(`Skill ${name} already exists.`)
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error
    }
    await writeFile(
      path,
      `---\ndescription: ${name}\n---\n\n# ${name}\n\nAdd instructions here.\n`,
      "utf8"
    )
    box.manifest.skills[name] = { enabled: true, required: false, description: name }
    await this.writeManifest(box)
    await this.reload()
    return path
  }

  async deleteTool(toolboxId: string, name: string): Promise<void> {
    const box = this.requireBox(toolboxId)
    if (box.manifest.builtin) throw new Error("Built-in tools cannot be deleted.")
    await rm(join(box.path, "tools", `${name}.ts`), { force: true })
    delete box.manifest.tools[name]
    await this.writeManifest(box)
    await this.reload()
  }

  async deleteSkill(toolboxId: string, name: string): Promise<void> {
    const box = this.requireBox(toolboxId)
    await rm(join(box.path, "skills", name), { recursive: true, force: true })
    delete box.manifest.skills[name]
    await this.writeManifest(box)
    await this.reload()
  }

  itemPath(id: string, kind?: "tool" | "skill", name?: string): string {
    const box = this.requireBox(id)
    if (kind === "tool" && name) return join(box.path, "tools", `${name}.ts`)
    if (kind === "skill" && name) return join(box.path, "skills", name)
    return box.path
  }

  private async loadToolbox(id: string): Promise<LoadedToolbox> {
    const path = join(this.root, id)
    const manifestPath = join(path, "toolbox.json")
    const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")))
    const { customTools, loadErrors } = manifest.builtin
      ? { customTools: new Map<string, Tool>(), loadErrors: new Map<string, string>() }
      : await loadCustomTools(path, manifest)
    await discoverSkills(path, manifest)
    return { id, path, manifestPath, manifest, customTools, loadErrors }
  }

  private snapshot(box: LoadedToolbox): ToolboxSnapshot {
    const toolNames = new Set([...Object.keys(box.manifest.tools), ...box.customTools.keys()])
    return {
      id: box.id,
      name: box.manifest.name,
      ...(box.manifest.description ? { description: box.manifest.description } : {}),
      enabled: box.manifest.enabled,
      ...(box.manifest.builtin ? { builtin: box.manifest.builtin } : {}),
      path: box.path,
      tools: [...toolNames].sort().map((name) => ({
        name,
        enabled:
          box.manifest.tools[name]?.required === true ||
          box.manifest.tools[name]?.enabled !== false,
        required: box.manifest.tools[name]?.required ?? false,
        ...(box.manifest.tools[name]?.description
          ? { description: box.manifest.tools[name].description }
          : {}),
        ...(!box.manifest.builtin ? { path: join(box.path, "tools", `${name}.ts`) } : {}),
        ...(box.loadErrors.get(name) ? { error: box.loadErrors.get(name) } : {}),
      })),
      skills: Object.entries(box.manifest.skills)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, settings]) => ({
          name,
          enabled: settings.enabled,
          required: settings.required,
          ...(settings.description ? { description: settings.description } : {}),
          path: join(box.path, "skills", name, "SKILL.md"),
        })),
    }
  }

  private requireBox(id: string): LoadedToolbox {
    const box = this.toolboxes.get(id)
    if (!box) throw new Error(`Unknown toolbox ${JSON.stringify(id)}.`)
    return box
  }

  private async writeManifest(box: LoadedToolbox): Promise<void> {
    await writeFile(box.manifestPath, `${JSON.stringify(box.manifest, null, 2)}\n`, "utf8")
  }
}

async function loadTsTool(sourcePath: string): Promise<Tool> {
  const source = await readFile(sourcePath, "utf8")
  const output = stripTypeScriptTypes(source, {
    mode: "transform",
    sourceMap: false,
    sourceUrl: sourcePath,
  })
  const runtimePath = sourcePath.replace(TS_EXTENSION_RE, ".openchatx.mjs")
  await writeFile(runtimePath, output, "utf8")
  const href = `${pathToFileURL(runtimePath).href}?v=${Date.now()}`
  const exported = defaultExport(await import(href))
  if (!isToolLike(exported))
    throw new Error("Default export must be a Tool or defineTool(...) result.")
  return exported
}

async function loadCustomTools(
  toolboxPath: string,
  manifest: ToolboxManifest
): Promise<{ customTools: Map<string, Tool>; loadErrors: Map<string, string> }> {
  const customTools = new Map<string, Tool>()
  const loadErrors = new Map<string, string>()
  const toolsPath = join(toolboxPath, "tools")
  await mkdir(toolsPath, { recursive: true })
  for (const entry of await readdir(toolsPath, { withFileTypes: true })) {
    if (!entry.isFile() || !TOOL_FILE_PATTERN.test(entry.name)) continue
    const sourcePath = join(toolsPath, entry.name)
    const sourceName = basename(entry.name, ".ts")
    try {
      const tool = await loadTsTool(sourcePath)
      if (tool.name !== sourceName) {
        throw new Error(
          `Tool name ${JSON.stringify(tool.name)} must match its filename ${JSON.stringify(sourceName)}.`
        )
      }
      customTools.set(sourceName, tool)
      const current = manifest.tools[sourceName]
      manifest.tools[sourceName] = {
        ...(current ?? { enabled: true, required: false }),
        ...(tool.required ? { enabled: true, required: true } : {}),
        ...(tool.description && !current?.description ? { description: tool.description } : {}),
      }
    } catch (error) {
      loadErrors.set(sourceName, error instanceof Error ? error.message : String(error))
    }
  }
  return { customTools, loadErrors }
}

async function discoverSkills(toolboxPath: string, manifest: ToolboxManifest): Promise<void> {
  const skillsPath = join(toolboxPath, "skills")
  await mkdir(skillsPath, { recursive: true })
  for (const entry of await readdir(skillsPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSkillName(entry.name)) continue
    if (!manifest.skills[entry.name])
      manifest.skills[entry.name] = { enabled: true, required: false }
  }
}

async function unloadCustomTools(toolboxes: Map<string, LoadedToolbox>): Promise<void> {
  for (const box of toolboxes.values()) {
    for (const tool of box.customTools.values()) {
      try {
        await tool.onUnload?.({ toolboxId: box.id })
      } catch (error) {
        console.warn(
          `Toolbox ${box.id}/${tool.name} unload failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }
}

async function loadCustomToolHooks(toolboxes: Map<string, LoadedToolbox>): Promise<void> {
  for (const box of toolboxes.values()) {
    for (const [sourceName, tool] of box.customTools) {
      try {
        await tool.onLoad?.({ toolboxId: box.id })
      } catch (error) {
        box.loadErrors.set(
          sourceName,
          `onLoad failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }
}

function registerCustomTool(server: McpServer, publicName: string, toolboxId: string, tool: Tool) {
  const originalName = tool.name
  const config = {
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    icons: tool.icons,
    _meta: { ...tool.meta, "openchatx/toolbox": toolboxId, "openchatx/originalTool": originalName },
  }
  const callback = async (input: unknown, context: Parameters<Tool["execute"]>[1]["mcp"]) => {
    const parsed = tool.inputSchema.parse(input)
    return tool.execute(parsed, {
      name: publicName,
      toolboxId,
      signal: context.mcpReq.signal,
      mcp: context,
    })
  }
  Reflect.apply(server.registerTool, server, [publicName, config, callback])
}

function toolTemplate(name: string): string {
  return `import { defineTool, z } from "openchatx-mcp/toolbox"\n\nexport default defineTool({\n  name: ${JSON.stringify(name)},\n  description: ${JSON.stringify(`${name} tool`)},\n  inputSchema: z.object({}),\n  async execute() {\n    return { content: [{ type: "text", text: "Hello from ${name}" }] }\n  },\n})\n`
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/gu, "_").replace(/_+/gu, "_") || "tool"
}

function validateId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) throw new Error(`Invalid ${label} id.`)
}

function parseCustomToolId(id: string): { toolbox: string; tool: string } {
  if (!CUSTOM_TOOL_ID_RE.test(id)) throw new Error(`Invalid custom tool id ${JSON.stringify(id)}.`)
  const prefixLength = "toolbox:".length
  const separator = id.indexOf(":", prefixLength)
  return { toolbox: id.slice(prefixLength, separator), tool: id.slice(separator + 1) }
}

function isToolLike(value: unknown): value is Tool {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "inputSchema" in value &&
    "execute" in value &&
    typeof value.execute === "function"
  )
}

function defaultExport(module: unknown): unknown {
  return typeof module === "object" && module !== null && "default" in module
    ? module.default
    : undefined
}

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
