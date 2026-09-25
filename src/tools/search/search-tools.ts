import { spawn } from "node:child_process"
import { stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { ToolError, toToolError } from "../../mcp/tool-error.js"
import type { ProjectScope } from "../../projects/project-scope.js"

const RESULT_LIMIT = 100
const STDOUT_LIMIT_BYTES = 4 * 1024 * 1024
const TRAILING_LINE_BREAK_RE = /\r?\n$/u

export function registerSearchTools(server: McpServer, projectScope?: ProjectScope): void {
  server.registerTool(
    "glob",
    {
      description:
        "Fast file/path discovery by glob pattern without invoking a shell. Use this when you need to find files by name or path pattern, or when you are unsure of the exact path before calling file_read. Do not use bash find or ls -R for ordinary file discovery. Returns up to 100 absolute paths, newest modified first.",
      inputSchema: z.object({
        pattern: z.string().min(1).describe('Glob pattern such as "**/*.ts" or "src/**/*.tsx".'),
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Directory to search. Defaults to the active Project root, otherwise the user's home directory."
          ),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe("Optional Project id. Read permission is enforced."),
      }),
      outputSchema: z.object({
        files: z.array(z.string()),
        count: z.number(),
        truncated: z.boolean(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ pattern, path, project_id }, context) => {
      try {
        const searchRoot = await resolveSearchPath(path, projectScope, project_id)
        const info = await stat(searchRoot)
        if (!info.isDirectory())
          throw new ToolError("GLOB_FAILED", `glob path must be a directory: ${searchRoot}`)

        const result = await runRg(
          ["--files", "--hidden", "-g", pattern],
          searchRoot,
          context.mcpReq.signal
        )
        if (result.code !== 0 && result.code !== 1)
          throw new ToolError("GLOB_FAILED", result.stderr || "glob failed")

        const relativeFiles = result.stdout.split("\n").filter(Boolean)
        const rows = await Promise.all(
          relativeFiles.map(async (file) => {
            const absolute = resolve(searchRoot, file)
            try {
              return { absolute, mtime: (await stat(absolute)).mtimeMs }
            } catch {
              return { absolute, mtime: 0 }
            }
          })
        )
        rows.sort(
          (left, right) => right.mtime - left.mtime || left.absolute.localeCompare(right.absolute)
        )
        const truncated = rows.length > RESULT_LIMIT
        const files = rows.slice(0, RESULT_LIMIT).map(({ absolute }) => absolute)

        return {
          structuredContent: { files, count: files.length, truncated },
          content: [
            {
              type: "text" as const,
              text:
                files.length === 0
                  ? "No files found"
                  : `${files.join("\n")}${truncated ? `\n\n(Results truncated: showing first ${RESULT_LIMIT} files.)` : ""}`,
            },
          ],
        }
      } catch (error) {
        throw toToolError(error, "GLOB_FAILED")
      }
    }
  )

  server.registerTool(
    "grep",
    {
      description:
        "Fast content search across files using a regular expression. Use this when you need to find files containing specific text or code patterns; use include to restrict file types. Do not use shell grep or rg for ordinary content search. If you specifically need match counts, aggregation, or ripgrep flags this tool does not expose, use bash with rg. Returns up to 100 matches with file paths and line numbers.",
      inputSchema: z.object({
        pattern: z.string().min(1).describe("Regular expression to search for."),
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "File or directory to search. Defaults to the active Project root, otherwise the user's home directory."
          ),
        include: z
          .string()
          .min(1)
          .optional()
          .describe('Optional file glob such as "*.ts" or "*.{ts,tsx}".'),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe("Optional Project id. Read permission is enforced."),
      }),
      outputSchema: z.object({
        matches: z.array(
          z.object({
            path: z.string(),
            line: z.number(),
            text: z.string(),
          })
        ),
        count: z.number(),
        truncated: z.boolean(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ pattern, path, include, project_id }, context) => {
      try {
        const requested = await resolveSearchPath(path, projectScope, project_id)
        const requestedInfo = await stat(requested).catch(() => undefined)
        const cwd = requestedInfo?.isFile() ? dirname(requested) : requested
        const target = requestedInfo?.isFile() ? basename(requested) : "."
        const args = ["--json", "--hidden", "--max-columns", "2000"]
        if (include) args.push("-g", include)
        args.push(pattern, target)

        const result = await runRg(args, cwd, context.mcpReq.signal)
        if (result.code !== 0 && result.code !== 1)
          throw new ToolError("GREP_FAILED", result.stderr || "grep failed")

        const allMatches = parseRgMatches(result.stdout, cwd)
        const truncated = allMatches.length > RESULT_LIMIT
        const matches = allMatches.slice(0, RESULT_LIMIT)
        const output = formatGrepOutput(matches, truncated)

        return {
          structuredContent: { matches, count: matches.length, truncated },
          content: [{ type: "text" as const, text: output }],
        }
      } catch (error) {
        throw toToolError(error, "GREP_FAILED")
      }
    }
  )
}

interface RgMatch {
  path: string
  line: number
  text: string
}

async function resolveSearchPath(
  path: string | undefined,
  projectScope?: ProjectScope,
  projectId?: string
): Promise<string> {
  if (projectScope) return (await projectScope.resolvePath(path, "read", projectId)).path
  if (!path) return MCP_CONFIG.defaultCwd
  return isAbsolute(path) ? path : join(MCP_CONFIG.defaultCwd, path)
}

function parseRgMatches(stdout: string, cwd: string): RgMatch[] {
  const matches: RgMatch[] = []
  for (const line of stdout.split("\n")) {
    if (!line) continue
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(message) || message.type !== "match" || !isRecord(message.data)) continue
    const path = textField(message.data.path)
    const lineNumber = message.data.line_number
    const lines = textField(message.data.lines)
    if (!path || typeof lineNumber !== "number" || lines === undefined) continue
    matches.push({
      path: resolve(cwd, path),
      line: lineNumber,
      text: lines.replace(TRAILING_LINE_BREAK_RE, ""),
    })
  }
  return matches
}

function textField(value: unknown): string | undefined {
  return isRecord(value) && typeof value.text === "string" ? value.text : undefined
}

function formatGrepOutput(matches: RgMatch[], truncated: boolean): string {
  if (matches.length === 0) return "No matches found"
  const output = [`Found ${matches.length} matches${truncated ? " (more matches available)" : ""}`]
  let current = ""
  for (const match of matches) {
    if (current !== match.path) {
      if (current) output.push("")
      current = match.path
      output.push(`${match.path}:`)
    }
    output.push(` Line ${match.line}: ${match.text}`)
  }
  if (truncated) output.push("", `(Results truncated: showing first ${RESULT_LIMIT} matches.)`)
  return output.join("\n")
}

async function runRg(
  args: string[],
  cwd: string,
  signal: AbortSignal
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("rg", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    })
    let stdout = ""
    let stderr = ""
    let stdoutBytes = 0

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > STDOUT_LIMIT_BYTES) {
        child.kill("SIGTERM")
        return
      }
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < 64 * 1024) stderr += chunk.toString()
    })
    child.once("error", reject)
    child.once("close", (code, childSignal) => {
      if (stdoutBytes > STDOUT_LIMIT_BYTES) {
        reject(new Error("ripgrep output exceeded the 4 MiB safety limit"))
        return
      }
      if (childSignal && signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("Search aborted"))
        return
      }
      resolvePromise({ code: code ?? 1, stdout, stderr: stderr.trim() })
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
