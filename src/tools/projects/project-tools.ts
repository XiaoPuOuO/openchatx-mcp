import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { ProjectRegistry } from "../../projects/project-registry.js"
import type { ProjectScope } from "../../projects/project-scope.js"

export function registerProjectTools(
  server: McpServer,
  projects: ProjectRegistry,
  scope?: ProjectScope
): void {
  server.registerTool(
    "project_list",
    {
      description:
        "List registered project roots and permission scopes. The current ChatGPT session's active project is included when available.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      structuredContent: {
        projects: await projects.list(),
        active_project: await scope?.current(),
      },
      content: [],
    })
  )

  server.registerTool(
    "project_manage",
    {
      description:
        "Register, update, or remove a named existing project directory without moving its files.",
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
          const active = await scope?.current()
          if (active?.id === input.id) await scope?.use(undefined)
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
    "project_use",
    {
      description:
        "Set or clear the active Project for this ChatGPT session. Relative file/search/shell paths then resolve from that Project and its permissions are enforced.",
      inputSchema: z.object({
        project_id: z.string().min(1).nullable(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_id }) => {
      try {
        if (!scope) throw new Error("Project session scope is unavailable.")
        const project = await scope.use(project_id ?? undefined)
        return {
          structuredContent: {
            active_project: project ?? null,
            default_cwd: project?.path ?? null,
          },
          content: [],
        }
      } catch (error) {
        throw toToolError(error, "PROJECT_USE_FAILED")
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
