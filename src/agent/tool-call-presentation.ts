import { asRecord } from "../utils.js"

export interface ToolCallPresentation {
  summary: string
  detail?: string
  detailLanguage?: string
}

/** Build the local dashboard presentation for one tool call without exposing observer state. */
export function presentToolCall(tool: string, input: unknown): ToolCallPresentation {
  return {
    summary: summarizeTool(tool, input),
    ...formatToolDetail(tool, input),
  }
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
    case "shell_run":
      if (typeof record.command === "string") return singleLine(record.command, 140)
      if (Array.isArray(record.commands)) return `${record.commands.length} parallel commands`
      return undefined
    case "shell_poll": {
      const shell = typeof record.shell_id === "string" ? record.shell_id : "default"
      const request = typeof record.request_id === "string" ? record.request_id : ""
      return request ? `${shell}/${request}` : shell
    }
    case "apply_patch":
      return typeof record.cwd === "string" ? record.cwd : "Applying patch"
    case "fetch_url":
      return typeof record.url === "string" ? singleLine(record.url, 140) : undefined
    case "image_view":
      return typeof record.path === "string" ? singleLine(record.path, 140) : undefined
    case "subagent_run":
      return Array.isArray(record.agents) ? `${record.agents.length} agents` : undefined
    default:
      return undefined
  }
}

function formatToolDetail(
  tool: string,
  input: unknown
): Pick<ToolCallPresentation, "detail" | "detailLanguage"> {
  const record = asRecord(input)
  if (tool === "shell_run" && record) {
    if (typeof record.command === "string")
      return { detail: record.command, detailLanguage: "bash" }
    if (Array.isArray(record.commands)) {
      const commands = record.commands
        .map((item) => asRecord(item)?.command)
        .filter((command): command is string => typeof command === "string")
      if (commands.length > 0) return { detail: commands.join("\n\n"), detailLanguage: "bash" }
    }
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
