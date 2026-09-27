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
      description: "Start, list, read, wait for, or cancel durable background jobs.",
      inputSchema: z.object({
        action: z.enum(["start", "list", "read", "wait", "cancel"]),
        label: z.string().min(1).max(120).optional(),
        command: z.string().min(1).optional(),
        cwd: z.string().min(1).optional(),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe("Optional Project id. Shell permission is enforced."),
        id: z.string().min(1).optional(),
        cursor: z.int().min(0).default(0),
        wait_ms: z
          .int()
          .min(0)
          .max(5 * 60_000)
          .default(30_000)
          .describe(
            "How long to wait before returning current status and incremental logs. Defaults to 30 seconds so the agent can emit progress heartbeats."
          ),
        kill_after_ms: z
          .int()
          .min(1)
          .max(60 * 60_000)
          .optional(),
        max_bytes: z.int().min(1).max(131072).default(16384),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (
      { action, label, command, cwd, project_id, id, cursor, wait_ms, kill_after_ms, max_bytes },
      context
    ) => {
      try {
        return await executeJobAction(
          jobs,
          projectScope,
          {
            action,
            label,
            command,
            cwd,
            project_id,
            id,
            cursor,
            wait_ms,
            kill_after_ms,
            max_bytes,
          },
          context.mcpReq.signal
        )
      } catch (error) {
        throw toToolError(error, "JOB_MANAGE_FAILED")
      }
    }
  )
}

async function executeJobAction(
  jobs: JobManager,
  projectScope: ProjectScope | undefined,
  input: {
    action: "start" | "list" | "read" | "wait" | "cancel"
    label?: string
    command?: string
    cwd?: string
    project_id?: string
    id?: string
    cursor: number
    wait_ms: number
    kill_after_ms?: number
    max_bytes: number
  },
  signal?: AbortSignal
) {
  switch (input.action) {
    case "start":
      return startJob(jobs, projectScope, input)
    case "list":
      return listJobs(jobs, input.project_id)
    case "read":
      return readJob(jobs, input.id, input.max_bytes)
    case "wait":
      return waitJob(jobs, input.id, input.cursor, input.wait_ms, input.max_bytes, signal)
    case "cancel":
      return cancelJob(jobs, input.id)
  }
}

async function startJob(
  jobs: JobManager,
  projectScope: ProjectScope | undefined,
  input: {
    label?: string
    command?: string
    cwd?: string
    project_id?: string
    kill_after_ms?: number
  }
) {
  if (!input.label) throw new Error("label is required for action=start.")
  if (!input.command) throw new Error("command is required for action=start.")
  const resolved = projectScope
    ? await projectScope.resolvePath(input.cwd, "shell", input.project_id)
    : { path: input.cwd, project: undefined }
  const job = await jobs.start(
    input.label,
    input.command,
    resolved.path,
    resolved.project?.id,
    input.kill_after_ms
  )
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

async function waitJob(
  jobs: JobManager,
  id: string | undefined,
  cursor: number,
  waitMs: number,
  maxBytes: number,
  signal?: AbortSignal
) {
  if (!id) throw new Error("id is required for action=wait.")
  const result = await jobs.wait(id, waitMs, cursor, maxBytes, signal)
  return {
    structuredContent: {
      ...result,
      next_cursor: result.nextCursor,
    },
    content: result.output ? [{ type: "text" as const, text: result.output }] : [],
  }
}

async function listJobs(jobs: JobManager, projectId?: string) {
  const jobsList = await jobs.list()
  return {
    structuredContent: {
      jobs: projectId ? jobsList.filter((job) => job.projectId === projectId) : jobsList,
    },
    content: [],
  }
}

async function readJob(jobs: JobManager, id: string | undefined, maxBytes: number) {
  if (!id) throw new Error("id is required for action=read.")
  const result = await jobs.readLog(id, maxBytes)
  return {
    structuredContent: result,
    content: result.output ? [{ type: "text" as const, text: result.output }] : [],
  }
}

async function cancelJob(jobs: JobManager, id?: string) {
  if (!id) throw new Error("id is required for action=cancel.")
  return { structuredContent: { job: await jobs.cancel(id) }, content: [] }
}
