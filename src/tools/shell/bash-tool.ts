import { spawn } from "node:child_process"
import { isAbsolute, resolve } from "node:path"
import process from "node:process"
import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { signalProcessGroup } from "../../child-process-termination.js"
import { MCP_CONFIG } from "../../config.js"
import { tokenPrefix } from "../../tokenizer.js"
import { withApplyPatchToolHint } from "./apply-patch-guidance.js"

const MAX_CAPTURE_BYTES = 1024 * 1024

export function registerBashTool(server: McpServer): void {
  server.registerTool(
    "bash",
    {
      description:
        "Run a non-interactive shell command in a fresh zsh process. Use workdir explicitly when needed. For prompts, REPLs, menus, or TTY-only programs, use terminal instead.",
      inputSchema: z.object({
        command: z.string().min(1),
        workdir: z
          .string()
          .min(1)
          .optional()
          .describe("Working directory. Relative paths resolve from the configured workspace."),
        timeout_ms: z
          .int()
          .min(1)
          .max(15 * 60_000)
          .default(120_000),
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
    async ({ command, workdir, timeout_ms, max_output_tokens }, context) => {
      try {
        const cwd = resolveWorkdir(workdir)
        const result = await runCommand(command, cwd, timeout_ms, context.mcpReq.signal)
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
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `BASH_FAILED: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        }
      }
    }
  )
}

function resolveWorkdir(workdir?: string): string {
  if (!workdir) return MCP_CONFIG.workspace
  return isAbsolute(workdir) ? workdir : resolve(MCP_CONFIG.workspace, workdir)
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(MCP_CONFIG.shell.path, ["-f", "-c", command], {
      cwd,
      env: process.env,
      detached: true,
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
