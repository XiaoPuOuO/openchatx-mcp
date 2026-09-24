import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import type { CapabilityRegistry } from "../../capabilities/catalog.js"

export function registerCapabilityTools(server: McpServer, capabilities: CapabilityRegistry): void {
  server.registerTool(
    "capability_list",
    {
      description:
        "List or search OpenChatX capabilities across MCP servers, custom toolboxes, subagents, and providers.",
      inputSchema: z.object({
        query: z.string().min(1).optional(),
        limit: z.int().min(1).max(50).default(20),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => ({
      structuredContent: {
        capabilities: query
          ? capabilities.search(query, limit)
          : capabilities.list().slice(0, limit),
      },
      content: [],
    })
  )
}
