import {
  Check,
  CircleGauge,
  LoaderCircle,
  Orbit,
  Square,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { useState } from "react"

import { Badge } from "../../components/ui/badge"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import { setAgentDot, stopAgentCall } from "../../lib/api"
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
  const [stoppingCallId, setStoppingCallId] = useState<string>()
  const [stopError, setStopError] = useState<string>()
  const [dotUpdating, setDotUpdating] = useState(false)
  const [dotError, setDotError] = useState<string>()
  const active = now - agent.lastSeenAt < 30_000
  const recent = [agent.current, ...agent.recent].filter((call): call is AgentCall => Boolean(call))
  const selectedCall = recent.find((call) => call.id === selectedCallId)

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

  async function toggleDot() {
    setDotUpdating(true)
    setDotError(undefined)
    try {
      await setAgentDot(agent.id, !agent.dot)
    } catch (error) {
      setDotError(error instanceof Error ? error.message : String(error))
    } finally {
      setDotUpdating(false)
    }
  }

  async function stopCall(call: AgentCall) {
    setStoppingCallId(call.id)
    setStopError(undefined)
    try {
      await stopAgentCall(agent.id, call.id)
    } catch (error) {
      setStopError(error instanceof Error ? error.message : String(error))
      setStoppingCallId(undefined)
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
              {agent.dot ? <Badge>Dot</Badge> : null}
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
            {agent.contextBudget ? (
              <div
                className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground"
                title={agent.dot ? "OpenChatX usage" : "OpenChatX context budget"}
              >
                <CircleGauge className="size-3.5" />
                <span>
                  {formatContextTokens(agent.contextBudget.tokens)}
                  {agent.dot ? null : ` / ${formatContextTokens(agent.contextBudget.threshold)}`}
                </span>
                <span className="text-muted-foreground/80">
                  input={formatContextTokens(agent.contextBudget.inputTokens)} output=
                  {formatContextTokens(agent.contextBudget.outputTokens)}
                </span>
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant={agent.dot ? "outline" : "ghost"}
              size="sm"
              disabled={dotUpdating}
              aria-label={agent.dot ? "取消 Dot" : "標記為 Dot"}
              title={agent.dot ? "取消 Dot" : "標記為 Dot"}
              onClick={() => void toggleDot()}
            >
              {dotUpdating ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Orbit className="size-3.5" />
              )}
              <span>Dot</span>
            </Button>
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
        </div>
        {dotError ? <p className="mt-2 text-xs text-destructive">{dotError}</p> : null}
      </CardHeader>

      <CardContent className="space-y-3 pt-3">
        <div>
          <h3 className="mb-1.5 text-[11px] font-medium text-muted-foreground">
            {t("agent.recent")}
          </h3>
          <div className="activity-list-scroll space-y-0.5">
            {recent.map((call) => (
              <ActivityRow
                key={call.id}
                call={call}
                onClick={() => setSelectedCallId(call.id)}
                onStop={call.status === "running" ? () => void stopCall(call) : undefined}
                stopping={stoppingCallId === call.id}
                locale={locale}
              />
            ))}
          </div>
        </div>

        {deleteError ? <div className="text-xs text-destructive">{deleteError}</div> : null}
        {stopError ? <div className="text-xs text-destructive">{stopError}</div> : null}
        <SteerComposer agent={agent} />
      </CardContent>
      <ToolCallModal call={selectedCall} onClose={() => setSelectedCallId(undefined)} />
    </Card>
  )
}

function ActivityRow({
  call,
  onClick,
  onStop,
  stopping,
  locale,
}: {
  call: AgentCall
  onClick: () => void
  onStop?: () => void
  stopping?: boolean
  locale: string
}) {
  const { t } = useI18n()
  const running = call.status === "running"
  const failed = call.status === "failed"
  const interrupted = call.status === "interrupted"
  const fallbackSummary = running
    ? t("agent.working")
    : failed
      ? t("agent.failed")
      : interrupted
        ? t("agent.interrupted")
        : t("agent.completed")

  return (
    <div
      className={`activity-row ${failed ? "activity-row-failed" : interrupted ? "activity-row-interrupted" : running ? "activity-row-running" : ""}`}
    >
      <button type="button" onClick={onClick} className="activity-row-open">
        {failed ? (
          <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : running ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-[var(--success-foreground)]" />
        ) : interrupted ? (
          <Square className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Check className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="w-24 shrink-0 truncate font-medium">{call.tool}</span>
        <span
          className={`min-w-0 flex-1 truncate ${failed ? "text-destructive" : "text-muted-foreground"}`}
        >
          {call.summary || fallbackSummary}
        </span>
        <span
          className={
            failed
              ? "shrink-0 text-destructive"
              : running
                ? "shrink-0 text-[var(--success-foreground)]"
                : "shrink-0 text-muted-foreground"
          }
        >
          {running ? t("agent.now") : formatClock(call.finishedAt ?? call.startedAt, locale)}
        </span>
      </button>
      {onStop ? (
        <button
          type="button"
          className="activity-stop-button"
          onClick={onStop}
          disabled={stopping}
          title={t("agent.stopCall")}
          aria-label={t("agent.stopCall")}
        >
          {stopping ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Square className="size-3.5" />
          )}
        </button>
      ) : null}
    </div>
  )
}

function StatusDot({ active }: { active: boolean }) {
  return <span className={active ? "status-dot status-dot-online" : "status-dot"} />
}

function formatContextTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens)
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${millions.toFixed(1).replace(/\.0$/u, "")}M`
  }
  const thousands = tokens / 1_000
  return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/u, "")}k`
}

function formatClock(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
}
