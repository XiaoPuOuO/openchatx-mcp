import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { toToolError } from "../../mcp/tool-error.js"
import type { ProjectScope } from "../../projects/project-scope.js"

const DEFAULT_READ_LIMIT = 2000
const MAX_READ_BYTES = 50 * 1024
const MAX_LINE_LENGTH = 2000
const LINE_SPLIT_RE = /\r?\n/u
const BINARY_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".class",
  ".jar",
  ".war",
  ".7z",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".bin",
  ".dat",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".wasm",
  ".pyc",
  ".pyo",
])

export function registerFileReadTool(server: McpServer, projectScope?: ProjectScope): void {
  server.registerTool(
    "file_read",
    {
      description:
        "Read a local file or directory. Use this when the path is already known. If the path is unknown, use glob first; if you need to locate specific content inside files, use grep first. Text files return line-numbered content with pagination; directories return sorted entries. Prefer one useful context window over many tiny reads. Binary files are rejected except images/PDFs, which return native MCP resource content.",
      inputSchema: z.object({
        filePath: z
          .string()
          .min(1)
          .describe(
            "File or directory to read. Relative paths resolve from the active Project root when selected, otherwise the user's home directory."
          ),
        offset: z
          .int()
          .min(1)
          .optional()
          .describe("The line or entry number to start reading from (1-indexed)."),
        limit: z
          .int()
          .min(1)
          .max(DEFAULT_READ_LIMIT)
          .optional()
          .describe("Maximum number of lines or directory entries to read (defaults to 2000)."),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional Project id. Relative paths resolve from that Project and read permission is enforced."
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filePath: inputPath, offset, limit, project_id }, ctx) => {
      try {
        const filePath = await resolveLocalPath(inputPath, "read", projectScope, project_id)
        return await readLocalPath(
          filePath,
          offset ?? 1,
          limit ?? DEFAULT_READ_LIMIT,
          ctx.mcpReq.signal
        )
      } catch (error) {
        throw toToolError(error, "FILE_READ_FAILED")
      }
    }
  )
}

async function readLocalPath(filePath: string, offset: number, limit: number, signal: AbortSignal) {
  const info = await stat(filePath)
  if (info.isDirectory()) return readDirectory(filePath, offset, limit)

  const data = await readFile(filePath, { signal })
  if (isImageOrPdf(filePath)) {
    return {
      content: [
        {
          type: "resource" as const,
          resource: {
            uri: pathToFileURL(filePath).href,
            mimeType: inferMimeType(filePath),
            blob: data.toString("base64"),
          },
        },
      ],
    }
  }
  if (isBinaryFile(filePath, data.subarray(0, 4096))) {
    throw new Error(`Cannot read binary file: ${filePath}`)
  }
  return readTextFile(filePath, data, offset, limit)
}

async function readDirectory(filePath: string, offset: number, limit: number) {
  const entries = (await readdir(filePath, { withFileTypes: true }))
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .sort((a, b) => a.localeCompare(b))
  const sliced = entries.slice(offset - 1, offset - 1 + limit)
  const truncated = offset - 1 + sliced.length < entries.length
  const output = [
    `<path>${filePath}</path>`,
    "<type>directory</type>",
    "<entries>",
    sliced.join("\n"),
    truncated
      ? `(Showing ${sliced.length} of ${entries.length} entries. Use offset=${offset + sliced.length} to continue.)`
      : `(${entries.length} entries)`,
    "</entries>",
  ].join("\n")
  return {
    structuredContent: {
      path: filePath,
      type: "directory",
      entries: sliced,
      offset,
      total_entries: entries.length,
      truncated,
    },
    content: [{ type: "text" as const, text: output }],
  }
}

function readTextFile(filePath: string, data: Buffer, offset: number, limit: number) {
  const lines = new TextDecoder("utf-8").decode(data).split(LINE_SPLIT_RE)
  if (offset > lines.length && !(lines.length === 1 && lines[0] === "" && offset === 1)) {
    throw new Error(`Offset ${offset} is out of range for this file (${lines.length} lines).`)
  }

  const selected: string[] = []
  let bytes = 0
  let cutByBytes = false
  for (let index = offset - 1; index < lines.length && selected.length < limit; index += 1) {
    const raw = lines[index] ?? ""
    const line =
      raw.length > MAX_LINE_LENGTH
        ? `${raw.slice(0, MAX_LINE_LENGTH)}... (line truncated to ${MAX_LINE_LENGTH} chars)`
        : raw
    const size = Buffer.byteLength(line, "utf8") + (selected.length > 0 ? 1 : 0)
    if (bytes + size > MAX_READ_BYTES) {
      cutByBytes = true
      break
    }
    selected.push(line)
    bytes += size
  }

  const lastLine = offset + selected.length - 1
  const truncated = cutByBytes || lastLine < lines.length
  let output = [`<path>${filePath}</path>`, "<type>file</type>", "<content>"].join("\n")
  output += `\n${selected.map((line, index) => `${offset + index}: ${line}`).join("\n")}`
  if (truncated) {
    output += `\n\n(Showing lines ${offset}-${lastLine}. Use offset=${lastLine + 1} to continue.)`
  }
  output += "\n</content>"

  return {
    structuredContent: {
      path: filePath,
      type: "file",
      text: selected.join("\n"),
      line_start: offset,
      line_end: lastLine,
      total_lines: lines.length,
      truncated,
    },
    content: [{ type: "text" as const, text: output }],
  }
}

export function registerFileWriteTool(server: McpServer, projectScope?: ProjectScope): void {
  server.registerTool(
    "file_write",
    {
      description:
        "Create a new text file or intentionally replace an entire existing text file. Prefer file_edit for localized changes to existing files. If the target already exists, you must read it with file_read before overwriting it so the replacement is based on current contents. Do not create new files unless the task actually requires them. Returns the resulting diff.",
      inputSchema: z.object({
        filePath: z
          .string()
          .min(1)
          .describe(
            "File to create or overwrite. Relative paths resolve from the active Project root when selected, otherwise the user's home directory."
          ),
        content: z.string().describe("The complete text content to write to the file."),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional Project id. Relative paths resolve from that Project and write permission is enforced."
          ),
      }),
      outputSchema: z.object({
        path: z.string(),
        diff: z.string(),
        created: z.boolean(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filePath: inputPath, content, project_id }, ctx) => {
      try {
        const filePath = await resolveLocalPath(inputPath, "write", projectScope, project_id)
        return await withFileEditLock(filePath, async () => {
          let before = ""
          let created = false
          try {
            const info = await stat(filePath)
            if (info.isDirectory()) throw new Error(`Path is a directory, not a file: ${filePath}`)
            before = await readFile(filePath, { encoding: "utf8", signal: ctx.mcpReq.signal })
          } catch (error) {
            if (!isFsError(error, "ENOENT")) throw error
            created = true
          }
          await mkdir(dirname(filePath), { recursive: true })
          await writeFile(filePath, content, { encoding: "utf8", signal: ctx.mcpReq.signal })
          const diff = createCompactDiff(before, content)
          return {
            structuredContent: { path: filePath, diff, created },
            content: [{ type: "text" as const, text: `File written successfully.\n\n${diff}` }],
          }
        })
      } catch (error) {
        throw toToolError(error, "FILE_WRITE_FAILED")
      }
    }
  )
}

export function registerFileEditTool(server: McpServer, projectScope?: ProjectScope): void {
  server.registerTool(
    "file_edit",
    {
      description:
        "Perform an exact string replacement in an existing text file. This is the default tool for localized edits. You must read the relevant file content with file_read before editing, then copy oldString from the current file while preserving exact whitespace and indentation. If oldString is missing or ambiguous, read more surrounding context and retry with a unique match; use replaceAll only when every occurrence should change. Use file_write for a new file or intentional whole-file replacement. Returns the resulting diff.",
      inputSchema: z.object({
        filePath: z
          .string()
          .min(1)
          .describe(
            "File to edit. Relative paths resolve from the active Project root when selected, otherwise the user's home directory."
          ),
        oldString: z
          .string()
          .min(1)
          .describe("The exact text to replace. It must be unique unless replaceAll is true."),
        newString: z.string().describe("Replacement text. Must differ from oldString."),
        replaceAll: z
          .boolean()
          .optional()
          .default(false)
          .describe("Replace every occurrence instead of requiring one unique match."),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional Project id. Relative paths resolve from that Project and write permission is enforced."
          ),
      }),
      outputSchema: z.object({
        path: z.string(),
        replacements: z.number(),
        diff: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ filePath: inputPath, oldString, newString, replaceAll, project_id }, ctx) => {
      try {
        const filePath = await resolveLocalPath(inputPath, "write", projectScope, project_id)
        return await editLocalFile({
          filePath,
          oldString,
          newString,
          replaceAll,
          signal: ctx.mcpReq.signal,
        })
      } catch (error) {
        throw toToolError(error, "FILE_EDIT_FAILED")
      }
    }
  )
}

async function editLocalFile(input: {
  filePath: string
  oldString: string
  newString: string
  replaceAll: boolean
  signal: AbortSignal
}) {
  if (input.oldString === input.newString) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }

  return withFileEditLock(input.filePath, () => editExistingFile(input))
}

async function editExistingFile(input: {
  filePath: string
  oldString: string
  newString: string
  replaceAll: boolean
  signal: AbortSignal
}) {
  const info = await stat(input.filePath)
  if (info.isDirectory()) throw new Error(`Path is a directory, not a file: ${input.filePath}`)

  const content = await readFile(input.filePath, { encoding: "utf8", signal: input.signal })
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n"
  const oldText = convertLineEndings(input.oldString, lineEnding)
  const newText = convertLineEndings(input.newString, lineEnding)
  const occurrences = countOccurrences(content, oldText)
  if (occurrences === 0) {
    throw new Error(
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings."
    )
  }
  if (!input.replaceAll && occurrences > 1) {
    throw new Error(
      "Found multiple matches for oldString. Provide more surrounding context to make the match unique."
    )
  }

  const next = input.replaceAll
    ? content.replaceAll(oldText, newText)
    : replaceOnce(content, oldText, newText)
  await writeFile(input.filePath, next, { encoding: "utf8", signal: input.signal })
  const replacements = input.replaceAll ? occurrences : 1
  return editResult(input.filePath, replacements, createCompactDiff(content, next))
}

function editResult(filePath: string, replacements: number, diff: string) {
  return {
    structuredContent: {
      path: filePath,
      replacements,
      diff,
    },
    content: [{ type: "text" as const, text: `Edit applied successfully.\n\n${diff}` }],
  }
}

const editLocks = new Map<string, Promise<void>>()

async function withFileEditLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = editLocks.get(path) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise
  })
  const queued = previous.then(() => current)
  editLocks.set(path, queued)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (editLocks.get(path) === queued) editLocks.delete(path)
  }
}

function convertLineEndings(text: string, ending: "\n" | "\r\n"): string {
  const normalized = text.replaceAll("\r\n", "\n")
  return ending === "\n" ? normalized : normalized.replaceAll("\n", "\r\n")
}

function countOccurrences(content: string, search: string) {
  let count = 0
  for (
    let nextIndex = content.indexOf(search);
    nextIndex !== -1;
    nextIndex = content.indexOf(search, nextIndex + search.length)
  ) {
    count += 1
  }
  return count
}

function createCompactDiff(before: string, after: string): string {
  const beforeLines = before.replaceAll("\r\n", "\n").split("\n")
  const afterLines = after.replaceAll("\r\n", "\n").split("\n")
  let start = 0
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start += 1
  }
  let beforeEnd = beforeLines.length - 1
  let afterEnd = afterLines.length - 1
  while (
    beforeEnd >= start &&
    afterEnd >= start &&
    beforeLines[beforeEnd] === afterLines[afterEnd]
  ) {
    beforeEnd -= 1
    afterEnd -= 1
  }
  const contextStart = Math.max(0, start - 2)
  const contextEndAfter = Math.min(afterLines.length - 1, afterEnd + 2)
  return [
    "--- before",
    "+++ after",
    `@@ line ${start + 1} @@`,
    ...beforeLines.slice(contextStart, start).map((line) => ` ${line}`),
    ...beforeLines.slice(start, beforeEnd + 1).map((line) => `-${line}`),
    ...afterLines.slice(start, afterEnd + 1).map((line) => `+${line}`),
    ...afterLines.slice(afterEnd + 1, contextEndAfter + 1).map((line) => ` ${line}`),
  ].join("\n")
}

function isBinaryFile(filePath: string, sample: Buffer): boolean {
  if (BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())) return true
  if (sample.length === 0) return false
  let nonPrintable = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable += 1
  }
  return nonPrintable / sample.length > 0.3
}

function inferMimeType(
  filePath: string
):
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "application/pdf"
  | "application/octet-stream" {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".gif":
      return "image/gif"
    case ".webp":
      return "image/webp"
    case ".pdf":
      return "application/pdf"
    default:
      return "application/octet-stream"
  }
}

function isImageOrPdf(filePath: string): boolean {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"].includes(
    extname(filePath).toLowerCase()
  )
}

function replaceOnce(content: string, search: string, replacement: string): string {
  const index = content.indexOf(search)
  return content.slice(0, index) + replacement + content.slice(index + search.length)
}

function isFsError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}

async function resolveLocalPath(
  path: string,
  permission: "read" | "write",
  projectScope?: ProjectScope,
  projectId?: string
): Promise<string> {
  if (projectScope) return (await projectScope.resolvePath(path, permission, projectId)).path
  return isAbsolute(path) ? path : resolve(MCP_CONFIG.defaultCwd, path)
}
