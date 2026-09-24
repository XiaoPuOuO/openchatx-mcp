import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { ProjectRegistry } from "../../projects/project-registry.js"

export function registerProjectTools(server: McpServer, projects: ProjectRegistry): void {
  server.registerTool(
    "project_list",
    {
      description: "List registered project roots and their OpenChatX permission scopes.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({ structuredContent: { projects: await projects.list() }, content: [] })
  )

  server.registerTool(
    "project_manage",
    {
      description: "Register, update, or remove a project without moving its files.",
      inputSchema: z.discriminatedUnion("action", [
        z.object({
          action: z.literal("upsert"),
          id: z.string().min(1),
          name: z.string().min(1),
          path: z.string().min(1),
          description: z.string().min(1).optional(),
          read: z.boolean().optional(),
          write: z.boolean().optional(),
          shell: z.boolean().optional(),
        }),
        z.object({ action: z.literal("remove"), id: z.string().min(1) }),
      ]),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        if (input.action === "remove") {
          await projects.remove(input.id)
          return { structuredContent: { removed: input.id }, content: [] }
        }
        const project = await projects.upsert({
          id: input.id,
          name: input.name,
          path: input.path,
          description: input.description,
          permissions: {
            ...(input.read === undefined ? {} : { read: input.read }),
            ...(input.write === undefined ? {} : { write: input.write }),
            ...(input.shell === undefined ? {} : { shell: input.shell }),
          },
        })
        return { structuredContent: { project }, content: [] }
      } catch (error) {
        throw toToolError(error, "PROJECT_MANAGE_FAILED")
      }
    }
  )

  server.registerTool(
    "project_resolve",
    {
      description:
        "Resolve a registered project root only if the requested read, write, or shell permission is granted.",
      inputSchema: z.object({
        id: z.string().min(1),
        permission: z.enum(["read", "write", "shell"]).default("read"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, permission }) => {
      try {
        return {
          structuredContent: { project: await projects.resolve(id, permission) },
          content: [],
        }
      } catch (error) {
        throw toToolError(error, "PROJECT_PERMISSION_DENIED")
      }
    }
  )
}
