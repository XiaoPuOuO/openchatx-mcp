import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { SummaryRegistry } from "../../summaries/summary-registry.js"

export function registerSummarizeTool(server: McpServer, summaries: SummaryRegistry): void {
  server.registerTool(
    "summarize",
    {
      description:
        "Create or consume a temporary cross-session task summary. To save, pass summary and receive its UUID. Write the summary in this order: ## Objective, ## Important Details, ## Work State with ### Completed / ### Active / ### Blocked, ## Next Move, ## Relevant Files. Preserve exact commands, errors, URLs, identifiers, decisions, and constraints needed to continue. In a later ChatGPT conversation, pass uuid to retrieve the full summary; retrieval consumes and deletes it.",
      inputSchema: z.union([
        z.object({
          summary: z.string().min(1).describe("Continuation summary to store temporarily."),
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
          const created = await summaries.create(input.summary)
          return {
            content: [{ type: "text" as const, text: created.uuid }],
          }
        }

        const consumed = await summaries.consume(input.uuid)
        return {
          content: [{ type: "text" as const, text: consumed.content }],
        }
      } catch (error) {
        throw toToolError(error, "SUMMARIZE_FAILED")
      }
    }
  )
}
