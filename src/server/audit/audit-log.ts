import { appendFileSync, chmodSync, existsSync } from "node:fs"

import { countTokens } from "../../tokenizer.js"
import { asRecord } from "../../utils.js"
import { errorMessage, formatAuditEntry, formatAuditTime, summarizeToolResult } from "./audit-format.js"
import { createAuditRequest, type McpAuditCall, type McpAuditRequest } from "./audit-request.js"

export type { McpAuditRequest } from "./audit-request.js"

interface McpAuditContext {
  sessionId?: string
}

export class McpAuditLogger {
  private readonly sessionAliases = new Map<string, string>()
  private readonly sessionTaskSlugs = new Map<string, string>()

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
    return createAuditRequest(
      payload,
      (toolName, argumentsValue) => this.startToolCall(toolName, argumentsValue, context),
      () => this.appendToolList()
    )
  }

  private startToolCall(toolName: string, argumentsValue: unknown, context: McpAuditContext): McpAuditCall {
    const sessionId = context.sessionId ? this.sessionAlias(context.sessionId) : undefined
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
        const shellExitFailed = toolName === "shell_run" && typeof exitCode === "number" && exitCode !== 0
        const httpStatus = input.httpStatus ?? 200
        const state = input.state ?? "finished"

        this.append(
          formatAuditEntry({
            time: startedTime,
            toolName,
            argumentsValue,
            durationMs: Math.max(0, this.clock() - startedAt),
            httpStatus,
            state,
            inputTokens,
            outputTokens: toolResponse.modelOutput !== undefined ? countTokens(toolResponse.modelOutput) : undefined,
            toolFailed: toolResponse.failed || shellExitFailed,
            failureMessage: toolResponse.failureMessage,
            responseSummary: toolResponse,
            sessionId,
          })
        )

        if (toolName === "start_here" && !toolResponse.failed && httpStatus < 400 && state === "finished" && context.sessionId) {
          const argumentsRecord = asRecord(argumentsValue)
          if (typeof argumentsRecord?.task_slug === "string") this.sessionTaskSlugs.set(context.sessionId, argumentsRecord.task_slug)
        }
      },
    }
  }

  private sessionAlias(sessionId: string): string {
    const known = this.sessionAliases.get(sessionId)
    const alias = known ?? `agent-${this.sessionAliases.size + 1}`
    if (!known) this.sessionAliases.set(sessionId, alias)
    const taskSlug = this.sessionTaskSlugs.get(sessionId)
    return taskSlug ? `${alias}/${taskSlug}` : alias
  }

  private appendToolList(): void {
    this.append(`--- # tools/list - ${formatAuditTime(this.now())}\n`)
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
