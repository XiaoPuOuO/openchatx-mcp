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
    "job_start",
    {
      description:
        "Start a durable background command that continues after the current ChatGPT tool call disconnects. Defaults to the active Project root when one is selected.",
      inputSchema: z.object({
        label: z.string().min(1).max(120),
        command: z.string().min(1),
        cwd: z.string().min(1).optional(),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe("Optional Project id. Shell permission is enforced."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ label, command, cwd, project_id }) => {
      try {
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
      } catch (error) {
        throw toToolError(error, "JOB_START_FAILED")
      }
    }
  )

  server.registerTool(
    "job_list",
    {
      description: "List durable jobs and their persisted status, including Project association.",
      inputSchema: z.object({
        project_id: z.string().min(1).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_id }) => {
      const jobsList = await jobs.list()
      return {
        structuredContent: {
          jobs: project_id ? jobsList.filter((job) => job.projectId === project_id) : jobsList,
        },
        content: [],
      }
    }
  )

  server.registerTool(
    "job_read",
    {
      description: "Read one durable job and the tail of its persisted log.",
      inputSchema: z.object({
        id: z.string().min(1),
        max_bytes: z.int().min(1).max(131072).default(16384),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, max_bytes }) => {
      try {
        const result = await jobs.readLog(id, max_bytes)
        return {
          structuredContent: result,
          content: result.output ? [{ type: "text" as const, text: result.output }] : [],
        }
      } catch (error) {
        throw toToolError(error, "JOB_READ_FAILED")
      }
    }
  )

  server.registerTool(
    "job_cancel",
    {
      description: "Cancel a running durable job.",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      try {
        return { structuredContent: { job: await jobs.cancel(id) }, content: [] }
      } catch (error) {
        throw toToolError(error, "JOB_CANCEL_FAILED")
      }
    }
  )
}
