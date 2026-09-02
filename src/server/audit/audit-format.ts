import { asRecord } from "../../utils.js"

const MAX_INLINE_ARGUMENT_CHARS = 600
const MAX_SHELL_COMMAND_CHARS = 2_000
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
  sessionId?: string
}): string {
  const abnormal = input.httpStatus >= 400 || input.state !== "finished" ? ` - HTTP ${input.httpStatus} ${input.state}` : ""
  const tokenCounts = ` - ${input.inputTokens} in${input.outputTokens !== undefined ? ` / ${input.outputTokens} out` : ""}`
  const invocationMarkers = formatInvocationMarkers(input.argumentsValue)
  const tag = auditTag(input)
  const tagPrefix = tag ? `${tag} ` : ""
  const heading = `--- # ${tagPrefix}${input.toolName} - ${input.durationMs}ms${tokenCounts}${invocationMarkers}${abnormal} - ${formatAuditTime(input.time)}`
  const details = [
    formatAuditSession(input.sessionId),
    formatArguments(input.toolName, input.argumentsValue, input.toolFailed, input.failureMessage),
    formatResponseSummary(input.toolName, input.responseSummary),
  ]
    .filter(Boolean)
    .join("\n")
  return details ? `${heading}\n${details}\n\n` : `${heading}\n\n`
}

export function summarizeToolResult(toolResult: unknown, modelResult: unknown, error?: unknown): ToolResponseSummary {
  if (error !== undefined) return { failed: true, failureMessage: errorMessage(error) }

  const toolRecord = asRecord(toolResult)
  const modelRecord = asRecord(modelResult)
  const modelOutput = modelRecord ? serializeModelFacingToolResult(modelRecord) : undefined
  if (!toolRecord) return { failed: false, modelOutput }

  const structuredContent = asRecord(toolRecord.structuredContent)
  if (toolRecord.isError !== true) return { failed: false, modelOutput, structuredContent }

  const resultOutput = structuredContent && typeof structuredContent.output === "string" ? structuredContent.output : undefined
  if (resultOutput) return { failed: true, failureMessage: resultOutput, modelOutput, structuredContent }

  const content = toolRecord.content
  if (Array.isArray(content)) {
    const message = content
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== undefined)
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
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

function formatAuditSession(sessionId: string | undefined): string {
  return sessionId ? `session: ${yamlString(sessionId)}` : ""
}

function formatInvocationMarkers(value: unknown): string {
  const argumentsRecord = asRecord(value)
  if (!argumentsRecord) return ""

  const markers: string[] = []
  if (typeof argumentsRecord.max_output_tokens === "number" && Number.isFinite(argumentsRecord.max_output_tokens)) {
    markers.push(`max_output_tokens=${argumentsRecord.max_output_tokens}`)
  }
  return markers.length > 0 ? ` - ${markers.join(" - ")}` : ""
}

function auditTag(input: { durationMs: number; httpStatus: number; state: "finished" | "closed"; toolFailed: boolean }): string {
  if (input.toolFailed || input.httpStatus >= 400 || input.state !== "finished") return "!"
  if (input.durationMs >= SLOW_CALL_MS) return "~"
  return ""
}

function formatArguments(toolName: string, value: unknown, toolFailed: boolean, failureMessage?: string): string {
  const argumentsRecord = asRecord(value)
  if (!argumentsRecord) return formatGenericArguments(value)

  switch (toolName) {
    case "apply_patch":
      return formatApplyPatchArguments(argumentsRecord, toolFailed, failureMessage)
    case "shell_run":
      return formatShellRunArguments(argumentsRecord, toolFailed, failureMessage)
    case "shell_poll":
      return formatShellPollArguments(argumentsRecord, toolFailed, failureMessage)
    default:
      return formatGenericArguments(value)
  }
}

function formatApplyPatchArguments(argumentsRecord: Record<string, unknown>, toolFailed: boolean, failureMessage?: string): string {
  const patch = typeof argumentsRecord.patch === "string" ? argumentsRecord.patch : ""
  const cwd = typeof argumentsRecord.cwd === "string" ? argumentsRecord.cwd : ""
  const summary = `cwd: ${yamlString(cwd)}\npatch_chars: ${characterCount(patch)}`
  if (!toolFailed) return summary
  const message = failureMessage ? `\nmessage: ${yamlString(truncate(failureMessage, MAX_FAILED_MESSAGE_CHARS))}` : ""
  return `${summary}${message}\npatch: |-\n${indentBlock(truncate(patch, MAX_FAILED_PATCH_CHARS))}`
}

function formatShellRunArguments(argumentsRecord: Record<string, unknown>, toolFailed: boolean, failureMessage?: string): string {
  const hasCommand = Object.hasOwn(argumentsRecord, "command")
  const hasCommands = Object.hasOwn(argumentsRecord, "commands")
  const inputShape = hasCommand ? (hasCommands ? "both" : "command") : hasCommands ? "commands" : "neither"
  const command = typeof argumentsRecord.command === "string" ? argumentsRecord.command : ""
  const commands = Array.isArray(argumentsRecord.commands) ? argumentsRecord.commands : null
  const shellId = typeof argumentsRecord.shell_id === "string" ? argumentsRecord.shell_id : "default"
  const requestId = typeof argumentsRecord.request_id === "string" ? argumentsRecord.request_id : ""
  const cwd = typeof argumentsRecord.cwd === "string" ? `\ncwd: ${yamlString(argumentsRecord.cwd)}` : ""
  const message = toolFailed && failureMessage ? `\nmessage: ${yamlString(truncate(failureMessage, MAX_FAILED_MESSAGE_CHARS))}` : ""
  const fields: string[] = [`shell: ${yamlString(`${shellId}/${requestId}`)}`]
  if (inputShape === "both" || inputShape === "neither") fields.push(`input: ${inputShape}`)
  if (cwd) fields.push(cwd.slice(1))
  if (message) fields.push(message.slice(1))
  if (hasCommand) fields.push(`command: |-\n${indentBlock(truncate(command, MAX_SHELL_COMMAND_CHARS))}`)
  if (hasCommands) fields.push(`commands: |-\n${indentBlock(truncate(JSON.stringify(commands ?? argumentsRecord.commands, null, 2), MAX_SHELL_COMMAND_CHARS))}`)
  return fields.join("\n")
}

function formatShellPollArguments(argumentsRecord: Record<string, unknown>, toolFailed: boolean, failureMessage?: string): string {
  const shellId = typeof argumentsRecord.shell_id === "string" ? argumentsRecord.shell_id : "default"
  const requestId = typeof argumentsRecord.request_id === "string" ? argumentsRecord.request_id : ""
  const cursor = typeof argumentsRecord.cursor === "number" ? argumentsRecord.cursor : 0
  const message = toolFailed && failureMessage ? `\nmessage: ${yamlString(truncate(failureMessage, MAX_FAILED_MESSAGE_CHARS))}` : ""
  return `shell: ${yamlString(`${shellId}/${requestId}`)}\ncursor: ${cursor}${message}`
}

function formatGenericArguments(value: unknown): string {
  const serialized = JSON.stringify(value ?? {})
  if (characterCount(serialized) <= MAX_INLINE_ARGUMENT_CHARS) return `args: ${serialized}`
  return `args: ${yamlString(truncate(serialized, MAX_INLINE_ARGUMENT_CHARS))}`
}

function formatResponseSummary(toolName: string, summary: ToolResponseSummary): string {
  const value = summary.structuredContent
  if (!value) return ""

  switch (toolName) {
    case "shell_run":
    case "shell_poll":
      return formatShellResponseSummary(value)
    default:
      return toolName.startsWith("computer_") ? formatComputerResponseSummary(value) : ""
  }
}

function formatShellResponseSummary(value: Record<string, unknown>): string {
  const parts = [
    typeof value.status === "string" ? `status=${yamlString(value.status)}` : "",
    typeof value.exit_code === "number" || value.exit_code === null ? `exit_code=${value.exit_code}` : "",
    typeof value.cwd === "string" ? `cwd=${yamlString(value.cwd)}` : "",
    typeof value.next_cursor === "number" ? `next_cursor=${value.next_cursor}` : "",
    typeof value.output_truncated === "boolean" ? `output_truncated=${value.output_truncated}` : "",
    typeof value.output_dropped === "boolean" ? `output_dropped=${value.output_dropped}` : "",
    typeof value.dropped_output_bytes === "number" ? `dropped_output_bytes=${value.dropped_output_bytes}` : "",
  ].filter(Boolean)
  return parts.length ? `result: ${parts.join(" ")}` : ""
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
      const record = asRecord(item)
      if (!record) continue
      if (record.type === "text" && typeof record.text === "string") {
        parts.push(record.text)
      } else if (record.type !== "image") {
        parts.push(JSON.stringify(record))
      }
    }
  }
  if (value.structuredContent !== undefined) parts.push(JSON.stringify(value.structuredContent))
  return parts.length > 0 ? parts.join("\n") : undefined
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

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const
