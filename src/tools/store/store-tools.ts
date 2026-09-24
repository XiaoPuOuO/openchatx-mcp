import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { CapabilityStoreService } from "../../store/store-service.js"

export function registerStoreTools(server: McpServer, store: CapabilityStoreService): void {
  server.registerTool(
    "store_list",
    {
      description: "Browse or search installable OpenChatX capabilities.",
      inputSchema: z.object({ query: z.string().min(1).optional() }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query }) => ({
      structuredContent: { capabilities: query ? await store.search(query) : await store.list() },
      content: [],
    })
  )

  server.registerTool(
    "store_install",
    {
      description: "Install one Capability Store entry into OpenChatX.",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      try {
        return { structuredContent: { capability: await store.install(id) }, content: [] }
      } catch (error) {
        throw toToolError(error, "STORE_INSTALL_FAILED")
      }
    }
  )

  server.registerTool(
    "store_uninstall",
    {
      description: "Uninstall a capability previously installed by the OpenChatX Capability Store.",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      try {
        await store.uninstall(id)
        return { structuredContent: { removed: id }, content: [] }
      } catch (error) {
        throw toToolError(error, "STORE_UNINSTALL_FAILED")
      }
    }
  )
}
