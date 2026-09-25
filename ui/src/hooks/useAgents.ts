import { useCallback, useEffect, useState } from "react"

import { deleteAgent, fetchAgents, subscribeToAgents } from "../lib/api"
import type { Agent } from "../types"

export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  useEffect(() => {
    void fetchAgents()
      .then((snapshot) => {
        setAgents((current) => mergeInitialSnapshot(current, snapshot))
      })
      .catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      )
      .finally(() => setLoading(false))

    return subscribeToAgents((event) => {
      setAgents((current) => {
        if (event.type === "agent_removed") {
          return current.filter((item) => item.id !== event.agentId)
        }
        const index = current.findIndex((item) => item.id === event.agent.id)
        if (index === -1) return [...current, event.agent]
        const next = [...current]
        next[index] = event.agent
        return next
      })
    }, setConnected)
  }, [])

  const removeAgent = useCallback(async (agentId: string) => {
    await deleteAgent(agentId)
    setAgents((current) => current.filter((agent) => agent.id !== agentId))
  }, [])

  return { agents, connected, loading, error, removeAgent }
}

function mergeInitialSnapshot(current: Agent[], snapshot: Agent[]): Agent[] {
  if (current.length === 0) return snapshot

  const liveById = new Map(current.map((agent) => [agent.id, agent]))
  const snapshotIds = new Set(snapshot.map((agent) => agent.id))
  return [
    ...snapshot.map((agent) => liveById.get(agent.id) ?? agent),
    ...current.filter((agent) => !snapshotIds.has(agent.id)),
  ]
}
