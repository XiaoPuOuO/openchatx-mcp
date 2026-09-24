import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { BashProcessManager } from "./bash-process-manager.js"

export function registerBashProcessTool(server: McpServer, manager: BashProcessManager): void {
  server.registerTool(
    "bash_process",
    {
      description:
        "Inspect and control long-running processes started by bash with keep=true. Use list to see which kept servers/watchers exist and whether they are still running, read to inspect captured stdout/stderr for debugging, and stop to terminate one managed process.",
      inputSchema: z.object({
        action: z.enum(["list", "read", "stop"]),
        process_id: z
          .string()
          .optional()
          .describe(
            "Required for read or stop. Use an id returned by bash keep=true or bash_process list."
          ),
        max_bytes: z
          .int()
          .min(1)
          .max(64 * 1024)
          .default(16 * 1024)
          .describe("For read, return at most this many trailing log bytes."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ action, process_id, max_bytes }) => {
      try {
        if (action === "list") {
          const processes = await manager.list()
          return {
            structuredContent: { processes },
            content: [
              {
                type: "text" as const,
                text:
                  processes.length === 0
                    ? "No managed bash processes."
                    : processes
                        .map(
                          (item) =>
                            `${item.id} pid=${item.pid} running=${item.running} cwd=${item.cwd}\n  ${item.command}`
                        )
                        .join("\n"),
              },
            ],
          }
        }
        if (!process_id) throw new Error(`process_id is required for action=${action}.`)
        if (action === "read") {
          const result = await manager.read(process_id, max_bytes)
          return {
            structuredContent: {
              process: result.process,
              output: result.output,
              truncated: result.truncated,
            },
            content: [
              {
                type: "text" as const,
                text: [
                  `${result.process.id} pid=${result.process.pid} running=${result.process.running}`,
                  result.output || "(no output yet)",
                  result.truncated ? "(showing trailing log bytes)" : "",
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            ],
          }
        }
        const managed = await manager.stop(process_id)
        return {
          structuredContent: { process: managed },
          content: [
            {
              type: "text" as const,
              text: `${managed.id} pid=${managed.pid} running=${managed.running}`,
            },
          ],
        }
      } catch (error) {
        throw toToolError(error, "BASH_PROCESS_FAILED")
      }
    }
  )
}
