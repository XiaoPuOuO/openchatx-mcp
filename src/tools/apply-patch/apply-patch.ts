import { spawn } from "node:child_process"
import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { tokenPrefix } from "../../tokenizer.js"

const FAILURE_OUTPUT_TOKENS = 1_024
const STOP_GRACE_MS = 500
const DEFAULT_APPLY_PATCH_BINARY = fileURLToPath(new URL("../../../vendor/apply-patch/apply_patch", import.meta.url))

export function registerApplyPatchTool(server: McpServer, executable = DEFAULT_APPLY_PATCH_BINARY): void {
  server.registerTool(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Shellby's first-class tool for local file modifications. Use `apply_patch` to create, update, delete, move, or rename files. A patch may contain multiple file operations and multiple update hunks. Use `@@ <context>` to scope an update to a class, function, section, or other unique line when needed.",
      inputSchema: z.object({
        patch: z
          .string()
          .describe(
            "A patch beginning with `*** Begin Patch` and ending with `*** End Patch`. Use `*** Add File`, `*** Update File`, or `*** Delete File` sections. Within `*** Update File`, use `*** Move to:` to move or rename a file, `@@ <context>` to scope a hunk to a unique class, function, section, or line, and `*** End of File` when an update specifically targets the file tail. A patch may contain multiple file sections and multiple hunks per file."
          ),
        cwd: z.string().refine(isAbsolute, "cwd must be an absolute path.").describe("Absolute directory used as the patch root."),
      }),
      outputSchema: z.object({
        status: z.enum(["completed", "failed", "partial"]),
        exit_code: z.int().min(0).max(255).nullable(),
        changed: z.string().optional().describe("Compact newline-delimited summary of file changes actually applied."),
        failed: z.string().optional().describe("The first file section or update hunk that failed, when it can be identified."),
        output: z.string().optional().describe("Present only on failure with bounded apply_patch stdout/stderr diagnostics."),
        output_dropped: z
          .literal(true)
          .optional()
          .describe("Present when failure diagnostics exceeded the apply_patch token ceiling and output was permanently discarded."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ patch, cwd }, ctx) => {
      try {
        const result = await applyPatch({ patch, cwd, executable, signal: ctx.mcpReq.signal })
        return {
          ...(result.status === "failed" ? { isError: true } : {}),
          structuredContent: toToolResult(result),
          content: [],
        }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `apply_patch_failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )
}

interface ApplyPatchInput {
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

async function applyPatch(input: ApplyPatchInput): Promise<ApplyPatchResult> {
  input.signal?.throwIfAborted()

  let cwdStat
  try {
    cwdStat = await stat(input.cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`cwd does not exist: ${input.cwd}`, { cause: error })
    }
    throw error
  }
  if (!cwdStat.isDirectory()) {
    throw new Error(`cwd is not a directory: ${input.cwd}`)
  }

  const sections = parsePatchSections(input.patch)

  const processResult = await new Promise<Omit<ApplyPatchResult, "changed" | "failed">>((resolve, reject) => {
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
    let terminateTimer: NodeJS.Timeout | null = null
    let forceSettleTimer: NodeJS.Timeout | null = null

    const appendOutput = (value: string) => {
      if (outputDropped || value.length === 0) return
      const bounded = tokenPrefix(output + value, FAILURE_OUTPUT_TOKENS)
      output = bounded.value
      outputDropped = bounded.truncated
    }
    const cleanup = () => {
      input.signal?.removeEventListener("abort", abort)
      if (terminateTimer) clearTimeout(terminateTimer)
      if (forceSettleTimer) clearTimeout(forceSettleTimer)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const killChild = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        if (process.platform === "win32") child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch {
        // Cleanup is best effort. Forced settlement below prevents a hung request.
      }
    }
    const abort = () => {
      if (aborted || settled) return
      aborted = true
      killChild("SIGTERM")
      terminateTimer = setTimeout(() => {
        if (settled) return
        killChild("SIGKILL")
        forceSettleTimer = setTimeout(() => {
          if (settled) return
          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
          child.unref()
          fail(new Error("apply_patch request was aborted."))
        }, STOP_GRACE_MS)
      }, STOP_GRACE_MS)
    }

    child.stdout.on("data", (chunk: Buffer) => appendOutput(stdoutDecoder.write(chunk)))
    child.stdout.on("end", () => appendOutput(stdoutDecoder.end()))
    child.stderr.on("data", (chunk: Buffer) => appendOutput(stderrDecoder.write(chunk)))
    child.stderr.on("end", () => appendOutput(stderrDecoder.end()))
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stdinError = error
    })
    child.once("error", (error) => fail(new Error(`apply_patch failed to start: ${error.message}`, { cause: error })))
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
  })

  const failedIndex = processResult.status === "failed" ? findFailedSectionIndex(processResult.output, sections) : -1
  const changed = summarizeChanges(processResult.status === "completed" ? sections : failedIndex >= 0 ? sections.slice(0, failedIndex) : [])
  const failed = failedIndex >= 0 ? summarizeFailure(processResult.output, sections[failedIndex]!) : undefined
  return {
    ...processResult,
    ...(changed ? { changed } : {}),
    ...(failed ? { failed } : {}),
  }
}

interface PatchHunk {
  index: number
  context?: string
  expected: string[]
}

interface PatchSection {
  kind: "add" | "update" | "delete"
  path: string
  moveTo?: string
  additions: number
  deletions: number
  hunks: PatchHunk[]
}

function parsePatchSections(patch: string): PatchSection[] {
  const sections: PatchSection[] = []
  let section: PatchSection | undefined
  let hunk: PatchHunk | undefined

  const startSection = (kind: PatchSection["kind"], path: string) => {
    section = { kind, path, additions: 0, deletions: 0, hunks: [] }
    sections.push(section)
    hunk = undefined
  }

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("*** Add File: ")) {
      startSection("add", line.slice("*** Add File: ".length).trim())
      continue
    }
    if (line.startsWith("*** Update File: ")) {
      startSection("update", line.slice("*** Update File: ".length).trim())
      continue
    }
    if (line.startsWith("*** Delete File: ")) {
      startSection("delete", line.slice("*** Delete File: ".length).trim())
      continue
    }
    if (!section) continue

    if (section.kind === "update" && line.startsWith("*** Move to: ")) {
      section.moveTo = line.slice("*** Move to: ".length).trim()
      continue
    }
    if (section.kind === "update" && (line === "@@" || line.startsWith("@@ "))) {
      hunk = {
        index: section.hunks.length + 1,
        ...(line.length > 2 ? { context: line.slice(3) } : {}),
        expected: [],
      }
      section.hunks.push(hunk)
      continue
    }
    if (line === "*** End of File" || line === "*** End Patch") continue

    if (section.kind === "add") {
      if (line.startsWith("+")) section.additions += 1
      continue
    }
    const prefix = line[0]
    if (section.kind !== "update" || (prefix !== " " && prefix !== "+" && prefix !== "-")) continue

    if (!hunk) {
      hunk = { index: section.hunks.length + 1, expected: [] }
      section.hunks.push(hunk)
    }
    if (line.startsWith("+")) section.additions += 1
    if (line.startsWith("-")) section.deletions += 1
    if (line.startsWith(" ") || line.startsWith("-")) hunk.expected.push(line.slice(1))
  }

  return sections.filter((candidate) => candidate.path.length > 0)
}

function summarizeChanges(sections: readonly PatchSection[]): string | undefined {
  const changed = sections.flatMap((section) => {
    if (section.kind === "add") return [`${section.path}${formatCounts(section.additions, 0) || " added"}`]
    if (section.kind === "delete") return [`${section.path} deleted`]
    if (section.moveTo) return [`${section.path} -> ${section.moveTo}${formatCounts(section.additions, section.deletions)}`]
    const counts = formatCounts(section.additions, section.deletions)
    return counts ? [`${section.path}${counts}`] : []
  })
  return changed.length > 0 ? changed.join("\n") : undefined
}

function formatCounts(additions: number, deletions: number): string {
  const parts: string[] = []
  if (additions > 0) parts.push(`+${additions}`)
  if (deletions > 0) parts.push(`-${deletions}`)
  return parts.length > 0 ? ` ${parts.join(" ")}` : ""
}

function findFailedSectionIndex(output: string, sections: readonly PatchSection[]): number {
  const headline = output.split("\n", 1)[0] ?? output
  let match = -1
  let matchLength = -1
  for (const [index, section] of sections.entries()) {
    for (const path of [section.path, section.moveTo]) {
      if (path && path.length > matchLength && headline.includes(path)) {
        match = index
        matchLength = path.length
      }
    }
  }
  return match
}

function summarizeFailure(output: string, section: PatchSection): string {
  const displayPath = section.moveTo ? `${section.path} -> ${section.moveTo}` : section.path
  if (section.kind !== "update" || section.hunks.length === 0) return displayPath

  const hunk = identifyFailedHunk(output, section.hunks)
  if (!hunk) return displayPath
  return hunk.context ? `${displayPath} @@ ${hunk.context}` : `${displayPath} hunk ${hunk.index}`
}

function identifyFailedHunk(output: string, hunks: readonly PatchHunk[]): PatchHunk | undefined {
  for (const hunk of hunks) {
    if (hunk.context && output.includes(`context '${hunk.context}'`)) return hunk
  }

  const body = output.split("\n").slice(1).join("\n").trim()
  if (body) {
    const scored = hunks
      .map((hunk) => ({
        hunk,
        score: hunk.expected.filter((line) => line.length > 0 && body.includes(line)).length,
      }))
      .sort((left, right) => right.score - left.score)
    if (scored[0] && scored[0].score > 0 && (scored.length === 1 || scored[0].score > scored[1]!.score)) return scored[0].hunk
  }

  return hunks.length === 1 ? hunks[0] : undefined
}
