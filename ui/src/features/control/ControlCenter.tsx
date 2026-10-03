import {
  Check,
  Cpu,
  History,
  LayoutDashboard,
  PauseCircle,
  Play,
  RotateCcw,
  ShieldAlert,
  Square,
  X,
} from "lucide-react"
import { type ComponentType, useCallback, useEffect, useMemo, useState } from "react"

import { PageHeader } from "../../components/PageHeader"
import { Badge } from "../../components/ui/badge"
import { Button } from "../../components/ui/button"
import { Card, CardContent } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import {
  decideApproval,
  fetchProcesses,
  fetchRecentWork,
  fetchRuntimeControl,
  fetchTimeline,
  type RecentWorkItem,
  type RuntimeApproval,
  type RuntimeControlState,
  restartProcess,
  resumeRecentWork,
  setAgentAccessPaused,
  stopProcess,
  type TimelineEvent,
  type UnifiedProcess,
} from "../../lib/runtime-control-api"

type ControlPage = "overview" | "approvals" | "processes" | "recent" | "timeline"

const CONTROL_PAGES: Array<{
  id: ControlPage
  icon: ComponentType<{ className?: string }>
  labelKey: string
}> = [
  { id: "overview", icon: LayoutDashboard, labelKey: "control.nav.overview" },
  { id: "approvals", icon: ShieldAlert, labelKey: "control.nav.approvals" },
  { id: "processes", icon: Cpu, labelKey: "control.nav.processes" },
  { id: "recent", icon: History, labelKey: "control.nav.recentWork" },
  { id: "timeline", icon: History, labelKey: "control.nav.timeline" },
]

const TIMELINE_FILTERS: Array<{ value: "all" | TimelineEvent["type"]; key: string }> = [
  { value: "all", key: "control.timeline.filterAll" },
  { value: "tool-started", key: "control.timeline.toolStarted" },
  { value: "tool-completed", key: "control.timeline.toolCompleted" },
  { value: "tool-failed", key: "control.timeline.toolFailed" },
  { value: "tool-interrupted", key: "control.timeline.toolInterrupted" },
  { value: "approval", key: "control.timeline.approval" },
  { value: "system", key: "control.timeline.system" },
  { value: "project", key: "control.timeline.project" },
]

export function ControlCenter({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [page, setPage] = useState<ControlPage>("overview")
  const [control, setControl] = useState<RuntimeControlState>()
  const [processes, setProcesses] = useState<UnifiedProcess[]>([])
  const [recentWork, setRecentWork] = useState<RecentWorkItem[]>([])
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [timelineFilter, setTimelineFilter] = useState<"all" | TimelineEvent["type"]>("all")
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState<string>()
  const [busy, setBusy] = useState<string>()

  const load = useCallback(async () => {
    try {
      const [nextControl, nextProcesses, nextRecent, nextTimeline] = await Promise.all([
        fetchRuntimeControl(),
        fetchProcesses(),
        fetchRecentWork(),
        fetchTimeline({ limit: 120 }),
      ])
      setControl(nextControl)
      setProcesses(nextProcesses)
      setRecentWork(nextRecent)
      setTimeline(nextTimeline)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 2_000)
    return () => window.clearInterval(timer)
  }, [load])

  const pendingApprovals = useMemo(
    () =>
      (control?.approvals ?? []).filter(
        (approval) => approval.status === "pending" || approval.status === "approved-once"
      ),
    [control?.approvals]
  )
  const runningProcesses = useMemo(
    () => processes.filter((process) => process.status === "running").length,
    [processes]
  )
  const filteredTimeline = useMemo(
    () =>
      timelineFilter === "all"
        ? timeline
        : timeline.filter((event) => event.type === timelineFilter),
    [timeline, timelineFilter]
  )

  const decide = async (
    approval: RuntimeApproval,
    decision: "approve-once" | "always-allow" | "deny"
  ) => {
    setBusy(approval.id)
    try {
      await decideApproval(approval.id, decision)
      setMessage(
        decision === "deny"
          ? t("control.message.permissionDenied")
          : decision === "always-allow"
            ? t("control.message.permissionAlwaysAllowed")
            : t("control.message.approvedOnce")
      )
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const processAction = async (process: UnifiedProcess, action: "stop" | "restart") => {
    setBusy(process.id)
    try {
      if (action === "stop") await stopProcess(process.id)
      else await restartProcess(process.id)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const resume = async (item: RecentWorkItem) => {
    setBusy(item.id)
    try {
      const result = await resumeRecentWork({
        ...(item.projectId ? { projectId: item.projectId } : {}),
        ...(item.agentId ? { agentId: item.agentId } : {}),
      })
      await navigator.clipboard?.writeText(result.content).catch(() => undefined)
      setMessage(t("control.message.resumeCopied", { uuid: result.uuid }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-muted/20">
      <PageHeader
        icon={ShieldAlert}
        title={t("control.title")}
        subtitle={t("control.subtitle")}
        onBack={onBack}
        actions={
          control ? (
            <Button
              size="sm"
              variant={control.agentAccess.paused ? "default" : "outline"}
              onClick={() =>
                void setAgentAccessPaused(!control.agentAccess.paused, true).then(load)
              }
            >
              {control.agentAccess.paused ? (
                <>
                  <Play className="size-4" />
                  {t("control.resumeAgent")}
                </>
              ) : (
                <>
                  <PauseCircle className="size-4" />
                  {t("control.emergencyPause")}
                </>
              )}
            </Button>
          ) : null
        }
      />

      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 px-4 py-4 md:px-5 md:py-5">
        <div className="grid min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-sm md:grid-cols-[210px_minmax(0,1fr)]">
          <nav className="flex gap-1 overflow-x-auto border-b p-2 md:min-h-0 md:flex-col md:overflow-y-auto md:border-r md:border-b-0 md:p-3">
            {CONTROL_PAGES.map((item) => {
              const Icon = item.icon
              const count =
                item.id === "approvals"
                  ? pendingApprovals.length
                  : item.id === "processes"
                    ? processes.length
                    : item.id === "recent"
                      ? recentWork.length
                      : item.id === "timeline"
                        ? timeline.length
                        : undefined
              return (
                <button
                  type="button"
                  key={item.id}
                  className={[
                    "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                    page === item.id
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  ].join(" ")}
                  onClick={() => setPage(item.id)}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="whitespace-nowrap">{t(item.labelKey)}</span>
                  {count !== undefined ? (
                    <Badge className="ml-auto min-w-6 justify-center">{count}</Badge>
                  ) : null}
                </button>
              )
            })}
          </nav>

          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
              <div className="mx-auto w-full max-w-5xl space-y-4">
                {control?.agentAccess.paused ? (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    {t("control.banner.paused")}
                  </div>
                ) : null}
                {control?.accessMode === "full-access" ? (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
                    {t("control.banner.fullAccess")}
                  </div>
                ) : control?.accessMode === "always-question" ? (
                  <div className="rounded-lg border bg-background px-4 py-3 text-sm">
                    {t("control.banner.alwaysQuestion")}
                  </div>
                ) : null}
                {error ? (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    {error}
                  </div>
                ) : null}
                {message ? (
                  <div className="rounded-lg border bg-background px-4 py-3 text-sm">{message}</div>
                ) : null}

                {page === "overview" ? (
                  <OverviewPage
                    pendingApprovals={pendingApprovals.length}
                    runningProcesses={runningProcesses}
                    processCount={processes.length}
                    recentCount={recentWork.length}
                    timelineCount={timeline.length}
                    onNavigate={setPage}
                  />
                ) : null}
                {page === "approvals" ? (
                  <ApprovalPage
                    approvals={pendingApprovals}
                    busy={busy}
                    alwaysQuestion={control?.accessMode === "always-question"}
                    onDecision={decide}
                  />
                ) : null}
                {page === "processes" ? (
                  <ProcessPage processes={processes} busy={busy} onAction={processAction} />
                ) : null}
                {page === "recent" ? (
                  <RecentWorkPage items={recentWork} busy={busy} onResume={resume} />
                ) : null}
                {page === "timeline" ? (
                  <TimelinePage
                    events={filteredTimeline}
                    filter={timelineFilter}
                    onFilterChange={setTimelineFilter}
                  />
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  )
}

function OverviewPage({
  pendingApprovals,
  runningProcesses,
  processCount,
  recentCount,
  timelineCount,
  onNavigate,
}: {
  pendingApprovals: number
  runningProcesses: number
  processCount: number
  recentCount: number
  timelineCount: number
  onNavigate: (page: ControlPage) => void
}) {
  const { t } = useI18n()
  const cards: Array<{
    page: Exclude<ControlPage, "overview">
    label: string
    value: number
    hint: string
  }> = [
    {
      page: "approvals",
      label: t("control.nav.approvals"),
      value: pendingApprovals,
      hint: t("control.overview.approvalsHint"),
    },
    {
      page: "processes",
      label: t("control.nav.processes"),
      value: processCount,
      hint: t("control.overview.processesHint", { running: runningProcesses }),
    },
    {
      page: "recent",
      label: t("control.nav.recentWork"),
      value: recentCount,
      hint: t("control.overview.recentHint"),
    },
    {
      page: "timeline",
      label: t("control.nav.timeline"),
      value: timelineCount,
      hint: t("control.overview.timelineHint"),
    },
  ]

  return (
    <>
      <div>
        <h2 className="text-lg font-semibold">{t("control.overview.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("control.overview.subtitle")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {cards.map((card) => (
          <button
            type="button"
            key={card.page}
            className="rounded-lg border bg-background p-4 text-left transition-colors hover:bg-accent/40"
            onClick={() => onNavigate(card.page)}
          >
            <div className="text-sm font-medium">{card.label}</div>
            <div className="mt-2 text-3xl font-semibold tabular-nums">{card.value}</div>
            <div className="mt-1 text-xs text-muted-foreground">{card.hint}</div>
          </button>
        ))}
      </div>
    </>
  )
}

function ApprovalPage({
  approvals,
  busy,
  alwaysQuestion,
  onDecision,
}: {
  approvals: RuntimeApproval[]
  busy?: string
  alwaysQuestion: boolean
  onDecision: (
    approval: RuntimeApproval,
    decision: "approve-once" | "always-allow" | "deny"
  ) => void
}) {
  const { t } = useI18n()
  return (
    <>
      <PageIntro title={t("control.approvals.title")} subtitle={t("control.approvals.subtitle")} />
      {approvals.length === 0 ? (
        <EmptyState>{t("control.approvals.empty")}</EmptyState>
      ) : (
        <div className="space-y-2">
          {approvals.map((approval) => (
            <div
              key={approval.id}
              className="flex flex-col gap-3 rounded-lg border bg-background p-3 lg:flex-row lg:items-center lg:justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{approvalReasonLabel(approval, t)}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {approval.toolName}
                  {approval.source?.id ? ` · ${approval.source.id}` : ""}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === approval.id}
                  onClick={() => onDecision(approval, "approve-once")}
                >
                  <Check className="size-4" />
                  {t("control.approvals.once")}
                </Button>
                {!alwaysQuestion ? (
                  <Button
                    size="sm"
                    disabled={busy === approval.id}
                    onClick={() => onDecision(approval, "always-allow")}
                  >
                    {t("control.approvals.always")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === approval.id}
                  onClick={() => onDecision(approval, "deny")}
                >
                  <X className="size-4" />
                  {t("control.approvals.deny")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function ProcessPage({
  processes,
  busy,
  onAction,
}: {
  processes: UnifiedProcess[]
  busy?: string
  onAction: (process: UnifiedProcess, action: "stop" | "restart") => void
}) {
  const { t } = useI18n()
  return (
    <>
      <PageIntro title={t("control.processes.title")} subtitle={t("control.processes.subtitle")} />
      {processes.length === 0 ? (
        <EmptyState>{t("control.processes.empty")}</EmptyState>
      ) : (
        <div className="space-y-2">
          {processes.map((process) => (
            <div
              key={process.id}
              className="flex flex-col gap-3 rounded-lg border bg-background px-3 py-3 lg:flex-row lg:items-center lg:justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{process.label}</span>
                  <Badge>{processKindLabel(process.kind, t)}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {processStatusLabel(process.status, t)}
                  </span>
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {process.pid ? `${t("control.processes.pid", { pid: process.pid })} · ` : ""}
                  {process.detail ?? process.id}
                  {process.restartCount
                    ? ` · ${t("control.processes.restarts", { count: process.restartCount })}`
                    : ""}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                {process.canRestart ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === process.id}
                    onClick={() => onAction(process, "restart")}
                  >
                    <RotateCcw className="size-4" />
                    {t("control.processes.restart")}
                  </Button>
                ) : null}
                {process.canStop ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === process.id}
                    onClick={() => onAction(process, "stop")}
                  >
                    <Square className="size-4" />
                    {t("control.processes.stop")}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function RecentWorkPage({
  items,
  busy,
  onResume,
}: {
  items: RecentWorkItem[]
  busy?: string
  onResume: (item: RecentWorkItem) => void
}) {
  const { t } = useI18n()
  return (
    <>
      <PageIntro title={t("control.recent.title")} subtitle={t("control.recent.subtitle")} />
      {items.length === 0 ? (
        <EmptyState>{t("control.recent.empty")}</EmptyState>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex flex-col gap-3 rounded-lg border bg-background p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{item.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {new Date(item.lastActivityAt).toLocaleString()}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === item.id}
                onClick={() => onResume(item)}
              >
                {t("control.recent.resume")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function TimelinePage({
  events,
  filter,
  onFilterChange,
}: {
  events: TimelineEvent[]
  filter: "all" | TimelineEvent["type"]
  onFilterChange: (value: "all" | TimelineEvent["type"]) => void
}) {
  const { t } = useI18n()
  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <PageIntro title={t("control.timeline.title")} subtitle={t("control.timeline.subtitle")} />
        <label className="w-full sm:w-56">
          <span className="mb-1 block text-xs text-muted-foreground">
            {t("control.timeline.filter")}
          </span>
          <select
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={filter}
            onChange={(event) =>
              onFilterChange(event.target.value as "all" | TimelineEvent["type"])
            }
          >
            {TIMELINE_FILTERS.map((item) => (
              <option key={item.value} value={item.value}>
                {t(item.key)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {events.length === 0 ? (
        <EmptyState>{t("control.timeline.empty")}</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          {events.map((event) => (
            <div
              key={event.id}
              className="grid gap-1 border-b px-3 py-3 text-xs last:border-b-0 sm:grid-cols-[170px_150px_minmax(0,1fr)] sm:gap-3"
            >
              <span className="text-muted-foreground">
                {new Date(event.timestamp).toLocaleString()}
              </span>
              <span className="font-medium">{timelineTypeLabel(event.type, t)}</span>
              <span className="min-w-0">
                <span>{event.label}</span>
                {event.detail ? (
                  <span className="ml-2 text-muted-foreground">{event.detail}</span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function PageIntro({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
    </div>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="py-10 text-center text-sm text-muted-foreground">
        {children}
      </CardContent>
    </Card>
  )
}

function approvalReasonLabel(
  approval: RuntimeApproval,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  if (approval.category.startsWith("permission:")) {
    const permission = approval.category.slice("permission:".length)
    const permissionKey = `control.permission.${permission}`
    const localizedPermission = t(permissionKey)
    return t("control.approvals.permissionRequest", {
      permission: localizedPermission === permissionKey ? permission : localizedPermission,
    })
  }
  const dangerKey = `control.danger.${approval.category}`
  const danger = t(dangerKey)
  if (danger !== dangerKey) return danger
  return t("control.approvals.actionRequest")
}

function processKindLabel(
  kind: UnifiedProcess["kind"],
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  const key = `control.processes.kind.${kind}`
  const translated = t(key)
  return translated === key ? kind : translated
}

function processStatusLabel(
  status: string,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  const key = `control.processes.status.${status}`
  const translated = t(key)
  return translated === key ? status : translated
}

function timelineTypeLabel(
  type: TimelineEvent["type"],
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  const key = `control.timeline.type.${type}`
  const translated = t(key)
  return translated === key ? type : translated
}
