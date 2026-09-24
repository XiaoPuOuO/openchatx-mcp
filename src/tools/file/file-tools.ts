import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"

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

const openAiFileSchema = z.object({
  download_url: z.url(),
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
})

export function registerFileReadTool(server: McpServer): void {
  server.registerTool(
    "file_read",
    {
      description:
        "Read a local file or directory. Text files return line-numbered model-readable content with pagination. Directories return sorted entries. Binary files are rejected except images/PDFs, which return native MCP resource content.",
      inputSchema: z.object({
        filePath: z
          .string()
          .min(1)
          .describe(
            "The absolute path to the file or directory to read. Relative paths resolve from the workspace."
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
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filePath: inputPath, offset, limit }, ctx) => {
      const filePath = resolveLocalPath(inputPath)
      try {
        return await readLocalPath(
          filePath,
          offset ?? 1,
          limit ?? DEFAULT_READ_LIMIT,
          ctx.mcpReq.signal
        )
      } catch (error) {
        return toolError("FILE_READ_FAILED", error)
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

export function registerFileWriteTool(server: McpServer): void {
  server.registerTool(
    "file_write",
    {
      description: "Write a ChatGPT file to the local filesystem.",
      inputSchema: z.object({
        file: openAiFileSchema,
        path: z
          .string()
          .min(1)
          .describe("Local destination path. Relative paths resolve from the workspace."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        "openai/fileParams": ["file"],
      },
    },
    async ({ file, path }, ctx) => {
      const filePath = resolveLocalPath(path)
      try {
        const response = await fetch(file.download_url, { signal: ctx.mcpReq.signal })
        if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}.`)
        const data = Buffer.from(await response.arrayBuffer())
        await writeFile(filePath, data, { signal: ctx.mcpReq.signal })
        return {
          content: [
            {
              type: "text" as const,
              text: `Wrote ${basename(filePath)} (${data.byteLength} bytes) to ${filePath}.`,
            },
          ],
        }
      } catch (error) {
        return toolError("FILE_WRITE_FAILED", error)
      }
    }
  )
}

export function registerFileEditTool(server: McpServer): void {
  server.registerTool(
    "file_edit",
    {
      description:
        "Edit one existing text file by replacing oldString with newString. Parameters mirror OpenCode's edit tool. Exact matches are preferred; line-trimmed matching is used as a conservative fallback. Use replaceAll only when every occurrence should change.",
      inputSchema: z.object({
        filePath: z
          .string()
          .min(1)
          .describe("File to edit. Relative paths resolve from the configured workspace."),
        oldString: z
          .string()
          .describe("The text to replace. Leave empty only when creating a new file."),
        newString: z.string().describe("Replacement text. Must differ from oldString."),
        replaceAll: z
          .boolean()
          .optional()
          .default(false)
          .describe("Replace every occurrence instead of requiring one unique match."),
      }),
      outputSchema: z.object({
        path: z.string(),
        replacements: z.number(),
        diff: z.string(),
        created: z.boolean().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ filePath: inputPath, oldString, newString, replaceAll }, ctx) => {
      const filePath = resolveLocalPath(inputPath)
      try {
        return await editLocalFile({
          filePath,
          oldString,
          newString,
          replaceAll,
          signal: ctx.mcpReq.signal,
        })
      } catch (error) {
        return toolError("FILE_EDIT_FAILED", error)
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

  return withFileEditLock(input.filePath, async () => {
    if (input.oldString === "") return createFileFromEdit(input)
    return editExistingFile(input)
  })
}

async function createFileFromEdit(input: {
  filePath: string
  newString: string
  signal: AbortSignal
}) {
  try {
    const info = await stat(input.filePath)
    if (info.isDirectory()) throw new Error(`Path is a directory, not a file: ${input.filePath}`)
    throw new Error(
      "oldString cannot be empty when editing an existing file. Provide the exact text to replace."
    )
  } catch (error) {
    if (!isFsError(error, "ENOENT")) throw error
  }

  await mkdir(dirname(input.filePath), { recursive: true })
  await writeFile(input.filePath, input.newString, { encoding: "utf8", signal: input.signal })
  const diff = createCompactDiff("", input.newString)
  return editResult(input.filePath, 0, diff, true)
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
  const match = findEditableMatch(content, oldText, input.replaceAll)
  if (!match) {
    throw new Error(
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings."
    )
  }
  if (!input.replaceAll && match.occurrences > 1) {
    throw new Error(
      "Found multiple matches for oldString. Provide more surrounding context to make the match unique."
    )
  }

  const next = input.replaceAll
    ? content.replaceAll(match.text, newText)
    : replaceOnce(content, match.text, newText)
  await writeFile(input.filePath, next, { encoding: "utf8", signal: input.signal })
  const replacements = input.replaceAll ? match.occurrences : 1
  return editResult(input.filePath, replacements, createCompactDiff(content, next))
}

function editResult(filePath: string, replacements: number, diff: string, created = false) {
  return {
    structuredContent: {
      path: filePath,
      replacements,
      diff,
      ...(created ? { created: true } : {}),
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

function findEditableMatch(
  content: string,
  search: string,
  replaceAll: boolean
): { text: string; occurrences: number } | undefined {
  const exact = countOccurrences(content, search)
  if (exact > 0) return { text: search, occurrences: exact }
  if (replaceAll) return undefined

  const sourceLines = content.split("\n")
  const searchLines = search.split("\n")
  if (searchLines.at(-1) === "") searchLines.pop()
  if (searchLines.length === 0) return undefined

  const candidates: string[] = []
  for (let start = 0; start <= sourceLines.length - searchLines.length; start += 1) {
    const matches = searchLines.every(
      (line, offset) => (sourceLines[start + offset] ?? "").trim() === line.trim()
    )
    if (matches) candidates.push(sourceLines.slice(start, start + searchLines.length).join("\n"))
  }
  if (candidates.length === 0) return undefined
  const distinct = [...new Set(candidates)]
  const first = distinct[0]
  if (!first) return undefined
  return { text: first, occurrences: candidates.length }
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

function resolveLocalPath(path: string): string {
  return isAbsolute(path) ? path : resolve(MCP_CONFIG.workspace, path)
}

function toolError(code: string, error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `${code}: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
  }
}
