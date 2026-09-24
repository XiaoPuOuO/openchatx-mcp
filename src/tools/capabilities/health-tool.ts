import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import type { CapabilityHealthService } from "../../capabilities/health.js"

export function registerCapabilityHealthTool(
  server: McpServer,
  health: CapabilityHealthService
): void {
  server.registerTool(
    "capability_health",
    {
      description:
        "Inspect OpenChatX runtime, tunnel, MCP, toolbox, and provider health before relying on a capability.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({ structuredContent: await health.snapshot(), content: [] })
  )
}
