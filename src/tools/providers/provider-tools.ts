import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { ProviderHub } from "../../providers/provider-hub.js"

export function registerProviderTools(server: McpServer, hub: ProviderHub): void {
  server.registerTool(
    "provider_presets",
    {
      description:
        "List built-in Provider Hub presets for hosted and local OpenAI-compatible runtimes.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({ structuredContent: { providers: hub.presets() }, content: [] })
  )

  server.registerTool(
    "provider_install",
    {
      description:
        "Install a Provider Hub preset into the OpenChatX subagent provider configuration.",
      inputSchema: z.object({
        preset: z.string().min(1),
        id: z.string().min(1).optional(),
        api_key: z.string().min(1).optional(),
        base_url: z.url().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ preset, id, api_key, base_url }) => {
      try {
        const config = hub.installPreset(preset, id, api_key, base_url)
        return {
          structuredContent: {
            provider: id ?? preset,
            configured: true,
            model_profiles: Object.keys(config.models).length,
          },
          content: [],
        }
      } catch (error) {
        throw toToolError(error, "PROVIDER_INSTALL_FAILED")
      }
    }
  )

  server.registerTool(
    "provider_probe",
    {
      description: "Probe a configured provider's OpenAI-compatible /models endpoint.",
      inputSchema: z.object({ provider: z.string().min(1) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ provider }) => ({ structuredContent: await hub.probe(provider), content: [] })
  )
}
