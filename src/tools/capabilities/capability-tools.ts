import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import type { CapabilityRegistry } from "../../capabilities/catalog.js"
import type { CapabilityHealthService } from "../../capabilities/health.js"

export function registerCapabilityTools(
  server: McpServer,
  capabilities: CapabilityRegistry,
  health?: CapabilityHealthService
): void {
  server.registerTool(
    "capability_list",
    {
      description:
        "List/search OpenChatX capabilities, or inspect platform health with action=health.",
      inputSchema: z.object({
        action: z.enum(["list", "health"]).default("list"),
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
    async ({ action, query, limit }) => {
      if (action === "health") {
        if (!health) throw new Error("Capability health service is unavailable.")
        return { structuredContent: await health.snapshot(), content: [] }
      }
      return {
        structuredContent: {
          capabilities: query
            ? capabilities.search(query, limit)
            : capabilities.list().slice(0, limit),
        },
        content: [],
      }
    }
  )
}
