import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { ToolError, toToolError } from "../../mcp/tool-error.js"
import type { ToolboxRegistry } from "../../toolbox/registry.js"
import { MAX_SKILL_SEARCH_RESULTS, SkillCatalogError, type SkillSummary } from "./skill-catalog.js"

const skillSummarySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
})

export function registerSkillTools(server: McpServer, toolboxes?: ToolboxRegistry): void {
  server.registerTool(
    "skill_search",
    {
      description:
        "Search reusable skills by keywords. Use this only when the user explicitly mentions a skill/workflow by name or asks to use one. Returns at most 5 matching skill names and descriptions; it does not load instructions.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Keywords from the user's referenced skill or workflow."),
        limit: z.number().int().min(1).max(MAX_SKILL_SEARCH_RESULTS).default(5),
      }),
      outputSchema: z.object({
        skills: z.array(skillSummarySchema).max(MAX_SKILL_SEARCH_RESULTS),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }, ctx) => {
      try {
        const available = (await toolboxes?.listSkills(ctx.mcpReq.signal)) ?? []
        const matches = searchCombinedSkills(available, query, limit)
        return {
          structuredContent: {
            skills: matches.map(({ name, description }) => ({
              name,
              ...(description ? { description } : {}),
            })),
          },
          content: [],
        }
      } catch (error) {
        throw skillToolError(error)
      }
    }
  )

  server.registerTool(
    "skill_load",
    {
      description:
        "Load the complete Markdown for one skill after discovering or otherwise knowing its exact name.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Exact skill name returned by skill_search."),
      }),
      outputSchema: z.object({
        name: z.string(),
        path: z.string(),
        markdown: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name }, ctx) => {
      try {
        if (!toolboxes) throw new Error("Toolbox runtime is unavailable.")
        const loaded = await toolboxes.readSkill(name, ctx.mcpReq.signal)
        return {
          structuredContent: {
            name,
            path: loaded.path,
            markdown: loaded.content,
          },
          content: [],
        }
      } catch (error) {
        throw skillToolError(error)
      }
    }
  )

  server.registerTool(
    "skill_manage",
    {
      description: "Create, edit, or delete portable SKILL.md skills inside a toolbox.",
      inputSchema: z.object({
        action: z.enum(["create", "edit", "delete"]),
        toolbox: z.string().min(1).describe("Toolbox id that owns the skill."),
        name: z
          .string()
          .min(1)
          .max(128)
          .describe(
            "Skill name. New skills must use lowercase letters/numbers separated by single hyphens, max 64 chars; edit/delete also accept safe legacy names."
          ),
        description: z.string().min(1).max(1024).optional(),
        markdown: z
          .string()
          .optional()
          .describe(
            "Complete SKILL.md Markdown. For create/edit it must include frontmatter name and description when supplied."
          ),
      }),
      outputSchema: z.object({
        action: z.enum(["create", "edit", "delete"]),
        name: z.string(),
        path: z.string().optional(),
        description: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        if (!toolboxes) throw new Error("Toolbox runtime is unavailable.")
        return await manageSkill(toolboxes, input)
      } catch (error) {
        throw skillToolError(error)
      }
    }
  )
}

async function manageSkill(
  toolboxes: ToolboxRegistry,
  input: {
    action: "create" | "edit" | "delete"
    toolbox: string
    name: string
    description?: string
    markdown?: string
  }
) {
  const { action: operation, toolbox, name, description, markdown } = input
  if (operation === "delete") {
    await toolboxes.deleteManagedSkill(toolbox, name)
    return {
      structuredContent: { action: operation, name: `${toolbox}.${name}` },
      content: [],
    }
  }

  const options = {
    ...(description ? { description } : {}),
    ...(markdown !== undefined ? { markdown } : {}),
  }
  const loaded =
    operation === "create"
      ? await toolboxes.createManagedSkill(toolbox, { name, ...options })
      : await toolboxes.editManagedSkill(toolbox, name, options)

  return {
    structuredContent: {
      action: operation,
      name: `${toolbox}.${name}`,
      path: loaded.path,
      ...(loaded.description ? { description: loaded.description } : {}),
    },
    content: [],
  }
}

function searchCombinedSkills(
  skills: SkillSummary[],
  query: string,
  limit: number
): SkillSummary[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return []
  const queryTokens = tokenize(normalizedQuery)

  return skills
    .map((skill) => ({ skill, score: scoreSkill(skill, normalizedQuery, queryTokens) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name)
    )
    .slice(0, Math.max(1, Math.min(MAX_SKILL_SEARCH_RESULTS, limit)))
    .map(({ skill }) => skill)
}

function scoreSkill(skill: SkillSummary, query: string, queryTokens: string[]) {
  const name = skill.name.toLowerCase()
  const description = skill.description?.toLowerCase() ?? ""
  let score = 0

  if (name === query) score += 100
  if (name.includes(query)) score += 40
  if (description.includes(query)) score += 20

  for (const token of queryTokens) {
    if (name === token) score += 20
    else if (name.includes(token)) score += 10
    if (description.includes(token)) score += 4
  }
  return score
}

function tokenize(value: string): string[] {
  return value.match(/[\p{L}\p{N}]+/gu) ?? []
}

function skillToolError(error: unknown): ToolError {
  if (error instanceof SkillCatalogError) return new ToolError(error.code, error.message, error)
  if (error instanceof ToolError) return error
  return toToolError(error, "SKILL_FAILED")
}
