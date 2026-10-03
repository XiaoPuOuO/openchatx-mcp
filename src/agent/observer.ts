import { EventEmitter } from "node:events"

import { agentActivityNotifier } from "../notifications/agent-activity-notifier.js"
import type { AgentIdentity } from "./context.js"
import { presentToolCall, presentToolFailure, presentToolResult } from "./tool-call-presentation.js"

type AgentCallStatus = "running" | "completed" | "failed" | "interrupted"

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

export interface AgentSnapshot {
  id: string
  taskSlug?: string
  projectId?: string
  goalId?: string
  dot?: boolean
  firstSeenAt: number
  lastSeenAt: number
  current?: AgentCallSnapshot
  recent: AgentCallSnapshot[]
  instructions: AgentInstructionSnapshot[]
  contextBudget?: {
    tokens: number
    inputTokens: number
    outputTokens: number
    threshold: number
  }
}

interface AgentState extends AgentSnapshot {
  sessionId: string
  activeCalls: Map<string, AgentCallSnapshot>
  activeCallStops: Map<string, () => void>
}

interface AgentChangedEvent {
  type: "agent_changed"
  agent: AgentSnapshot
}

interface AgentRemovedEvent {
  type: "agent_removed"
  agentId: string
}

type AgentObserverEvent = AgentChangedEvent | AgentRemovedEvent

export interface AgentObserver {
  listAgents(): AgentSnapshot[]
  deleteAgent(agentId: string): boolean
  sessionIdForAgent(agentId: string): string | undefined
  setDot(agentId: string, dot: boolean): boolean
  startTool(agent: AgentIdentity | undefined, tool: string, input: unknown): string | undefined
  registerToolStop(
    agent: AgentIdentity | undefined,
    callId: string | undefined,
    stop: () => void
  ): boolean
  stopTool(agentId: string, callId: string): boolean
  stopAllTools(): number
  finishTool(agent: AgentIdentity | undefined, callId: string | undefined, result?: unknown): void
  failTool(agent: AgentIdentity | undefined, callId: string | undefined, error?: unknown): void
  interruptTool(
    agent: AgentIdentity | undefined,
    callId: string | undefined,
    result?: unknown
  ): void
  updateContextBudget(
    agent: AgentIdentity | undefined,
    usage:
      | { tokens: number; inputTokens: number; outputTokens: number; threshold: number }
      | undefined
  ): void
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

  const listAgents = (): AgentSnapshot[] =>
    [...agentsBySession.values()]
      .map(toSnapshot)
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)

  function ensureAgent(identity: AgentIdentity | undefined): AgentState | undefined {
    if (!identity) return undefined
    const existing = agentsBySession.get(identity.sessionId)
    if (existing) {
      existing.taskSlug = identity.taskSlug
      existing.projectId = identity.projectId
      existing.goalId = identity.goalId
      existing.lastSeenAt = now()
      return existing
    }

    const timestamp = now()
    const state: AgentState = {
      id: identity.agent,
      taskSlug: identity.taskSlug,
      projectId: identity.projectId,
      goalId: identity.goalId,
      sessionId: identity.sessionId,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      recent: [],
      instructions: [],
      activeCalls: new Map(),
      activeCallStops: new Map(),
    }
    agentsBySession.set(identity.sessionId, state)
    sessionsByAgentId.set(identity.agent, identity.sessionId)
    return state
  }

  function emitAgent(agent: AgentState): void {
    events.emit("event", {
      type: "agent_changed",
      agent: toSnapshot(agent),
    } satisfies AgentChangedEvent)
  }

  function deleteAgent(agentId: string): boolean {
    const sessionId = sessionsByAgentId.get(agentId)
    if (!sessionId) return false
    sessionsByAgentId.delete(agentId)
    agentsBySession.delete(sessionId)
    events.emit("event", {
      type: "agent_removed",
      agentId,
    } satisfies AgentRemovedEvent)
    return true
  }

  function startTool(
    identity: AgentIdentity | undefined,
    tool: string,
    input: unknown
  ): string | undefined {
    if (!identity) return undefined
    const agent = ensureAgent(identity)
    if (!agent) return undefined
    agentActivityNotifier.activityStarted(identity.sessionId)
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

  function registerToolStop(
    identity: AgentIdentity | undefined,
    callId: string | undefined,
    stop: () => void
  ): boolean {
    if (!identity || !callId) return false
    const agent = agentsBySession.get(identity.sessionId)
    if (!agent?.activeCalls.has(callId)) return false
    agent.activeCallStops.set(callId, stop)
    return true
  }

  function stopTool(agentId: string, callId: string): boolean {
    const sessionId = sessionsByAgentId.get(agentId)
    const agent = sessionId ? agentsBySession.get(sessionId) : undefined
    const stop = agent?.activeCallStops.get(callId)
    if (!agent || !stop || !agent.activeCalls.has(callId)) return false
    stop()
    return true
  }

  function settleTool(
    identity: AgentIdentity | undefined,
    callId: string | undefined,
    status: "completed" | "failed" | "interrupted",
    result?: unknown
  ): void {
    if (!identity || !callId) return
    const agent = agentsBySession.get(identity.sessionId)
    const activeCall = agent?.activeCalls.get(callId)
    if (!agent || !activeCall) return
    const timestamp = now()
    agent.taskSlug = identity.taskSlug
    agent.projectId = identity.projectId
    agent.goalId = identity.goalId
    const call: AgentCallSnapshot = {
      ...activeCall,
      ...(status === "failed"
        ? presentToolFailure(result)
        : presentToolResult(activeCall.tool, result)),
      status,
      finishedAt: timestamp,
    }
    agent.activeCalls.delete(callId)
    agent.activeCallStops.delete(callId)
    agent.current = latestActiveCall(agent.activeCalls)
    agent.recent = [call, ...agent.recent].slice(0, MAX_RECENT_CALLS)
    agent.lastSeenAt = timestamp
    emitAgent(agent)
    if (agent.activeCalls.size === 0) {
      agentActivityNotifier.activitySettled(identity.sessionId, identity.taskSlug)
    }
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

  function updateContextBudget(
    identity: AgentIdentity | undefined,
    usage:
      | { tokens: number; inputTokens: number; outputTokens: number; threshold: number }
      | undefined
  ): void {
    if (!identity || !usage) return
    const agent = ensureAgent(identity)
    if (!agent) return
    agent.contextBudget = { ...usage }
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

  return {
    listAgents,
    deleteAgent,
    sessionIdForAgent: (agentId) => sessionsByAgentId.get(agentId),
    setDot: (agentId, dot) =>
      setAgentDot(agentsBySession, sessionsByAgentId, emitAgent, agentId, dot),
    startTool,
    registerToolStop,
    stopTool,
    stopAllTools: () => stopAllActiveTools(agentsBySession.values()),
    finishTool: (agent, callId, result) => settleTool(agent, callId, "completed", result),
    failTool: (agent, callId, error) => settleTool(agent, callId, "failed", error),
    interruptTool: (agent, callId, result) => settleTool(agent, callId, "interrupted", result),
    updateContextBudget,
    queueInstruction,
    cancelInstruction,
    drainInstructions,
    subscribe: (listener) => subscribeAgentEvents(events, listener),
  }
}

function subscribeAgentEvents(
  events: EventEmitter,
  listener: (event: AgentObserverEvent) => void
): () => void {
  events.on("event", listener)
  return () => events.off("event", listener)
}

function setAgentDot(
  agentsBySession: Map<string, AgentState>,
  sessionsByAgentId: Map<string, string>,
  emitAgent: (agent: AgentState) => void,
  agentId: string,
  dot: boolean
): boolean {
  const sessionId = sessionsByAgentId.get(agentId)
  const agent = sessionId ? agentsBySession.get(sessionId) : undefined
  if (!agent) return false
  agent.dot = dot || undefined
  emitAgent(agent)
  return true
}

function stopAllActiveTools(agents: Iterable<AgentState>) {
  let stopped = 0
  for (const agent of agents) {
    for (const [callId, stop] of agent.activeCallStops) {
      if (!agent.activeCalls.has(callId)) continue
      stop()
      stopped += 1
    }
  }
  return stopped
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
    projectId: agent.projectId,
    goalId: agent.goalId,
    dot: agent.dot,
    firstSeenAt: agent.firstSeenAt,
    lastSeenAt: agent.lastSeenAt,
    current: agent.current ? { ...agent.current } : undefined,
    recent: agent.recent.map((call) => ({ ...call })),
    instructions: agent.instructions.map((instruction) => ({ ...instruction })),
    contextBudget: agent.contextBudget ? { ...agent.contextBudget } : undefined,
  }
}
