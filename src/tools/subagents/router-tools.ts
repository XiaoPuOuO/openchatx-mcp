import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { SmartModelRouter } from "../../subagents/router.js"

const routeInput = z.object({
  task: z.string().min(1),
  preferred_tags: z.array(z.string().min(1)).optional(),
  local_only: z.boolean().default(false),
  max_cost_tier: z.enum(["low", "medium", "high"]).optional(),
  min_context_window: z.int().positive().optional(),
})

export function registerSmartRoutingTools(server: McpServer, router: SmartModelRouter): void {
  server.registerTool(
    "subagent_route",
    {
      description:
        "Choose the best configured subagent profile for a task using tags, locality, context, and cost policy.",
      inputSchema: routeInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const selection = router.select({
          task: input.task,
          preferredTags: input.preferred_tags,
          localOnly: input.local_only,
          maxCostTier: input.max_cost_tier,
          minContextWindow: input.min_context_window,
        })
        return { structuredContent: { selection }, content: [] }
      } catch (error) {
        throw toToolError(error, "SUBAGENT_ROUTE_FAILED")
      }
    }
  )

  server.registerTool(
    "subagent_route_run",
    {
      description:
        "Automatically choose a configured model profile for a task and delegate the task to it.",
      inputSchema: routeInput.extend({
        system: z.string().min(1).optional(),
        thinking: z.boolean().optional(),
        thinking_effort: z.string().min(1).optional(),
        max_output_tokens: z.int().positive().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      try {
        const routed = await router.run(
          {
            task: input.task,
            preferredTags: input.preferred_tags,
            localOnly: input.local_only,
            maxCostTier: input.max_cost_tier,
            minContextWindow: input.min_context_window,
            system: input.system,
            thinking: input.thinking,
            thinkingEffort: input.thinking_effort,
            maxOutputTokens: input.max_output_tokens,
          },
          context.mcpReq.signal
        )
        return {
          structuredContent: routed,
          content: [{ type: "text" as const, text: routed.result.content }],
        }
      } catch (error) {
        throw toToolError(error, "SUBAGENT_ROUTE_FAILED")
      }
    }
  )
}
