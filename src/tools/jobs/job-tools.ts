import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import type { JobManager } from "../../jobs/job-manager.js"
import { toToolError } from "../../mcp/tool-error.js"
import type { ProjectScope } from "../../projects/project-scope.js"

export function registerJobTools(
  server: McpServer,
  jobs: JobManager,
  projectScope?: ProjectScope
): void {
  server.registerTool(
    "job_manage",
    {
      description:
        "Start, list, read, or cancel durable background jobs. Use action=start, list, read, or cancel.",
      inputSchema: z.object({
        action: z.enum(["start", "list", "read", "cancel"]),
        label: z.string().min(1).max(120).optional(),
        command: z.string().min(1).optional(),
        cwd: z.string().min(1).optional(),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe("Optional Project id. Shell permission is enforced."),
        id: z.string().min(1).optional(),
        max_bytes: z.int().min(1).max(131072).default(16384),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ action, label, command, cwd, project_id, id, max_bytes }) => {
      try {
        switch (action) {
          case "start": {
            if (!label) throw new Error("label is required for action=start.")
            if (!command) throw new Error("command is required for action=start.")
            const resolved = projectScope
              ? await projectScope.resolvePath(cwd, "shell", project_id)
              : { path: cwd, project: undefined }
            const job = await jobs.start(label, command, resolved.path, resolved.project?.id)
            return {
              structuredContent: {
                job,
                ...(resolved.project
                  ? { project: { id: resolved.project.id, name: resolved.project.name } }
                  : {}),
              },
              content: [],
            }
          }
          case "list": {
            const jobsList = await jobs.list()
            return {
              structuredContent: {
                jobs: project_id ? jobsList.filter((job) => job.projectId === project_id) : jobsList,
              },
              content: [],
            }
          }
          case "read": {
            if (!id) throw new Error("id is required for action=read.")
            const result = await jobs.readLog(id, max_bytes)
            return {
              structuredContent: result,
              content: result.output ? [{ type: "text" as const, text: result.output }] : [],
            }
          }
          case "cancel":
            if (!id) throw new Error("id is required for action=cancel.")
            return { structuredContent: { job: await jobs.cancel(id) }, content: [] }
        }
      } catch (error) {
        throw toToolError(error, "JOB_MANAGE_FAILED")
      }
    }
  )
}
