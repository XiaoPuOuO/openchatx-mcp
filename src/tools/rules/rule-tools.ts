import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { ToolError, toToolError } from "../../mcp/tool-error.js"
import type { ToolboxRegistry } from "../../toolbox/registry.js"
import { MAX_RULE_RESOLVE_RESULTS, RuleCatalogError, type RuleMode } from "./rule-catalog.js"
import { exportRule, importRule } from "./rule-compat.js"

const ruleModeSchema = z.enum(["always", "auto_attached", "agent_requested", "manual"])

export function registerRuleTools(server: McpServer, toolboxes?: ToolboxRegistry): void {
  registerResolveTool(server, toolboxes)
  registerManageTool(server, toolboxes)
}

function registerResolveTool(server: McpServer, toolboxes?: ToolboxRegistry): void {
  server.registerTool(
    "rule_resolve",
    {
      description:
        "Resolve applicable rules, or load one exact rule. Use action=resolve (default) with query/paths, or action=load with toolbox_id/name.",
      inputSchema: z.object({
        action: z.enum(["resolve", "load"]).default("resolve"),
        query: z.string().optional(),
        paths: z.array(z.string()).max(100).optional(),
        limit: z.number().int().min(1).max(MAX_RULE_RESOLVE_RESULTS).default(10),
        toolbox_id: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
      }),
      annotations: readOnlyAnnotations(),
    },
    async ({ action, query, paths, limit, toolbox_id, name }, ctx) => {
      try {
        if (action === "load") {
          const toolboxId = requiredString(toolbox_id, "toolbox_id", action)
          const ruleName = requiredString(name, "name", action)
          const rule = await requireToolboxes(toolboxes)
            .ruleCatalog(toolboxId)
            .load(ruleName, ctx.mcpReq.signal)
          return {
            structuredContent: ruleResult({ ...rule, toolboxId }),
            content: [],
          }
        }

        const matches = await requireToolboxes(toolboxes).resolveRules(
          { query, paths, limit },
          ctx.mcpReq.signal
        )
        return {
          structuredContent: { rules: matches.map(ruleResult) },
          content: [],
        }
      } catch (error) {
        throw ruleToolError(error)
      }
    }
  )
}

function registerManageTool(server: McpServer, toolboxes?: ToolboxRegistry): void {
  server.registerTool(
    "rule_manage",
    {
      description:
        "Create, edit, delete, import, or export .mdc rules. import/export support Cursor, Claude, and AGENTS.md formats.",
      inputSchema: z.object({
        toolbox_id: z.string().min(1),
        action: z.enum(["create", "edit", "delete", "import", "export"]),
        name: z.string().min(1).max(128).optional(),
        mode: ruleModeSchema.optional(),
        description: z.string().max(1024).optional(),
        globs: z.array(z.string().min(1)).max(100).optional(),
        alwaysApply: z.boolean().optional(),
        markdown: z.string().optional(),
        content: z.string().optional(),
        format: z.enum(["cursor", "claude", "agents"]).optional(),
        source: z.string().min(1).optional(),
        destination: z.string().min(1).optional(),
        replace: z.boolean().default(false),
        allow_lossy: z.boolean().default(false),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      toolbox_id,
      action,
      name,
      mode,
      description,
      globs,
      alwaysApply,
      markdown,
      content,
      format,
      source,
      destination,
      replace,
      allow_lossy,
    }) => {
      try {
        const rules = requireToolboxes(toolboxes).ruleCatalog(toolbox_id)
        return await executeRuleAction(rules, toolbox_id, {
          action,
          name,
          mode,
          description,
          globs,
          alwaysApply,
          markdown,
          content,
          format,
          source,
          destination,
          replace,
          allow_lossy,
        })
      } catch (error) {
        throw ruleToolError(error)
      }
    }
  )
}

type RuleManageInput = {
  action: "create" | "edit" | "delete" | "import" | "export"
  name?: string
  mode?: RuleMode
  description?: string
  globs?: string[]
  alwaysApply?: boolean
  markdown?: string
  content?: string
  format?: "cursor" | "claude" | "agents"
  source?: string
  destination?: string
  replace: boolean
  allow_lossy: boolean
}

async function executeRuleAction(
  rules: ReturnType<ToolboxRegistry["ruleCatalog"]>,
  toolboxId: string,
  input: RuleManageInput
) {
  switch (input.action) {
    case "delete":
      return deleteRule(rules, input)
    case "import":
      return importManagedRule(rules, toolboxId, input)
    case "export":
      return exportManagedRule(rules, input)
    case "create":
    case "edit":
      return writeRule(rules, toolboxId, input)
  }
}

async function deleteRule(
  rules: ReturnType<ToolboxRegistry["ruleCatalog"]>,
  input: RuleManageInput
) {
  const ruleName = requiredString(input.name, "name", input.action)
  await rules.delete(ruleName)
  return { structuredContent: { action: input.action, removed: ruleName }, content: [] }
}

async function importManagedRule(
  rules: ReturnType<ToolboxRegistry["ruleCatalog"]>,
  toolboxId: string,
  input: RuleManageInput
) {
  if (!input.format) throw missingField("format", input.action)
  const source = requiredString(input.source, "source", input.action)
  const rule = await importRule(rules, {
    format: input.format,
    source,
    replace: input.replace,
    ...(input.name ? { name: input.name } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.globs !== undefined ? { globs: input.globs } : {}),
  })
  return {
    structuredContent: { action: input.action, rule: ruleResult({ ...rule, toolboxId }) },
    content: [],
  }
}

async function exportManagedRule(
  rules: ReturnType<ToolboxRegistry["ruleCatalog"]>,
  input: RuleManageInput
) {
  if (!input.format) throw missingField("format", input.action)
  const name = requiredString(input.name, "name", input.action)
  const destination = requiredString(input.destination, "destination", input.action)
  const result = await exportRule(rules, {
    format: input.format,
    name,
    destination,
    replace: input.replace,
    allowLossy: input.allow_lossy,
  })
  return { structuredContent: { action: input.action, ...result }, content: [] }
}

async function writeRule(
  rules: ReturnType<ToolboxRegistry["ruleCatalog"]>,
  toolboxId: string,
  input: RuleManageInput
) {
  const name = requiredString(input.name, "name", input.action)
  const ruleInput = normalizeRuleInput(input)
  const rule =
    input.action === "create"
      ? await rules.create({ name, ...ruleInput })
      : await rules.edit(name, ruleInput)
  return {
    structuredContent: { action: input.action, rule: ruleResult({ ...rule, toolboxId }) },
    content: [],
  }
}

function normalizeRuleInput(input: {
  mode?: RuleMode
  description?: string
  globs?: string[]
  alwaysApply?: boolean
  markdown?: string
  content?: string
}) {
  if (input.content !== undefined) return { content: input.content }

  const normalized = {
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.globs !== undefined ? { globs: input.globs } : {}),
    ...(input.alwaysApply !== undefined ? { alwaysApply: input.alwaysApply } : {}),
    ...(input.markdown !== undefined ? { markdown: input.markdown } : {}),
  }

  if (!input.mode) return normalized
  if (input.mode === "always") return { ...normalized, alwaysApply: true }
  if (input.mode === "auto_attached") {
    if (!input.globs || input.globs.length === 0) {
      throw new RuleCatalogError("invalid_rule", "Auto Attached rules require at least one glob.")
    }
    return { ...normalized, globs: input.globs, alwaysApply: false }
  }
  if (input.mode === "agent_requested") {
    if (!input.description?.trim()) {
      throw new RuleCatalogError(
        "invalid_rule",
        "Agent Requested rules require a non-empty description."
      )
    }
    return { ...normalized, description: input.description, globs: [], alwaysApply: false }
  }
  return { ...normalized, description: "", globs: [], alwaysApply: false }
}

function requiredString(value: string | undefined, field: string, action: string): string {
  if (!value?.trim()) throw missingField(field, action)
  return value
}

function missingField(field: string, action: string): RuleCatalogError {
  return new RuleCatalogError(
    "invalid_rule",
    `${field} is required for rule_manage action=${action}.`
  )
}

function requireToolboxes(toolboxes?: ToolboxRegistry): ToolboxRegistry {
  if (!toolboxes) {
    throw new ToolError(
      "RULE_TOOLBOX_UNAVAILABLE",
      "Toolbox runtime is unavailable; rules must belong to a toolbox."
    )
  }
  return toolboxes
}

function ruleResult(rule: {
  toolboxId?: string
  name: string
  description?: string
  globs: string[]
  alwaysApply: boolean
  mode: RuleMode
  path: string
  markdown: string
}) {
  return {
    ...(rule.toolboxId ? { toolboxId: rule.toolboxId } : {}),
    name: rule.name,
    ...(rule.description ? { description: rule.description } : {}),
    globs: rule.globs,
    alwaysApply: rule.alwaysApply,
    mode: rule.mode,
    path: rule.path,
    markdown: rule.markdown,
  }
}

function readOnlyAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const
}

function ruleToolError(error: unknown): ToolError {
  if (error instanceof RuleCatalogError) return new ToolError(error.code, error.message, error)
  if (error instanceof ToolError) return error
  return toToolError(error, "RULE_FAILED")
}
