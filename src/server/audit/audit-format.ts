import { asRecord } from "../../utils.js"

const MAX_INLINE_ARGUMENT_CHARS = 600
const MAX_COMMAND_CHARS = 2_000
const MAX_FAILED_PATCH_CHARS = 32_000
const MAX_FAILED_MESSAGE_CHARS = 1_000
const SLOW_CALL_MS = 5_000

export interface ToolResponseSummary {
  failed: boolean
  failureMessage?: string
  modelOutput?: string
  structuredContent?: Record<string, unknown>
}

export function formatAuditEntry(input: {
  time: Date
  toolName: string
  argumentsValue: unknown
  durationMs: number
  httpStatus: number
  state: "finished" | "closed"
  inputTokens: number
  outputTokens?: number
  toolFailed: boolean
  failureMessage?: string
  responseSummary: ToolResponseSummary
  agentLabel?: string
}): string {
  const abnormal =
    input.httpStatus >= 400 || input.state !== "finished"
      ? ` - HTTP ${input.httpStatus} ${input.state}`
      : ""
  const tokenCounts = ` - ${input.inputTokens} in${input.outputTokens !== undefined ? ` / ${input.outputTokens} out` : ""}`
  const tag = auditTag(input)
  const tagPrefix = tag ? `${tag} ` : ""
  const heading = `--- # ${tagPrefix}${input.toolName} - ${input.durationMs}ms${tokenCounts}${abnormal} - ${formatAuditTime(input.time)}`
  const details = [
    formatAgentLabel(input.agentLabel),
    formatArguments(input.toolName, input.argumentsValue, input.toolFailed, input.failureMessage),
    formatResponseSummary(input.toolName, input.responseSummary),
  ]
    .filter(Boolean)
    .join("\n")
  return details ? `${heading}\n${details}\n\n` : `${heading}\n\n`
}

export function summarizeToolResult(
  toolResult: unknown,
  modelResult: unknown,
  error?: unknown
): ToolResponseSummary {
  if (error !== undefined) return { failed: true, failureMessage: errorMessage(error) }

  const toolRecord = asRecord(toolResult)
  const modelRecord = asRecord(modelResult)
  const modelOutput = modelRecord ? serializeModelFacingToolResult(modelRecord) : undefined
  if (!toolRecord) return { failed: false, modelOutput }

  const structuredContent = asRecord(toolRecord.structuredContent)
  if (toolRecord.isError !== true) return { failed: false, modelOutput, structuredContent }

  const resultOutput =
    structuredContent && typeof structuredContent.output === "string"
      ? structuredContent.output
      : undefined
  if (resultOutput)
    return { failed: true, failureMessage: resultOutput, modelOutput, structuredContent }

  const content = toolRecord.content
  if (Array.isArray(content)) {
    const message = content
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== undefined)
      .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
      .join("\n")
    if (message) return { failed: true, failureMessage: message, modelOutput, structuredContent }
  }
  return { failed: true, modelOutput, structuredContent }
}

export function formatAuditTime(date: Date): string {
  const hours = date.getHours()
  const hour = hours % 12 || 12
  const meridiem = hours < 12 ? "AM" : "PM"
  return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()} ${hour}:${twoDigits(date.getMinutes())} ${meridiem}`
}

function characterCount(value: string): number {
  return Array.from(value).length
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatAgentLabel(agentLabel: string | undefined): string {
  return agentLabel ? `session: ${yamlString(agentLabel)}` : ""
}

function auditTag(input: {
  durationMs: number
  httpStatus: number
  state: "finished" | "closed"
  toolFailed: boolean
}): "!" | "~" | "" {
  if (input.toolFailed || input.httpStatus >= 400 || input.state !== "finished") return "!"
  if (input.durationMs >= SLOW_CALL_MS) return "~"
  return ""
}

function formatArguments(
  toolName: string,
  value: unknown,
  toolFailed: boolean,
  failureMessage?: string
): string {
  const argumentsRecord = asRecord(value)
  if (!argumentsRecord) return formatGenericArguments(value)

  switch (toolName) {
    case "apply_patch":
      return formatApplyPatchArguments(argumentsRecord, toolFailed, failureMessage)
    case "file_write":
      return formatFileWriteArguments(argumentsRecord, toolFailed, failureMessage)
    case "bash":
      return formatBashArguments(argumentsRecord, toolFailed, failureMessage)
    default:
      return formatGenericArguments(value)
  }
}

function formatFileWriteArguments(
  argumentsRecord: Record<string, unknown>,
  toolFailed: boolean,
  failureMessage?: string
): string {
  const fields = [
    typeof argumentsRecord.filePath === "string"
      ? `filePath: ${yamlString(argumentsRecord.filePath)}`
      : "",
    typeof argumentsRecord.content === "string"
      ? `content_chars: ${argumentsRecord.content.length}`
      : "",
  ].filter(Boolean)
  if (toolFailed && failureMessage)
    fields.push(`message: ${yamlString(truncate(failureMessage, MAX_FAILED_MESSAGE_CHARS))}`)
  return fields.join("\n")
}

function formatApplyPatchArguments(
  argumentsRecord: Record<string, unknown>,
  toolFailed: boolean,
  failureMessage?: string
): string {
  const patch = typeof argumentsRecord.patch === "string" ? argumentsRecord.patch : ""
  const cwd = typeof argumentsRecord.cwd === "string" ? argumentsRecord.cwd : ""
  const summary = `cwd: ${yamlString(cwd)}\npatch_chars: ${characterCount(patch)}`
  if (!toolFailed) return summary
  const message = failureMessage
    ? `\nmessage: ${yamlString(truncate(failureMessage, MAX_FAILED_MESSAGE_CHARS))}`
    : ""
  return `${summary}${message}\npatch: |-\n${indentBlock(truncate(patch, MAX_FAILED_PATCH_CHARS))}`
}

function formatBashArguments(
  argumentsRecord: Record<string, unknown>,
  toolFailed: boolean,
  failureMessage?: string
): string {
  const command = typeof argumentsRecord.command === "string" ? argumentsRecord.command : ""
  const workdir =
    typeof argumentsRecord.workdir === "string"
      ? `workdir: ${yamlString(argumentsRecord.workdir)}`
      : ""
  const message =
    toolFailed && failureMessage
      ? `message: ${yamlString(truncate(failureMessage, MAX_FAILED_MESSAGE_CHARS))}`
      : ""
  const fields: string[] = []
  if (workdir) fields.push(workdir)
  pushExplicitNumberArgument(fields, argumentsRecord, "timeout_ms")
  pushExplicitNumberArgument(fields, argumentsRecord, "max_output_tokens")
  if (message) fields.push(message)
  if (command) fields.push(`command: |-\n${indentBlock(truncate(command, MAX_COMMAND_CHARS))}`)
  return fields.join("\n")
}

function pushExplicitNumberArgument(
  fields: string[],
  argumentsRecord: Record<string, unknown>,
  key: string
): void {
  const value = argumentsRecord[key]
  if (Object.hasOwn(argumentsRecord, key) && typeof value === "number" && Number.isFinite(value))
    fields.push(`${key}: ${value}`)
}

function formatGenericArguments(value: unknown): string {
  const serialized = JSON.stringify(value ?? {})
  if (characterCount(serialized) <= MAX_INLINE_ARGUMENT_CHARS) return `args: ${serialized}`
  return `args: ${yamlString(truncate(serialized, MAX_INLINE_ARGUMENT_CHARS))}`
}

function formatResponseSummary(toolName: string, summary: ToolResponseSummary): string {
  const value = summary.structuredContent
  if (!value) return ""

  if (toolName === "bash") {
    const parts = [
      typeof value.exit_code === "number" ? `exit_code=${value.exit_code}` : "",
      typeof value.cwd === "string" ? `cwd=${yamlString(value.cwd)}` : "",
      value.timed_out === true ? "timed_out=true" : "",
      value.output_truncated === true ? "output_truncated=true" : "",
    ].filter(Boolean)
    return parts.length ? `result: ${parts.join(" ")}` : ""
  }
  return toolName.startsWith("computer_") ? formatComputerResponseSummary(value) : ""
}

function formatComputerResponseSummary(value: Record<string, unknown>): string {
  const parts = [
    typeof value.snapshot_id === "string" ? `snapshot_id=${yamlString(value.snapshot_id)}` : "",
    typeof value.application_name === "string" ? `app=${yamlString(value.application_name)}` : "",
    typeof value.window_title === "string" ? `window=${yamlString(value.window_title)}` : "",
    typeof value.is_dialog === "boolean" ? `dialog=${value.is_dialog}` : "",
    typeof value.capture_mode === "string" ? `capture_mode=${yamlString(value.capture_mode)}` : "",
    typeof value.element_count === "number" ? `elements=${value.element_count}` : "",
    typeof value.interactable_count === "number" ? `interactable=${value.interactable_count}` : "",
  ].filter(Boolean)
  return parts.length ? `result: ${parts.join(" ")}` : ""
}

function serializeModelFacingToolResult(value: Record<string, unknown>): string | undefined {
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

function serializeModelFacingContentItem(value: unknown): string | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  if (record.type === "text" && typeof record.text === "string") return record.text
  if (record.type === "image" || record.type === "audio") return undefined
  if (record.type === "resource") {
    const resource = asRecord(record.resource)
    if (resource && typeof resource.blob === "string") return undefined
  }
  return JSON.stringify(record)
}

function indentBlock(content: string): string {
  return content
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function truncate(value: string, maxChars: number): string {
  const characters = Array.from(value)
  if (characters.length <= maxChars) return value
  const omitted = characters.length - maxChars
  return `${characters.slice(0, maxChars).join("")}… [${omitted} chars omitted]`
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0")
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const
