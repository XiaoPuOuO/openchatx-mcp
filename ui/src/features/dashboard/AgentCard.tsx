import { Check, LoaderCircle, Trash2, TriangleAlert } from "lucide-react"
import { useState } from "react"

import { Badge } from "../../components/ui/badge"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import type { Agent, AgentCall } from "../../types"
import { SteerComposer } from "./SteerComposer"
import { ToolCallModal } from "./ToolCallModal"

export function AgentCard({
  agent,
  now,
  onDelete,
}: {
  agent: Agent
  now: number
  onDelete: () => Promise<void>
}) {
  const { t, locale } = useI18n()
  const [selectedCallId, setSelectedCallId] = useState<string>()
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()
  const active = now - agent.lastSeenAt < 30_000
  const recent = [agent.current, ...agent.recent].filter((call): call is AgentCall => Boolean(call))
  const selectedCall = recent.find((call) => call.id === selectedCallId)
  const visibleRecent = recent.slice(0, 4)

  async function remove() {
    if (!window.confirm(t("agent.deleteConfirm", { id: agent.id }))) return
    setDeleting(true)
    setDeleteError(undefined)
    try {
      await onDelete()
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error))
      setDeleting(false)
    }
  }

  return (
    <Card className="session-card overflow-hidden">
      <CardHeader className="session-card-header border-b">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusDot active={active} />
              <h2 className="truncate text-[14px] font-semibold tracking-tight">{agent.id}</h2>
              <span className={active ? "session-state session-state-active" : "session-state"}>
                {active ? t("agent.active") : t("agent.inactive")}
              </span>
            </div>
            <p className="mt-1 truncate text-[12px] text-muted-foreground">
              {agent.taskSlug ?? t("agent.noTask")}
            </p>
            {agent.projectId || agent.goalId ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {agent.projectId ? (
                  <Badge>{t("agent.project", { id: agent.projectId })}</Badge>
                ) : null}
                {agent.goalId ? <Badge>{t("agent.goal", { id: agent.goalId })}</Badge> : null}
              </div>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="session-delete-button size-7"
            disabled={deleting}
            aria-label={t("agent.delete")}
            title={t("agent.delete")}
            onClick={() => void remove()}
          >
            {deleting ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 pt-3">
        <div>
          <h3 className="mb-1.5 text-[11px] font-medium text-muted-foreground">
            {t("agent.recent")}
          </h3>
          <div className="space-y-0.5">
            {visibleRecent.map((call) => (
              <ActivityRow
                key={call.id}
                call={call}
                onClick={() => setSelectedCallId(call.id)}
                locale={locale}
              />
            ))}
          </div>
          {recent.length > visibleRecent.length ? (
            <div className="mt-1 px-2 text-[11px] text-muted-foreground">
              {t("agent.moreActivity", { count: recent.length - visibleRecent.length })}
            </div>
          ) : null}
        </div>

        {deleteError ? <div className="text-xs text-destructive">{deleteError}</div> : null}
        <SteerComposer agent={agent} />
      </CardContent>
      <ToolCallModal call={selectedCall} onClose={() => setSelectedCallId(undefined)} />
    </Card>
  )
}

function ActivityRow({
  call,
  onClick,
  locale,
}: {
  call: AgentCall
  onClick: () => void
  locale: string
}) {
  const { t } = useI18n()
  const running = call.status === "running"
  const failed = call.status === "failed"

  return (
    <button
      type="button"
      onClick={onClick}
      className={`activity-row ${failed ? "activity-row-failed" : running ? "activity-row-running" : ""}`}
    >
      {failed ? (
        <TriangleAlert className="size-3.5 shrink-0 text-red-600" />
      ) : running ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-emerald-600" />
      ) : (
        <Check className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="w-24 shrink-0 truncate font-medium">{call.tool}</span>
      <span
        className={`min-w-0 flex-1 truncate ${failed ? "text-red-700" : "text-muted-foreground"}`}
      >
        {call.summary || (running ? t("agent.working") : t("agent.completed"))}
      </span>
      <span
        className={
          failed
            ? "shrink-0 text-red-600"
            : running
              ? "shrink-0 text-emerald-600"
              : "shrink-0 text-muted-foreground"
        }
      >
        {running ? t("agent.now") : formatClock(call.finishedAt ?? call.startedAt, locale)}
      </span>
    </button>
  )
}

function StatusDot({ active }: { active: boolean }) {
  return <span className={active ? "status-dot status-dot-online" : "status-dot"} />
}

function formatClock(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
}
