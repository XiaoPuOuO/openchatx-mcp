import { createHash, randomUUID } from "node:crypto"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"

import {
  type AgentProjectRouting,
  getAgentIdentity,
  runWithAgent,
  runWithAgentId,
  setAgentProjectExternalAccessAll,
  setAgentProjectId,
  setAgentProjectRoutingPending,
  setAgentSkillSelection,
  setAgentTaskSlug,
} from "../agent/context.js"
import type { AgentObserver } from "../agent/observer.js"
import type { McpServerFactory } from "../mcp/server-factory.js"
import { agentPathsAllowed } from "./agent-path-scope.js"
import { toolDecision } from "./agent-permissions.js"
import { executeAgentProgram } from "./agent-program.js"
import type { AgentAttachment, AgentFunction, AgentFunctionCall } from "./agent-provider.js"
import type { SubagentModelProfile } from "./config.js"

const MAX_MEDIA_BYTES = 4 * 1024 * 1024
const MAX_MEDIA_ITEMS = 4
const MAX_OUTPUT_CHARS = 48_000
const MAX_UI_OUTPUT_CHARS = 256_000
// Approvals may remain pending while the user is away; avoid the SDK's 60s timeout.
const SUBAGENT_TOOL_WAIT_MS = 7 * 24 * 60 * 60_000
const FUNCTION_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/u
const NON_FUNCTION_NAME_RE = /[^a-zA-Z0-9_-]/gu
const BASE64_DATA_RE = /^[A-Za-z0-9+/=]+$/u

export interface SubagentToolContext {
  sessionId: string
  profileId: string
  agentId?: string
  projectId?: string
  projectRouting?: AgentProjectRouting
  projectExternalAccessAll?: boolean
  projectRoot?: string
  policy?: SubagentModelProfile
  approveTool?: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<void>
  onProgramStep?: (
    call: AgentFunctionCall,
    signal?: AbortSignal
  ) => Promise<{ text: string; failed: boolean; attachments?: AgentAttachment[] }>
}

export interface OpenAgentTools {
  specs: AgentFunction[]
  parallelReadOnly: ReadonlySet<string>
  bootstrapInstructions?: string
  call: (
    call: AgentFunctionCall,
    signal?: AbortSignal,
    onProgress?: (message: string) => void
  ) => Promise<{
    name: string
    text: string
    displayText?: string
    failed: boolean
    attachments?: AgentAttachment[]
  }>
  close: () => Promise<void>
}

function programEnabled(
  names: ReadonlyMap<string, string>,
  identity: SubagentToolContext
): boolean {
  if (names.has("agent_program")) return false
  if (!identity.policy) return true
  if (
    identity.policy.read_only ||
    ["plan", "explore", "review"].includes(identity.policy.agent_mode)
  )
    return false
  return toolDecision(identity.policy, "agent_program", false) !== "deny"
}

export async function openSubagentTools(
  factory: McpServerFactory,
  observer: AgentObserver,
  identity: SubagentToolContext,
  bootstrap = true
): Promise<OpenAgentTools> {
  const agentContext = { ...identity, agentId: identity.agentId ?? randomUUID() }
  const server = factory({ agentObserver: observer })
  const client = new Client({ name: "openchatx-subagent", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const tools = await scoped(agentContext, () => client.listTools())
    if (!tools.tools.some((tool) => tool.name === "skill_search"))
      scoped(agentContext, () => setAgentSkillSelection(null))
    let bootstrapInstructions: string | undefined
    if (bootstrap && tools.tools.some((tool) => tool.name === "start_here")) {
      const started = await scoped(agentContext, () =>
        client.callTool({
          name: "start_here",
          arguments: {
            mode: "coding",
            task_id: `subagent-${agentContext.profileId}`,
            agent_id: agentContext.agentId,
          },
        })
      )
      if (started.isError)
        throw new Error(`Subagent initialization failed: ${toolResultText(started)}`)
      bootstrapInstructions = toolResultText(started)
    }
    const names = new Map<string, string>()
    const parallelReadOnly = new Set<string>()
    const specs: AgentFunction[] = []
    for (const tool of tools.tools) {
      const name = safeFunctionName(tool.name)
      // Preserve collision-free routing between model-facing functions and MCP names.
      if (names.has(name)) continue
      const isReadOnly = tool.annotations?.readOnlyHint === true
      if (agentContext.policy && toolDecision(agentContext.policy, name, isReadOnly) === "deny")
        continue
      names.set(name, tool.name)
      // Only tools explicitly marked read-only may overlap with other calls.
      // Mutation-capable and unannotated tools remain sequential.
      if (tool.annotations?.readOnlyHint === true) parallelReadOnly.add(name)
      specs.push({
        name,
        description: tool.description ?? tool.name,
        parameters: isRecord(tool.inputSchema)
          ? tool.inputSchema
          : {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
      })
    }
    if (programEnabled(names, agentContext)) {
      specs.push({
        name: "agent_program",
        description:
          'Execute a constrained dataflow program of up to 24 MCP calls. Independent read-only calls overlap; writes execute sequentially. Reference earlier results using {$from: "stepId", path: "field"}. No arbitrary JavaScript is executed.',
        parameters: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              minItems: 1,
              maxItems: 24,
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  tool: { type: "string" },
                  arguments: { type: "object" },
                },
                required: ["id", "tool", "arguments"],
              },
            },
            stop_on_error: { type: "boolean" },
          },
          required: ["steps"],
        },
      })
    }
    const executeCall: OpenAgentTools["call"] = async (call, signal, onProgress) => {
      if (call.name === "agent_program" && !names.has("agent_program")) {
        const decision = agentContext.policy
          ? toolDecision(agentContext.policy, "agent_program", false, call.arguments)
          : "allow"
        if (decision === "deny")
          return { name: call.name, failed: true, text: "Program execution denied." }
        if (decision === "ask") {
          if (!agentContext.approveTool)
            return { name: call.name, failed: true, text: "Program execution requires approval." }
          await scoped(agentContext, () =>
            agentContext.approveTool?.("agent_program", call.arguments, signal)
          )
        }
        return runAgentProgram(call, {
          signal,
          onProgress,
          specs,
          names,
          readOnly: parallelReadOnly,
          executeCall,
          onProgramStep: agentContext.onProgramStep,
        })
      }
      return executeMcpTool(call, {
        signal,
        onProgress,
        identity: agentContext,
        names,
        readOnly: parallelReadOnly,
        client,
      })
    }
    return {
      specs,
      parallelReadOnly,
      ...(bootstrapInstructions ? { bootstrapInstructions } : {}),
      call: executeCall,
      close: () => Promise.allSettled([client.close(), server.close()]).then(() => undefined),
    }
  } catch (error) {
    await Promise.allSettled([client.close(), server.close()])
    throw error
  }
}

async function executeMcpTool(
  call: AgentFunctionCall,
  options: {
    signal?: AbortSignal
    onProgress?: (message: string) => void
    identity: SubagentToolContext
    names: ReadonlyMap<string, string>
    readOnly: ReadonlySet<string>
    client: Client
  }
): ReturnType<OpenAgentTools["call"]> {
  const { signal, onProgress, identity, names, readOnly, client } = options
  const originalName = names.get(call.name)
  if (!originalName) return { name: call.name, failed: true, text: `Unknown tool ${call.name}.` }
  try {
    const permission = identity.policy
      ? toolDecision(identity.policy, call.name, readOnly.has(call.name), call.arguments)
      : "allow"
    if (permission === "deny")
      return { name: call.name, failed: true, text: `Tool ${call.name} is denied for this agent.` }
    if (
      identity.policy &&
      !(await agentPathsAllowed(
        identity.policy,
        call.name,
        call.arguments,
        identity.projectRoot,
        identity.projectId
      ))
    )
      return {
        name: call.name,
        failed: true,
        text: `Tool ${call.name} is outside the permitted paths.`,
      }
    if (permission === "ask") {
      if (!identity.approveTool)
        return { name: call.name, failed: true, text: `Tool ${call.name} requires approval.` }
      await scoped(identity, () => identity.approveTool?.(originalName, call.arguments, signal))
    }
    const result = await scoped(identity, () =>
      client.callTool(
        {
          name: originalName,
          arguments: {
            ...call.arguments,
            ...(identity.agentId ? { agent_id: identity.agentId } : {}),
          },
        },
        {
          timeout: SUBAGENT_TOOL_WAIT_MS,
          ...(signal ? { signal } : {}),
          ...(onProgress
            ? {
                onprogress: (progress: { message?: string; progress: number; total?: number }) =>
                  onProgress(progress.message ?? `${progress.progress}/${progress.total ?? "?"}`),
              }
            : {}),
        }
      )
    )
    const attachments = toolResultAttachments(result)
    const displayText = toolResultText(result, MAX_UI_OUTPUT_CHARS)
    return {
      name: call.name,
      failed: result.isError === true,
      text: truncateToolText(displayText, MAX_OUTPUT_CHARS),
      displayText,
      ...(attachments.length ? { attachments } : {}),
    }
  } catch (error) {
    return {
      name: call.name,
      failed: true,
      text: error instanceof Error ? error.message : "Tool execution failed.",
    }
  }
}

async function runAgentProgram(
  call: AgentFunctionCall,
  options: {
    signal?: AbortSignal
    onProgress?: (message: string) => void
    specs: AgentFunction[]
    names: ReadonlyMap<string, string>
    readOnly: ReadonlySet<string>
    executeCall: OpenAgentTools["call"]
    onProgramStep?: SubagentToolContext["onProgramStep"]
  }
): ReturnType<OpenAgentTools["call"]> {
  const { signal, onProgress, specs, names, readOnly, executeCall, onProgramStep } = options
  try {
    if (!specs.some((spec) => spec.name === "agent_program"))
      throw new Error("Program execution is not available to this agent.")
    const attachments: AgentAttachment[] = []
    const results = await executeAgentProgram(call.arguments, {
      known: new Set(names.keys()),
      readOnly,
      signal,
      onProgress,
      call: async (name, args) => {
        const nested = { id: `program-${name}`, name, arguments: args }
        const result = onProgramStep
          ? await onProgramStep(nested, signal)
          : await executeCall(nested, signal, onProgress)
        if (result.attachments?.length)
          attachments.push(...result.attachments.slice(0, MAX_MEDIA_ITEMS - attachments.length))
        return { text: result.text, failed: result.failed }
      },
    })
    return {
      name: call.name,
      failed: results.some((result) => result.failed),
      text: JSON.stringify(results),
      ...(attachments.length ? { attachments } : {}),
    }
  } catch (error) {
    return {
      name: call.name,
      failed: true,
      text: error instanceof Error ? error.message : JSON.stringify(error),
    }
  }
}

function scoped<T>(identity: SubagentToolContext, operation: () => T): T {
  return runWithAgent(identity.sessionId, () => {
    const execute = () => {
      const current = getAgentIdentity()
      if (!current?.taskSlug) setAgentTaskSlug(`subagent-${identity.profileId}`)
      // Initialize only once: later project_manage changes belong to the subagent session.
      if (!current?.projectRouting) {
        if (identity.projectId) setAgentProjectId(identity.projectId)
        else if (identity.projectRouting === "unscoped") setAgentProjectId(undefined)
        else setAgentProjectRoutingPending()
        if (identity.projectExternalAccessAll) setAgentProjectExternalAccessAll(true)
      }
      return operation()
    }
    return identity.agentId
      ? runWithAgentId(identity.agentId, execute, identity.sessionId)
      : execute()
  })
}

function safeFunctionName(name: string): string {
  if (FUNCTION_NAME_RE.test(name)) return name
  const stem = name.replace(NON_FUNCTION_NAME_RE, "_").slice(0, 42)
  return `${stem}_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`
}

function toolBlockText(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined
  if (item.type === "text" && typeof item.text === "string") return item.text
  if (item.type === "resource_link" && typeof item.uri === "string") return `File link: ${item.uri}`
  if (item.type !== "resource" || !isRecord(item.resource)) return undefined
  const name = typeof item.resource.uri === "string" ? item.resource.uri : "file"
  if (typeof item.resource.text === "string") return `File ${name}:\n${item.resource.text}`
  if (typeof item.resource.blob === "string")
    return `Binary file ${name} (embedded; see media attachment when supported)`
  return undefined
}

function toolResultText(result: unknown, maxChars = MAX_OUTPUT_CHARS): string {
  if (!isRecord(result)) return truncateToolText(String(result), maxChars)
  const parts: string[] = []
  if (Array.isArray(result.content))
    for (const item of result.content) {
      const text = toolBlockText(item)
      if (text) parts.push(text)
    }
  if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent))
  return truncateToolText(parts.join("\n"), maxChars)
}

function mediaFromMcpBlock(item: unknown): AgentAttachment | undefined {
  if (!isRecord(item)) return undefined
  let type: AgentAttachment["type"]
  let data: unknown
  let mimeType: unknown
  if (item.type === "image" || item.type === "audio") {
    type = item.type
    data = item.data
    mimeType = item.mimeType
  } else if (item.type === "resource" && isRecord(item.resource)) {
    mimeType = item.resource.mimeType
    data = item.resource.blob
    if (typeof mimeType !== "string") return undefined
    if (mimeType.startsWith("image/")) type = "image"
    else if (mimeType.startsWith("audio/")) type = "audio"
    else return undefined
  } else return undefined
  if (typeof data !== "string" || typeof mimeType !== "string") return undefined
  // Large or invalid base64 never reaches model context.
  if (data.length > Math.ceil((MAX_MEDIA_BYTES * 4) / 3)) return undefined
  if (!BASE64_DATA_RE.test(data)) return undefined
  return { type, data, mimeType }
}

function toolResultAttachments(result: unknown): AgentAttachment[] {
  if (!isRecord(result) || !Array.isArray(result.content)) return []
  const attachments: AgentAttachment[] = []
  for (const item of result.content) {
    if (attachments.length >= MAX_MEDIA_ITEMS) break
    const media = mediaFromMcpBlock(item)
    if (media) attachments.push(media)
  }
  return attachments
}

function truncateToolText(output: string, maxChars: number): string {
  return output.length <= maxChars
    ? output
    : `${output.slice(0, maxChars)}\n[Tool output truncated at ${maxChars} characters]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
