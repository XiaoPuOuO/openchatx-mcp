const SHORT_STRING_MAX = 120
const MAX_INLINE_LINE = 240

export function compactToolResult(toolName: string, result: unknown): unknown {
  if (!isRecord(result) || result.structuredContent === undefined) return result
  const rendered = renderToolStructuredContent(toolName, result.structuredContent)
  const compact = { ...result }
  delete compact.structuredContent
  if (!rendered) return compact
  compact.content = appendTextContent(compact.content, rendered)
  return compact
}

export function formatOutputBlock(metadata: readonly string[], body?: string): string {
  const header = `---- ${metadata.filter(Boolean).join(" ")} ----`
  return body ? `${header}\n\n${body}` : header
}

export function appendToolEvents(result: unknown, events: readonly string[]): unknown {
  if (events.length === 0 || !isRecord(result)) return result
  return {
    ...result,
    content: appendTextContent(result.content, events.map((event) => `**Notice:** ${event}`).join("\n")),
  }
}

export function renderStructuredContent(value: unknown): string {
  if (isRecord(value)) return renderRecord(value, 0)
  if (Array.isArray(value)) return renderArray(value, 0)
  return `result=${formatScalar(value)}`
}

function renderToolStructuredContent(toolName: string, value: unknown): string {
  if (toolName === "shell_run" || toolName === "shell_poll") return renderShellResult(value)
  if (toolName === "apply_patch") return renderApplyPatchResult(value)
  if (toolName === "subagent_result") return renderSubagentResult(value)
  return renderStructuredContent(value)
}

function renderShellResult(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.commands) || !value.commands.every(isRecord)) return renderStructuredContent(value)

  const { commands, output, ...metadata } = value
  return renderStructuredContent({
    ...metadata,
    commands: commands.map(({ run, status, exit_code, command, ...details }) => ({
      run,
      ...(status === "completed" && typeof exit_code === "number" ? {} : { status }),
      ...(exit_code === null ? {} : { exit_code }),
      command,
      ...details,
    })),
    output,
  })
}

function renderApplyPatchResult(value: unknown): string {
  if (!isRecord(value)) return renderStructuredContent(value)

  const inline: string[] = []
  const sections: string[] = []
  if (typeof value.status === "string") inline.push(`status=${value.status}`)
  if (typeof value.exit_code === "number" || value.exit_code === null) inline.push(`exit_code=${String(value.exit_code)}`)
  if (value.output_dropped === true) inline.push("output_dropped=true")
  if (typeof value.changed === "string" && value.changed) sections.push(`changed:\n${value.changed}`)
  if (typeof value.failed === "string" && value.failed) sections.push(`failed:\n${value.failed}`)
  if (typeof value.output === "string" && value.output) sections.push(`output:\n\n${value.output}`)

  return [inline.join(" "), ...sections].filter(Boolean).join("\n\n") || renderStructuredContent(value)
}

function renderSubagentResult(value: unknown): string {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "turns") || !Array.isArray(value.turns) || !value.turns.every(isRecord)) {
    return renderStructuredContent(value)
  }
  if (value.turns.length === 0) return renderStructuredContent(value)

  return value.turns
    .map((turn) => {
      const metadata: string[] = []
      for (const key of ["turn_id", "status", "activity", "activity_age_ms"] as const) {
        const item = turn[key]
        if (item !== undefined && isInlineScalar(item)) metadata.push(`${key}=${formatScalar(item)}`)
      }
      if (metadata.length === 0) return renderRecordListItem(turn, 0)

      const bodies = [
        typeof turn.response === "string" && turn.response ? turn.response : "",
        typeof turn.error === "string" && turn.error ? turn.error : "",
      ].filter(Boolean)
      return formatOutputBlock(metadata, bodies.join("\n\n"))
    })
    .join("\n\n")
}

/**
 * Render a record as a string, with nested records indented and arrays rendered as lists.
 * @param record - The record to render. Empty values are skipped.
 * @param depth - The depth of the record.
 * @returns The rendered record as a string.
 */
function renderRecord(record: Record<string, unknown>, depth: number): string {
  const inline: string[] = []
  const sections: string[] = []

  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue
    if (isInlineScalar(value)) {
      inline.push(`${key}=${formatScalar(value)}`)
      continue
    }

    if (typeof value === "string") {
      sections.push(`${key}:${key === "output" ? "\n\n" : "\n"}${depth > 0 ? indentBlock(value) : value}`)
      continue
    }

    if (Array.isArray(value)) {
      sections.push(`${key}:\n\n${renderArray(value, depth + 1)}`)
      continue
    }

    if (isRecord(value)) {
      const nested = renderRecord(value, depth + 1)
      sections.push(nested ? `${key}:\n${indentBlock(nested)}` : `${key}={}`)
      continue
    }

    sections.push(`${key}=${minifiedJson(value)}`)
  }

  const inlineText = wrapInlineParts(inline)
  return [inlineText, ...sections].filter(Boolean).join("\n\n")
}

function renderArray(values: readonly unknown[], depth: number): string {
  if (values.length === 0) return "[]"
  if (values.every(isInlineScalar)) return minifiedJson(values)

  if (values.every(isRecord)) {
    const rendered = values.map((value) => renderRecordListItem(value, depth))
    return rendered.join(rendered.every((item) => !item.includes("\n")) ? "\n" : "\n\n")
  }

  return minifiedJson(values)
}

function renderRecordListItem(record: Record<string, unknown>, depth: number): string {
  const rendered = renderRecord(record, depth)
  if (!rendered) return "-"
  const [first = "", ...rest] = rendered.split("\n")
  return [`- ${first}`, ...rest.map((line) => (line ? `  ${line}` : ""))].join("\n")
}

function indentBlock(value: string): string {
  return value
    .split("\n")
    .map((line) => (line ? `  ${line}` : ""))
    .join("\n")
}

function appendTextContent(content: unknown, text: string): unknown[] {
  const items = Array.isArray(content) ? [...content] : []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue
    items[index] = {
      ...item,
      text: item.text ? `${item.text}\n\n${text}` : text,
    }
    return items
  }
  items.push({ type: "text", text })
  return items
}

function wrapInlineParts(parts: readonly string[]): string {
  if (parts.length === 0) return ""
  const lines: string[] = []
  let line = ""
  for (const part of parts) {
    if (!line) {
      line = part
      continue
    }
    if (line.length + 1 + part.length <= MAX_INLINE_LINE) {
      line += ` ${part}`
      continue
    }
    lines.push(line)
    line = part
  }
  if (line) lines.push(line)
  return lines.join("\n")
}

function isInlineScalar(value: unknown): boolean {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return true
  return typeof value === "string" && !value.includes("\n") && value.length <= SHORT_STRING_MAX
}

function formatScalar(value: unknown): string {
  if (value === undefined) return "undefined"
  if (typeof value !== "string") return String(value)
  if (value === "") return '""'
  if (isAmbiguousBareString(value)) return JSON.stringify(value)
  if (/^[A-Za-z0-9_./:@%+,-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function isAmbiguousBareString(value: string): boolean {
  if (value === "null" || value === "true" || value === "false" || value === "NaN" || value === "Infinity" || value === "-Infinity") return true
  return value.trim() === value && value !== "" && Number.isFinite(Number(value))
}

function minifiedJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
