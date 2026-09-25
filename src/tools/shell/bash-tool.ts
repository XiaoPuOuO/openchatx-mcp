import { spawn } from "node:child_process"
import { isAbsolute, resolve } from "node:path"
import process from "node:process"
import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { signalProcessGroup } from "../../child-process-termination.js"
import { MCP_CONFIG } from "../../config.js"
import { shellCommandArgs } from "../../host-platform.js"
import { toToolError } from "../../mcp/tool-error.js"
import type { ProjectScope } from "../../projects/project-scope.js"
import { tokenPrefix } from "../../tokenizer.js"
import { withApplyPatchToolHint } from "./apply-patch-guidance.js"
import type { BashProcessManager } from "./bash-process-manager.js"
import { prepareShellCommand } from "./rtk.js"

const MAX_CAPTURE_BYTES = 1024 * 1024

export function registerBashTool(
  server: McpServer,
  processManager?: BashProcessManager,
  projectScope?: ProjectScope
): void {
  server.registerTool(
    "bash",
    {
      description:
        "Run a genuine non-interactive shell operation in a fresh host shell process (zsh on macOS, PowerShell on Windows). Use this for builds, tests, git, package managers, processes, networking, permissions, system commands, pipelines, or shell features that dedicated tools do not provide. Set keep=true for long-running non-interactive servers, watchers, or daemons that must remain alive after the tool call returns. OpenChatX captures kept-process stdout/stderr; use bash_process to list processes, read logs for debugging, or stop one. Do NOT use bash for ordinary file reading, editing, writing, filename discovery, or content search: use file_read, file_edit, file_write, glob, or grep instead. Shell rg is appropriate only when you need capabilities grep does not expose, such as match counts or specialized ripgrep flags. Use workdir explicitly when needed. For prompts, REPLs, menus, or TTY-only programs, use terminal instead.",
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
          .max(15 * 60_000)
          .default(120_000)
          .describe("Maximum runtime for normal commands. Ignored when keep=true."),
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
    async ({ command, workdir, project_id, timeout_ms, keep, max_output_tokens }, context) => {
      try {
        const cwd = await resolveWorkdir(workdir, projectScope, project_id)
        const executableCommand = prepareShellCommand(command, cwd, process.env)
        if (keep) {
          if (!processManager) throw new Error("Managed bash processes are not available.")
          const kept = await processManager.start(executableCommand, cwd)
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
        const result = await runCommand(executableCommand, cwd, timeout_ms, context.mcpReq.signal)
        const bounded = tokenPrefix(withApplyPatchToolHint(result.output), max_output_tokens)
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
      } catch (error) {
        throw toToolError(error, "BASH_FAILED")
      }
    }
  )
}

async function resolveWorkdir(
  workdir: string | undefined,
  projectScope?: ProjectScope,
  projectId?: string
): Promise<string> {
  if (projectScope) return (await projectScope.resolvePath(workdir, "shell", projectId)).path
  if (!workdir) return MCP_CONFIG.defaultCwd
  return isAbsolute(workdir) ? workdir : resolve(MCP_CONFIG.defaultCwd, workdir)
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
      env: process.env,
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
