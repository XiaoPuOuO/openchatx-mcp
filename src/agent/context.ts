import { AsyncLocalStorage } from "node:async_hooks"

export interface AgentIdentity {
  readonly sessionId: string
  readonly agent: string
  readonly taskSlug?: string
}

interface StoredAgentIdentity {
  sessionId: string
  agent: string
  taskSlug?: string
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

function agentForSession(sessionId: string): StoredAgentIdentity {
  const known = agents.get(sessionId)
  if (known) return known

  const identity = { sessionId, agent: `agent-${agents.size + 1}` }
  agents.set(sessionId, identity)
  return identity
}
