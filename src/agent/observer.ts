import { EventEmitter } from "node:events"

import type { AgentIdentity } from "./context.js"
import { presentToolCall, presentToolFailure, presentToolResult } from "./tool-call-presentation.js"

type AgentCallStatus = "running" | "completed" | "failed"

interface AgentCallSnapshot {
  id: string
  tool: string
  summary: string
  detail?: string
  detailLanguage?: string
  resultDetail?: string
  resultDetailLanguage?: string
  error?: string
  startedAt: number
  finishedAt?: number
  status: AgentCallStatus
}

interface AgentInstructionSnapshot {
  id: string
  message: string
  createdAt: number
  deliveredAt?: number
}

interface AgentSnapshot {
  id: string
  taskSlug?: string
  firstSeenAt: number
  lastSeenAt: number
  current?: AgentCallSnapshot
  recent: AgentCallSnapshot[]
  instructions: AgentInstructionSnapshot[]
}

interface AgentState extends AgentSnapshot {
  sessionId: string
  activeCalls: Map<string, AgentCallSnapshot>
}

interface AgentObserverEvent {
  type: "agent_changed"
  agent: AgentSnapshot
}

export interface AgentObserver {
  listAgents(): AgentSnapshot[]
  startTool(agent: AgentIdentity | undefined, tool: string, input: unknown): string | undefined
  finishTool(agent: AgentIdentity | undefined, callId: string | undefined, result?: unknown): void
  failTool(agent: AgentIdentity | undefined, callId: string | undefined, error?: unknown): void
  queueInstruction(agentId: string, message: string): AgentInstructionSnapshot | undefined
  cancelInstruction(agentId: string, instructionId: string): boolean
  drainInstructions(agent: AgentIdentity | undefined): string[]
  subscribe(listener: (event: AgentObserverEvent) => void): () => void
}

const MAX_RECENT_CALLS = 12
const MAX_INSTRUCTIONS = 12

export function createAgentObserver(now: () => number = () => Date.now()): AgentObserver {
  const agentsBySession = new Map<string, AgentState>()
  const sessionsByAgentId = new Map<string, string>()
  const events = new EventEmitter()
  let callCounter = 0
  let instructionCounter = 0

  function listAgents(): AgentSnapshot[] {
    return [...agentsBySession.values()]
      .map(toSnapshot)
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
  }

  function ensureAgent(identity: AgentIdentity | undefined): AgentState | undefined {
    if (!identity) return undefined
    const existing = agentsBySession.get(identity.sessionId)
    if (existing) {
      existing.taskSlug = identity.taskSlug
      existing.lastSeenAt = now()
      return existing
    }

    const timestamp = now()
    const state: AgentState = {
      id: identity.agent,
      taskSlug: identity.taskSlug,
      sessionId: identity.sessionId,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      recent: [],
      instructions: [],
      activeCalls: new Map(),
    }
    agentsBySession.set(identity.sessionId, state)
    sessionsByAgentId.set(identity.agent, identity.sessionId)
    return state
  }

  function emitAgent(agent: AgentState): void {
    events.emit("event", {
      type: "agent_changed",
      agent: toSnapshot(agent),
    } satisfies AgentObserverEvent)
  }

  function startTool(
    identity: AgentIdentity | undefined,
    tool: string,
    input: unknown
  ): string | undefined {
    const agent = ensureAgent(identity)
    if (!agent) return undefined
    const timestamp = now()
    const presentation = presentToolCall(tool, input)
    const call: AgentCallSnapshot = {
      id: `call-${++callCounter}`,
      tool,
      ...presentation,
      startedAt: timestamp,
      status: "running",
    }
    agent.activeCalls.set(call.id, call)
    agent.current = call
    agent.lastSeenAt = timestamp
    emitAgent(agent)
    return call.id
  }

  function settleTool(
    identity: AgentIdentity | undefined,
    callId: string | undefined,
    status: "completed" | "failed",
    result?: unknown
  ): void {
    if (!identity || !callId) return
    const agent = agentsBySession.get(identity.sessionId)
    const activeCall = agent?.activeCalls.get(callId)
    if (!agent || !activeCall) return
    const timestamp = now()
    agent.taskSlug = identity.taskSlug
    const call: AgentCallSnapshot = {
      ...activeCall,
      ...(status === "completed"
        ? presentToolResult(activeCall.tool, result)
        : presentToolFailure(result)),
      status,
      finishedAt: timestamp,
    }
    agent.activeCalls.delete(callId)
    agent.current = latestActiveCall(agent.activeCalls)
    agent.recent = [call, ...agent.recent].slice(0, MAX_RECENT_CALLS)
    agent.lastSeenAt = timestamp
    emitAgent(agent)
  }

  function queueInstruction(
    agentId: string,
    message: string
  ): AgentInstructionSnapshot | undefined {
    const sessionId = sessionsByAgentId.get(agentId)
    const agent = sessionId ? agentsBySession.get(sessionId) : undefined
    const trimmed = message.trim()
    if (!agent || !trimmed) return undefined
    const instruction: AgentInstructionSnapshot = {
      id: `instruction-${++instructionCounter}`,
      message: trimmed,
      createdAt: now(),
    }
    agent.instructions = [instruction, ...agent.instructions].slice(0, MAX_INSTRUCTIONS)
    emitAgent(agent)
    return { ...instruction }
  }

  function cancelInstruction(agentId: string, instructionId: string): boolean {
    const sessionId = sessionsByAgentId.get(agentId)
    const agent = sessionId ? agentsBySession.get(sessionId) : undefined
    if (!agent) return false
    const instruction = agent.instructions.find((item) => item.id === instructionId)
    if (!instruction || instruction.deliveredAt !== undefined) return false
    agent.instructions = agent.instructions.filter((item) => item.id !== instructionId)
    emitAgent(agent)
    return true
  }

  function drainInstructions(identity: AgentIdentity | undefined): string[] {
    if (!identity) return []
    const agent = agentsBySession.get(identity.sessionId)
    if (!agent) return []
    const timestamp = now()
    const pending = agent.instructions.filter(
      (instruction) => instruction.deliveredAt === undefined
    )
    if (pending.length === 0) return []
    const pendingIds = new Set(pending.map((instruction) => instruction.id))
    agent.instructions = agent.instructions.map((instruction) =>
      pendingIds.has(instruction.id) ? { ...instruction, deliveredAt: timestamp } : instruction
    )
    agent.lastSeenAt = timestamp
    emitAgent(agent)
    return pending.reverse().map((instruction) => `Human instruction: ${instruction.message}`)
  }

  function subscribe(listener: (event: AgentObserverEvent) => void): () => void {
    events.on("event", listener)
    return () => events.off("event", listener)
  }

  return {
    listAgents,
    startTool,
    finishTool: (agent, callId, result) => settleTool(agent, callId, "completed", result),
    failTool: (agent, callId, error) => settleTool(agent, callId, "failed", error),
    queueInstruction,
    cancelInstruction,
    drainInstructions,
    subscribe,
  }
}

function latestActiveCall(calls: Map<string, AgentCallSnapshot>): AgentCallSnapshot | undefined {
  let latest: AgentCallSnapshot | undefined
  for (const call of calls.values()) {
    if (!latest || call.startedAt >= latest.startedAt) latest = call
  }
  return latest
}

function toSnapshot(agent: AgentState): AgentSnapshot {
  return {
    id: agent.id,
    taskSlug: agent.taskSlug,
    firstSeenAt: agent.firstSeenAt,
    lastSeenAt: agent.lastSeenAt,
    current: agent.current ? { ...agent.current } : undefined,
    recent: agent.recent.map((call) => ({ ...call })),
    instructions: agent.instructions.map((instruction) => ({ ...instruction })),
  }
}
