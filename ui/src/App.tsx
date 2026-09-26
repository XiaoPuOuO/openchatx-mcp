import {
  Activity,
  Blocks,
  BrainCircuit,
  ExternalLink,
  FileText,
  FolderKanban,
  Gauge,
  PackageOpen,
  RefreshCw,
  ServerCog,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { LanguageSwitcher } from "./components/LanguageSwitcher"
import { Button } from "./components/ui/button"
import { AgentCard } from "./features/dashboard/AgentCard"
import { PlatformHomePanel } from "./features/dashboard/PlatformHomePanel"
import { McpServerManager } from "./features/mcp-servers/McpServerManager"
import { ProjectManager } from "./features/projects/ProjectManager"
import { StatusPage } from "./features/status/StatusPage"
import { CapabilityStoreManager } from "./features/store/CapabilityStoreManager"
import { SubagentManager } from "./features/subagents/SubagentManager"
import { SummaryManager } from "./features/summaries/SummaryManager"
import { ToolboxManager } from "./features/toolboxes/ToolboxManager"
import { useAgents } from "./hooks/useAgents"
import { useI18n } from "./i18n"
import { fetchUpdateCheck, type UpdateCheck } from "./lib/api"

type View =
  | "dashboard"
  | "projects"
  | "summaries"
  | "store"
  | "subagents"
  | "toolboxes"
  | "mcp-servers"
  | "status"

type NavItem = {
  id: View
  labelKey: string
  icon: typeof Gauge
}

const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", labelKey: "nav.overview", icon: Gauge },
  { id: "projects", labelKey: "nav.projects", icon: FolderKanban },
  { id: "summaries", labelKey: "nav.summaries", icon: FileText },
  { id: "store", labelKey: "nav.store", icon: PackageOpen },
  { id: "subagents", labelKey: "nav.subagents", icon: BrainCircuit },
  { id: "toolboxes", labelKey: "nav.toolboxes", icon: Blocks },
  { id: "mcp-servers", labelKey: "nav.mcpServers", icon: ServerCog },
  { id: "status", labelKey: "nav.systemStatus", icon: Activity },
]

const WORKSPACE_NAV = NAV_ITEMS.filter((item) =>
  ["dashboard", "projects", "summaries"].includes(item.id)
)
const CAPABILITY_NAV = NAV_ITEMS.filter((item) =>
  ["store", "subagents", "toolboxes", "mcp-servers"].includes(item.id)
)
const SYSTEM_NAV = NAV_ITEMS.filter((item) => item.id === "status")

export function App() {
  const [view, setView] = useState<View>("dashboard")
  const { agents, connected, loading, error, removeAgent } = useAgents()
  const { t } = useI18n()
  const [now, setNow] = useState(Date.now())
  const [update, setUpdate] = useState<UpdateCheck>()

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    void fetchUpdateCheck()
      .then(setUpdate)
      .catch(() => undefined)
  }, [])

  const activeCount = agents.filter((agent) => now - agent.lastSeenAt < 30_000).length
  const titleKey = NAV_ITEMS.find((item) => item.id === view)?.labelKey
  const title = titleKey ? t(titleKey) : "OpenChatX"

  const page = useMemo(() => {
    const back = () => setView("dashboard")
    switch (view) {
      case "projects":
        return <ProjectManager onBack={back} />
      case "summaries":
        return <SummaryManager onBack={back} />
      case "store":
        return <CapabilityStoreManager onBack={back} />
      case "subagents":
        return <SubagentManager onBack={back} />
      case "toolboxes":
        return <ToolboxManager onBack={back} />
      case "mcp-servers":
        return <McpServerManager onBack={back} />
      case "status":
        return <StatusPage onBack={back} />
      default:
        return (
          <Dashboard
            agents={agents}
            activeCount={activeCount}
            connected={connected}
            loading={loading}
            error={error}
            now={now}
            onRemoveAgent={removeAgent}
            onOpenProjects={() => setView("projects")}
            loadingLabel={t("dashboard.loading")}
            noAgentsLabel={t("dashboard.noAgents")}
            noAgentsHint={t("dashboard.noAgentsHint")}
          />
        )
    }
  }, [view, agents, activeCount, connected, loading, error, now, removeAgent, t])

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <img src="/ui/openchatx-mcp-icon.png" alt="" className="size-8 rounded-[9px]" />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold">OpenChatX</div>
            <div className="truncate text-[11px] text-muted-foreground">{t("app.subtitle")}</div>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="OpenChatX">
          <NavSection
            label={t("nav.workspace")}
            items={WORKSPACE_NAV}
            view={view}
            onSelect={setView}
            t={t}
          />
          <NavSection
            label={t("nav.capabilities")}
            items={CAPABILITY_NAV}
            view={view}
            onSelect={setView}
            t={t}
          />
          <NavSection
            label={t("nav.system")}
            items={SYSTEM_NAV}
            view={view}
            onSelect={setView}
            t={t}
          />
        </nav>

        <div className="sidebar-footer">
          <div className="runtime-summary">
            <span className={connected ? "status-dot status-dot-online" : "status-dot"} />
            <div className="min-w-0">
              <div className="text-xs font-medium">
                {connected ? t("sidebar.connected") : t("dashboard.reconnecting")}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {t("sidebar.sessionsSummary", { active: activeCount, total: agents.length })}
              </div>
            </div>
          </div>
        </div>
      </aside>

      <section className="app-main">
        <header className="app-toolbar">
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</h1>
          </div>
          <div className="flex items-center gap-1.5">
            <LanguageSwitcher />
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => window.location.reload()}
              aria-label={t("common.refresh")}
              title={t("common.refresh")}
            >
              <RefreshCw className="size-4" />
            </Button>
          </div>
        </header>

        <div className={view === "dashboard" ? "app-content" : "app-content embedded-page"}>
          {update?.updateAvailable ? (
            <div className="mx-5 mt-4 flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{t("update.available")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("update.versionMessage", {
                    current: update.currentVersion,
                    latest: update.latestVersion ?? "?",
                  })}
                </div>
              </div>
              {update.releaseUrl ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => window.open(update.releaseUrl, "_blank", "noopener,noreferrer")}
                >
                  <ExternalLink className="size-4" />
                  {t("update.viewRelease")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {page}
        </div>
      </section>
    </div>
  )
}

function Dashboard({
  agents,
  activeCount,
  connected,
  loading,
  error,
  now,
  onRemoveAgent,
  onOpenProjects,
  loadingLabel,
  noAgentsLabel,
  noAgentsHint,
}: {
  agents: ReturnType<typeof useAgents>["agents"]
  activeCount: number
  connected: boolean
  loading: boolean
  error?: string
  now: number
  onRemoveAgent: (agentId: string) => Promise<void>
  onOpenProjects: () => void
  loadingLabel: string
  noAgentsLabel: string
  noAgentsHint: string
}) {
  const { t } = useI18n()

  return (
    <main className="dashboard-page">
      <div className="page-heading">
        <div>
          <h2>{t("dashboard.heading")}</h2>
          <p>
            {connected
              ? activeCount > 0
                ? t("dashboard.workingNow", { count: activeCount })
                : t("dashboard.ready")
              : t("dashboard.connecting")}
          </p>
        </div>
      </div>

      <PlatformHomePanel onOpenProjects={onOpenProjects} />

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="session-section">
        <div className="section-heading">
          <h3>{t("dashboard.sessions")}</h3>
          <span>{agents.length}</span>
        </div>

        {loading ? (
          <div className="empty-state">{loadingLabel}</div>
        ) : agents.length === 0 ? (
          <div className="empty-state">
            <strong>{noAgentsLabel}</strong>
            <p>{noAgentsHint}</p>
          </div>
        ) : (
          <div className="session-grid">
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                now={now}
                onDelete={() => onRemoveAgent(agent.id)}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  )
}

function NavSection({
  label,
  items,
  view,
  onSelect,
  t,
}: {
  label: string
  items: NavItem[]
  view: View
  onSelect: (view: View) => void
  t: (key: string, values?: Record<string, string | number>) => string
}) {
  return (
    <div className="sidebar-section">
      <div className="sidebar-section-label">{label}</div>
      {items.map(({ id, labelKey, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className={view === id ? "sidebar-item sidebar-item-active" : "sidebar-item"}
          onClick={() => onSelect(id)}
        >
          <Icon className="size-4" strokeWidth={1.8} />
          <span>{t(labelKey)}</span>
        </button>
      ))}
    </div>
  )
}
