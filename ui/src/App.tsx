import {
  Activity,
  Blocks,
  BrainCircuit,
  PackageOpen,
  RefreshCw,
  Settings,
  Wifi,
  WifiOff,
} from "lucide-react"
import { useEffect, useState } from "react"

import { LanguageSwitcher } from "./components/LanguageSwitcher"
import { Button } from "./components/ui/button"
import { AgentCard } from "./features/dashboard/AgentCard"
import { PlatformHomePanel } from "./features/dashboard/PlatformHomePanel"
import { McpServerManager } from "./features/mcp-servers/McpServerManager"
import { StatusPage } from "./features/status/StatusPage"
import { CapabilityStoreManager } from "./features/store/CapabilityStoreManager"
import { SubagentManager } from "./features/subagents/SubagentManager"
import { ToolboxManager } from "./features/toolboxes/ToolboxManager"
import { useAgents } from "./hooks/useAgents"
import { useI18n } from "./i18n"

export function App() {
  const [view, setView] = useState<
    "dashboard" | "mcp-servers" | "toolboxes" | "subagents" | "store" | "status"
  >("dashboard")
  if (view === "mcp-servers") {
    return <McpServerManager onBack={() => setView("dashboard")} />
  }
  if (view === "toolboxes") {
    return <ToolboxManager onBack={() => setView("dashboard")} />
  }
  if (view === "subagents") {
    return <SubagentManager onBack={() => setView("dashboard")} />
  }
  if (view === "store") {
    return <CapabilityStoreManager onBack={() => setView("dashboard")} />
  }
  if (view === "status") {
    return <StatusPage onBack={() => setView("dashboard")} />
  }
  return (
    <Dashboard
      onOpenMcpServers={() => setView("mcp-servers")}
      onOpenToolboxes={() => setView("toolboxes")}
      onOpenSubagents={() => setView("subagents")}
      onOpenStore={() => setView("store")}
      onOpenStatus={() => setView("status")}
    />
  )
}

function Dashboard({
  onOpenMcpServers,
  onOpenToolboxes,
  onOpenSubagents,
  onOpenStore,
  onOpenStatus,
}: {
  onOpenMcpServers: () => void
  onOpenToolboxes: () => void
  onOpenSubagents: () => void
  onOpenStore: () => void
  onOpenStatus: () => void
}) {
  const { agents, connected, loading, error } = useAgents()
  const { t } = useI18n()
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
            <img
              src="/ui/openchatx-mcp-icon.png"
              alt="openchatx-mcp"
              className="size-9 rounded-lg"
            />
            <div>
              <h1 className="text-base font-semibold tracking-tight">openchatx-mcp</h1>
              <p className="text-xs text-muted-foreground">
                {t("dashboard.activeObserved", { active: activeCount, observed: agents.length })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div
              className={`hidden items-center gap-1.5 text-xs sm:flex ${connected ? "text-emerald-600" : "text-muted-foreground"}`}
            >
              {connected ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
              {connected ? t("dashboard.live") : t("dashboard.reconnecting")}
            </div>
            <LanguageSwitcher />
            <Button variant="outline" size="sm" onClick={onOpenStatus}>
              <Activity className="size-3.5" />
              Status
            </Button>
            <Button variant="outline" size="sm" onClick={onOpenStore}>
              <PackageOpen className="size-3.5" />
              Store
            </Button>
            <Button variant="outline" size="sm" onClick={onOpenSubagents}>
              <BrainCircuit className="size-3.5" />
              {t("dashboard.subagents")}
            </Button>
            <Button variant="outline" size="sm" onClick={onOpenToolboxes}>
              <Blocks className="size-3.5" />
              {t("dashboard.toolboxes")}
            </Button>
            <Button variant="outline" size="sm" onClick={onOpenMcpServers}>
              <Settings className="size-3.5" />
              {t("dashboard.mcpServer")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              <RefreshCw className="size-3.5" />
              {t("common.refresh")}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] px-5 py-6 lg:px-8">
        <PlatformHomePanel />
        {error ? (
          <div className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="mb-3 text-sm font-medium">ChatGPT sessions</div>
        {loading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t("dashboard.loading")}
          </div>
        ) : agents.length === 0 ? (
          <div className="rounded-lg border px-4 py-8 text-center">
            <h2 className="text-sm font-medium">{t("dashboard.noAgents")}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t("dashboard.noAgentsHint")}
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
