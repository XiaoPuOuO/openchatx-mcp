import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { ProviderHub } from "../../providers/provider-hub.js"

export function registerProviderTools(server: McpServer, hub: ProviderHub): void {
  server.registerTool(
    "provider_manage",
    {
      description: "List presets, install a preset, or probe a configured provider.",
      inputSchema: z.object({
        action: z.enum(["presets", "install", "probe"]),
        preset: z.string().min(1).optional(),
        id: z.string().min(1).optional(),
        api_key: z.string().min(1).optional(),
        base_url: z.url().optional(),
        provider: z.string().min(1).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ action, preset, id, api_key, base_url, provider }) => {
      try {
        switch (action) {
          case "presets":
            return { structuredContent: { providers: hub.presets() }, content: [] }
          case "install": {
            const presetId = required(preset, "preset", action)
            const config = hub.installPreset(presetId, id, api_key, base_url)
            return {
              structuredContent: {
                provider: id ?? presetId,
                configured: true,
                model_profiles: Object.keys(config.models).length,
              },
              content: [],
            }
          }
          case "probe":
            return {
              structuredContent: await hub.probe(required(provider, "provider", action)),
              content: [],
            }
        }
      } catch (error) {
        throw toToolError(error, "PROVIDER_MANAGE_FAILED")
      }
    }
  )
}

function required<T>(value: T | undefined, field: string, action: string): T {
  if (value === undefined) throw new Error(`${field} is required for action=${action}.`)
  return value
}
