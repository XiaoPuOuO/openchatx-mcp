import { join } from "node:path"
import type { Page } from "playwright-core"

import type { AgentIdentity } from "../../agent/context.js"
import { MCP_CONFIG } from "../../config.js"
import {
  type ChatGptDelegationActivity,
  type ChatGptDelegationCallContext,
  ChatGptDelegationError,
  type ChatGptDelegationPollResult,
} from "./contracts.js"
import type { AssistantResponseObservation } from "./response-observer.js"
import { createDelegationStore, DelegationStoreError } from "./store.js"

const AGENT_IDLE_TTL_MS = 30 * 60_000
const STALE_TURN_RECOVERY_MS = 3 * 60_000

type BrowserAgentStatus = "idle" | "uncertain" | ChatGptDelegationActivity

export interface BrowserAgentState {
  agentId: string
  kind: "subagent" | "clone"
  memory: boolean
  status: BrowserAgentStatus
  page?: Page
  conversationUrl?: string
  lastCompletedAt?: number
  idleExpired?: boolean
  lastUsedAt: number
  turnCount: number
}

export interface BrowserTurnState {
  turnId: string
  agentId: string
  parentAgent?: AgentIdentity
  status: "running" | "completed" | "failed"
  recoveryAttempted: boolean
  lastActivityAt: number
  response?: string
  errorCode?: string
  errorMessage?: string
  prompt: string
  observation?: AssistantResponseObservation
  settled: Promise<void>
  settle: () => void
}

export interface ActiveAgentOperation extends ChatGptDelegationCallContext {
  turnId?: string
}

interface DelegationScope {
  agents: Map<string, BrowserAgentState>
  turns: Map<string, BrowserTurnState>
  activeOperations: Map<string, ActiveAgentOperation>
  pendingEvents: string[]
}

export type IdleCleanupAction =
  | {
      kind: "recover"
      turn: BrowserTurnState
      error: ChatGptDelegationError
    }
  | {
      kind: "close-page"
      agent: BrowserAgentState
      page: Page
    }

export class DelegationLifecycle {
  private readonly store = createDelegationStore(join(MCP_CONFIG.stateDir, "subagents.sqlite"))
  private readonly scopes = new Map<AgentIdentity | undefined, DelegationScope>()
  private readonly eventHydrationAttempted = new Set<AgentIdentity | undefined>()
  private disposed = false

  get isDisposed(): boolean {
    return this.disposed
  }

  reserveOperation(
    parentAgent: AgentIdentity | undefined,
    agentId: string,
    context: ChatGptDelegationCallContext
  ): ActiveAgentOperation {
    const scope = this.getScope(parentAgent)
    const agent = scope.agents.get(agentId)
    this.assertAgentOperationAvailable(scope, agentId, agent)
    this.assertDelegatedAgentSlotAvailable(parentAgent, scope, agentId)
    const operation: ActiveAgentOperation = { ...context }
    scope.activeOperations.set(agentId, operation)
    return operation
  }

  releaseOperation(
    parentAgent: AgentIdentity | undefined,
    agentId: string,
    operation: ActiveAgentOperation
  ): void {
    const scope = this.scopes.get(parentAgent)
    if (scope?.activeOperations.get(agentId) === operation) scope.activeOperations.delete(agentId)
  }

  operationSignal(
    parentAgent: AgentIdentity | undefined,
    agentId: string
  ): AbortSignal | undefined {
    return this.scopes.get(parentAgent)?.activeOperations.get(agentId)?.signal
  }

  requireOperationSignal(
    parentAgent: AgentIdentity | undefined,
    agentId: string
  ): AbortSignal | undefined {
    const operation = this.scopes.get(parentAgent)?.activeOperations.get(agentId)
    if (!operation) {
      throw new ChatGptDelegationError("AGENT_BUSY", `Agent ${agentId} has no active operation.`)
    }
    return operation.signal
  }

  getAgent(parentAgent: AgentIdentity | undefined, agentId: string): BrowserAgentState | undefined {
    return this.scopes.get(parentAgent)?.agents.get(agentId)
  }

  createSubagentAgent(
    parentAgent: AgentIdentity | undefined,
    agentId: string,
    memory: boolean,
    now: number
  ): BrowserAgentState {
    const persisted = memory ? this.readPersistedAgent(parentAgent, agentId) : undefined
    return {
      agentId,
      kind: persisted?.kind ?? "subagent",
      memory,
      status: "idle",
      lastUsedAt: now,
      turnCount: persisted?.turnCount ?? 0,
      conversationUrl: persisted?.conversationUrl,
    }
  }

  createRestoredCloneAgent(
    parentAgent: AgentIdentity | undefined,
    agentId: string,
    now: number
  ): BrowserAgentState {
    const persisted = this.readPersistedAgent(parentAgent, agentId)
    if (persisted?.kind !== "clone") {
      throw new ChatGptDelegationError("AGENT_TARGET_LOST", `Unknown agent: ${agentId}`)
    }
    return {
      agentId,
      kind: "clone",
      memory: true,
      status: "idle",
      lastUsedAt: now,
      turnCount: persisted.turnCount,
      conversationUrl: persisted.conversationUrl,
    }
  }

  createCloneAgent(agentId: string, page: Page, now: number): BrowserAgentState {
    return {
      agentId,
      kind: "clone",
      memory: true,
      status: "idle",
      page,
      lastUsedAt: now,
      turnCount: 0,
    }
  }

  registerAgent(parentAgent: AgentIdentity | undefined, agent: BrowserAgentState): void {
    this.getScope(parentAgent).agents.set(agent.agentId, agent)
  }

  removeAgent(parentAgent: AgentIdentity | undefined, agent: BrowserAgentState): void {
    const scope = this.scopes.get(parentAgent)
    if (scope?.agents.get(agent.agentId) === agent) scope.agents.delete(agent.agentId)
  }

  resetUnsubmittedAgent(agent: BrowserAgentState): void {
    agent.status = "idle"
  }

  assertCloneAvailable(parentAgent: AgentIdentity | undefined, cloneId: string): void {
    const scope = this.getScope(parentAgent)
    if (scope.agents.has(cloneId) || this.readPersistedAgent(parentAgent, cloneId)) {
      throw new ChatGptDelegationError("AGENT_BUSY", `Clone ${cloneId} already exists.`)
    }
  }

  createTurn(
    parentAgent: AgentIdentity | undefined,
    agent: BrowserAgentState,
    prompt: string,
    now: number
  ): BrowserTurnState {
    const settlement = createTurnSettlement()
    return {
      turnId: `${agent.agentId}_turn_${agent.turnCount + 1}`,
      agentId: agent.agentId,
      parentAgent,
      status: "running",
      recoveryAttempted: false,
      lastActivityAt: now,
      prompt,
      settled: settlement.promise,
      settle: settlement.resolve,
    }
  }

  recordActivity(
    agent: BrowserAgentState,
    turn: BrowserTurnState,
    activity: ChatGptDelegationActivity | undefined,
    now: number
  ): void {
    if (activity) agent.status = activity
    turn.lastActivityAt = now
  }

  recordSubmittedTurn(
    parentAgent: AgentIdentity | undefined,
    agent: BrowserAgentState,
    turn: BrowserTurnState,
    observation: AssistantResponseObservation,
    now: number
  ): void {
    const scope = this.getScope(parentAgent)
    const operation = scope.activeOperations.get(agent.agentId)
    if (!operation) {
      throw new ChatGptDelegationError(
        "AGENT_BUSY",
        `Agent ${agent.agentId} has no active operation.`
      )
    }

    if (agent.status === "idle") agent.status = "Working"
    agent.lastUsedAt = now
    agent.turnCount += 1
    turn.observation = observation
    scope.turns.set(turn.turnId, turn)
    operation.turnId = turn.turnId
    operation.signal = undefined
    this.persistAgent(parentAgent, agent)
  }

  requireTurn(parentAgent: AgentIdentity | undefined, turnId: string): BrowserTurnState {
    const turn = this.scopes.get(parentAgent)?.turns.get(turnId)
    if (!turn) throw new ChatGptDelegationError("UNKNOWN_TURN", `Unknown agent turn: ${turnId}`)
    return turn
  }

  pollResult(
    parentAgent: AgentIdentity | undefined,
    turn: BrowserTurnState,
    now: number
  ): ChatGptDelegationPollResult {
    const agentStatus = this.scopes.get(parentAgent)?.agents.get(turn.agentId)?.status
    const activity = agentStatus === "idle" || agentStatus === "uncertain" ? undefined : agentStatus
    return {
      status: turn.status,
      activity: turn.status === "running" ? activity : undefined,
      activityAgeMs: turn.status === "running" ? Math.max(0, now - turn.lastActivityAt) : undefined,
      response: turn.response,
      errorCode: turn.errorCode,
      errorMessage: turn.errorMessage,
    }
  }

  agentForTurn(turn: BrowserTurnState): BrowserAgentState | undefined {
    return this.scopes.get(turn.parentAgent)?.agents.get(turn.agentId)
  }

  persistAgent(parentAgent: AgentIdentity | undefined, agent: BrowserAgentState): void {
    if (!agent.memory || !agent.conversationUrl) return
    try {
      this.store.set(parentAgent, agent.agentId, {
        conversationUrl: agent.conversationUrl,
        turnCount: agent.turnCount,
        kind: agent.kind,
      })
    } catch (error) {
      if (!(error instanceof DelegationStoreError)) {
        console.warn(`Unexpected subagent persistence write failure: ${unknownErrorMessage(error)}`)
      }
    }
  }

  startRecovery(turn: BrowserTurnState, agent: BrowserAgentState, now: number): boolean {
    if (turn.recoveryAttempted || !agent.conversationUrl) return false
    turn.recoveryAttempted = true
    turn.lastActivityAt = now
    agent.status = "Working"
    return true
  }

  markUncertain(agent: BrowserAgentState): void {
    agent.status = "uncertain"
  }

  detachObservation(turn: BrowserTurnState): AssistantResponseObservation | undefined {
    const observation = turn.observation
    turn.observation = undefined
    return observation
  }

  completeTurn(
    turn: BrowserTurnState,
    response: string,
    now: number
  ): AssistantResponseObservation | undefined {
    if (turn.status !== "running") return
    const scope = this.scopes.get(turn.parentAgent)
    const agent = scope?.agents.get(turn.agentId)
    if (!scope || !agent) {
      return this.failTurn(
        turn,
        new ChatGptDelegationError("AGENT_TARGET_LOST", `Agent ${turn.agentId} no longer exists.`)
      )
    }

    agent.lastCompletedAt = now
    agent.lastUsedAt = now
    agent.status = "idle"
    turn.status = "completed"
    turn.response = response
    const observation = this.settleTurn(turn)
    scope.pendingEvents.push(`agent_finished agent_id=${turn.agentId} turn_id=${turn.turnId}`)
    return observation
  }

  failTurn(turn: BrowserTurnState, error: unknown): AssistantResponseObservation | undefined {
    if (turn.status !== "running") return
    turn.status = "failed"
    turn.errorCode = error instanceof ChatGptDelegationError ? error.code : "subagent_failed"
    turn.errorMessage = error instanceof Error ? error.message : String(error)
    return this.settleTurn(turn)
  }

  drainEvents(parentAgent: AgentIdentity | undefined): string[] {
    const scope = this.getScope(parentAgent)
    if (!this.eventHydrationAttempted.has(parentAgent)) {
      this.eventHydrationAttempted.add(parentAgent)
      try {
        scope.pendingEvents.push(
          ...this.listPersistedAgents(parentAgent)
            .filter((agent) => agent.turnCount > 0)
            .map(
              (agent) =>
                `existing_agent agent_id=${agent.agentId} latest_turn_id=${agent.agentId}_turn_${agent.turnCount}`
            )
        )
      } catch (error) {
        if (!(error instanceof ChatGptDelegationError)) throw error
      }
    }
    if (scope.pendingEvents.length === 0) return []
    return scope.pendingEvents.splice(0)
  }

  idleCleanupActions(now: number): IdleCleanupAction[] {
    const actions: IdleCleanupAction[] = []
    for (const scope of this.scopes.values()) {
      for (const agent of scope.agents.values()) {
        const action = this.idleCleanupAction(scope, agent, now)
        if (action) actions.push(action)
      }
    }
    return actions
  }

  commitIdlePageClosed(agent: BrowserAgentState, page: Page): void {
    if (agent.page !== page) return
    agent.page = undefined
    if (!agent.memory) agent.idleExpired = true
  }

  dispose(): {
    agents: BrowserAgentState[]
    observations: AssistantResponseObservation[]
  } {
    this.disposed = true
    const turns = [...this.scopes.values()].flatMap((scope) => [...scope.turns.values()])
    const agents = [...this.scopes.values()].flatMap((scope) => [...scope.agents.values()])
    const observations = turns.flatMap((turn) => {
      const observation = this.detachObservation(turn)
      turn.settle()
      return observation ? [observation] : []
    })
    this.scopes.clear()
    this.eventHydrationAttempted.clear()
    this.store.close()
    return { agents, observations }
  }

  private getScope(parentAgent: AgentIdentity | undefined): DelegationScope {
    const existing = this.scopes.get(parentAgent)
    if (existing) return existing
    const scope: DelegationScope = {
      agents: new Map(),
      turns: new Map(),
      activeOperations: new Map(),
      pendingEvents: [],
    }
    this.scopes.set(parentAgent, scope)
    return scope
  }

  private assertAgentOperationAvailable(
    scope: DelegationScope,
    agentId: string,
    agent: BrowserAgentState | undefined
  ): void {
    if (agent?.idleExpired) {
      throw new ChatGptDelegationError(
        "TEMP_AGENT_EXPIRED",
        `Temporary agent ${agentId} was closed after 30 minutes of inactivity. Its conversation cannot be resumed.`
      )
    }
    if (scope.activeOperations.has(agentId)) {
      throw new ChatGptDelegationError("AGENT_BUSY", `Agent ${agentId} already has an active turn.`)
    }
    if (agent?.status === "uncertain") {
      throw new ChatGptDelegationError(
        "AGENT_BUSY",
        `Agent ${agentId} has uncertain upstream state after recovery could not confirm completion. Use another existing agent ID, or a new ID if a delegated-agent slot is available.`
      )
    }
    if (agent && agent.status !== "idle") {
      throw new ChatGptDelegationError("AGENT_BUSY", `Agent ${agentId} is still ${agent.status}.`)
    }
  }

  private idleCleanupAction(
    scope: DelegationScope,
    agent: BrowserAgentState,
    now: number
  ): IdleCleanupAction | undefined {
    const activeOperation = scope.activeOperations.get(agent.agentId)
    const activeTurn = activeOperation?.turnId ? scope.turns.get(activeOperation.turnId) : undefined
    if (activeTurn?.status === "running") {
      const idleMs = now - activeTurn.lastActivityAt
      if (agent.memory && !activeTurn.recoveryAttempted && idleMs >= STALE_TURN_RECOVERY_MS) {
        return {
          kind: "recover",
          turn: activeTurn,
          error: new ChatGptDelegationError(
            "AGENT_IDLE_EXPIRED",
            "Agent turn had no observable progress for 3 minutes."
          ),
        }
      }
      if (idleMs >= AGENT_IDLE_TTL_MS) {
        return {
          kind: "recover",
          turn: activeTurn,
          error: new ChatGptDelegationError(
            "AGENT_IDLE_EXPIRED",
            "Agent turn expired after 30 minutes without observable progress."
          ),
        }
      }
      return
    }
    if (
      (activeOperation && !activeOperation.turnId) ||
      now - agent.lastUsedAt < AGENT_IDLE_TTL_MS
    ) {
      return
    }
    const page = agent.page
    if (!page || page.isClosed()) return
    return { kind: "close-page", agent, page }
  }

  private assertDelegatedAgentSlotAvailable(
    parentAgent: AgentIdentity | undefined,
    scope: DelegationScope,
    requestedAgentId: string
  ): void {
    const agents = new Map<string, string | undefined>()

    for (const persisted of this.listPersistedAgents(parentAgent)) {
      agents.set(
        persisted.agentId,
        persisted.turnCount > 0 ? `${persisted.agentId}_turn_${persisted.turnCount}` : undefined
      )
    }
    for (const agent of scope.agents.values()) {
      const activeTurnId = scope.activeOperations.get(agent.agentId)?.turnId
      agents.set(
        agent.agentId,
        activeTurnId ??
          (agent.turnCount > 0 ? `${agent.agentId}_turn_${agent.turnCount}` : undefined)
      )
    }
    for (const [agentId, operation] of scope.activeOperations) {
      if (!agents.has(agentId)) agents.set(agentId, operation.turnId)
    }

    if (agents.has(requestedAgentId) || agents.size < MCP_CONFIG.chatGpt.maxDelegatedAgents) return

    const existing = [...agents.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([existingAgentId, turnId]) => `${existingAgentId} (latest_turn_id=${turnId ?? "pending"})`
      )
      .join(", ")
    throw new ChatGptDelegationError(
      "AGENT_LIMIT_REACHED",
      `This main agent already has the maximum ${MCP_CONFIG.chatGpt.maxDelegatedAgents} delegated agents. Reuse one of these agent IDs: ${existing}.`
    )
  }

  private settleTurn(turn: BrowserTurnState): AssistantResponseObservation | undefined {
    const observation = this.detachObservation(turn)
    const scope = this.scopes.get(turn.parentAgent)
    if (scope?.activeOperations.get(turn.agentId)?.turnId === turn.turnId) {
      scope.activeOperations.delete(turn.agentId)
    }
    turn.settle()
    return observation
  }

  private readPersistedAgent(parentAgent: AgentIdentity | undefined, agentId: string) {
    try {
      return this.store.get(parentAgent, agentId)
    } catch (error) {
      throw persistenceUnavailable(error)
    }
  }

  private listPersistedAgents(parentAgent: AgentIdentity | undefined) {
    try {
      return this.store.list(parentAgent)
    } catch (error) {
      throw persistenceUnavailable(error)
    }
  }
}

function createTurnSettlement(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function persistenceUnavailable(error: unknown): ChatGptDelegationError {
  const operation = error instanceof DelegationStoreError ? error.operation : "read"
  return new ChatGptDelegationError(
    "SUBAGENT_PERSISTENCE_UNAVAILABLE",
    `Subagent persistence is unavailable after a ${operation} failure. No new prompt was submitted.`,
    { cause: error }
  )
}

function unknownErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error)
  }
  return "Unknown error"
}
