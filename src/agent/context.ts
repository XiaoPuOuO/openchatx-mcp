import { AsyncLocalStorage } from "node:async_hooks"
import { isAbsolute, relative, resolve, sep } from "node:path"

export type AgentProjectRouting = "pending" | "project" | "unscoped"
export type AgentSkillRouting = "pending" | "searched" | "selected" | "skipped"

export interface AgentIdentity {
  readonly sessionId: string
  readonly agent: string
  readonly agentId?: string
  readonly parentSessionId?: string
  readonly isDot?: boolean
  readonly taskSlug?: string
  readonly projectId?: string
  readonly projectRouting?: AgentProjectRouting
  readonly skillRouting?: AgentSkillRouting
  readonly skillSearchResults?: readonly string[]
  readonly goalId?: string
  readonly projectExternalAccessAll?: boolean
}

interface StoredAgentIdentity {
  sessionId: string
  agent: string
  agentId?: string
  parentSessionId?: string
  isDot?: boolean
  taskSlug?: string
  projectId?: string
  projectRouting?: AgentProjectRouting
  skillRouting?: AgentSkillRouting
  skillSearchResults?: string[]
  selectedSkill?: string | null
  goalId?: string
  projectExternalAccessAll?: boolean
  projectExternalAccessOnce?: string[]
}

const agents = new Map<string, StoredAgentIdentity>()
const agentIdsByParentSession = new Map<string, Set<string>>()
const parentSessionsByAgentId = new Map<string, Set<string>>()
const currentAgent = new AsyncLocalStorage<StoredAgentIdentity>()

export function runWithAgent<T>(
  sessionId: string | undefined,
  callback: () => T,
  isDot = false
): T {
  return sessionId ? currentAgent.run(agentForSession(sessionId, isDot), callback) : callback()
}

/** Resolves only an explicitly supplied Agent ID; identity is never inferred. */
export function resolveAgentId(agentId?: string): string | undefined | null {
  const parentSessionId = currentAgent.getStore()?.parentSessionId
  if (!agentId) return undefined
  if (parentSessionId) {
    const ids = agentIdsByParentSession.get(parentSessionId) ?? new Set<string>()
    ids.add(agentId)
    agentIdsByParentSession.set(parentSessionId, ids)
    const parents = parentSessionsByAgentId.get(agentId) ?? new Set<string>()
    parents.add(parentSessionId)
    parentSessionsByAgentId.set(agentId, parents)
  }
  return agentId
}

export function runWithAgentId<T>(agentId: string, callback: () => T, sessionId?: string): T {
  const parentSessionId = currentAgent.getStore()?.parentSessionId
  const isDot = currentAgent.getStore()?.isDot ?? false
  return currentAgent.run(agentForAgentId(agentId, parentSessionId, sessionId, isDot), callback)
}

export function forgetAgentIdentity(sessionId: string): void {
  const entry = [...agents.entries()].find(
    ([, candidate]) => candidate.sessionId === sessionId && candidate.agentId
  )
  if (!entry) return
  const [agentKey, agentIdentity] = entry
  if (!agentIdentity.agentId) return
  agents.delete(agentKey)
  const parents = parentSessionsByAgentId.get(agentIdentity.agentId)
  for (const parentSessionId of parents ?? []) {
    const ids = agentIdsByParentSession.get(parentSessionId)
    ids?.delete(agentIdentity.agentId)
    if (ids?.size === 0) {
      agentIdsByParentSession.delete(parentSessionId)
      agents.delete(`session:${parentSessionId}`)
    }
  }
  parentSessionsByAgentId.delete(agentIdentity.agentId)
}

export function getAgentIdentity(): AgentIdentity | undefined {
  return currentAgent.getStore()
}

export function setAgentTaskSlug(taskSlug: string): void {
  const identity = currentAgent.getStore()
  if (!identity) return
  if (identity.taskSlug !== taskSlug) {
    identity.skillRouting = "pending"
    identity.skillSearchResults = []
    identity.selectedSkill = undefined
  }
  identity.taskSlug = taskSlug
}

export function recordAgentSkillSearch(skillNames: string[]): void {
  const identity = currentAgent.getStore()
  if (!identity) return
  identity.skillSearchResults = [...skillNames]
  if (identity.skillRouting !== "selected" && identity.skillRouting !== "skipped")
    identity.skillRouting = "searched"
}

export function setAgentSkillSelection(skillName: string | null): void {
  const identity = currentAgent.getStore()
  if (!identity) return
  identity.selectedSkill = skillName
  identity.skillRouting = skillName === null ? "skipped" : "selected"
}

export function setAgentProjectId(projectId: string | undefined): void {
  const identity = currentAgent.getStore()
  if (!identity) return
  if (identity.projectId !== projectId) {
    identity.projectExternalAccessOnce = []
    identity.goalId = undefined
  }
  identity.projectId = projectId
  identity.projectRouting = projectId ? "project" : "unscoped"
}

export function initializeAgentProjectRouting(hasActiveProject: boolean): void {
  const identity = currentAgent.getStore()
  if (!identity || identity.projectRouting !== undefined) return
  identity.projectRouting = hasActiveProject ? "project" : "pending"
}

export function setAgentProjectRoutingPending(): void {
  const identity = currentAgent.getStore()
  if (!identity) return
  identity.projectId = undefined
  identity.projectRouting = "pending"
  identity.projectExternalAccessOnce = []
  identity.goalId = undefined
}

export function setAgentGoalId(goalId: string | undefined): void {
  const identity = currentAgent.getStore()
  if (!identity) return
  identity.goalId = goalId
}

export function grantAgentProjectExternalAccessOnce(path: string): void {
  const identity = currentAgent.getStore()
  if (!identity) return
  if (!isAbsolute(path))
    throw new Error("One-time external Project access requires an absolute path.")
  identity.projectExternalAccessOnce ??= []
  identity.projectExternalAccessOnce.push(resolve(path))
}

export function setAgentProjectExternalAccessAll(enabled: boolean): void {
  const identity = currentAgent.getStore()
  if (!identity) return
  identity.projectExternalAccessAll = enabled
  if (!enabled) identity.projectExternalAccessOnce = []
}

export function consumeAgentProjectExternalAccess(path: string): boolean {
  const identity = currentAgent.getStore()
  if (!identity) return false
  if (identity.projectExternalAccessAll) return true
  const absolute = resolve(path)
  const grants = identity.projectExternalAccessOnce ?? []
  const index = grants.findIndex((grant) => containsPath(grant, absolute))
  if (index < 0) return false
  grants.splice(index, 1)
  return true
}

function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function agentForSession(sessionId: string, isDot: boolean): StoredAgentIdentity {
  const key = `session:${sessionId}`
  const known = agents.get(key)
  if (known) {
    known.isDot ||= isDot
    return known
  }

  const identity = {
    sessionId,
    parentSessionId: sessionId,
    isDot,
    agent: `agent-${agents.size + 1}`,
  }
  agents.set(key, identity)
  return identity
}

function agentForAgentId(
  agentId: string,
  parentSessionId?: string,
  sessionId?: string,
  isDot = false
): StoredAgentIdentity {
  const key = `agent:${agentId}`
  const known = agents.get(key)
  if (known) {
    known.parentSessionId ??= parentSessionId
    known.isDot ||= isDot
    return known
  }

  const identity = {
    sessionId: sessionId ?? key,
    agent: `agent-${agents.size + 1}`,
    agentId,
    parentSessionId,
    isDot,
  }
  agents.set(key, identity)
  return identity
}
