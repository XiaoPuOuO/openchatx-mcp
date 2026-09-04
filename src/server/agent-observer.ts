import { EventEmitter } from "node:events"

import type { AgentIdentity } from "./agent-context.js"

export type AgentCallStatus = "running" | "completed" | "failed"

export interface AgentCallSnapshot {
  id: string
  tool: string
  summary: string
  startedAt: number
  finishedAt?: number
  status: AgentCallStatus
}

export interface AgentInstructionSnapshot {
  id: string
  message: string
  createdAt: number
  deliveredAt?: number
}

export interface AgentSnapshot {
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

export interface AgentObserverEvent {
  type: "agent_changed"
  agent: AgentSnapshot
}

export interface AgentObserver {
  listAgents(): AgentSnapshot[]
  startTool(agent: AgentIdentity | undefined, tool: string, input: unknown): string | undefined
  finishTool(agent: AgentIdentity | undefined, callId: string | undefined): void
  failTool(agent: AgentIdentity | undefined, callId: string | undefined): void
  queueInstruction(agentId: string, message: string): AgentInstructionSnapshot | undefined
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
    events.emit("event", { type: "agent_changed", agent: toSnapshot(agent) } satisfies AgentObserverEvent)
  }

  function startTool(identity: AgentIdentity | undefined, tool: string, input: unknown): string | undefined {
    const agent = ensureAgent(identity)
    if (!agent) return undefined
    const timestamp = now()
    const call: AgentCallSnapshot = {
      id: `call-${++callCounter}`,
      tool,
      summary: summarizeTool(tool, input),
      startedAt: timestamp,
      status: "running",
    }
    agent.activeCalls.set(call.id, call)
    agent.current = call
    agent.lastSeenAt = timestamp
    emitAgent(agent)
    return call.id
  }

  function settleTool(identity: AgentIdentity | undefined, callId: string | undefined, status: "completed" | "failed"): void {
    if (!identity || !callId) return
    const agent = agentsBySession.get(identity.sessionId)
    const activeCall = agent?.activeCalls.get(callId)
    if (!agent || !activeCall) return
    const timestamp = now()
    agent.taskSlug = identity.taskSlug
    const call: AgentCallSnapshot = { ...activeCall, status, finishedAt: timestamp }
    agent.activeCalls.delete(callId)
    agent.current = latestActiveCall(agent.activeCalls)
    agent.recent = [call, ...agent.recent].slice(0, MAX_RECENT_CALLS)
    agent.lastSeenAt = timestamp
    emitAgent(agent)
  }

  function queueInstruction(agentId: string, message: string): AgentInstructionSnapshot | undefined {
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

  function drainInstructions(identity: AgentIdentity | undefined): string[] {
    if (!identity) return []
    const agent = agentsBySession.get(identity.sessionId)
    if (!agent) return []
    const timestamp = now()
    const pending = agent.instructions.filter((instruction) => instruction.deliveredAt === undefined)
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
    finishTool: (agent, callId) => settleTool(agent, callId, "completed"),
    failTool: (agent, callId) => settleTool(agent, callId, "failed"),
    queueInstruction,
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

function summarizeTool(tool: string, input: unknown): string {
  const record = asRecord(input)
  if (!record) return ""
  if (tool === "shell_run") {
    if (typeof record.command === "string") return singleLine(record.command, 140)
    if (Array.isArray(record.commands)) return `${record.commands.length} parallel commands`
  }
  if (tool === "shell_poll") {
    const shell = typeof record.shell_id === "string" ? record.shell_id : "default"
    const request = typeof record.request_id === "string" ? record.request_id : ""
    return request ? `${shell}/${request}` : shell
  }
  if (tool === "apply_patch") {
    return typeof record.cwd === "string" ? record.cwd : "Applying patch"
  }
  if (tool === "fetch_url" && typeof record.url === "string") return singleLine(record.url, 140)
  if (tool === "image_view" && typeof record.path === "string") return singleLine(record.path, 140)
  if (tool === "subagent_run" && Array.isArray(record.agents)) return `${record.agents.length} agents`

  const preferred = ["path", "cwd", "request_id", "query", "name", "task_id"]
  for (const key of preferred) {
    if (typeof record[key] === "string") return singleLine(record[key] as string, 140)
  }
  return ""
}

function singleLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
