import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { setAgentTaskSlug } from "../../agent/context.js"
import { createAgentLoadDeduper } from "../../agent/load-deduper.js"
import type { CapabilityDescriptor } from "../../capabilities/catalog.js"
import { MCP_CONFIG } from "../../config.js"
import type { RegisteredGoal } from "../../goals/goal-registry.js"
import type { GoalScope } from "../../goals/goal-scope.js"
import type { RegisteredProject } from "../../projects/project-registry.js"
import type { ProjectScope } from "../../projects/project-scope.js"
import type { ToolboxRule } from "../../toolbox/registry.js"

export const START_HERE_TOOL_NAME = "start_here"
const AGENT_TEMPLATE_NAME = "AGENTS.template.md"
const PROMPT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const START_HERE_COOLDOWN_MS = 5_000
const loadStartInstructions = createAgentLoadDeduper<string>(START_HERE_COOLDOWN_MS)

type PromptSource = {
  path: string
  prompt: string
}

export type CapabilityCatalog = CapabilityDescriptor[]

export interface StartHereTemplateContext {
  mode: string
  taskId: string
  modeInstructions: string
  projectContext: string
  goalContext: string
  capabilityCatalog: string
  alwaysRules: string
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

export function registerStartHereTool(
  server: McpServer,
  capabilityCatalog?: () => CapabilityCatalog,
  projectScope?: ProjectScope,
  goalScope?: GoalScope,
  alwaysAppliedRules?: () => Promise<ToolboxRule[]>
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
      const { value: modeInstructions, reused } = await loadStartInstructions(mode, async () => {
        const selected = await readStartPrompt(mode)
        return selected.prompt.trim()
      })
      setAgentTaskSlug(task_id)
      const activeProject = project_id
        ? await projectScope?.use(project_id)
        : await projectScope?.current()
      const registeredProjects = !activeProject && projectScope ? await projectScope.list() : []
      const capabilities = capabilityCatalog ? renderCapabilityCatalog(capabilityCatalog()) : ""
      const projectContext = projectScope
        ? renderProjectContext(activeProject, registeredProjects)
        : ""
      const goalContext = goalScope ? renderGoalContext(await goalScope.open(), activeProject) : ""
      const ruleContext = alwaysAppliedRules
        ? renderAlwaysAppliedRules(await alwaysAppliedRules())
        : ""
      const template = await readAgentInstructionsTemplate()
      const instructions = renderStartHereTemplate(template, {
        mode,
        taskId: task_id,
        modeInstructions,
        projectContext,
        goalContext,
        capabilityCatalog: capabilities,
        alwaysRules: ruleContext,
      })
      return {
        content: [
          {
            type: "text",
            text: reused
              ? [
                  `Mode ${JSON.stringify(mode)} was loaded recently by this agent; reuse the previously returned instructions.`,
                  projectContext,
                  goalContext,
                  capabilities,
                  ruleContext,
                ]
                  .filter(Boolean)
                  .join("\n\n")
              : instructions,
          },
        ],
      }
    }
  )
}

function renderGoalContext(
  goals: RegisteredGoal[],
  activeProject: RegisteredProject | undefined
): string {
  if (goals.length === 0) return ""
  return [
    "# Tasks for this workspace session",
    activeProject
      ? `These unfinished tasks belong to Project ${JSON.stringify(activeProject.id)}. Work on them when relevant to the user's request and keep their status accurate with goal_manage.`
      : "These unfinished tasks are unscoped and apply only while no Project is active. Work on them when relevant to the user's request and keep their status accurate with goal_manage.",
    ...goals.map((goal) => {
      const detail = goal.description ? ` — ${goal.description}` : ""
      return `- [${goal.status}] ${goal.id}: ${goal.title}${detail}`
    }),
  ].join("\n")
}

function renderAlwaysAppliedRules(rules: ToolboxRule[]): string {
  if (rules.length === 0) return ""
  return [
    "# Always-applied rules",
    "The following persistent .mdc rules apply to every request in this session.",
    ...rules.map((rule) => `## ${rule.toolboxId}/${rule.name}\n\n${rule.markdown}`),
  ].join("\n")
}

function renderProjectContext(
  activeProject: RegisteredProject | undefined,
  registeredProjects: RegisteredProject[]
): string {
  if (activeProject) {
    return [
      "# Active Project",
      `- ${activeProject.id} (${activeProject.name}) — ${activeProject.path}`,
      ...(activeProject.additionalPaths.length > 0
        ? activeProject.additionalPaths.map((path) => `- additional root: ${path}`)
        : []),
      `- permissions: read=${activeProject.permissions.read}, write=${activeProject.permissions.write}, shell=${activeProject.permissions.shell}`,
      "Relative file/search/shell paths resolve from this Project until project_use changes or clears it.",
    ].join("\n")
  }
  if (registeredProjects.length === 0) {
    return [
      "# Projects",
      "No Projects are registered yet.",
      "For each new user task, decide whether it belongs to a durable Project. If it does, locate the relevant project folders, choose exactly one primary root, include any additional roots that belong to the same workspace, create the Project with project_manage, then activate it with project_use before project-focused work. Leave machine/global tasks unscoped.",
    ].join("\n")
  }
  return [
    "# Registered Projects",
    ...registeredProjects
      .slice(0, 8)
      .map(
        (project) =>
          `- ${project.id} (${project.name}) — primary: ${project.path}${project.additionalPaths.length > 0 ? `; additional: ${project.additionalPaths.join(", ")}` : ""}`
      ),
    "No Project is active. For each new user task, decide whether it is project-scoped. Reuse and activate a matching Project before project-focused work. If no registered Project matches, locate the relevant folders, choose one primary root plus any additional roots, create it with project_manage, then activate it with project_use. Leave machine/global tasks unscoped.",
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
  root = repositoryRoot,
  template?: string,
  context: Partial<Omit<StartHereTemplateContext, "mode" | "modeInstructions">> = {}
): Promise<string> {
  const [selected, agentTemplate] = await Promise.all([
    readStartPrompt(mode, root),
    template === undefined ? readBundledAgentTemplate(root) : Promise.resolve(template),
  ])
  return renderStartHereTemplate(agentTemplate, {
    mode,
    taskId: context.taskId ?? "",
    modeInstructions: selected.prompt.trim(),
    projectContext: context.projectContext ?? "",
    goalContext: context.goalContext ?? "",
    capabilityCatalog: context.capabilityCatalog ?? "",
    alwaysRules: context.alwaysRules ?? "",
  })
}

export async function readAgentInstructionsTemplate(): Promise<string> {
  try {
    return await readFile(MCP_CONFIG.agentInstructionsFile, "utf8")
  } catch (error) {
    if (!isFsError(error, "ENOENT")) throw error
    return readBundledAgentTemplate(repositoryRoot)
  }
}

export function renderStartHereTemplate(
  template: string,
  context: StartHereTemplateContext
): string {
  const hadGoalPlaceholder = template.includes("{{GOAL_CONTEXT}}")
  const replacements: Record<string, string> = {
    "{{MODE}}": context.mode,
    "{{TASK_ID}}": context.taskId,
    "{{MODE_INSTRUCTIONS}}": context.modeInstructions,
    "{{PROJECT_CONTEXT}}": context.projectContext,
    "{{GOAL_CONTEXT}}": context.goalContext,
    "{{CAPABILITY_CATALOG}}": context.capabilityCatalog,
    "{{ALWAYS_RULES}}": context.alwaysRules,
  }
  let output = template
  for (const [placeholder, value] of Object.entries(replacements)) {
    output = output.replaceAll(placeholder, value)
  }
  if (!hadGoalPlaceholder && context.goalContext) {
    output = `${output.trim()}\n\n${context.goalContext}`
  }
  return output.trim()
}

async function readBundledAgentTemplate(root: string): Promise<string> {
  return readFile(join(root, "src", "tools", "start-here", AGENT_TEMPLATE_NAME), "utf8")
}

export function discoverPromptModes(root = repositoryRoot): string[] {
  const bundledDirectory = join(root, "src", "tools", "start-here", "prompts")
  const localDirectory = join(root, ".openchatx", "prompts")
  const names = new Set([...readPromptSlugs(bundledDirectory), ...readPromptSlugs(localDirectory)])
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
