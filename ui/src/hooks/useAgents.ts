import { useEffect, useState } from "react"

import { fetchAgents, subscribeToAgents } from "../lib/api"
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
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)))
      .finally(() => setLoading(false))

    return subscribeToAgents(
      ({ agent }) => {
        setAgents((current) => {
          const index = current.findIndex((item) => item.id === agent.id)
          if (index === -1) return [...current, agent]
          const next = [...current]
          next[index] = agent
          return next
        })
      },
      setConnected
    )
  }, [])

  return { agents, connected, loading, error }
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
