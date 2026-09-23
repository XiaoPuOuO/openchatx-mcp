import { Activity, PencilRuler, RefreshCw, Wifi, WifiOff } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "./components/ui/button"
import { RoomEditor } from "./features/agent-room/editor/RoomEditor"
import { AgentCard } from "./features/dashboard/AgentCard"
import { useAgents } from "./hooks/useAgents"

export function App() {
  const editorRoute =
    window.location.pathname.replace(/\/+$/u, "") === "/ui/editor" ||
    new URLSearchParams(window.location.search).has("editor")
  if (editorRoute) return <RoomEditor />
  return <Dashboard />
}

function Dashboard() {
  const { agents, connected, loading, error } = useAgents()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const activeCount = agents.filter((agent) => now - agent.lastSeenAt < 30_000).length

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-5 py-4 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-foreground text-background">
              <Activity className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight">Shellby Control</h1>
              <p className="text-xs text-muted-foreground">
                {activeCount} active · {agents.length} observed
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div
              className={`hidden items-center gap-1.5 text-xs sm:flex ${connected ? "text-emerald-600" : "text-muted-foreground"}`}
            >
              {connected ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
              {connected ? "Live" : "Reconnecting"}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => (window.location.href = "/ui/?editor=1")}
            >
              <PencilRuler className="size-3.5" />
              Edit room
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              <RefreshCw className="size-3.5" />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] px-5 py-6 lg:px-8">
        {error ? (
          <div className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="py-24 text-center text-sm text-muted-foreground">
            Loading Shellby agents...
          </div>
        ) : agents.length === 0 ? (
          <div className="mx-auto max-w-lg py-24 text-center">
            <Activity className="mx-auto size-8 text-muted-foreground" />
            <h2 className="mt-4 text-lg font-semibold">No agents observed yet</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Agents will appear here automatically when they make a Shellby MCP tool call.
            </p>
          </div>
        ) : (
          <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} now={now} />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
