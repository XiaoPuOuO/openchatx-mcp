import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import type { ServerContext } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../config.js"
import type { ExternalMcpRegistry } from "../external-mcp/registry.js"
import type { JobManager } from "../jobs/job-manager.js"
import type { SubagentRuntime } from "../subagents/runtime.js"
import type { AgentTeamService } from "../teams/team-service.js"
import type { ToolboxRegistry } from "../toolbox/registry.js"

const toolStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("tool"),
  tool: z.string().min(1),
  arguments_json: z.string().default("{}"),
})

const subagentStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("subagent"),
  profile: z.string().min(1),
  task: z.string().min(1),
})

const teamStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("team"),
  team: z.string().min(1),
  task: z.string().min(1),
})

const jobStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("job"),
  label: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
})

const workflowStepSchema = z.discriminatedUnion("kind", [
  toolStepSchema,
  subagentStepSchema,
  teamStepSchema,
  jobStepSchema,
])

const workflowSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    steps: z.array(workflowStepSchema).min(1).max(40),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .superRefine((workflow, context) => {
    const ids = new Set<string>()
    for (const [index, step] of workflow.steps.entries()) {
      if (ids.has(step.id)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: "Workflow step ids must be unique.",
        })
      }
      ids.add(step.id)
    }
  })

const stateSchema = z.object({ workflows: z.array(workflowSchema) })

export type WorkflowDefinition = z.infer<typeof workflowSchema>
export type WorkflowStep = z.infer<typeof workflowStepSchema>

export interface WorkflowRunResult {
  workflow: { id: string; name: string }
  input: string
  steps: Array<{
    id: string
    kind: WorkflowStep["kind"]
    ok: boolean
    result?: unknown
    error?: string
  }>
}

export interface WorkflowServices {
  toolboxes?: ToolboxRegistry
  externalMcp?: ExternalMcpRegistry
  subagents?: SubagentRuntime
  teams?: AgentTeamService
  jobs?: JobManager
}

const TEMPLATE_RE = /\{\{\s*(input|steps\.([A-Za-z0-9._-]+))\s*\}\}/gu

export class WorkflowService {
  private readonly workflows = new Map<string, WorkflowDefinition>()
  private loadPromise?: Promise<void>

  constructor(
    private readonly services: WorkflowServices,
    private readonly statePath = resolve(MCP_CONFIG.stateDir, "workflows.json")
  ) {}

  async list(): Promise<WorkflowDefinition[]> {
    await this.ensureLoaded()
    return [...this.workflows.values()]
      .map((workflow) => ({
        ...workflow,
        steps: workflow.steps.map((step) => ({ ...step })),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async upsert(input: {
    id: string
    name: string
    description?: string
    steps: WorkflowStep[]
  }): Promise<WorkflowDefinition> {
    await this.ensureLoaded()
    const now = new Date().toISOString()
    const previous = this.workflows.get(input.id)
    const workflow = workflowSchema.parse({
      ...input,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    })
    this.workflows.set(workflow.id, workflow)
    await this.persist()
    return workflow
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded()
    if (!this.workflows.delete(id)) throw new Error(`Unknown workflow ${JSON.stringify(id)}.`)
    await this.persist()
  }

  async run(
    id: string,
    input: string,
    context: ServerContext,
    signal?: AbortSignal
  ): Promise<WorkflowRunResult> {
    await this.ensureLoaded()
    const workflow = this.workflows.get(id)
    if (!workflow) throw new Error(`Unknown workflow ${JSON.stringify(id)}.`)

    const values = new Map<string, unknown>()
    const steps: WorkflowRunResult["steps"] = []
    for (const step of workflow.steps) {
      if (signal?.aborted) throw signal.reason ?? new Error("Workflow aborted.")
      try {
        const result = await this.runStep(step, input, values, context, signal)
        values.set(step.id, result)
        steps.push({ id: step.id, kind: step.kind, ok: true, result })
      } catch (error) {
        steps.push({
          id: step.id,
          kind: step.kind,
          ok: false,
          error: error instanceof Error ? error.message : "Workflow step failed.",
        })
        break
      }
    }

    return { workflow: { id: workflow.id, name: workflow.name }, input, steps }
  }

  private async runStep(
    step: WorkflowStep,
    input: string,
    values: Map<string, unknown>,
    context: ServerContext,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (step.kind === "tool") {
      const args = parseArguments(renderTemplate(step.arguments_json, input, values))
      if (step.tool.startsWith("toolbox:")) {
        if (!this.services.toolboxes) throw new Error("Toolbox runtime is unavailable.")
        return this.services.toolboxes.callCustomTool(step.tool, args, context)
      }
      if (step.tool.startsWith("mcp:")) {
        if (!this.services.externalMcp) throw new Error("External MCP runtime is unavailable.")
        return this.services.externalMcp.call(step.tool, args)
      }
      throw new Error(
        `Workflow tool step requires a lazy tool id, got ${JSON.stringify(step.tool)}.`
      )
    }

    if (step.kind === "subagent") {
      if (!this.services.subagents) throw new Error("Subagent runtime is unavailable.")
      return this.services.subagents.run(
        {
          profileId: step.profile,
          task: renderTemplate(step.task, input, values),
        },
        signal
      )
    }

    if (step.kind === "team") {
      if (!this.services.teams) throw new Error("Agent Teams runtime is unavailable.")
      return this.services.teams.run(step.team, renderTemplate(step.task, input, values), signal)
    }

    if (!this.services.jobs) throw new Error("Durable Jobs runtime is unavailable.")
    return this.services.jobs.start(
      renderTemplate(step.label, input, values),
      renderTemplate(step.command, input, values),
      step.cwd ? renderTemplate(step.cwd, input, values) : undefined
    )
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    await this.loadPromise
  }

  private async load(): Promise<void> {
    try {
      const state = stateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")))
      for (const workflow of state.workflows) this.workflows.set(workflow.id, workflow)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    await writeFile(
      this.statePath,
      `${JSON.stringify({ workflows: [...this.workflows.values()] }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    )
  }
}

function renderTemplate(template: string, input: string, values: Map<string, unknown>): string {
  return template.replace(TEMPLATE_RE, (_match, key: string, stepId?: string) => {
    if (key === "input") return input
    return serializeTemplateValue(values.get(stepId ?? ""))
  })
}

function serializeTemplateValue(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

function parseArguments(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Workflow tool arguments_json must render to a JSON object.")
  }
  return Object.fromEntries(Object.entries(parsed))
}
