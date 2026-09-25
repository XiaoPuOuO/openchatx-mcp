import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { ToolError, toToolError } from "../../mcp/tool-error.js"
import type { ToolboxRegistry } from "../../toolbox/registry.js"
import { MAX_RULE_RESOLVE_RESULTS, RuleCatalogError, type RuleMode } from "./rule-catalog.js"
import { exportRule, importRule } from "./rule-compat.js"

const ruleModeSchema = z.enum(["always", "auto_attached", "agent_requested", "manual"])

const ruleResultSchema = z.object({
  toolboxId: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  globs: z.array(z.string()),
  alwaysApply: z.boolean(),
  mode: ruleModeSchema,
  path: z.string(),
  markdown: z.string(),
})

export function registerRuleTools(server: McpServer, toolboxes?: ToolboxRegistry): void {
  registerResolveTool(server, toolboxes)
  registerLoadTool(server, toolboxes)
  registerManageTool(server, toolboxes)
  registerCompatibilityTools(server, toolboxes)
}

function registerResolveTool(server: McpServer, toolboxes?: ToolboxRegistry): void {
  server.registerTool(
    "rule_resolve",
    {
      description:
        "Resolve applicable Auto Attached and Agent Requested rules. File globs select Auto Attached rules; task text selects Agent Requested rules. Always rules are already injected by start_here and Manual rules are never auto-selected.",
      inputSchema: z.object({
        query: z.string().optional(),
        paths: z.array(z.string()).max(100).optional(),
        limit: z.number().int().min(1).max(MAX_RULE_RESOLVE_RESULTS).default(10),
      }),
      outputSchema: z.object({
        rules: z.array(ruleResultSchema).max(MAX_RULE_RESOLVE_RESULTS),
      }),
      annotations: readOnlyAnnotations(),
    },
    async ({ query, paths, limit }, ctx) => {
      try {
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

function registerLoadTool(server: McpServer, toolboxes?: ToolboxRegistry): void {
  server.registerTool(
    "rule_load",
    {
      description:
        "Load one exact rule by name. Primarily use this for Manual rules or when the user explicitly references a rule.",
      inputSchema: z.object({
        toolbox_id: z.string().min(1),
        name: z.string().min(1),
      }),
      outputSchema: ruleResultSchema,
      annotations: readOnlyAnnotations(),
    },
    async ({ toolbox_id, name }, ctx) => {
      try {
        const rule = await requireToolboxes(toolboxes)
          .ruleCatalog(toolbox_id)
          .load(name, ctx.mcpReq.signal)
        return { structuredContent: ruleResult({ ...rule, toolboxId: toolbox_id }), content: [] }
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
        "Create, edit, or delete OpenChatX .mdc rules. The four activation modes are Always, Auto Attached, Agent Requested, and Manual.",
      inputSchema: z.object({
        toolbox_id: z.string().min(1),
        action: z.enum(["create", "edit", "delete"]),
        name: z.string().min(1).max(128),
        mode: ruleModeSchema.optional(),
        description: z.string().max(1024).optional(),
        globs: z.array(z.string().min(1)).max(100).optional(),
        alwaysApply: z.boolean().optional(),
        markdown: z.string().optional(),
        content: z
          .string()
          .optional()
          .describe(
            "Complete .mdc file. When supplied, metadata/body fields and mode are ignored."
          ),
      }),
      outputSchema: z.object({
        action: z.enum(["create", "edit", "delete"]),
        rule: ruleResultSchema.optional(),
        removed: z.string().optional(),
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
    }) => {
      try {
        const rules = requireToolboxes(toolboxes).ruleCatalog(toolbox_id)
        if (action === "delete") {
          await rules.delete(name)
          return {
            structuredContent: { action, removed: name },
            content: [],
          }
        }

        const input = normalizeRuleInput({
          mode,
          description,
          globs,
          alwaysApply,
          markdown,
          content,
        })
        const rule =
          action === "create"
            ? await rules.create({ name, ...input })
            : await rules.edit(name, input)

        return {
          structuredContent: { action, rule: ruleResult({ ...rule, toolboxId: toolbox_id }) },
          content: [],
        }
      } catch (error) {
        throw ruleToolError(error)
      }
    }
  )
}

function registerCompatibilityTools(server: McpServer, toolboxes?: ToolboxRegistry): void {
  server.registerTool(
    "rule_import",
    {
      description:
        "Import one external rule file into OpenChatX. Supports Cursor .mdc, Claude .claude/rules/*.md, and AGENTS.md.",
      inputSchema: z.object({
        toolbox_id: z.string().min(1),
        format: z.enum(["cursor", "claude", "agents"]),
        source: z.string().min(1),
        name: z.string().min(1).optional(),
        replace: z.boolean().default(false),
        mode: ruleModeSchema.optional(),
        description: z.string().max(1024).optional(),
        globs: z.array(z.string().min(1)).max(100).optional(),
      }),
      outputSchema: ruleResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ toolbox_id, format, source, name, replace, mode, description, globs }) => {
      try {
        const rules = requireToolboxes(toolboxes).ruleCatalog(toolbox_id)
        const rule = await importRule(rules, {
          format,
          source,
          replace,
          ...(name ? { name } : {}),
          ...(mode ? { mode } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(globs !== undefined ? { globs } : {}),
        })
        return {
          structuredContent: ruleResult({ ...rule, toolboxId: toolbox_id }),
          content: [],
        }
      } catch (error) {
        throw ruleToolError(error)
      }
    }
  )

  server.registerTool(
    "rule_export",
    {
      description:
        "Export one OpenChatX rule to Cursor .mdc, Claude .claude/rules Markdown, or AGENTS.md. Lossy exports are rejected unless allow_lossy is true.",
      inputSchema: z.object({
        toolbox_id: z.string().min(1),
        format: z.enum(["cursor", "claude", "agents"]),
        name: z.string().min(1),
        destination: z.string().min(1),
        replace: z.boolean().default(false),
        allow_lossy: z.boolean().default(false),
      }),
      outputSchema: z.object({
        path: z.string(),
        format: z.enum(["cursor", "claude", "agents"]),
        mode: ruleModeSchema,
        warnings: z.array(z.string()),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ toolbox_id, format, name, destination, replace, allow_lossy }) => {
      try {
        const rules = requireToolboxes(toolboxes).ruleCatalog(toolbox_id)
        const result = await exportRule(rules, {
          format,
          name,
          destination,
          replace,
          allowLossy: allow_lossy,
        })
        return { structuredContent: result, content: [] }
      } catch (error) {
        throw ruleToolError(error)
      }
    }
  )
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
