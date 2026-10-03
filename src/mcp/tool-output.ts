const SHORT_STRING_MAX = 120
const MAX_INLINE_LINE = 240
const BARE_STRING_PATTERN = /^[A-Za-z0-9_./:@%+,-]+$/u
const IMAGE_MIME_PATTERN = /^image\//iu
const BASE64_DATA_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u
const IMAGE_DATA_URL_PATTERN = /data:(image\/[^;,\s]+);base64,([A-Za-z0-9+/=]+)/giu
const IMAGE_MOVED_MARKER = "[image moved to native MCP content]"
const TRAILING_WHITESPACE_RE = /\s+$/u

export function normalizeToolResultImages(result: unknown): unknown {
  if (!isRecord(result)) return result

  const images: Array<{ type: "image"; mimeType: string; data: string }> = []
  const normalized = { ...result }

  if (Array.isArray(result.content)) {
    normalized.content = result.content.flatMap((item) => normalizeContentItem(item, images))
  }
  if (result.structuredContent !== undefined) {
    normalized.structuredContent = extractImagePayloads(result.structuredContent, images)
  }

  if (images.length === 0) return result
  const content = Array.isArray(normalized.content) ? [...normalized.content] : []
  content.push(...images)
  normalized.content = content
  return normalized
}

export function compactToolResult(toolName: string, result: unknown): unknown {
  if (!isRecord(result) || result.structuredContent === undefined) return result
  if (
    result.isError === true &&
    isRecord(result.structuredContent) &&
    typeof result.structuredContent.error_code === "string"
  )
    return result
  const rendered = renderToolStructuredContent(toolName, result.structuredContent)
  const compact = { ...result }
  compact.structuredContent = undefined
  if (!rendered) return compact
  compact.content = appendTextContent(compact.content, rendered)
  return compact
}

export function formatOutputBlock(metadata: readonly string[], body?: string): string {
  const header = `---- ${metadata.filter(Boolean).join(" ")} ----`
  return body ? `${header}\n\n${body}` : header
}

export const USER_INTERRUPT_TEXT = "interrupted by user"

export function appendInterruptedByUser(result: unknown): unknown {
  if (!isRecord(result)) {
    const prefix = typeof result === "string" && result ? `${result}\n` : ""
    return {
      structuredContent: { interrupted: true },
      content: [{ type: "text", text: `${prefix}${USER_INTERRUPT_TEXT}` }],
    }
  }

  const interrupted = { ...result }
  let structured: unknown = result.structuredContent
  if (isRecord(structured)) structured = { ...structured, interrupted: true }
  else if (structured === undefined) structured = { interrupted: true }

  let hasStructuredOutput = false
  if (isRecord(structured) && typeof structured.output === "string") {
    structured.output = appendInterruptText(structured.output)
    hasStructuredOutput = true
  }
  interrupted.structuredContent = structured
  if (!hasStructuredOutput)
    interrupted.content = appendTextContent(result.content, USER_INTERRUPT_TEXT)
  if ("isError" in interrupted) interrupted.isError = false
  return interrupted
}

export function appendToolEvents(result: unknown, events: readonly string[]): unknown {
  if (events.length === 0 || !isRecord(result)) return result
  return {
    ...result,
    content: appendTextContent(
      result.content,
      events.map((event) => `**Notice:** ${event}`).join("\n")
    ),
  }
}

export function modelFacingToolResultText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const parts: string[] = []
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      const serialized = serializeModelFacingContentItem(item)
      if (serialized !== undefined) parts.push(serialized)
    }
  }
  if (value.structuredContent !== undefined) parts.push(JSON.stringify(value.structuredContent))
  return parts.length > 0 ? parts.join("\n") : undefined
}

export function renderStructuredContent(value: unknown): string {
  if (isRecord(value)) return renderRecord(value, 0)
  if (Array.isArray(value)) return renderArray(value, 0)
  return `result=${formatScalar(value)}`
}

function renderToolStructuredContent(toolName: string, value: unknown): string {
  if (toolName === "apply_patch") return renderApplyPatchResult(value)
  return renderStructuredContent(value)
}

function renderApplyPatchResult(value: unknown): string {
  if (!isRecord(value)) return renderStructuredContent(value)

  const inline: string[] = []
  const sections: string[] = []
  if (typeof value.status === "string") inline.push(`status=${value.status}`)
  if (typeof value.exit_code === "number" || value.exit_code === null)
    inline.push(`exit_code=${String(value.exit_code)}`)
  if (value.output_dropped === true) inline.push("output_dropped=true")
  if (typeof value.changed === "string" && value.changed)
    sections.push(`changed:\n${value.changed}`)
  if (typeof value.failed === "string" && value.failed) sections.push(`failed:\n${value.failed}`)
  if (typeof value.output === "string" && value.output) sections.push(`output:\n\n${value.output}`)

  return (
    [inline.join(" "), ...sections].filter(Boolean).join("\n\n") || renderStructuredContent(value)
  )
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
      sections.push(
        `${key}:${key === "output" ? "\n\n" : "\n"}${depth > 0 ? indentBlock(value) : value}`
      )
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

function appendInterruptText(value: string): string {
  if (!value) return USER_INTERRUPT_TEXT
  if (value.trimEnd().endsWith(USER_INTERRUPT_TEXT)) return value
  return `${value.replace(TRAILING_WHITESPACE_RE, "")}\n${USER_INTERRUPT_TEXT}`
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
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return true
  return typeof value === "string" && !value.includes("\n") && value.length <= SHORT_STRING_MAX
}

function formatScalar(value: unknown): string {
  if (value === undefined) return "undefined"
  if (typeof value !== "string") return String(value)
  if (value === "") return '""'
  if (isAmbiguousBareString(value)) return JSON.stringify(value)
  if (BARE_STRING_PATTERN.test(value)) return value
  return JSON.stringify(value)
}

function isAmbiguousBareString(value: string): boolean {
  if (
    value === "null" ||
    value === "true" ||
    value === "false" ||
    value === "NaN" ||
    value === "Infinity" ||
    value === "-Infinity"
  )
    return true
  return value.trim() === value && value !== "" && Number.isFinite(Number(value))
}

function minifiedJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function normalizeContentItem(
  value: unknown,
  images: Array<{ type: "image"; mimeType: string; data: string }>
): unknown[] {
  const record = isRecord(value) ? value : undefined
  if (!record) return [value]
  if (record.type !== "text" || typeof record.text !== "string") return [value]

  const parsed = tryParseJson(record.text)
  if (parsed !== undefined) {
    const imageCountBefore = images.length
    const normalized = extractImagePayloads(parsed, images)
    if (images.length > imageCountBefore) {
      return [{ ...record, text: JSON.stringify(normalized) }]
    }
  }

  let changed = false
  const text = record.text.replace(
    IMAGE_DATA_URL_PATTERN,
    (_match, mimeType: string, data: string) => {
      pushImage(images, mimeType, data)
      changed = true
      return IMAGE_MOVED_MARKER
    }
  )
  return changed ? [{ ...record, text }] : [value]
}

function extractImagePayloads(
  value: unknown,
  images: Array<{ type: "image"; mimeType: string; data: string }>
): unknown {
  if (Array.isArray(value)) return value.map((item) => extractImagePayloads(item, images))
  if (!isRecord(value)) return value

  if (isImagePayload(value)) {
    pushImage(images, value.mimeType, value.data)
    return {
      ...value,
      data: IMAGE_MOVED_MARKER,
    }
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, extractImagePayloads(nested, images)])
  )
}

function pushImage(
  images: Array<{ type: "image"; mimeType: string; data: string }>,
  mimeType: string,
  data: string
): void {
  if (images.some((image) => image.mimeType === mimeType && image.data === data)) return
  images.push({ type: "image", mimeType, data })
}

function isImagePayload(
  value: Record<string, unknown>
): value is Record<string, unknown> & { mimeType: string; data: string } {
  return (
    typeof value.mimeType === "string" &&
    IMAGE_MIME_PATTERN.test(value.mimeType) &&
    typeof value.data === "string" &&
    value.data.length >= 32 &&
    BASE64_DATA_PATTERN.test(value.data)
  )
}

function tryParseJson(value: string): unknown | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function serializeModelFacingContentItem(value: unknown): string | undefined {
  const record = isRecord(value) ? value : undefined
  if (!record) return undefined
  if (record.type === "text" && typeof record.text === "string") return record.text
  if (record.type === "image" || record.type === "audio") return undefined
  if (record.type === "resource") {
    const resource = isRecord(record.resource) ? record.resource : undefined
    if (resource && typeof resource.blob === "string") return undefined
  }
  return JSON.stringify(record)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
