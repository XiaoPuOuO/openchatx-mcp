import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import type { ToolboxRegistry } from "../../toolbox/registry.js"

const kindSchema = z.enum(["toolbox", "tool", "skill"])
const actionSchema = z.enum(["create", "delete", "enable", "disable", "reload"])

export function registerToolboxManagementTools(server: McpServer, registry: ToolboxRegistry): void {
  server.registerTool(
    "toolbox_list",
    {
      description:
        "List installed toolboxes/plugins with their tools and skills, including enabled state and source paths.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      structuredContent: { toolboxes: registry.snapshots() },
      content: [],
    })
  )

  server.registerTool(
    "toolbox_manage",
    {
      description:
        "Create, delete, enable, disable, or reload toolboxes/plugins, TypeScript tools, and skills. For authoring a new plugin, load the toolbox-manager.plugin-authoring skill first.",
      inputSchema: z.object({
        action: actionSchema,
        kind: kindSchema.default("toolbox"),
        toolbox_id: z
          .string()
          .min(1)
          .optional()
          .describe("Toolbox/plugin id. Required except for reload."),
        name: z
          .string()
          .min(1)
          .optional()
          .describe("Tool or skill name. For toolbox creation, optional display name."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ action, kind, toolbox_id, name }) => {
      try {
        const path = await applyManagementAction(registry, { action, kind, toolbox_id, name })
        return {
          structuredContent: {
            ok: true,
            ...(path ? { path } : {}),
            toolboxes: registry.snapshots(),
          },
          content: [],
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `TOOLBOX_MANAGE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        }
      }
    }
  )
}

interface ManagementAction {
  action: z.infer<typeof actionSchema>
  kind: z.infer<typeof kindSchema>
  toolbox_id?: string
  name?: string
}

async function applyManagementAction(
  registry: ToolboxRegistry,
  input: ManagementAction
): Promise<string | undefined> {
  if (input.action === "reload") {
    await registry.reload()
    return undefined
  }
  const toolboxId = required(input.toolbox_id, "toolbox_id")

  if (input.kind === "toolbox") {
    if (input.action === "create") {
      await registry.createToolbox(toolboxId, input.name ?? toolboxId)
      return registry.itemPath(toolboxId)
    }
    if (input.action === "delete") {
      await registry.deleteToolbox(toolboxId)
      return undefined
    }
    await registry.setToolboxEnabled(toolboxId, input.action === "enable")
    return undefined
  }

  const name = required(input.name, "name")
  if (input.kind === "tool") {
    if (input.action === "create") return registry.createTool(toolboxId, name)
    if (input.action === "delete") {
      await registry.deleteTool(toolboxId, name)
      return undefined
    }
    await registry.setToolEnabled(toolboxId, name, input.action === "enable")
    return undefined
  }

  if (input.action === "create") return registry.createSkill(toolboxId, name)
  if (input.action === "delete") {
    await registry.deleteSkill(toolboxId, name)
    return undefined
  }
  await registry.setSkillEnabled(toolboxId, name, input.action === "enable")
  return undefined
}

function required(value: string | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required for this action.`)
  return value
}
