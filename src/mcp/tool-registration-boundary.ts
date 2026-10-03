import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server"

import { getAgentIdentity } from "../agent/context.js"
import type { AgentObserver } from "../agent/observer.js"
import type { RuntimeControlService, RuntimeToolSource } from "../runtime/runtime-control.js"
import type { McpAuditRequest } from "../server/audit/audit-log.js"
import { timelineRegistry } from "../timeline/timeline-registry.js"
import { shellRunFileEditNotices } from "../tools/shell/apply-patch-guidance.js"
import { START_HERE_TOOL_NAME } from "../tools/start-here/start-here.js"
import type { ContextBudgetGuard } from "./context-budget.js"
import type { ProgressHeartbeatGuard } from "./progress-heartbeat.js"
import { ToolError, toToolError } from "./tool-error.js"
import {
  appendInterruptedByUser,
  appendToolEvents,
  compactToolResult,
  normalizeToolResultImages,
  USER_INTERRUPT_TEXT,
} from "./tool-output.js"
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
  runtimeControl?: RuntimeControlService
}

const USER_INTERRUPT_GRACE_MS = 350

interface RegisteredTool extends PreparedToolRegistration {
  callback: (...args: unknown[]) => unknown
  source?: RuntimeToolSource
}

interface ToolDispatchState {
  observedCallId?: string
}

interface ToolDispatchOutcome {
  toolResult: unknown
  modelResult: unknown
}

async function runRegisteredTool(input: {
  name: string
  tool: RegisteredTool
  inputValue: unknown
  argumentsValue: Record<string, unknown>
  context: ServerContext
  options: ToolRegistrationBoundaryOptions
  structuredOutput: boolean
  userStopController: AbortController
  state: ToolDispatchState
}): Promise<ToolDispatchOutcome> {
  const agent = getAgentIdentity()
  const fullAccess = (await input.options.runtimeControl?.snapshot())?.accessMode === "full-access"
  enforceConversationRouting(agent, input.name, input.argumentsValue, fullAccess)

  const grant = await input.options.runtimeControl?.authorize({
    toolName: input.name,
    argumentsValue: input.argumentsValue,
    ...(input.tool.source ? { source: input.tool.source } : {}),
  })

  input.state.observedCallId = input.options.agentObserver?.startTool(
    agent,
    input.name,
    input.argumentsValue
  )
  recordTimelineEvent({
    type: "tool-started",
    label: `Started ${input.name}`,
    agent,
    toolName: input.name,
    argumentsValue: input.argumentsValue,
  })
  registerUserStop(
    input.options.agentObserver,
    agent,
    input.state.observedCallId,
    input.userStopController
  )

  const rawResult = await executeRegisteredTool(input, grant)
  const interrupted = input.userStopController.signal.aborted
  const toolResult = interrupted ? appendInterruptedByUser(rawResult) : rawResult
  const modelResult = await prepareToolModelResult({
    name: input.name,
    tool: input.tool,
    toolResult,
    argumentsValue: input.argumentsValue,
    agent,
    options: input.options,
    structuredOutput: input.structuredOutput,
  })

  settleObservedToolCall({
    observer: input.options.agentObserver,
    agent,
    callId: input.state.observedCallId,
    name: input.name,
    toolResult,
    modelResult,
    interrupted,
  })
  recordToolOutcome(input.name, agent, modelResult, interrupted)
  return { toolResult, modelResult }
}

function registerUserStop(
  observer: AgentObserver | undefined,
  agent: ReturnType<typeof getAgentIdentity>,
  callId: string | undefined,
  controller: AbortController
): void {
  observer?.registerToolStop(agent, callId, () => {
    if (controller.signal.aborted) return
    controller.abort(new ToolError("USER_FORCED_STOP", USER_INTERRUPT_TEXT))
  })
}

async function executeRegisteredTool(
  input: {
    tool: RegisteredTool
    inputValue: unknown
    context: ServerContext
    options: ToolRegistrationBoundaryOptions
    userStopController: AbortController
  },
  grant: Awaited<ReturnType<RuntimeControlService["authorize"]>> | undefined
): Promise<unknown> {
  const callbackContext = withToolSignal(input.context, input.userStopController.signal)
  const execute = () =>
    input.tool.acceptsInput
      ? input.tool.callback(input.inputValue, callbackContext)
      : input.tool.callback(callbackContext)
  const execution = Promise.resolve().then(() =>
    grant && input.options.runtimeControl
      ? input.options.runtimeControl.runWithGrant(grant, execute)
      : execute()
  )
  return waitForToolExecution(execution, input.userStopController.signal)
}

async function prepareToolModelResult(input: {
  name: string
  tool: RegisteredTool
  toolResult: unknown
  argumentsValue: Record<string, unknown>
  agent: ReturnType<typeof getAgentIdentity>
  options: ToolRegistrationBoundaryOptions
  structuredOutput: boolean
}): Promise<unknown> {
  const normalized = normalizeToolResultImages(input.toolResult)
  let projected = normalized
  if (!input.tool.nativeContent && !input.structuredOutput) {
    projected = compactToolResult(input.name, normalized)
  }
  const withEvents = appendProgressHeartbeat(
    appendToolEvents(
      projected,
      collectToolEvents(input.name, input.argumentsValue, input.agent, input.options)
    ),
    input.options.progressHeartbeat,
    input.agent
  )
  return applyContextBudgetNotice(
    input.options.contextBudget,
    input.options.agentObserver,
    input.agent,
    input.name,
    input.argumentsValue,
    withEvents
  )
}

function settleObservedToolCall(input: {
  observer?: AgentObserver
  agent: ReturnType<typeof getAgentIdentity>
  callId?: string
  name: string
  toolResult: unknown
  modelResult: unknown
  interrupted: boolean
}): void {
  const observerResult = isFileEditingTool(input.name) ? input.toolResult : input.modelResult
  if (input.interrupted) {
    input.observer?.interruptTool(input.agent, input.callId, observerResult)
    return
  }
  if (isErrorResult(input.modelResult)) {
    input.observer?.failTool(input.agent, input.callId, input.modelResult)
    return
  }
  input.observer?.finishTool(input.agent, input.callId, observerResult)
}

function recordToolOutcome(
  name: string,
  agent: ReturnType<typeof getAgentIdentity>,
  modelResult: unknown,
  interrupted: boolean
): void {
  if (interrupted) {
    recordTimelineEvent({
      type: "tool-interrupted",
      label: `Interrupted ${name}`,
      agent,
      toolName: name,
    })
    return
  }
  if (isErrorResult(modelResult)) {
    recordTimelineEvent({
      type: "tool-failed",
      label: `Failed ${name}`,
      agent,
      toolName: name,
    })
    return
  }
  recordTimelineEvent({
    type: "tool-completed",
    label: `Completed ${name}`,
    agent,
    toolName: name,
  })
}

async function handleToolDispatchError(input: {
  error: unknown
  name: string
  argumentsValue: Record<string, unknown>
  options: ToolRegistrationBoundaryOptions
  structuredOutput: boolean
  userStopController: AbortController
  state: ToolDispatchState
}): Promise<unknown> {
  const agent = getAgentIdentity()
  const interrupted = input.userStopController.signal.aborted || isUserForcedStop(input.error)
  const baseResult = interrupted
    ? appendInterruptedByUser(isRecord(input.error) ? input.error : undefined)
    : formatToolError(input.error, input.structuredOutput)
  const modelResult = await prepareErrorModelResult({
    name: input.name,
    argumentsValue: input.argumentsValue,
    agent,
    options: input.options,
    result: baseResult,
  })

  if (interrupted) {
    input.options.agentObserver?.interruptTool(agent, input.state.observedCallId, modelResult)
    recordTimelineEvent({
      type: "tool-interrupted",
      label: `Interrupted ${input.name}`,
      detail: USER_INTERRUPT_TEXT,
      agent,
      toolName: input.name,
    })
    return modelResult
  }

  input.options.agentObserver?.failTool(agent, input.state.observedCallId, modelResult)
  recordTimelineEvent({
    type: "tool-failed",
    label: `Failed ${input.name}`,
    detail: input.error instanceof Error ? input.error.message : undefined,
    agent,
    toolName: input.name,
  })
  return modelResult
}

async function prepareErrorModelResult(input: {
  name: string
  argumentsValue: Record<string, unknown>
  agent: ReturnType<typeof getAgentIdentity>
  options: ToolRegistrationBoundaryOptions
  result: unknown
}): Promise<unknown> {
  const withEvents = appendToolEvents(
    input.result,
    collectToolEvents(input.name, input.argumentsValue, input.agent, input.options)
  )
  const withProgress = appendProgressHeartbeat(
    withEvents,
    input.options.progressHeartbeat,
    input.agent
  )
  return applyContextBudgetNotice(
    input.options.contextBudget,
    input.options.agentObserver,
    input.agent,
    input.name,
    input.argumentsValue,
    withProgress
  )
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
    const argumentsValue = isRecord(inputValue) ? inputValue : {}
    const auditCall = options.auditRequest?.claimTool(context.mcpReq.id, name)
    const userStopController = new AbortController()
    const state: ToolDispatchState = {}

    try {
      const outcome = await runRegisteredTool({
        name,
        tool,
        inputValue,
        argumentsValue,
        context,
        options,
        structuredOutput,
        userStopController,
        state,
      })
      auditCall?.finish({ toolResult: outcome.toolResult, modelResult: outcome.modelResult })
      return outcome.modelResult
    } catch (error) {
      const modelResult = await handleToolDispatchError({
        error,
        name,
        argumentsValue,
        options,
        structuredOutput,
        userStopController,
        state,
      })
      auditCall?.finish({ error, modelResult })
      return modelResult
    }
  }

  const boundaryRegisterTool = (
    name: string,
    config: ToolRegistrationConfig,
    callback: unknown
  ) => {
    const registration = prepareToolRegistration(name, config, structuredOutput)

    if (typeof callback !== "function") return registerTool(name, config, callback)
    const source = runtimeToolSource(config)
    const tool: RegisteredTool = {
      callback: (...args: unknown[]) => callback(...args),
      ...registration,
      ...(source ? { source } : {}),
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

async function waitForToolExecution(
  execution: Promise<unknown>,
  userStopSignal: AbortSignal
): Promise<unknown> {
  if (userStopSignal.aborted) {
    throw userStopSignal.reason ?? new ToolError("USER_FORCED_STOP", USER_INTERRUPT_TEXT)
  }

  return new Promise((resolvePromise, reject) => {
    let settled = false
    let interruptTimer: NodeJS.Timeout | undefined

    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      if (interruptTimer) clearTimeout(interruptTimer)
      userStopSignal.removeEventListener("abort", onAbort)
      action()
    }
    const onAbort = () => {
      if (settled || interruptTimer) return
      interruptTimer = setTimeout(() => {
        settle(() =>
          reject(userStopSignal.reason ?? new ToolError("USER_FORCED_STOP", USER_INTERRUPT_TEXT))
        )
      }, USER_INTERRUPT_GRACE_MS)
      interruptTimer.unref()
    }

    userStopSignal.addEventListener("abort", onAbort, { once: true })
    execution.then(
      (result) => settle(() => resolvePromise(result)),
      (error) => settle(() => reject(error))
    )
  })
}

function isUserForcedStop(value: unknown): value is ToolError {
  return value instanceof ToolError && value.code === "USER_FORCED_STOP"
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

function recordTimelineEvent(input: {
  type: "tool-started" | "tool-completed" | "tool-failed" | "tool-interrupted"
  label: string
  detail?: string
  agent: ReturnType<typeof getAgentIdentity>
  toolName: string
  argumentsValue?: Record<string, unknown>
}): void {
  void timelineRegistry
    .append({
      type: input.type,
      label: input.label,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.agent ? { agentId: input.agent.agent } : {}),
      ...(input.agent?.projectId ? { projectId: input.agent.projectId } : {}),
      toolName: input.toolName,
      ...(input.argumentsValue ? { argumentsValue: input.argumentsValue } : {}),
    })
    .catch(() => undefined)
}

function enforceConversationRouting(
  agent: ReturnType<typeof getAgentIdentity>,
  name: string,
  input: Record<string, unknown>,
  fullAccess: boolean
): void {
  if (agent && name !== START_HERE_TOOL_NAME && !agent.taskSlug) {
    throw new ToolError(
      "INITIALIZATION_REQUIRED",
      "openchatx-mcp has not been initialized for this conversation. Call `start_here` first, and follow the instructions."
    )
  }
  if (fullAccess || agent?.projectRouting !== "pending" || isProjectRoutingTool(name, input)) return
  throw new ToolError(
    "PROJECT_ROUTING_REQUIRED",
    "Resolve Project routing before normal work with project_manage. For project work: action=list, action=upsert if needed, then action=use with project_id. For machine/global work: action=use with project_id=null. Do not bypass routing or reach for internal paths. Only glob is available while routing is pending."
  )
}

function runtimeToolSource(config: ToolRegistrationConfig): RuntimeToolSource | undefined {
  const meta = isRecord(config._meta) ? config._meta : undefined
  const annotations = isRecord(config.annotations) ? config.annotations : undefined
  const hints = {
    ...(annotations?.readOnlyHint === true ? { readOnlyHint: true } : {}),
    ...(annotations?.destructiveHint === true ? { destructiveHint: true } : {}),
    ...(annotations?.openWorldHint === true ? { openWorldHint: true } : {}),
  }

  const toolboxId = meta?.["openchatx/toolbox"]
  if (typeof toolboxId === "string" && toolboxId) {
    const originalTool = meta?.["openchatx/originalTool"]
    return {
      kind: "toolbox",
      id: toolboxId,
      ...(typeof originalTool === "string" && originalTool
        ? { canonicalToolName: originalTool }
        : {}),
      ...hints,
    }
  }
  const externalServer = meta?.["shellby/externalServer"]
  if (typeof externalServer === "string" && externalServer) {
    const originalTool = meta?.["shellby/originalTool"]
    return {
      kind: "mcp",
      id: externalServer,
      ...(typeof originalTool === "string" && originalTool
        ? { canonicalToolName: originalTool }
        : {}),
      ...hints,
    }
  }
  return { kind: "builtin", ...hints }
}

function isErrorResult(value: unknown): boolean {
  const record = isRecord(value) ? value : undefined
  return record?.isError === true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
