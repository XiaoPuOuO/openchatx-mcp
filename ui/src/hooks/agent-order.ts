import type { Agent } from "../types.js"

const AGENT_REORDER_THRESHOLD_MS = 3 * 60 * 1_000

export function upsertAgentByActivity(current: Agent[], updated: Agent): Agent[] {
  const existingIndex = current.findIndex((agent) => agent.id === updated.id)
  if (existingIndex < 0) {
    const insertAt = current.findIndex(
      (agent) => updated.lastSeenAt - agent.lastSeenAt >= AGENT_REORDER_THRESHOLD_MS
    )
    if (insertAt < 0) return [...current, updated]
    return [...current.slice(0, insertAt), updated, ...current.slice(insertAt)]
  }

  const next = [...current]
  next[existingIndex] = updated

  let targetIndex = existingIndex
  for (let index = existingIndex - 1; index >= 0; index -= 1) {
    const preceding = next[index]
    if (!preceding) break
    if (updated.lastSeenAt - preceding.lastSeenAt < AGENT_REORDER_THRESHOLD_MS) break
    targetIndex = index
  }
  if (targetIndex === existingIndex) return next

  next.splice(existingIndex, 1)
  next.splice(targetIndex, 0, updated)
  return next
}
