import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { SubagentRuntime } from "../../subagents/runtime.js"

export function registerSubagentTools(server: McpServer, runtime: SubagentRuntime): void {
  const profileGuide = runtime
    .profiles()
    .slice(0, 12)
    .map((profile) => `${profile.id}: ${profile.description.slice(0, 180)}`)
    .join("; ")
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
      description: `Delegate a task to one curated provider-backed model profile. Providers do not automatically expose their full model catalogs.${profileGuide ? ` Available profiles: ${profileGuide}` : " No model profiles are currently configured."}`,
      inputSchema: z.object({
        model: z.string().min(1).describe("Curated profile id from subagent_list."),
        task: z.string().min(1),
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
