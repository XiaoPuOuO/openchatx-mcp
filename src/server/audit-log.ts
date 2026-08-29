import { appendFileSync, chmodSync, existsSync } from "node:fs"

import { countTokens } from "../tokenizer.js"
import { asRecord } from "../utils.js"

const MAX_INLINE_ARGUMENT_CHARS = 600
const MAX_SHELL_COMMAND_CHARS = 2_000
const MAX_FAILED_PATCH_CHARS = 32_000
const MAX_FAILED_MESSAGE_CHARS = 1_000
const SLOW_CALL_MS = 5_000

interface JsonRpcToolCall {
  method?: unknown
  params?: {
    name?: unknown
    arguments?: unknown
  }
}

export interface McpAuditCall {
  finish(input?: {
    toolResult?: unknown
    modelResult?: unknown
    error?: unknown
    httpStatus?: number
    state?: "finished" | "closed"
  }): void
}

export interface McpAuditRequest {
  claimTool(toolName: string, argumentsValue: unknown): McpAuditCall | undefined
  finishTransport(input: { httpStatus: number; state: "finished" | "closed" }): void
}

export interface McpAuditContext {
  sessionId?: string
}

interface ToolResponseSummary {
  failed: boolean
  failureMessage?: string
  modelOutput?: string
  structuredContent?: Record<string, unknown>
}

export class McpAuditLogger {
  // Session IDS are NOT private, aliases are using to make it human readable
  private readonly sessionAliases = new Map<string, string>()

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
    private readonly clock: () => number = () => Date.now()
  ) {
    try {
      if (existsSync(this.filePath)) chmodSync(this.filePath, 0o600)
    } catch (error) {
      console.warn(`Could not secure MCP audit log: ${errorMessage(error)}`)
    }
  }

  startRequest(payload: unknown, context: McpAuditContext = {}): McpAuditRequest {
    const requests = Array.isArray(payload) ? payload : [payload]
    const pending: Array<{ name: string; argumentsValue: unknown; call: McpAuditCall; claimed: boolean }> = []
    for (const request of requests) {
      if (isToolListRequest(request)) {
        this.append(`--- # tools/list - ${formatAuditTime(this.now())}\n`)
        continue
      }
      const parsed = parseToolCall(request)
      if (!parsed) continue
      pending.push({
        name: parsed.name,
        argumentsValue: parsed.arguments,
        call: this.startToolCall(parsed.name, parsed.arguments, context),
        claimed: false,
      })
    }

    return {
      claimTool: (toolName, argumentsValue) => {
        const match =
          pending.find((item) => !item.claimed && item.name === toolName && inputMatches(item.argumentsValue, argumentsValue)) ??
          pending.find((item) => !item.claimed && item.name === toolName)
        if (!match) return undefined
        match.claimed = true
        return match.call
      },
      finishTransport: ({ httpStatus, state }) => {
        for (const item of pending) {
          if (item.claimed) continue
          item.claimed = true
          item.call.finish({
            error: new Error("tool_rejected: Tool call was rejected before execution, likely during validation or dispatch."),
            httpStatus,
            state,
          })
        }
      },
    }
  }

  startToolCalls(payload: unknown, context: McpAuditContext = {}): McpAuditCall[] {
    const requests = Array.isArray(payload) ? payload : [payload]
    return requests.flatMap((request) => {
      if (isToolListRequest(request)) {
        this.append(`--- # tools/list - ${formatAuditTime(this.now())}\n`)
        return []
      }

      const parsed = parseToolCall(request)
      if (!parsed) return []
      return [this.startToolCall(parsed.name, parsed.arguments, context)]
    })
  }

  startToolCall(toolName: string, argumentsValue: unknown, context: McpAuditContext = {}): McpAuditCall {
    const auditContext = this.aliasAuditContext(context)
    const startedAt = this.clock()
    const startedTime = this.now()
    const inputTokens = countTokens(JSON.stringify(argumentsValue ?? {}))
    let finished = false

    return {
      finish: (input = {}) => {
        if (finished) return
        finished = true
        const toolResponse = summarizeToolResult(input.toolResult, input.modelResult ?? input.toolResult, input.error)
        const exitCode = toolResponse.structuredContent?.exit_code
        const shellExitFailed = (toolName === "shell_run" || toolName === "shell_poll") && typeof exitCode === "number" && exitCode !== 0
        this.append(
          formatEntry({
            time: startedTime,
            toolName,
            argumentsValue,
            durationMs: Math.max(0, this.clock() - startedAt),
            httpStatus: input.httpStatus ?? 200,
            state: input.state ?? "finished",
            inputTokens,
            outputTokens: toolResponse.modelOutput !== undefined ? countTokens(toolResponse.modelOutput) : undefined,
            toolFailed: toolResponse.failed || shellExitFailed,
            failureMessage: toolResponse.failureMessage,
            responseSummary: toolResponse,
            context: auditContext,
          })
        )
      },
    }
  }

  private aliasAuditContext(context: McpAuditContext): McpAuditContext {
    return {
      sessionId: context.sessionId ? this.sessionAlias(context.sessionId) : undefined,
    }
  }

  private sessionAlias(sessionId: string): string {
    const known = this.sessionAliases.get(sessionId)
    if (known) return known
    const alias = `agent-${this.sessionAliases.size + 1}`
    this.sessionAliases.set(sessionId, alias)
    return alias
  }

  private append(entry: string): void {
    try {
      appendFileSync(this.filePath, entry, { encoding: "utf8", mode: 0o600 })
      chmodSync(this.filePath, 0o600)
    } catch (error) {
      console.warn(`Could not update MCP audit log: ${errorMessage(error)}`)
    }
  }
}

export function formatAuditTime(date: Date): string {
  const hours = date.getHours()
  const hour = hours % 12 || 12
  const meridiem = hours < 12 ? "AM" : "PM"
  return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()} ${hour}:${twoDigits(date.getMinutes())} ${meridiem}`
}

export function characterCount(value: string): number {
  return Array.from(value).length
}

function formatEntry(input: {
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
  context: McpAuditContext
}): string {
  const abnormal = input.httpStatus >= 400 || input.state !== "finished" ? ` - HTTP ${input.httpStatus} ${input.state}` : ""
  const tokenCounts = ` - ${input.inputTokens} in${input.outputTokens !== undefined ? ` / ${input.outputTokens} out` : ""}`
  const invocationMarkers = formatInvocationMarkers(input.argumentsValue)
  const tag = auditTag(input)
  const tagPrefix = tag ? `${tag} ` : ""
  const heading = `--- # ${tagPrefix}${input.toolName} - ${input.durationMs}ms${tokenCounts}${invocationMarkers}${abnormal} - ${formatAuditTime(input.time)}`
  const details = [
    formatAuditContext(input.context),
    formatArguments(input.toolName, input.argumentsValue, input.toolFailed, input.failureMessage),
    formatResponseSummary(input.toolName, input.responseSummary),
  ]
    .filter(Boolean)
    .join("\n")
  return details ? `${heading}\n${details}\n\n` : `${heading}\n\n`
}

function formatAuditContext(context: McpAuditContext): string {
  return context.sessionId ? `session: ${yamlString(context.sessionId)}` : ""
}

function formatInvocationMarkers(value: unknown): string {
  const argumentsRecord = asRecord(value)
  if (!argumentsRecord) return ""

  const markers: string[] = []
  if (argumentsRecord.structured === true) markers.push("structured")
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

  if (toolName === "apply_patch" && argumentsRecord) {
    const patch = typeof argumentsRecord.patch === "string" ? argumentsRecord.patch : ""
    const cwd = typeof argumentsRecord.cwd === "string" ? argumentsRecord.cwd : ""
    const summary = `cwd: ${yamlString(cwd)}\npatch_chars: ${characterCount(patch)}`
    if (!toolFailed) return summary
    const message = failureMessage ? `\nmessage: ${yamlString(truncate(failureMessage, MAX_FAILED_MESSAGE_CHARS))}` : ""
    return `${summary}${message}\npatch: |-\n${indentBlock(truncate(patch, MAX_FAILED_PATCH_CHARS))}`
  }

  if (toolName === "shell_run" && argumentsRecord) {
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

  if (toolName === "shell_poll" && argumentsRecord) {
    const shellId = typeof argumentsRecord.shell_id === "string" ? argumentsRecord.shell_id : "default"
    const requestId = typeof argumentsRecord.request_id === "string" ? argumentsRecord.request_id : ""
    const cursor = typeof argumentsRecord.cursor === "number" ? argumentsRecord.cursor : 0
    const message = toolFailed && failureMessage ? `\nmessage: ${yamlString(truncate(failureMessage, MAX_FAILED_MESSAGE_CHARS))}` : ""
    return `shell: ${yamlString(`${shellId}/${requestId}`)}\ncursor: ${cursor}${message}`
  }

  const serialized = JSON.stringify(value ?? {})
  if (characterCount(serialized) <= MAX_INLINE_ARGUMENT_CHARS) {
    return `args: ${serialized}`
  }
  return `args: ${yamlString(truncate(serialized, MAX_INLINE_ARGUMENT_CHARS))}`
}

function summarizeToolResult(toolResult: unknown, modelResult: unknown, error?: unknown): ToolResponseSummary {
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

function formatResponseSummary(toolName: string, summary: ToolResponseSummary): string {
  const value = summary.structuredContent
  if (!value) return ""

  if (toolName === "shell_run" || toolName === "shell_poll") {
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

  if (toolName.startsWith("computer_")) {
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

  return ""
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

function parseToolCall(value: unknown): { name: string; arguments?: unknown } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const request = value as JsonRpcToolCall
  if (request.method !== "tools/call") return undefined
  const name = request.params?.name
  if (typeof name !== "string" || !name) return undefined
  return { name, arguments: request.params?.arguments }
}

function inputMatches(expected: unknown, actual: unknown): boolean {
  if (Object.is(expected, actual)) return true
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => inputMatches(item, actual[index]))
  }
  const expectedRecord = asRecord(expected)
  const actualRecord = asRecord(actual)
  if (expectedRecord && actualRecord) {
    return Object.entries(expectedRecord).every(([key, value]) => Object.hasOwn(actualRecord, key) && inputMatches(value, actualRecord[key]))
  }
  return false
}

function isToolListRequest(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as JsonRpcToolCall).method === "tools/list")
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0")
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
