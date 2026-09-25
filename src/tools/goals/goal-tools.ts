import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { type GoalRegistry, goalStatusSchema } from "../../goals/goal-registry.js"
import type { GoalScope } from "../../goals/goal-scope.js"
import { toToolError } from "../../mcp/tool-error.js"

export function registerGoalTools(server: McpServer, goals: GoalRegistry, scope?: GoalScope): void {
  server.registerTool(
    "goal_list",
    {
      description:
        "List Goals for the current workspace session only. When no Project is active, only unscoped Goals are returned.",
      inputSchema: z.object({
        status: goalStatusSchema.optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ status }) => {
      if (!scope) throw new Error("Goal workspace scope is unavailable.")
      return {
        structuredContent: { goals: await scope.list(status) },
        content: [],
      }
    }
  )

  server.registerTool(
    "goal_manage",
    {
      description:
        "Create, update, or remove a Goal in the current workspace session. Creation automatically binds the Goal to the active Project, or to the unscoped session when no Project is active. Goals cannot be moved between workspaces.",
      inputSchema: z.discriminatedUnion("action", [
        z.object({
          action: z.literal("create"),
          id: z.string().min(1),
          title: z.string().min(1),
          description: z.string().min(1).optional(),
        }),
        z.object({
          action: z.literal("update"),
          id: z.string().min(1),
          title: z.string().min(1).optional(),
          description: z.string().nullable().optional(),
          status: goalStatusSchema.optional(),
        }),
        z.object({ action: z.literal("remove"), id: z.string().min(1) }),
      ]),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        if (!scope) throw new Error("Goal workspace scope is unavailable.")
        if (input.action === "remove") {
          await scope.get(input.id)
          await goals.remove(input.id)
          return { structuredContent: { removed: input.id }, content: [] }
        }

        if (input.action === "create") {
          const goal = await scope.create({
            id: input.id,
            title: input.title,
            description: input.description,
          })
          return { structuredContent: { goal }, content: [] }
        }

        await scope.get(input.id)
        const goal = await goals.update(input.id, {
          title: input.title,
          description: input.description,
          status: input.status,
        })
        return { structuredContent: { goal }, content: [] }
      } catch (error) {
        throw toToolError(error, "GOAL_MANAGE_FAILED")
      }
    }
  )
}
