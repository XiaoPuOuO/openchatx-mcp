import type { McpServer, ServerContext } from "@modelcontextprotocol/server"

import { getAgentIdentity } from "../agent/context.js"
import type { AgentObserver } from "../agent/observer.js"
import type { McpAuditRequest } from "../server/audit/audit-log.js"
import { shellRunFileEditNotices } from "../tools/shell/apply-patch-guidance.js"
import { START_HERE_TOOL_NAME } from "../tools/start-here/start-here.js"
import { appendToolEvents, compactToolResult } from "./tool-output.js"
import {
  type PreparedToolRegistration,
  prepareToolRegistration,
  type ToolRegistrationConfig,
} from "./tool-schema-presentation.js"

export interface ToolRegistrationBoundaryOptions {
  structuredOutput: boolean
  agentObserver?: AgentObserver
  auditRequest?: McpAuditRequest
}

interface RegisteredTool extends PreparedToolRegistration {
  callback: (...args: unknown[]) => unknown
}

export function installToolRegistrationBoundary(
  server: McpServer,
  options: ToolRegistrationBoundaryOptions
): void {
  const originalRegisterTool = server.registerTool
  const registerTool = (name: string, config: ToolRegistrationConfig, callback: unknown): unknown =>
    Reflect.apply(originalRegisterTool, server, [name, config, callback])
  const { structuredOutput } = options

  const dispatchTool = async (
    name: string,
    tool: RegisteredTool,
    inputValue: unknown,
    context: ServerContext
  ): Promise<unknown> => {
    const input = isRecord(inputValue) ? inputValue : {}
    const auditCall = options.auditRequest?.claimTool(context.mcpReq.id, name)
    let observedCallId: string | undefined

    try {
      const agent = getAgentIdentity()
      if (agent && name !== START_HERE_TOOL_NAME && !agent.taskSlug) {
        const result = startupRequiredResult()
        auditCall?.finish({ toolResult: result, modelResult: result })
        return result
      }

      observedCallId = options.agentObserver?.startTool(agent, name, input)
      const result = await (tool.acceptsInput
        ? tool.callback(inputValue, context)
        : tool.callback(context))
      options.agentObserver?.finishTool(agent, observedCallId)

      const projected =
        !tool.nativeContent && !structuredOutput ? compactToolResult(name, result) : result
      const events = collectToolEvents(name, input, agent, options)
      const finalResult = appendToolEvents(projected, events)
      auditCall?.finish({ toolResult: result, modelResult: finalResult })
      return finalResult
    } catch (error) {
      const agent = getAgentIdentity()
      options.agentObserver?.failTool(agent, observedCallId)
      const result = toolError(error instanceof Error ? error.message : String(error))
      auditCall?.finish({ error, modelResult: result })
      return result
    }
  }

  const boundaryRegisterTool = (
    name: string,
    config: ToolRegistrationConfig,
    callback: unknown
  ) => {
    const registration = prepareToolRegistration(name, config, structuredOutput)

    if (typeof callback !== "function") return registerTool(name, config, callback)
    const tool: RegisteredTool = {
      callback: (...args: unknown[]) => callback(...args),
      ...registration,
    }
    const wrapped = tool.acceptsInput
      ? (inputValue: unknown, context: ServerContext) =>
          dispatchTool(name, tool, inputValue, context)
      : (context: ServerContext) => dispatchTool(name, tool, undefined, context)
    return registerTool(name, config, wrapped)
  }
  if (!Reflect.set(server, "registerTool", boundaryRegisterTool)) {
    throw new TypeError("Could not install the MCP tool registration boundary.")
  }
}

function collectToolEvents(
  name: string,
  input: Record<string, unknown>,
  agent: ReturnType<typeof getAgentIdentity>,
  options: ToolRegistrationBoundaryOptions
): string[] {
  return [
    ...(name === "shell_run" ? shellRunFileEditNotices(input) : []),
    ...(options.agentObserver?.drainInstructions(agent) ?? []),
  ]
}

function toolError(text: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  }
}

function startupRequiredResult() {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: "openchatx-mcp has not been initialized for this conversation. Call `start_here` first, and follow the instructions.",
      },
    ],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
