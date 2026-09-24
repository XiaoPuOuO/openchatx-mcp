import { asRecord } from "../utils.js"

export interface ToolCallPresentation {
  summary: string
  detail?: string
  detailLanguage?: string
  resultDetail?: string
  resultDetailLanguage?: string
  error?: string
}

/** Build the local dashboard presentation for one tool call without exposing observer state. */
export function presentToolCall(tool: string, input: unknown): ToolCallPresentation {
  return {
    summary: summarizeTool(tool, input),
    ...formatToolDetail(tool, input),
  }
}

export function presentToolResult(
  tool: string,
  result: unknown
): Pick<ToolCallPresentation, "resultDetail" | "resultDetailLanguage"> {
  const record = asRecord(result)
  const structured = record ? asRecord(record.structuredContent) : undefined
  if (
    (tool === "file_edit" || tool === "file_write") &&
    structured &&
    typeof structured.diff === "string"
  ) {
    return { resultDetail: structured.diff, resultDetailLanguage: "diff" }
  }
  return {}
}

export function presentToolFailure(error: unknown): Pick<ToolCallPresentation, "error"> {
  if (error instanceof Error) return { error: error.message }

  const record = asRecord(error)
  if (record) {
    const structured = asRecord(record.structuredContent)
    if (structured && typeof structured.output === "string") {
      return { error: structured.output }
    }
    if (structured && typeof structured.message === "string") {
      return { error: structured.message }
    }

    if (Array.isArray(record.content)) {
      const message = record.content
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== undefined)
        .flatMap((item) =>
          item.type === "text" && typeof item.text === "string" ? [item.text] : []
        )
        .join("\n")
      if (message) return { error: message }
    }

    if (typeof record.message === "string") return { error: record.message }
  }

  return { error: String(error) }
}

function summarizeTool(tool: string, input: unknown): string {
  const record = asRecord(input)
  if (!record) return ""
  const specialized = summarizeKnownTool(tool, record)
  if (specialized !== undefined) return specialized

  const preferred = ["path", "cwd", "request_id", "query", "name", "task_id"]
  for (const key of preferred) {
    const value = record[key]
    if (typeof value === "string") return singleLine(value, 140)
  }
  return ""
}

function summarizeKnownTool(tool: string, record: Record<string, unknown>): string | undefined {
  switch (tool) {
    case "bash":
      return typeof record.command === "string" ? singleLine(record.command, 140) : undefined
    case "terminal":
      if (typeof record.session_id === "string")
        return `${String(record.action ?? "terminal")}: ${record.session_id}`
      return typeof record.action === "string" ? record.action : undefined
    case "apply_patch":
      return typeof record.cwd === "string" ? record.cwd : "Applying patch"
    case "fetch_url":
      return typeof record.url === "string" ? singleLine(record.url, 140) : undefined
    case "image_view":
      return typeof record.path === "string" ? singleLine(record.path, 140) : undefined
    default:
      return undefined
  }
}

function formatToolDetail(
  tool: string,
  input: unknown
): Pick<ToolCallPresentation, "detail" | "detailLanguage"> {
  const record = asRecord(input)
  if (tool === "bash" && record && typeof record.command === "string") {
    return { detail: record.command, detailLanguage: "bash" }
  }
  if (tool === "apply_patch" && record && typeof record.patch === "string") {
    return { detail: record.patch, detailLanguage: "diff" }
  }
  if (input === undefined) return {}
  try {
    return { detail: JSON.stringify(input, null, 2), detailLanguage: "json" }
  } catch {
    return { detail: String(input) }
  }
}

function singleLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim()
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`
}
