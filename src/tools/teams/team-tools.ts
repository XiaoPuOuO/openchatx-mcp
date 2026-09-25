import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { AgentTeamService } from "../../teams/team-service.js"

export function registerAgentTeamTools(server: McpServer, teams: AgentTeamService): void {
  server.registerTool(
    "agent_team_list",
    {
      description: "List configured multi-model agent teams.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({ structuredContent: { teams: await teams.list() }, content: [] })
  )

  server.registerTool(
    "agent_team_manage",
    {
      description:
        "Create, update, or remove an agent team made from configured subagent profiles.",
      inputSchema: z.discriminatedUnion("action", [
        z.object({
          action: z.literal("upsert"),
          id: z.string().min(1),
          name: z.string().min(1),
          description: z.string().min(1).optional(),
          members: z
            .array(
              z.object({
                profile: z.string().min(1),
                role: z.string().min(1),
                instructions: z.string().min(1).optional(),
              })
            )
            .min(1)
            .max(12),
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
        if (input.action === "remove") {
          await teams.remove(input.id)
          return { structuredContent: { removed: input.id }, content: [] }
        }
        return { structuredContent: { team: await teams.upsert(input) }, content: [] }
      } catch (error) {
        throw toToolError(error, "AGENT_TEAM_MANAGE_FAILED")
      }
    }
  )

  server.registerTool(
    "agent_team_run",
    {
      description:
        "Run one task across all members of an agent team in parallel and return their separate results for ChatGPT to integrate.",
      inputSchema: z.object({ team: z.string().min(1), task: z.string().min(1) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ team, task }, context) => {
      try {
        const result = await teams.run(team, task, context.mcpReq.signal)
        return { structuredContent: result, content: [] }
      } catch (error) {
        throw toToolError(error, "AGENT_TEAM_RUN_FAILED")
      }
    }
  )
}
