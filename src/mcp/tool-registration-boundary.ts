import type { McpServer, ServerContext } from "@modelcontextprotocol/server"
import type { z } from "zod"

import { getAgentIdentity } from "../agent/context.js"
import type { AgentObserver } from "../agent/observer.js"
import type { McpAuditRequest } from "../server/audit/audit-log.js"
import type { ReviewPromptTracker } from "../tools/review/review-tool.js"
import { shellRunFileEditNotices } from "../tools/shell/apply-patch-guidance.js"
import { START_HERE_TOOL_NAME } from "../tools/start-here/start-here.js"
import {
  mergeThenRunResult,
  parseThenRun,
  shouldStopThenRun,
  splitThenRun,
  type ThenRunCall,
} from "./then-run.js"
import { appendToolEvents, compactToolResult } from "./tool-output.js"
import { prepareToolRegistration, type ToolRegistrationConfig } from "./tool-schema-presentation.js"

export interface ToolRegistrationBoundaryOptions {
  structuredOutput: boolean
  drainPendingEvents?: () => string[]
  agentObserver?: AgentObserver
  reviewPromptTracker?: ReviewPromptTracker
  auditRequest?: McpAuditRequest
}

interface RegisteredTool {
  callback: (...args: unknown[]) => unknown
  inputSchema?: z.ZodType
  outputSchema?: z.ZodType
  acceptsInput: boolean
  nativeContent: boolean
}

export function installToolRegistrationBoundary(
  server: McpServer,
  options: ToolRegistrationBoundaryOptions
): void {
  const originalRegisterTool = server.registerTool
  const registerTool = (name: string, config: ToolRegistrationConfig, callback: unknown): unknown =>
    Reflect.apply(originalRegisterTool, server, [name, config, callback])
  const { structuredOutput } = options
  const tools = new Map<string, RegisteredTool>()

  const dispatchTool = async (
    name: string,
    inputValue: unknown,
    context: ServerContext,
    nested = false
  ): Promise<unknown> => {
    const tool = tools.get(name)
    if (!tool) return toolError(`Tool ${name} not found.`)

    const auditInput = isRecord(inputValue) ? inputValue : {}
    const auditCall = nested
      ? options.auditRequest?.startNestedTool(name, auditInput)
      : options.auditRequest?.claimTool(context.mcpReq.id, name)
    let observedCallId: string | undefined

    try {
      const parsedInput = await parseToolInput(name, tool, inputValue, nested)
      if (parsedInput.error) {
        auditCall?.finish({ toolResult: parsedInput.error, modelResult: parsedInput.error })
        return parsedInput.error
      }

      const input = isRecord(parsedInput.value) ? parsedInput.value : {}
      const { arguments: callbackInput, thenRun } = splitThenRun(name, input)
      const agent = getAgentIdentity()
      if (agent && name !== START_HERE_TOOL_NAME && !agent.taskSlug) {
        const result = startupRequiredResult()
        auditCall?.finish({ toolResult: result, modelResult: result })
        return result
      }

      observedCallId = options.agentObserver?.startTool(agent, name, input)
      const result = await invokeTool(tool, callbackInput, context)
      if (nested) await validateToolOutput(name, tool.outputSchema, result)
      options.agentObserver?.finishTool(agent, observedCallId)

      const projected = projectToolResult(name, result, tool, nested, structuredOutput)
      const events = collectToolEvents(name, input, agent, options)
      const finalResult = appendToolEvents(projected, events)
      auditCall?.finish({ toolResult: result, modelResult: finalResult })
      return continueThenRun(name, result, thenRun, finalResult, context)
    } catch (error) {
      const agent = getAgentIdentity()
      options.agentObserver?.failTool(agent, observedCallId)
      const result = toolError(error instanceof Error ? error.message : String(error))
      auditCall?.finish({ error, modelResult: result })
      return result
    }
  }

  async function continueThenRun(
    name: string,
    result: unknown,
    thenRun: unknown,
    finalResult: unknown,
    context: ServerContext
  ): Promise<unknown> {
    if (thenRun === undefined || shouldStopThenRun(name, result)) return finalResult

    let next: ThenRunCall
    try {
      next = parseThenRun(thenRun, (toolName) => tools.has(toolName))
    } catch (error) {
      return mergeThenRunResult(
        finalResult,
        toolError(`then_run_error: ${error instanceof Error ? error.message : String(error)}`)
      )
    }
    return mergeThenRunResult(
      finalResult,
      await dispatchTool(next.name, next.arguments, context, true)
    )
  }

  const boundaryRegisterTool = (
    name: string,
    config: ToolRegistrationConfig,
    callback: unknown
  ) => {
    const registration = prepareToolRegistration(name, config, structuredOutput)

    if (typeof callback !== "function") return registerTool(name, config, callback)
    tools.set(name, {
      callback: (...args: unknown[]) => callback(...args),
      ...registration,
    })
    const wrapped = async (inputValue: unknown, context: ServerContext) =>
      dispatchTool(name, inputValue, context)
    return registerTool(name, config, wrapped)
  }
  if (!Reflect.set(server, "registerTool", boundaryRegisterTool)) {
    throw new TypeError("Could not install the MCP tool registration boundary.")
  }
}

async function parseToolInput(
  name: string,
  tool: RegisteredTool,
  inputValue: unknown,
  nested: boolean
): Promise<{ value: unknown; error?: ReturnType<typeof toolError> }> {
  const value = inputValue ?? {}
  if (!nested || !tool.inputSchema) return { value }

  const parsed = await tool.inputSchema.safeParseAsync(value)
  if (parsed.success) return { value: parsed.data }
  return {
    value,
    error: toolError(
      `Input validation error: Invalid arguments for tool ${name}: ${parsed.error.issues[0]?.message ?? "validation failed"}`
    ),
  }
}

function invokeTool(
  tool: RegisteredTool,
  callbackInput: Record<string, unknown>,
  context: unknown
): unknown {
  return tool.acceptsInput ? tool.callback(callbackInput, context) : tool.callback(context)
}

function projectToolResult(
  name: string,
  result: unknown,
  tool: RegisteredTool,
  nested: boolean,
  structuredOutput: boolean
): unknown {
  return nested || (!tool.nativeContent && !structuredOutput)
    ? compactToolResult(name, result)
    : result
}

function collectToolEvents(
  name: string,
  input: Record<string, unknown>,
  agent: ReturnType<typeof getAgentIdentity>,
  options: ToolRegistrationBoundaryOptions
): string[] {
  return [
    ...(name === "shell_run" ? shellRunFileEditNotices(input) : []),
    ...(options.drainPendingEvents?.() ?? []),
    ...(options.agentObserver?.drainInstructions(agent) ?? []),
    ...(options.reviewPromptTracker?.() ?? []),
  ]
}

async function validateToolOutput(
  toolName: string,
  schema: z.ZodType | undefined,
  result: unknown
): Promise<void> {
  if (!schema || isToolError(result)) return
  if (!isRecord(result) || result.structuredContent === undefined) {
    throw new Error(
      `Output validation error: Tool ${toolName} has an output schema but no structured content was provided`
    )
  }
  const parsed = await schema.safeParseAsync(result.structuredContent)
  if (!parsed.success)
    throw new Error(
      `Output validation error: Invalid structured content for tool ${toolName}: ${parsed.error.issues[0]?.message ?? "validation failed"}`
    )
}

function toolError(text: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  }
}

function isToolError(value: unknown): boolean {
  return isRecord(value) && value.isError === true
}

function startupRequiredResult() {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: "Shellby has not been initialized for this conversation. Call `start_here` first, and follow the instructions.",
      },
    ],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
