import { AsyncLocalStorage } from "node:async_hooks"

export interface AgentIdentity {
  readonly sessionId: string
  readonly agent: string
  taskSlug?: string
}

const agents = new Map<string, AgentIdentity>()
const currentAgent = new AsyncLocalStorage<AgentIdentity | undefined>()

export function runWithAgent<T>(sessionId: string | undefined, callback: () => T): T {
  return currentAgent.run(sessionId ? agentForSession(sessionId) : undefined, callback)
}

export function getAgentIdentity(): AgentIdentity | undefined {
  return currentAgent.getStore()
}

export function setAgentTaskSlug(taskSlug: string): void {
  const identity = currentAgent.getStore()
  if (identity) identity.taskSlug = taskSlug
}

function agentForSession(sessionId: string): AgentIdentity {
  const known = agents.get(sessionId)
  if (known) return known

  const identity = { sessionId, agent: `agent-${agents.size + 1}` }
  agents.set(sessionId, identity)
  return identity
}
