import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import type { JobManager } from "../../jobs/job-manager.js"
import { toToolError } from "../../mcp/tool-error.js"

export function registerJobTools(server: McpServer, jobs: JobManager): void {
  server.registerTool(
    "job_start",
    {
      description:
        "Start a durable background command that continues after the current ChatGPT tool call disconnects.",
      inputSchema: z.object({
        label: z.string().min(1).max(120),
        command: z.string().min(1),
        cwd: z.string().min(1).optional(),
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
        const job = await jobs.start(input.label, input.command, input.cwd)
        return { structuredContent: { job }, content: [] }
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
