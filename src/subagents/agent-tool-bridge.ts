import { createHash } from "node:crypto"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"

import {
  type AgentProjectRouting,
  getAgentIdentity,
  runWithAgent,
  setAgentProjectExternalAccessAll,
  setAgentProjectId,
  setAgentProjectRoutingPending,
  setAgentTaskSlug,
} from "../agent/context.js"
import type { AgentObserver } from "../agent/observer.js"
import type { McpServerFactory } from "../mcp/server-factory.js"
import type { AgentFunction, AgentFunctionCall } from "./agent-provider.js"

const MAX_OUTPUT_CHARS = 48_000
const MAX_UI_OUTPUT_CHARS = 256_000
// Approvals may remain pending while the user is away; avoid the SDK's 60s timeout.
const SUBAGENT_TOOL_WAIT_MS = 7 * 24 * 60 * 60_000
const FUNCTION_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/u
const NON_FUNCTION_NAME_RE = /[^a-zA-Z0-9_-]/gu

export interface SubagentToolContext {
  sessionId: string
  profileId: string
  projectId?: string
  projectRouting?: AgentProjectRouting
  projectExternalAccessAll?: boolean
}

export interface OpenAgentTools {
  specs: AgentFunction[]
  bootstrapInstructions?: string
  call: (
    call: AgentFunctionCall,
    signal?: AbortSignal
  ) => Promise<{ name: string; text: string; displayText?: string; failed: boolean }>
  close: () => Promise<void>
}

export async function openSubagentTools(
  factory: McpServerFactory,
  observer: AgentObserver,
  identity: SubagentToolContext,
  bootstrap = true
): Promise<OpenAgentTools> {
  const server = factory({ agentObserver: observer })
  const client = new Client({ name: "openchatx-subagent", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const tools = await scoped(identity, () => client.listTools())
    let bootstrapInstructions: string | undefined
    if (bootstrap && tools.tools.some((tool) => tool.name === "start_here")) {
      const started = await scoped(identity, () =>
        client.callTool({
          name: "start_here",
          arguments: { mode: "coding", task_id: `subagent-${identity.profileId}` },
        })
      )
      if (started.isError)
        throw new Error(`Subagent initialization failed: ${toolResultText(started)}`)
      bootstrapInstructions = toolResultText(started)
    }
    const names = new Map<string, string>()
    const specs: AgentFunction[] = []
    for (const tool of tools.tools) {
      const name = safeFunctionName(tool.name)
      // Preserve collision-free routing between model-facing functions and MCP names.
      if (names.has(name)) continue
      names.set(name, tool.name)
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
    return {
      specs,
      ...(bootstrapInstructions ? { bootstrapInstructions } : {}),
      call: async (call, signal) => {
        const originalName = names.get(call.name)
        if (!originalName)
          return {
            name: call.name,
            failed: true,
            text: `Unknown tool ${call.name}.`,
          }
        try {
          const result = await scoped(identity, () =>
            client.callTool(
              { name: originalName, arguments: call.arguments },
              { timeout: SUBAGENT_TOOL_WAIT_MS, ...(signal ? { signal } : {}) }
            )
          )
          // Keep the model context bounded while retaining a longer log for the UI.
          const displayText = toolResultText(result, MAX_UI_OUTPUT_CHARS)
          return {
            name: call.name,
            failed: result.isError === true,
            text: truncateToolText(displayText, MAX_OUTPUT_CHARS),
            displayText,
          }
        } catch (error) {
          return {
            name: call.name,
            failed: true,
            text: error instanceof Error ? error.message : "Tool execution failed.",
          }
        }
      },
      close: () => Promise.allSettled([client.close(), server.close()]).then(() => undefined),
    }
  } catch (error) {
    await Promise.allSettled([client.close(), server.close()])
    throw error
  }
}

function scoped<T>(identity: SubagentToolContext, operation: () => T): T {
  return runWithAgent(identity.sessionId, () => {
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
  })
}

function safeFunctionName(name: string): string {
  if (FUNCTION_NAME_RE.test(name)) return name
  const stem = name.replace(NON_FUNCTION_NAME_RE, "_").slice(0, 42)
  return `${stem}_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`
}

function toolResultText(result: unknown, maxChars = MAX_OUTPUT_CHARS): string {
  if (!isRecord(result)) return truncateToolText(String(result), maxChars)
  const parts: string[] = []
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string")
        parts.push(item.text)
    }
  }
  if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent))
  return truncateToolText(parts.join("\n"), maxChars)
}

function truncateToolText(output: string, maxChars: number): string {
  return output.length <= maxChars
    ? output
    : `${output.slice(0, maxChars)}\n[Tool output truncated at ${maxChars} characters]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
