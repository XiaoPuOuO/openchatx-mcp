import type { SubagentSessionEvent } from "../../types"

export interface DiffLine {
  kind: "add" | "remove" | "context" | "hunk"
  text: string
  oldNumber?: number
  newNumber?: number
}

export interface FileDiff {
  path: string
  language: string
  lines: DiffLine[]
  additions: number
  deletions: number
  change: "added" | "deleted" | "modified"
  snippet?: boolean
}

export interface ToolDetails {
  name: string
  subtitle: string
  kind: "edit" | "shell" | "search" | "read" | "other"
  command?: string
  files: FileDiff[]
  result: string
  argumentsText?: string
  language?: string
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

export function toolArguments(input?: string): Record<string, unknown> {
  if (!input) return {}
  try {
    const parsed: unknown = JSON.parse(input)
    if (!isRecord(parsed)) return {}
    const nested = parsed.arguments_json
    if (typeof nested === "string") {
      try {
        const args: unknown = JSON.parse(nested)
        if (isRecord(args)) return { ...args, tool: parsed.tool }
      } catch {
        /* Display original arguments when nested JSON is not valid. */
      }
    }
    return parsed
  } catch {
    return {}
  }
}

function getString(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    if (typeof args[name] === "string") return args[name] as string
  }
  return undefined
}

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/")
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized
}

function languageFor(path: string): string {
  const suffix = path.split(".").at(-1)?.toLowerCase()
  const known: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    css: "css",
    scss: "css",
    html: "xml",
    xml: "xml",
    sh: "bash",
    bash: "bash",
    py: "python",
    rs: "rust",
    go: "go",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
  }
  return suffix ? (known[suffix] ?? "plaintext") : "plaintext"
}

function newDiff(path: string, change: FileDiff["change"] = "modified", snippet = false): FileDiff {
  return {
    path,
    language: languageFor(path),
    change,
    lines: [],
    additions: 0,
    deletions: 0,
    ...(snippet ? { snippet: true } : {}),
  }
}

function appendLine(file: FileDiff, line: string, counter: { old?: number; next?: number }): void {
  if (line.startsWith("@@")) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line)
    counter.old = match ? Number(match[1]) : undefined
    counter.next = match ? Number(match[2]) : undefined
    file.lines.push({ kind: "hunk", text: line })
    return
  }
  if (line.startsWith("\\ No newline")) return
  const mark = line[0]
  if (mark !== "+" && mark !== "-" && mark !== " ") return
  const kind = mark === "+" ? "add" : mark === "-" ? "remove" : "context"
  file.lines.push({
    kind,
    text: line.slice(1),
    ...(kind !== "add" && counter.old !== undefined ? { oldNumber: counter.old++ } : {}),
    ...(kind !== "remove" && counter.next !== undefined ? { newNumber: counter.next++ } : {}),
  })
  if (kind === "add") file.additions += 1
  if (kind === "remove") file.deletions += 1
}

export function parseApplyPatch(raw: string): FileDiff[] {
  if (
    !raw.includes("*** Begin Patch") &&
    !raw.includes("*** Update File:") &&
    !raw.includes("*** Add File:") &&
    !raw.includes("*** Delete File:")
  )
    return []
  const files: FileDiff[] = []
  let current: FileDiff | undefined
  const counter: { old?: number; next?: number } = {}
  for (const line of raw.replaceAll("\r\n", "\n").split("\n")) {
    const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/u.exec(line)
    if (header) {
      current = newDiff(
        header[2],
        header[1] === "Add" ? "added" : header[1] === "Delete" ? "deleted" : "modified"
      )
      files.push(current)
      counter.old = undefined
      counter.next = undefined
      continue
    }
    if (!current || line === "*** End Patch" || line === "*** Begin Patch") continue
    if (line.startsWith("*** Move to:")) {
      current.path = line.slice("*** Move to:".length).trim()
      current.language = languageFor(current.path)
      continue
    }
    appendLine(current, line, counter)
  }
  return files.filter((file) => file.lines.length > 0 || file.change === "deleted")
}

function cleanDiffPath(path: string): string {
  const cleaned = path.split("\t")[0].trim()
  if (cleaned === "/dev/null") return cleaned
  return cleaned.replace(/^[ab]\//u, "")
}

export function parseUnifiedDiff(raw: string, fallbackPath = ""): FileDiff[] {
  const text = raw.replaceAll("\r\n", "\n")
  if (!text.includes("@@") || (!text.includes("--- ") && !text.includes("diff --git"))) return []
  const files: FileDiff[] = []
  let current: FileDiff | undefined
  const counter: { old?: number; next?: number } = {}
  for (const line of text.split("\n")) {
    const git = /^diff --git a\/(.+) b\/(.+)$/u.exec(line)
    if (git) {
      current = newDiff(git[2])
      files.push(current)
      counter.old = undefined
      counter.next = undefined
      continue
    }
    if (line.startsWith("--- ")) {
      const source = cleanDiffPath(line.slice(4))
      const path = source === "/dev/null" ? fallbackPath : source
      if (!current) {
        current = newDiff(path || fallbackPath)
        files.push(current)
      }
      if (source === "/dev/null") current.change = "added"
      continue
    }
    if (line.startsWith("+++ ")) {
      const destination = cleanDiffPath(line.slice(4))
      if (!current) {
        current = newDiff(destination === "/dev/null" ? fallbackPath : destination)
        files.push(current)
      }
      if (destination === "/dev/null") current.change = "deleted"
      else {
        current.path = destination
        current.language = languageFor(destination)
      }
      continue
    }
    if (!current) continue
    if (line.startsWith("new file mode")) current.change = "added"
    else if (line.startsWith("deleted file mode")) current.change = "deleted"
    else appendLine(current, line, counter)
  }
  return files.filter((file) => file.lines.length > 0)
}

function snippetDiff(
  path: string,
  removed: string,
  added: string,
  change: FileDiff["change"] = "modified"
): FileDiff {
  const file = newDiff(path, change, true)
  for (const text of removed.split("\n")) {
    if (!text && removed.length === 0) continue
    file.lines.push({ kind: "remove", text })
    file.deletions += 1
  }
  for (const text of added.split("\n")) {
    if (!text && added.length === 0) continue
    file.lines.push({ kind: "add", text })
    file.additions += 1
  }
  return file
}

export function describeTool(event: SubagentSessionEvent): ToolDetails {
  const args = toolArguments(event.input)
  const tool = event.tool ?? "tool"
  const lower = tool.toLowerCase()
  const command = getString(args, "command")
  const path = getString(args, "filePath", "file_path", "path", "file") ?? ""
  const patch = getString(args, "patch")
  const shell = /(?:^|[_:])(?:bash|shell|terminal|shell_run)$/u.test(lower)
  const edit =
    /(?:apply_patch|file_edit|file_write|edit_file|write_file|patch)$/u.test(lower) ||
    Boolean(patch)
  const search = /(?:grep|glob|search)$/u.test(lower)
  const read = /(?:file_read|read_file)$/u.test(lower)
  let files: FileDiff[] = []
  if (edit) {
    // Prefer a returned unified diff with reliable hunk line numbers.
    files = parseUnifiedDiff(event.text, path)
    if (files.length === 0 && patch) files = parseApplyPatch(patch)
    if (files.length === 0 && path) {
      const removed = getString(args, "oldString", "old_string") ?? ""
      const added = getString(args, "newString", "new_string", "content") ?? ""
      if (removed || added)
        files = [snippetDiff(path, removed, added, removed ? "modified" : "added")]
    }
  }
  let subtitle = ""
  if (shell) subtitle = command ?? ""
  else if (files.length) subtitle = files.map((file) => basename(file.path)).join(" · ")
  else if (read || edit) subtitle = path
  else if (search) {
    const pattern = getString(args, "pattern", "query") ?? ""
    subtitle = [path, pattern].filter(Boolean).join(" · ")
  } else subtitle = getString(args, "job_id", "model", "query", "tool") ?? ""
  return {
    name: shell
      ? "Shell"
      : read
        ? "Read"
        : search
          ? tool === "glob"
            ? "Glob"
            : "Grep"
          : edit
            ? "Edit"
            : tool,
    subtitle,
    kind: edit ? "edit" : shell ? "shell" : search ? "search" : read ? "read" : "other",
    ...(command ? { command } : {}),
    files,
    result: event.text,
    ...(event.input ? { argumentsText: event.input } : {}),
    ...(read ? { language: languageFor(path) } : {}),
  }
}
