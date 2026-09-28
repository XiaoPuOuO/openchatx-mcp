import { spawn } from "node:child_process"
import { isAbsolute, resolve } from "node:path"
import process from "node:process"
import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { childProcessEnvironment } from "../../child-environment.js"
import { signalProcessGroup } from "../../child-process-termination.js"
import { MCP_CONFIG } from "../../config.js"
import { shellCommandArgs } from "../../host-platform.js"
import type { JobManager } from "../../jobs/job-manager.js"
import { ToolError, toToolError } from "../../mcp/tool-error.js"
import type { ProjectScope } from "../../projects/project-scope.js"
import { tokenPrefix } from "../../tokenizer.js"
import { withApplyPatchToolHint } from "./apply-patch-guidance.js"
import type { BashProcessManager } from "./bash-process-manager.js"
import { prepareShellCommand } from "./rtk.js"

const MAX_CAPTURE_BYTES = 1024 * 1024

export function registerBashTool(
  server: McpServer,
  processManager?: BashProcessManager,
  projectScope?: ProjectScope,
  jobManager?: JobManager
): void {
  server.registerTool(
    "bash",
    {
      description:
        "Run a genuine non-interactive shell operation. timeout_ms is the foreground wait budget, not a kill deadline: if the command is still running when it expires, OpenChatX promotes it to a durable job and returns job_id plus current logs. Continue with job_manage action=wait or cancel. Set kill_after_ms only for a real hard runtime limit. keep=true is only for persistent servers/watchers/daemons and remains managed by bash_process.",
      inputSchema: z.object({
        command: z.string().min(1),
        workdir: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Working directory. Defaults to the active Project root, otherwise the user's home directory."
          ),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional Project id. Shell permission is enforced and relative workdir resolves from that Project."
          ),
        timeout_ms: z
          .int()
          .min(1)
          .max(60 * 60_000)
          .default(30_000)
          .describe(
            "Foreground wait budget before returning a still-running command as a durable job. Defaults to 30 seconds so the agent can emit a progress heartbeat. Does not kill the command. Ignored when keep=true."
          ),
        kill_after_ms: z
          .int()
          .min(1)
          .max(60 * 60_000)
          .optional()
          .describe("Optional hard runtime limit. The durable process is terminated after this."),
        keep: z
          .boolean()
          .default(false)
          .describe(
            "Keep a long-running command alive after this tool call returns. Use for servers, watchers, or other background processes. OpenChatX captures stdout/stderr so bash_process can read the logs later."
          ),
        max_output_tokens: z
          .int()
          .min(1)
          .max(MCP_CONFIG.shell.maxOutputTokens)
          .default(MCP_CONFIG.shell.defaultOutputTokens),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (
      { command, workdir, project_id, timeout_ms, kill_after_ms, keep, max_output_tokens },
      context
    ) => {
      try {
        return await executeBash({
          command,
          workdir,
          projectId: project_id,
          waitMs: timeout_ms,
          killAfterMs: kill_after_ms,
          keep,
          maxOutputTokens: max_output_tokens,
          signal: context.mcpReq.signal,
          processManager,
          projectScope,
          jobManager,
        })
      } catch (error) {
        throw toToolError(error, "BASH_FAILED")
      }
    }
  )
}

interface BashExecutionInput {
  command: string
  workdir?: string
  projectId?: string
  waitMs: number
  killAfterMs?: number
  keep: boolean
  maxOutputTokens: number
  signal: AbortSignal
  processManager?: BashProcessManager
  projectScope?: ProjectScope
  jobManager?: JobManager
}

async function executeBash(input: BashExecutionInput) {
  const scope = await resolveExecutionScope(input.workdir, input.projectScope, input.projectId)
  const cwd = scope.path
  const environment = childProcessEnvironment()
  const executableCommand = prepareShellCommand(input.command, cwd, environment)
  if (input.keep) return runKeptCommand(executableCommand, cwd, input.processManager)
  if (input.jobManager) return runDurableCommand(executableCommand, cwd, scope.projectId, input)
  return runLegacyForegroundCommand(executableCommand, cwd, input)
}

async function runKeptCommand(command: string, cwd: string, processManager?: BashProcessManager) {
  if (!processManager) throw new Error("Managed bash processes are not available.")
  const kept = await processManager.start(command, cwd)
  return {
    structuredContent: {
      cwd,
      kept: true,
      process_id: kept.id,
      pid: kept.pid,
      log_path: kept.logPath,
    },
    content: [],
  }
}

async function runDurableCommand(
  command: string,
  cwd: string,
  projectId: string | undefined,
  input: BashExecutionInput
) {
  const jobs = input.jobManager
  if (!jobs) throw new Error("Durable jobs are unavailable.")
  const job = await jobs.start(
    bashJobLabel(input.command),
    command,
    cwd,
    projectId,
    input.killAfterMs
  )
  let waited: Awaited<ReturnType<JobManager["wait"]>>
  try {
    waited = await jobs.wait(job.id, input.waitMs, 0, MAX_CAPTURE_BYTES, input.signal)
  } catch (error) {
    if (isUserForcedStop(input.signal.reason)) {
      await jobs.cancel(job.id)
      throw input.signal.reason
    }
    throw error
  }
  const bounded = tokenPrefix(withApplyPatchToolHint(waited.output), input.maxOutputTokens)
  if (waited.job.status === "running")
    return durableRunningResult(cwd, waited, bounded.value, bounded.truncated)

  const result = {
    structuredContent: {
      cwd,
      exit_code: waited.job.exitCode ?? (waited.job.status === "completed" ? 0 : 1),
      output: bounded.value,
      ...(waited.job.timedOut ? { timed_out: true } : {}),
      ...(bounded.truncated || waited.truncated ? { output_truncated: true } : {}),
    },
    content: [],
  }
  await jobs.forget(job.id)
  return result
}

function durableRunningResult(
  cwd: string,
  waited: Awaited<ReturnType<JobManager["wait"]>>,
  output: string,
  outputTruncated: boolean
) {
  return {
    structuredContent: {
      cwd,
      running: true,
      promoted_to_job: true,
      job_id: waited.job.id,
      pid: waited.job.pid,
      output,
      next_cursor: waited.nextCursor,
      wait_expired: true,
      ...(waited.job.killAfterAt ? { kill_after_at: waited.job.killAfterAt } : {}),
      ...(outputTruncated || waited.truncated ? { output_truncated: true } : {}),
    },
    content: [],
  }
}

async function runLegacyForegroundCommand(command: string, cwd: string, input: BashExecutionInput) {
  const result = await runCommand(command, cwd, input.waitMs, input.signal)
  const bounded = tokenPrefix(withApplyPatchToolHint(result.output), input.maxOutputTokens)
  return {
    structuredContent: {
      cwd,
      exit_code: result.exitCode,
      output: bounded.value,
      ...(result.timedOut ? { timed_out: true } : {}),
      ...(bounded.truncated ? { output_truncated: true } : {}),
    },
    content: [],
  }
}

async function resolveExecutionScope(
  workdir: string | undefined,
  projectScope?: ProjectScope,
  projectId?: string
): Promise<{ path: string; projectId?: string }> {
  if (projectScope) {
    const resolved = await projectScope.resolvePath(workdir, "shell", projectId)
    return {
      path: resolved.path,
      ...(resolved.project ? { projectId: resolved.project.id } : {}),
    }
  }
  if (!workdir) return { path: MCP_CONFIG.defaultCwd }
  return { path: isAbsolute(workdir) ? workdir : resolve(MCP_CONFIG.defaultCwd, workdir) }
}

function bashJobLabel(command: string): string {
  const compact = command.replace(/\s+/gu, " ").trim()
  return `bash: ${compact.slice(0, 114)}`
}

function isUserForcedStop(value: unknown): value is ToolError {
  return value instanceof ToolError && value.code === "USER_FORCED_STOP"
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(MCP_CONFIG.shell.path, shellCommandArgs(command), {
      cwd,
      env: childProcessEnvironment(),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    let capturedBytes = 0
    let timedOut = false

    const append = (chunk: Buffer) => {
      if (capturedBytes >= MAX_CAPTURE_BYTES) return
      const remaining = MAX_CAPTURE_BYTES - capturedBytes
      const bounded = chunk.subarray(0, remaining)
      output += bounded.toString("utf8")
      capturedBytes += bounded.length
    }
    child.stdout.on("data", append)
    child.stderr.on("data", append)

    const terminate = () => signalProcessGroup(child, "SIGTERM")
    const timeout = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)

    const abort = () => terminate()
    signal.addEventListener("abort", abort, { once: true })

    child.once("error", (error) => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("Command aborted."))
        return
      }
      resolvePromise({ exitCode: code ?? 1, output, timedOut })
    })
  })
}
