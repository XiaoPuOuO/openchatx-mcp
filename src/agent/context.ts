import { AsyncLocalStorage } from "node:async_hooks"
import { isAbsolute, relative, resolve, sep } from "node:path"

export type AgentProjectRouting = "pending" | "project" | "unscoped"

export interface AgentIdentity {
  readonly sessionId: string
  readonly agent: string
  readonly taskSlug?: string
  readonly projectId?: string
  readonly projectRouting?: AgentProjectRouting
  readonly goalId?: string
  readonly projectExternalAccessAll?: boolean
}

interface StoredAgentIdentity {
  sessionId: string
  agent: string
  taskSlug?: string
  projectId?: string
  projectRouting?: AgentProjectRouting
  goalId?: string
  projectExternalAccessAll?: boolean
  projectExternalAccessOnce?: string[]
}

const agents = new Map<string, StoredAgentIdentity>()
const currentAgent = new AsyncLocalStorage<StoredAgentIdentity>()

export function runWithAgent<T>(sessionId: string | undefined, callback: () => T): T {
  return sessionId ? currentAgent.run(agentForSession(sessionId), callback) : callback()
}

export function getAgentIdentity(): AgentIdentity | undefined {
  return currentAgent.getStore()
}

export function setAgentTaskSlug(taskSlug: string): void {
  const identity = currentAgent.getStore()
  if (identity) identity.taskSlug = taskSlug
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

function agentForSession(sessionId: string): StoredAgentIdentity {
  const known = agents.get(sessionId)
  if (known) return known

  const identity = { sessionId, agent: `agent-${agents.size + 1}` }
  agents.set(sessionId, identity)
  return identity
}
