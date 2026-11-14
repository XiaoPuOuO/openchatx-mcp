import { useCallback, useEffect, useRef, useState } from "react"

import { deleteAgent, fetchAgents, subscribeToAgents } from "../lib/api"
import type { Agent } from "../types"
import { upsertAgentByActivity } from "./agent-order.js"

export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const eventVersion = useRef(0)

  useEffect(() => {
    let active = true
    const refresh = async () => {
      const version = eventVersion.current
      try {
        const snapshot = await fetchAgents()
        if (active && version === eventVersion.current) setAgents(snapshot)
        if (active) setError(undefined)
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError))
      } finally {
        if (active) setLoading(false)
      }
    }

    const unsubscribe = subscribeToAgents(
      (event) => {
        eventVersion.current += 1
        setAgents((current) => {
          if (event.type === "agent_removed") {
            return current.filter((item) => item.id !== event.agentId)
          }
          return upsertAgentByActivity(current, event.agent)
        })
      },
      (isConnected) => {
        setConnected(isConnected)
        if (isConnected) void refresh()
      }
    )
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    void refresh()
    // SSE provides immediate updates; polling reconciles missed events and
    // silently disconnected streams so evicted sessions cannot remain overnight.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh()
    }, 10_000)

    return () => {
      active = false
      unsubscribe()
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.clearInterval(timer)
    }
  }, [])

  const removeAgent = useCallback(async (agentId: string) => {
    await deleteAgent(agentId)
    setAgents((current) => current.filter((agent) => agent.id !== agentId))
  }, [])

  return { agents, connected, loading, error, removeAgent }
}
