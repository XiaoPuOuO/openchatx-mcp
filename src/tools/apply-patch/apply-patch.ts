import { spawn } from "node:child_process"
import type { Stats } from "node:fs"
import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import process from "node:process"
import { StringDecoder } from "node:string_decoder"
import { fileURLToPath } from "node:url"
import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import {
  type ProcessGroupTermination,
  startProcessGroupTermination,
} from "../../child-process-termination.js"
import type { ProjectScope } from "../../projects/project-scope.js"
import { tokenPrefix } from "../../tokenizer.js"
import { summarizePatchExecution } from "./patch-summary.js"

const FAILURE_OUTPUT_TOKENS = 1_024
const STOP_GRACE_MS = 500
const DEFAULT_APPLY_PATCH_BINARY = fileURLToPath(
  new URL("../../../vendor/apply-patch/apply_patch", import.meta.url)
)

export function isApplyPatchSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin"
}

export function registerApplyPatchTool(server: McpServer, projectScope?: ProjectScope): void {
  server.registerTool(
    "apply_patch",
    {
      description:
        "Apply an explicit structured patch when the task is naturally expressed as a patch: coordinated multi-file changes, file moves/deletions, or a patch supplied by the user. Do not use this as the default file editor. For localized changes to an existing text file use `file_edit`; for creating or completely rewriting a text file use `file_write`. A patch may contain multiple file operations and update hunks; use `@@ <context>` to scope a hunk when needed.",
      inputSchema: z.object({
        patch: z
          .string()
          .describe(
            "A patch beginning with `*** Begin Patch` and ending with `*** End Patch`. Use `*** Add File`, `*** Update File`, or `*** Delete File` sections. Within `*** Update File`, use `*** Move to:` to move or rename a file, `@@ <context>` to scope a hunk to a unique class, function, section, or line, and `*** End of File` when an update specifically targets the file tail. A patch may contain multiple file sections and multiple hunks per file."
          ),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe("Patch root. Defaults to the active Project root when one is selected."),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional Project id. Write permission is enforced and cwd must stay inside that Project."
          ),
      }),
      outputSchema: z.object({
        status: z.enum(["completed", "failed", "partial"]),
        exit_code: z.int().min(0).max(255).nullable(),
        changed: z
          .string()
          .optional()
          .describe("Compact newline-delimited summary of file changes actually applied."),
        failed: z
          .string()
          .optional()
          .describe(
            "The first file section or update hunk that failed, when it can be identified."
          ),
        output: z
          .string()
          .optional()
          .describe("Present only on failure with bounded apply_patch stdout/stderr diagnostics."),
        output_dropped: z
          .literal(true)
          .optional()
          .describe(
            "Present when failure diagnostics exceeded the apply_patch token ceiling and output was permanently discarded."
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ patch, cwd, project_id }, ctx) => {
      try {
        const resolvedCwd = projectScope
          ? (await projectScope.resolvePath(cwd, "write", project_id)).path
          : requireAbsoluteCwd(cwd)
        const result = await applyPatch({
          patch,
          cwd: resolvedCwd,
          executable: DEFAULT_APPLY_PATCH_BINARY,
          signal: ctx.mcpReq.signal,
        })
        return {
          ...(result.status === "failed" ? { isError: true } : {}),
          structuredContent: toToolResult(result),
          content: [],
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `apply_patch_failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        }
      }
    }
  )
}

export interface ApplyPatchInput {
  patch: string
  cwd: string
  executable: string
  signal?: AbortSignal
}

interface ApplyPatchResult {
  status: "completed" | "failed"
  exit_code: number | null
  changed?: string
  failed?: string
  output: string
  output_dropped: boolean
}

interface CompactApplyPatchResult {
  status: ApplyPatchResult["status"] | "partial"
  exit_code: number | null
  changed?: string
  failed?: string
  output?: string
  output_dropped?: true
}

function toToolResult(result: ApplyPatchResult): CompactApplyPatchResult {
  const compact: CompactApplyPatchResult = {
    status: result.status === "failed" && result.changed ? "partial" : result.status,
    exit_code: result.exit_code,
  }
  if (result.changed) compact.changed = result.changed
  if (result.failed) compact.failed = result.failed
  if (result.status === "failed") {
    compact.output = result.output
    if (result.output_dropped) compact.output_dropped = true
  }
  return compact
}

export async function applyPatch(input: ApplyPatchInput): Promise<ApplyPatchResult> {
  input.signal?.throwIfAborted()

  let cwdStat: Stats
  try {
    cwdStat = await stat(input.cwd)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error(`cwd does not exist: ${input.cwd}`, { cause: error })
    }
    throw error
  }
  if (!cwdStat.isDirectory()) {
    throw new Error(`cwd is not a directory: ${input.cwd}`)
  }

  const processResult = await new Promise<Omit<ApplyPatchResult, "changed" | "failed">>(
    (resolve, reject) => {
      const child = spawn(input.executable, [], {
        cwd: input.cwd,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      })
      const stdoutDecoder = new StringDecoder("utf8")
      const stderrDecoder = new StringDecoder("utf8")
      let output = ""
      let outputDropped = false
      let stdinError: Error | undefined
      let aborted = false
      let settled = false
      let termination: ProcessGroupTermination | null = null
      let forceSettleTimer: NodeJS.Timeout | null = null

      const appendOutput = (value: string) => {
        if (outputDropped || value.length === 0) return
        const bounded = tokenPrefix(output + value, FAILURE_OUTPUT_TOKENS)
        output = bounded.value
        outputDropped = bounded.truncated
      }
      const cleanup = () => {
        input.signal?.removeEventListener("abort", abort)
        termination?.cancel()
        termination = null
        if (forceSettleTimer) clearTimeout(forceSettleTimer)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const abort = () => {
        if (aborted || settled) return
        aborted = true
        const currentTermination = startProcessGroupTermination(child, {
          graceMs: STOP_GRACE_MS,
        })
        termination = currentTermination
        void currentTermination.completion.then((result) => {
          if (termination !== currentTermination || result !== "grace_elapsed" || settled) return
          termination = null
          forceSettleTimer = setTimeout(() => {
            if (settled) return
            child.stdin.destroy()
            child.stdout.destroy()
            child.stderr.destroy()
            child.unref()
            fail(new Error("apply_patch request was aborted."))
          }, STOP_GRACE_MS)
        })
      }

      child.stdout.on("data", (chunk: Buffer) => appendOutput(stdoutDecoder.write(chunk)))
      child.stdout.on("end", () => appendOutput(stdoutDecoder.end()))
      child.stderr.on("data", (chunk: Buffer) => appendOutput(stderrDecoder.write(chunk)))
      child.stderr.on("end", () => appendOutput(stderrDecoder.end()))
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") stdinError = error
      })
      child.once("error", (error) =>
        fail(new Error(`apply_patch failed to start: ${error.message}`, { cause: error }))
      )
      child.once("close", (code) => {
        if (settled) return
        if (aborted) {
          fail(new Error("apply_patch request was aborted."))
          return
        }
        if (stdinError) {
          fail(new Error(`apply_patch stdin failed: ${stdinError.message}`, { cause: stdinError }))
          return
        }
        settled = true
        cleanup()
        resolve({
          status: code === 0 ? "completed" : "failed",
          exit_code: code,
          output,
          output_dropped: outputDropped,
        })
      })

      input.signal?.addEventListener("abort", abort, { once: true })
      if (input.signal?.aborted) abort()
      child.stdin.end(input.patch)
    }
  )

  const summary = summarizePatchExecution(
    input.patch,
    processResult.status === "completed",
    processResult.output
  )
  return {
    ...processResult,
    ...summary,
  }
}

function requireAbsoluteCwd(cwd: string | undefined): string {
  if (!cwd) throw new Error("cwd is required when Project scope is unavailable.")
  if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute path.")
  return cwd
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}
