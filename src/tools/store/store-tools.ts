import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { CapabilityStoreService } from "../../store/store-service.js"
import type { ToolboxRegistry } from "../../toolbox/registry.js"

export function registerStoreTools(
  server: McpServer,
  store: CapabilityStoreService,
  toolboxes?: ToolboxRegistry
): void {
  server.registerTool(
    "store_list",
    {
      description:
        "Browse built-in and unreviewed GitHub community OpenChatX capabilities. Community entries come from public repositories with topic openchatx-capability.",
      inputSchema: z.object({
        query: z.string().min(1).optional(),
        source: z.enum(["all", "builtin", "community"]).default("all"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, source }) => ({
      structuredContent: await store.browse(query ?? "", source),
      content: [],
    })
  )

  server.registerTool(
    "store_recommended_mcps",
    {
      description:
        "List MCP servers officially recommended by OpenChatX. Recommendations are curated links, not security endorsements of third-party projects.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      structuredContent: { mcps: await store.recommendedMcps() },
      content: [],
    })
  )

  server.registerTool(
    "store_get",
    {
      description:
        "Resolve one Store capability. GitHub community entries are pinned to an exact immutable commit revision.",
      inputSchema: z.object({
        id: z.string().min(1),
        revision: z.string().min(1).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, revision }) => {
      try {
        return { structuredContent: { capability: await store.get(id, revision) }, content: [] }
      } catch (error) {
        throw toToolError(error, "STORE_GET_FAILED")
      }
    }
  )

  server.registerTool(
    "store_source_tree",
    {
      description:
        "List the exact source tree for a Store capability before installation. GitHub entries return the pinned commit revision.",
      inputSchema: z.object({
        id: z.string().min(1),
        revision: z.string().min(1).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, revision }) => {
      try {
        return { structuredContent: await store.sourceTree(id, revision), content: [] }
      } catch (error) {
        throw toToolError(error, "STORE_SOURCE_FAILED")
      }
    }
  )

  server.registerTool(
    "store_source_read",
    {
      description:
        "Read one source file from a Store capability at an exact revision so the agent can inspect it before installation.",
      inputSchema: z.object({
        id: z.string().min(1),
        path: z.string().min(1),
        revision: z.string().min(1).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, path, revision }) => {
      try {
        const result = await store.sourceRead(id, path, revision)
        return {
          structuredContent: {
            capability: result.capability,
            ...(result.revision ? { revision: result.revision } : {}),
            path: result.path,
          },
          content: [{ type: "text" as const, text: result.content }],
        }
      } catch (error) {
        throw toToolError(error, "STORE_SOURCE_FAILED")
      }
    }
  )

  server.registerTool(
    "store_review",
    {
      description:
        "Run static pre-install analysis over capability source code. This is evidence for review, not a safety verdict; inspect cited files with store_source_read.",
      inputSchema: z.object({
        id: z.string().min(1),
        revision: z.string().min(1).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, revision }) => {
      try {
        return { structuredContent: await store.review(id, revision), content: [] }
      } catch (error) {
        throw toToolError(error, "STORE_REVIEW_FAILED")
      }
    }
  )

  server.registerTool(
    "store_install",
    {
      description:
        "Install one Store capability. For GitHub community entries, pass the exact revision that was inspected to install that reviewed commit rather than a moving branch.",
      inputSchema: z.object({
        id: z.string().min(1),
        revision: z.string().min(1).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, revision }) => {
      try {
        return {
          structuredContent: { capability: await store.install(id, revision) },
          content: [],
        }
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

  registerPortableSkillStoreTools(server, toolboxes)

  server.registerTool(
    "store_publish_check",
    {
      description:
        "Validate a local Capability directory for serverless community publishing through a public GitHub repository with topic openchatx-capability.",
      inputSchema: z.object({ directory: z.string().min(1) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ directory }) => {
      try {
        return { structuredContent: await store.preparePublish(directory), content: [] }
      } catch (error) {
        throw toToolError(error, "STORE_PUBLISH_CHECK_FAILED")
      }
    }
  )
}

function registerPortableSkillStoreTools(server: McpServer, toolboxes?: ToolboxRegistry): void {
  server.registerTool(
    "store_skill_import",
    {
      description:
        "Import a portable Agent Skills folder containing SKILL.md and optional scripts/references/assets into a toolbox.",
      inputSchema: z.object({
        toolbox: z.string().min(1).describe("Toolbox id that will own the imported skill."),
        directory: z.string().min(1).describe("Local skill directory containing SKILL.md."),
        replace: z.boolean().default(false),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ toolbox, directory, replace }) => {
      try {
        if (!toolboxes) throw new Error("Toolbox runtime is unavailable.")
        const skill = await toolboxes.importSkill(toolbox, directory, { replace })
        return {
          structuredContent: {
            skill: {
              name: `${toolbox}.${skill.name}`,
              ...(skill.description ? { description: skill.description } : {}),
            },
            path: skill.path,
          },
          content: [],
        }
      } catch (error) {
        throw toToolError(error, "STORE_SKILL_IMPORT_FAILED")
      }
    }
  )

  server.registerTool(
    "store_skill_export",
    {
      description:
        "Export one toolbox skill as a portable Agent Skills folder for Claude, Codex, or another SKILL.md consumer.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe("Qualified toolbox skill name, for example legal.legal-counsel."),
        directory: z.string().min(1).describe("Destination parent directory."),
        replace: z.boolean().default(false),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, directory, replace }) => {
      try {
        if (!toolboxes) throw new Error("Toolbox runtime is unavailable.")
        const path = await toolboxes.exportSkill(name, directory, { replace })
        return {
          structuredContent: { name, path },
          content: [],
        }
      } catch (error) {
        throw toToolError(error, "STORE_SKILL_EXPORT_FAILED")
      }
    }
  )
}
