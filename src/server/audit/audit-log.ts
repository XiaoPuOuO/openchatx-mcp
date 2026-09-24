import { appendFileSync, chmodSync, existsSync } from "node:fs"

import { getAgentIdentity } from "../../agent/context.js"
import { countTokens } from "../../tokenizer.js"
import {
  errorMessage,
  formatAuditEntry,
  formatAuditTime,
  summarizeToolResult,
} from "./audit-format.js"
import { createAuditRequest, type McpAuditCall, type McpAuditRequest } from "./audit-request.js"

export type { McpAuditRequest } from "./audit-request.js"

export class McpAuditLogger {
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

  startRequest(payload: unknown): McpAuditRequest {
    return createAuditRequest(
      payload,
      (toolName, argumentsValue) => this.startToolCall(toolName, argumentsValue),
      () => this.appendToolList()
    )
  }

  private startToolCall(toolName: string, argumentsValue: unknown): McpAuditCall {
    const identity = getAgentIdentity()
    let agentLabel: string | undefined
    if (identity) {
      agentLabel = identity.taskSlug ? `${identity.agent}/${identity.taskSlug}` : identity.agent
    }
    const startedAt = this.clock()
    const startedTime = this.now()
    const inputTokens = countTokens(JSON.stringify(argumentsValue ?? {}))
    let finished = false

    return {
      finish: (input = {}) => {
        if (finished) return
        finished = true

        const toolResponse = summarizeToolResult(
          input.toolResult,
          input.modelResult ?? input.toolResult,
          input.error
        )
        const httpStatus = input.httpStatus ?? 200
        const state = input.state ?? "finished"
        const exitCode = toolResponse.structuredContent?.exit_code
        const commandFailed = toolName === "bash" && typeof exitCode === "number" && exitCode !== 0
        const commandOutput = toolResponse.structuredContent?.output
        let failureMessage = toolResponse.failureMessage
        if (!failureMessage && commandFailed) {
          failureMessage =
            typeof commandOutput === "string" && commandOutput.trim()
              ? commandOutput.trim()
              : `Command exited with code ${exitCode}.`
        }

        this.append(
          formatAuditEntry({
            time: startedTime,
            toolName,
            argumentsValue,
            durationMs: Math.max(0, this.clock() - startedAt),
            httpStatus,
            state,
            inputTokens,
            outputTokens:
              toolResponse.modelOutput !== undefined
                ? countTokens(toolResponse.modelOutput)
                : undefined,
            toolFailed: toolResponse.failed || commandFailed,
            failureMessage,
            responseSummary: toolResponse,
            agentLabel,
          })
        )
      },
    }
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
