import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server"

import { getAgentIdentity } from "../agent/context.js"
import type { AgentObserver } from "../agent/observer.js"
import type { McpAuditRequest } from "../server/audit/audit-log.js"
import { shellRunFileEditNotices } from "../tools/shell/apply-patch-guidance.js"
import { START_HERE_TOOL_NAME } from "../tools/start-here/start-here.js"
import type { ContextBudgetGuard } from "./context-budget.js"
import type { ProgressHeartbeatGuard } from "./progress-heartbeat.js"
import { ToolError, toToolError } from "./tool-error.js"
import { appendToolEvents, compactToolResult, normalizeToolResultImages } from "./tool-output.js"
import {
  type PreparedToolRegistration,
  prepareToolRegistration,
  type ToolRegistrationConfig,
} from "./tool-schema-presentation.js"

export interface ToolRegistrationBoundaryOptions {
  structuredOutput: boolean
  agentObserver?: AgentObserver
  auditRequest?: McpAuditRequest
  contextBudget?: ContextBudgetGuard
  progressHeartbeat?: ProgressHeartbeatGuard
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
          "Resolve Project routing before normal work with project_manage. For project work: action=list, action=upsert if needed, then action=use with project_id. For machine/global work: action=use with project_id=null. Do not bypass routing or reach for internal paths. Only glob is available while routing is pending."
        )
      }

      observedCallId = options.agentObserver?.startTool(agent, name, input)
      const userStopController = new AbortController()
      options.agentObserver?.registerToolStop(agent, observedCallId, () => {
        if (userStopController.signal.aborted) return
        userStopController.abort(new ToolError("USER_FORCED_STOP", "（被用戶強制停止）"))
      })
      const callbackContext = withToolSignal(context, userStopController.signal)
      const result = await (tool.acceptsInput
        ? tool.callback(inputValue, callbackContext)
        : tool.callback(callbackContext))
      const normalizedResult = normalizeToolResultImages(result)
      const projected =
        !tool.nativeContent && !structuredOutput
          ? compactToolResult(name, normalizedResult)
          : normalizedResult
      const resultWithEvents = appendProgressHeartbeat(
        appendToolEvents(projected, collectToolEvents(name, input, agent, options)),
        options.progressHeartbeat,
        agent
      )
      const finalResult = await applyContextBudgetNotice(
        options.contextBudget,
        options.agentObserver,
        agent,
        name,
        input,
        resultWithEvents
      )

      if (isErrorResult(finalResult))
        options.agentObserver?.failTool(agent, observedCallId, finalResult)
      else
        options.agentObserver?.finishTool(
          agent,
          observedCallId,
          isFileEditingTool(name) ? result : finalResult
        )

      auditCall?.finish({ toolResult: result, modelResult: finalResult })
      return finalResult
    } catch (error) {
      const agent = getAgentIdentity()
      const result = formatToolError(error, structuredOutput)
      const resultWithEvents = appendToolEvents(
        result,
        collectToolEvents(name, input, agent, options)
      )
      const resultWithProgress = appendProgressHeartbeat(
        resultWithEvents,
        options.progressHeartbeat,
        agent
      )
      const finalResult = await applyContextBudgetNotice(
        options.contextBudget,
        options.agentObserver,
        agent,
        name,
        input,
        resultWithProgress
      )
      options.agentObserver?.failTool(agent, observedCallId, finalResult)
      auditCall?.finish({ error, modelResult: finalResult })
      return finalResult
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

function withToolSignal(context: ServerContext, localSignal: AbortSignal): ServerContext {
  return {
    ...context,
    mcpReq: {
      ...context.mcpReq,
      signal: AbortSignal.any([context.mcpReq.signal, localSignal]),
    },
  }
}

function appendProgressHeartbeat(
  result: unknown,
  progressHeartbeat: ProgressHeartbeatGuard | undefined,
  agent: ReturnType<typeof getAgentIdentity>
): unknown {
  const instruction = progressHeartbeat?.record(agent)
  return appendToolEvents(result, instruction ? [instruction] : [])
}

async function applyContextBudgetNotice(
  contextBudget: ContextBudgetGuard | undefined,
  observer: AgentObserver | undefined,
  agent: ReturnType<typeof getAgentIdentity>,
  name: string,
  input: Record<string, unknown>,
  result: unknown
): Promise<unknown> {
  const notice = await contextBudget?.record(agent, name, input, result)
  observer?.updateContextBudget(agent, contextBudget?.usage(agent))
  return appendToolEvents(result, notice ? [notice] : [])
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

function isFileEditingTool(name: string): boolean {
  return name === "file_edit" || name === "file_write"
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
