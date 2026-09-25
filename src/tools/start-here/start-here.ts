import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { setAgentTaskSlug } from "../../agent/context.js"
import { createAgentLoadDeduper } from "../../agent/load-deduper.js"
import type { CapabilityDescriptor } from "../../capabilities/catalog.js"
import type { RegisteredProject } from "../../projects/project-registry.js"
import type { ProjectScope } from "../../projects/project-scope.js"

export const START_HERE_TOOL_NAME = "start_here"
const SHARED_PROMPT_NAME = "shared"
const PROMPT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const START_HERE_COOLDOWN_MS = 5_000
const loadStartInstructions = createAgentLoadDeduper<string>(START_HERE_COOLDOWN_MS)

type PromptSource = {
  path: string
  prompt: string
}

export type CapabilityCatalog = CapabilityDescriptor[]

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

export function registerStartHereTool(
  server: McpServer,
  capabilityCatalog?: () => CapabilityCatalog,
  projectScope?: ProjectScope
): void {
  const modes = discoverPromptModes()
  const [firstMode, ...remainingModes] = modes
  if (firstMode === undefined) throw new Error("start_here requires at least one prompt mode")

  server.registerTool(
    START_HERE_TOOL_NAME,
    {
      description:
        "Initialize openchatx-mcp once per conversation. Loads the selected Deep Work mode, returns a lightweight capability catalog for MCP servers/subagents/custom toolboxes, and unlocks the other tools.",
      inputSchema: z.object({
        mode: z.enum([firstMode, ...remainingModes]),
        task_id: z.string().min(1).max(128),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe("Optional registered Project to make active for this ChatGPT session."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ mode, task_id, project_id }) => {
      const { value: instructions, reused } = await loadStartInstructions(mode, () =>
        buildStartHereInstructions(mode)
      )
      setAgentTaskSlug(task_id)
      const activeProject = project_id
        ? await projectScope?.use(project_id)
        : await projectScope?.current()
      const registeredProjects = !activeProject && projectScope ? await projectScope.list() : []
      const capabilities = capabilityCatalog ? renderCapabilityCatalog(capabilityCatalog()) : ""
      const projectContext = renderProjectContext(activeProject, registeredProjects)
      return {
        content: [
          {
            type: "text",
            text: reused
              ? [
                  `Mode ${JSON.stringify(mode)} was loaded recently by this agent; reuse the previously returned instructions.`,
                  projectContext,
                  capabilities,
                ]
                  .filter(Boolean)
                  .join("\n\n")
              : [instructions, projectContext, capabilities].filter(Boolean).join("\n\n"),
          },
        ],
      }
    }
  )
}

function renderProjectContext(
  activeProject: RegisteredProject | undefined,
  registeredProjects: RegisteredProject[]
): string {
  if (activeProject) {
    return [
      "# Active Project",
      `- ${activeProject.id} (${activeProject.name}) — ${activeProject.path}`,
      `- permissions: read=${activeProject.permissions.read}, write=${activeProject.permissions.write}, shell=${activeProject.permissions.shell}`,
      "Relative file/search/shell paths resolve from this Project until project_use changes or clears it.",
    ].join("\n")
  }
  if (registeredProjects.length === 0) return ""
  return [
    "# Registered Projects",
    ...registeredProjects
      .slice(0, 8)
      .map((project) => `- ${project.id} (${project.name}) — ${project.path}`),
    "No Project is active. Use project_use before project-focused work so relative paths and permission scope are explicit.",
  ].join("\n")
}

export function renderCapabilityCatalog(catalog: CapabilityCatalog): string {
  if (catalog.length === 0) return ""
  const lines = catalog.map((capability) => {
    const detailParts: string[] = [capability.available ? "available" : "unavailable"]
    if (capability.toolCount !== undefined) detailParts.push(`${capability.toolCount} tools`)
    if (capability.skillCount !== undefined) detailParts.push(`${capability.skillCount} skills`)
    if (capability.profileCount !== undefined)
      detailParts.push(`${capability.profileCount} model profiles`)
    const description = capability.description ? ` — ${capability.description}` : ""
    return `- ${capability.id} (${capability.name}): ${detailParts.join(", ")}${description}`
  })
  return [
    "# Available OpenChatX capabilities",
    "Capabilities are presented as one platform catalog regardless of whether they come from MCP, custom tools, model profiles, or providers.",
    ...lines,
    "Use capability_list when you need exact invocation details. Tool-backed capabilities are discovered with tool_search/tool_call; agent capabilities run through subagent_run.",
  ].join("\n")
}

export async function buildStartHereInstructions(
  mode: string,
  root = repositoryRoot
): Promise<string> {
  const [selected, shared] = await Promise.all([
    readStartPrompt(mode, root),
    readStartPrompt(SHARED_PROMPT_NAME, root),
  ])
  return [shared.prompt.trim(), selected.prompt.trim()].filter(Boolean).join("\n\n")
}

export function discoverPromptModes(root = repositoryRoot): string[] {
  const bundledDirectory = join(root, "src", "tools", "start-here", "prompts")
  const localDirectory = join(root, ".openchatx", "prompts")
  const names = new Set([...readPromptSlugs(bundledDirectory), ...readPromptSlugs(localDirectory)])
  names.delete(SHARED_PROMPT_NAME)
  return [...names].sort()
}

export async function readStartPrompt(name: string, root = repositoryRoot): Promise<PromptSource> {
  const localPath = join(root, ".openchatx", "prompts", `${name}.md`)
  try {
    return { path: localPath, prompt: await readFile(localPath, "utf8") }
  } catch (error) {
    if (!isFsError(error, "ENOENT")) throw error
  }

  const bundledPath = join(root, "src", "tools", "start-here", "prompts", `${name}.md`)
  return { path: bundledPath, prompt: await readFile(bundledPath, "utf8") }
}

function readPromptSlugs(directory: string): string[] {
  try {
    const slugs = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3))
    const invalid = slugs.find((slug) => !PROMPT_SLUG_PATTERN.test(slug))
    if (invalid)
      throw new Error(
        `Invalid start_here prompt filename: ${invalid}.md. Use lowercase kebab-case.`
      )
    return slugs
  } catch (error) {
    if (isFsError(error, "ENOENT")) return []
    throw error
  }
}

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
