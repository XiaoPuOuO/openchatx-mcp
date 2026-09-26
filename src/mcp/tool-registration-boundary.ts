import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server"

import { getAgentIdentity } from "../agent/context.js"
import type { AgentObserver } from "../agent/observer.js"
import type { McpAuditRequest } from "../server/audit/audit-log.js"
import { shellRunFileEditNotices } from "../tools/shell/apply-patch-guidance.js"
import { START_HERE_TOOL_NAME } from "../tools/start-here/start-here.js"
import { ToolError, toToolError } from "./tool-error.js"
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
        throw new ToolError(
          "INITIALIZATION_REQUIRED",
          "openchatx-mcp has not been initialized for this conversation. Call `start_here` first, and follow the instructions."
        )
      }
      if (agent?.projectRouting === "pending" && !isProjectRoutingTool(name, input)) {
        throw new ToolError(
          "PROJECT_ROUTING_REQUIRED",
          "Resolve Project routing before normal work. If this task belongs to a Project, inspect registered Projects, create one if needed, then activate it with project_use. If this is a machine/global task, explicitly call project_use with project_id=null. Only glob is available for locating a project root while routing is pending."
        )
      }

      observedCallId = options.agentObserver?.startTool(agent, name, input)
      const result = await (tool.acceptsInput
        ? tool.callback(inputValue, context)
        : tool.callback(context))
      const projected =
        !tool.nativeContent && !structuredOutput ? compactToolResult(name, result) : result
      const events = collectToolEvents(name, input, agent, options)
      const finalResult = appendToolEvents(projected, events)

      if (isErrorResult(finalResult))
        options.agentObserver?.failTool(agent, observedCallId, finalResult)
      else options.agentObserver?.finishTool(agent, observedCallId, finalResult)

      auditCall?.finish({ toolResult: result, modelResult: finalResult })
      return finalResult
    } catch (error) {
      const agent = getAgentIdentity()
      const result = formatToolError(error, structuredOutput)
      options.agentObserver?.failTool(agent, observedCallId, result)
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
    ...(name === "bash" ? shellRunFileEditNotices(input) : []),
    ...(options.agentObserver?.drainInstructions(agent) ?? []),
  ]
}

function formatToolError(error: unknown, structuredOutput: boolean): CallToolResult {
  const failure = toToolError(error)
  return {
    isError: true,
    ...(structuredOutput ? { structuredContent: { error_code: failure.code } } : {}),
    content: [{ type: "text" as const, text: `${failure.code}: ${failure.message}` }],
  }
}

function isProjectRoutingTool(name: string, input: Record<string, unknown>): boolean {
  if (
    name === START_HERE_TOOL_NAME ||
    name === "summarize" ||
    name === "tool_search" ||
    name === "glob"
  )
    return true
  if (name.startsWith("project_")) return true
  return (
    name === "tool_call" &&
    typeof input.tool === "string" &&
    input.tool.startsWith("builtin:project_")
  )
}

function isErrorResult(value: unknown): boolean {
  const record = isRecord(value) ? value : undefined
  return record?.isError === true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
