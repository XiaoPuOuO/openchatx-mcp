import { type AgentIdentity, getAgentIdentity } from "./context.js"

interface TrackedLoad<T> {
  startedAt: number
  load: Promise<T>
}

/**
 * Deduplicate recent keyed loads within one agent identity.
 *
 * A successful load remains reusable for `cooldownMs`. A failed shared load is removed and the
 * caller immediately retries through its own loader. Callers without session identity are never
 * deduplicated.
 */
export function createAgentLoadDeduper<T>(cooldownMs: number) {
  const recentLoads = new Map<AgentIdentity, Map<string, TrackedLoad<T>>>()

  return async function loadOnce(
    key: string,
    load: () => Promise<T>
  ): Promise<{ value: T; reused: boolean }> {
    const agent = getAgentIdentity()
    if (!agent) return { value: await load(), reused: false }

    let agentLoads = recentLoads.get(agent)
    const recent = agentLoads?.get(key)
    if (recent && Date.now() - recent.startedAt < cooldownMs) {
      try {
        return { value: await recent.load, reused: true }
      } catch {
        if (agentLoads?.get(key) === recent) agentLoads.delete(key)
      }
    }

    const pending = load()
    const tracked = { startedAt: Date.now(), load: pending }
    agentLoads ??= new Map()
    recentLoads.set(agent, agentLoads)
    agentLoads.set(key, tracked)
    const cleanup = setTimeout(() => {
      if (agentLoads.get(key) !== tracked) return
      agentLoads.delete(key)
      if (agentLoads.size === 0) recentLoads.delete(agent)
    }, cooldownMs)
    cleanup.unref()

    try {
      return { value: await pending, reused: false }
    } catch (error) {
      if (agentLoads.get(key) === tracked) agentLoads.delete(key)
      throw error
    }
  }
}
