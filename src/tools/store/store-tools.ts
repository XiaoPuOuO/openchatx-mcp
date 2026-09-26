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
    "store_browse",
    {
      description:
        "Browse, inspect, and review Capability Store entries. Use action=list, recommended_mcps, get, source_tree, source_read, or review.",
      inputSchema: z.discriminatedUnion("action", [
        z.object({
          action: z.literal("list"),
          query: z.string().min(1).optional(),
          source: z.enum(["all", "builtin", "community"]).default("all"),
        }),
        z.object({ action: z.literal("recommended_mcps") }),
        z.object({
          action: z.literal("get"),
          id: z.string().min(1),
          revision: z.string().min(1).optional(),
        }),
        z.object({
          action: z.literal("source_tree"),
          id: z.string().min(1),
          revision: z.string().min(1).optional(),
        }),
        z.object({
          action: z.literal("source_read"),
          id: z.string().min(1),
          path: z.string().min(1),
          revision: z.string().min(1).optional(),
        }),
        z.object({
          action: z.literal("review"),
          id: z.string().min(1),
          revision: z.string().min(1).optional(),
        }),
      ]),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        switch (input.action) {
          case "list":
            return {
              structuredContent: await store.browse(input.query ?? "", input.source),
              content: [],
            }
          case "recommended_mcps":
            return {
              structuredContent: { mcps: await store.recommendedMcps() },
              content: [],
            }
          case "get":
            return {
              structuredContent: { capability: await store.get(input.id, input.revision) },
              content: [],
            }
          case "source_tree":
            return {
              structuredContent: await store.sourceTree(input.id, input.revision),
              content: [],
            }
          case "source_read": {
            const result = await store.sourceRead(input.id, input.path, input.revision)
            return {
              structuredContent: {
                capability: result.capability,
                ...(result.revision ? { revision: result.revision } : {}),
                path: result.path,
              },
              content: [{ type: "text" as const, text: result.content }],
            }
          }
          case "review":
            return {
              structuredContent: await store.review(input.id, input.revision),
              content: [],
            }
        }
      } catch (error) {
        throw toToolError(error, "STORE_BROWSE_FAILED")
      }
    }
  )

  server.registerTool(
    "store_manage",
    {
      description:
        "Install or uninstall Capability Store entries, or validate a local capability before publishing. Use action=install, uninstall, or publish_check.",
      inputSchema: z.discriminatedUnion("action", [
        z.object({
          action: z.literal("install"),
          id: z.string().min(1),
          revision: z.string().min(1).optional(),
        }),
        z.object({
          action: z.literal("uninstall"),
          id: z.string().min(1),
        }),
        z.object({
          action: z.literal("publish_check"),
          directory: z.string().min(1),
        }),
      ]),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        switch (input.action) {
          case "install":
            return {
              structuredContent: { capability: await store.install(input.id, input.revision) },
              content: [],
            }
          case "uninstall":
            await store.uninstall(input.id)
            return { structuredContent: { removed: input.id }, content: [] }
          case "publish_check":
            return {
              structuredContent: await store.preparePublish(input.directory),
              content: [],
            }
        }
      } catch (error) {
        throw toToolError(error, "STORE_MANAGE_FAILED")
      }
    }
  )

  server.registerTool(
    "store_skill",
    {
      description: "Import or export portable SKILL.md folders. Use action=import or export.",
      inputSchema: z.discriminatedUnion("action", [
        z.object({
          action: z.literal("import"),
          toolbox: z.string().min(1).describe("Toolbox id that will own the imported skill."),
          directory: z.string().min(1).describe("Local skill directory containing SKILL.md."),
          replace: z.boolean().default(false),
        }),
        z.object({
          action: z.literal("export"),
          name: z
            .string()
            .min(1)
            .describe("Qualified toolbox skill name, for example legal.legal-counsel."),
          directory: z.string().min(1).describe("Destination parent directory."),
          replace: z.boolean().default(false),
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
        if (!toolboxes) throw new Error("Toolbox runtime is unavailable.")
        if (input.action === "import") {
          const skill = await toolboxes.importSkill(input.toolbox, input.directory, {
            replace: input.replace,
          })
          return {
            structuredContent: {
              skill: {
                name: `${input.toolbox}.${skill.name}`,
                ...(skill.description ? { description: skill.description } : {}),
              },
              path: skill.path,
            },
            content: [],
          }
        }

        const path = await toolboxes.exportSkill(input.name, input.directory, {
          replace: input.replace,
        })
        return {
          structuredContent: { name: input.name, path },
          content: [],
        }
      } catch (error) {
        throw toToolError(error, "STORE_SKILL_FAILED")
      }
    }
  )
}
