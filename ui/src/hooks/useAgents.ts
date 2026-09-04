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
      .then(setAgents)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)))
      .finally(() => setLoading(false))

    return subscribeToAgents(
      ({ agent }) => {
        setAgents((current) => {
          const next = current.filter((item) => item.id !== agent.id)
          next.push(agent)
          return next.sort((left, right) => right.lastSeenAt - left.lastSeenAt)
        })
      },
      setConnected
    )
  }, [])

  return { agents, connected, loading, error }
}
