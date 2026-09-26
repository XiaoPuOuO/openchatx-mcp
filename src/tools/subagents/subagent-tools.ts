import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { SmartModelRouter } from "../../subagents/router.js"
import type { SubagentRuntime } from "../../subagents/runtime.js"

export function registerSubagentTools(
  server: McpServer,
  runtime: SubagentRuntime,
  router?: SmartModelRouter
): void {
  server.registerTool(
    "subagent_list",
    {
      description:
        "List the curated subagent model profiles configured by the user, including what each model is best used for.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({ structuredContent: { models: runtime.profiles() }, content: [] })
  )

  server.registerTool(
    "subagent_run",
    {
      description:
        "Delegate to a curated model profile, auto-route a task, or return the routed profile without running it.",
      inputSchema: z.object({
        action: z.enum(["run", "route"]).default("run"),
        model: z.string().min(1).optional(),
        task: z.string().min(1),
        preferred_tags: z.array(z.string().min(1)).optional(),
        local_only: z.boolean().default(false),
        max_cost_tier: z.enum(["low", "medium", "high"]).optional(),
        min_context_window: z.int().positive().optional(),
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
        if (input.action === "route") {
          if (!router) throw new Error("Smart model routing is unavailable.")
          return {
            structuredContent: {
              selection: router.select({
                task: input.task,
                preferredTags: input.preferred_tags,
                localOnly: input.local_only,
                maxCostTier: input.max_cost_tier,
                minContextWindow: input.min_context_window,
              }),
            },
            content: [],
          }
        }

        if (!input.model) {
          if (!router) throw new Error("model is required when smart routing is unavailable.")
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
        }

        const result = await runtime.run(
          {
            profileId: input.model,
            task: input.task,
            system: input.system,
            thinking: input.thinking,
            thinkingEffort: input.thinking_effort,
            maxOutputTokens: input.max_output_tokens,
          },
          context.mcpReq.signal
        )
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: result.content }],
        }
      } catch (error) {
        throw toToolError(error, "SUBAGENT_FAILED")
      }
    }
  )
}
