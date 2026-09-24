import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import type { JobManager } from "../../jobs/job-manager.js"
import { toToolError } from "../../mcp/tool-error.js"
import type { ProjectRegistry } from "../../projects/project-registry.js"

export function registerJobTools(
  server: McpServer,
  jobs: JobManager,
  projects?: ProjectRegistry
): void {
  server.registerTool(
    "job_start",
    {
      description:
        "Start a durable background command that continues after the current ChatGPT tool call disconnects.",
      inputSchema: z.object({
        label: z.string().min(1).max(120),
        command: z.string().min(1),
        cwd: z.string().min(1).optional(),
        project_id: z.string().min(1).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        if (input.cwd && input.project_id)
          throw new Error("job_start accepts either cwd or project_id, not both.")
        const project = input.project_id
          ? await projects?.resolve(input.project_id, "shell")
          : undefined
        if (input.project_id && !project)
          throw new Error("Project registry is unavailable for project-scoped jobs.")
        const job = await jobs.start(input.label, input.command, project?.path ?? input.cwd)
        return {
          structuredContent: {
            job,
            ...(project ? { project: { id: project.id, name: project.name } } : {}),
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
      description: "List durable jobs and their persisted status.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({ structuredContent: { jobs: await jobs.list() }, content: [] })
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
