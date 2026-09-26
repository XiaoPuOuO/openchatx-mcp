import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import {
  grantAgentProjectExternalAccessOnce,
  setAgentProjectExternalAccessAll,
} from "../../agent/context.js"
import { toToolError } from "../../mcp/tool-error.js"
import type { ProjectRegistry } from "../../projects/project-registry.js"
import type { ProjectScope } from "../../projects/project-scope.js"

interface ProjectUpsertInput {
  id: string
  name: string
  path: string
  additional_paths?: string[]
  description?: string
  read?: boolean
  write?: boolean
  shell?: boolean
}

export function registerProjectTools(
  server: McpServer,
  projects: ProjectRegistry,
  scope?: ProjectScope
): void {
  server.registerTool(
    "project_manage",
    {
      description:
        "List, register, remove, activate, resolve, or grant session access for Projects.",
      inputSchema: z.object({
        action: z.enum([
          "list",
          "upsert",
          "remove",
          "use",
          "resolve",
          "grant_once",
          "grant_all_session",
          "revoke_all_session",
        ]),
        id: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        path: z.string().min(1).optional(),
        additional_paths: z.array(z.string().min(1)).optional(),
        description: z.string().min(1).optional(),
        read: z.boolean().optional(),
        write: z.boolean().optional(),
        shell: z.boolean().optional(),
        project_id: z.string().min(1).nullable().optional(),
        permission: z.enum(["read", "write", "shell"]).default("read"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        switch (input.action) {
          case "list":
            return {
              structuredContent: {
                projects: await projects.list(),
                active_project: await scope?.current(),
              },
              content: [],
            }
          case "upsert": {
            const project = await upsertProject(projects, scope, {
              id: required(input.id, "id", input.action),
              name: required(input.name, "name", input.action),
              path: required(input.path, "path", input.action),
              additional_paths: input.additional_paths,
              description: input.description,
              read: input.read,
              write: input.write,
              shell: input.shell,
            })
            return { structuredContent: { project }, content: [] }
          }
          case "remove": {
            const id = required(input.id, "id", input.action)
            const active = await scope?.current()
            if (active?.id === id) await scope?.use(undefined)
            await projects.remove(id)
            return { structuredContent: { removed: id }, content: [] }
          }
          case "grant_once": {
            const path = required(input.path, "path", input.action)
            grantAgentProjectExternalAccessOnce(path)
            return { structuredContent: { granted_once: path }, content: [] }
          }
          case "grant_all_session":
            setAgentProjectExternalAccessAll(true)
            return { structuredContent: { external_access_all: true }, content: [] }
          case "revoke_all_session":
            setAgentProjectExternalAccessAll(false)
            return { structuredContent: { external_access_all: false }, content: [] }
          case "use": {
            if (!scope) throw new Error("Project session scope is unavailable.")
            const project = await scope.use(input.project_id ?? undefined)
            return {
              structuredContent: {
                active_project: project ?? null,
                default_cwd: project?.path ?? null,
              },
              content: [],
            }
          }
          case "resolve":
            return {
              structuredContent: {
                project: await projects.resolve(
                  required(input.id, "id", input.action),
                  input.permission
                ),
              },
              content: [],
            }
        }
      } catch (error) {
        throw toToolError(error, "PROJECT_MANAGE_FAILED")
      }
    }
  )
}

function required<T>(value: T | undefined, field: string, action: string): T {
  if (value === undefined) throw new Error(`${field} is required for action=${action}.`)
  return value
}

async function upsertProject(
  projects: ProjectRegistry,
  scope: ProjectScope | undefined,
  input: ProjectUpsertInput
) {
  const active = await scope?.current()
  if (active && active.id !== input.id) {
    throw new Error(
      `Project ${JSON.stringify(active.id)} is active. Clear it with project_manage action=use and project_id=null before registering or editing a different Project.`
    )
  }
  if (active?.id === input.id && scope) {
    const nextRoots = [input.path, ...(input.additional_paths ?? active.additionalPaths)]
    for (const root of nextRoots) {
      if (root !== active.path && !active.additionalPaths.includes(root)) {
        await scope.resolvePath(root, "read")
      }
    }
  }
  return projects.upsert({
    id: input.id,
    name: input.name,
    path: input.path,
    additionalPaths: input.additional_paths,
    description: input.description,
    permissions: {
      ...(input.read === undefined ? {} : { read: input.read }),
      ...(input.write === undefined ? {} : { write: input.write }),
      ...(input.shell === undefined ? {} : { shell: input.shell }),
    },
  })
}
