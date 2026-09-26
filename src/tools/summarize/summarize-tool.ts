import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { SummaryRegistry } from "../../summaries/summary-registry.js"

export function registerSummarizeTool(server: McpServer, summaries: SummaryRegistry): void {
  server.registerTool(
    "summarize",
    {
      description:
        "Create or consume a temporary cross-session handoff. To save, pass summary plus recent_context and receive a UUID. Write summary in this order: ## Objective, ## Important Details, ## Work State with ### Completed / ### Active / ### Blocked, ## Next Move, ## Relevant Files. recent_context should preserve roughly the most recent 8k tokens of useful conversation verbatim when practical, with role labels (for example ### User / ### Assistant); older material belongs in summary. Keep exact commands, errors, URLs, identifiers, decisions, constraints, and tool outcomes when needed. In a later ChatGPT conversation, pass uuid to retrieve summary + recent context; retrieval consumes and deletes it.",
      inputSchema: z.union([
        z.object({
          summary: z.string().min(1).describe("Compacted older context for the handoff."),
          recent_context: z
            .string()
            .min(1)
            .describe("Recent conversation turns kept separately from the compacted summary."),
        }),
        z.object({
          uuid: z.uuid().describe("Summary UUID to retrieve and consume."),
        }),
      ]),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        if ("summary" in input) {
          const created = await summaries.create(input.summary, input.recent_context)
          return {
            content: [{ type: "text" as const, text: created.uuid }],
          }
        }

        const consumed = await summaries.consume(input.uuid)
        return {
          content: [
            {
              type: "text" as const,
              text: renderHandoff(consumed.content, consumed.recentContext),
            },
          ],
        }
      } catch (error) {
        throw toToolError(error, "SUMMARIZE_FAILED")
      }
    }
  )
}

function renderHandoff(summary: string, recentContext: string): string {
  if (!recentContext) return summary
  return `${summary}\n\n## Recent Context\n\n${recentContext}`
}
