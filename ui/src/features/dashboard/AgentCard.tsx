import {
  BrainCircuit,
  Check,
  ChevronRight,
  CircleGauge,
  Infinity as InfinityIcon,
  LoaderCircle,
  Square,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { useState } from "react"

import { Badge } from "../../components/ui/badge"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { ConfirmDialog } from "../../components/ui/confirm-dialog"
import { useI18n } from "../../i18n"
import { setUnlimitedContext, stopAgentCall } from "../../lib/api"
import type { Agent, AgentCall, SubagentSessionSummary } from "../../types"
import { SteerComposer } from "./SteerComposer"
import { ToolCallModal } from "./ToolCallModal"

export function AgentCard({
  agent,
  subagents = [],
  onOpenSubagent,
  now,
  onDelete,
  showContextLimit = true,
}: {
  agent: Agent
  subagents?: SubagentSessionSummary[]
  onOpenSubagent?: (jobId: string) => void
  now: number
  onDelete: () => Promise<void>
  showContextLimit?: boolean
}) {
  const { t, locale } = useI18n()
  const [selectedCallId, setSelectedCallId] = useState<string>()
  const [deleting, setDeleting] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()
  const [stoppingCallId, setStoppingCallId] = useState<string>()
  const [stopError, setStopError] = useState<string>()
  const [changingLimit, setChangingLimit] = useState(false)
  const [limitError, setLimitError] = useState<string>()
  const active = now - agent.lastSeenAt < 30_000
  const recent = [agent.current, ...agent.recent].filter((call): call is AgentCall => Boolean(call))
  const selectedCall = recent.find((call) => call.id === selectedCallId)

  async function remove() {
    if (deleting) return
    setDeleting(true)
    setDeleteError(undefined)
    try {
      await onDelete()
      setDeleteDialogOpen(false)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error))
      setDeleteDialogOpen(false)
    } finally {
      setDeleting(false)
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

  async function toggleUnlimited() {
    setChangingLimit(true)
    setLimitError(undefined)
    try {
      await setUnlimitedContext(agent.id, !agent.contextBudget?.unlimited)
    } catch (error) {
      setLimitError(error instanceof Error ? error.message : String(error))
    } finally {
      setChangingLimit(false)
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
            {agent.agentId ? (
              <p
                className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
                title={agent.agentId}
              >
                Agent UUID: {agent.agentId}
              </p>
            ) : null}
            {agent.contextBudget?.dot ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Badge>Dot</Badge>
              </div>
            ) : null}
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
                title="OpenChatX context budget"
              >
                <CircleGauge className="size-3.5" />
                <span>
                  {formatContextTokens(agent.contextBudget.tokens)}
                  {showContextLimit && !agent.contextBudget.unlimited ? (
                    <>
                      {" / "}
                      {formatContextTokens(agent.contextBudget.threshold)}
                    </>
                  ) : null}
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
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={changingLimit}
              aria-pressed={agent.contextBudget?.unlimited === true}
              aria-label={t("agent.unlimitedContext")}
              title={t("agent.unlimitedContextHint")}
              onClick={() => void toggleUnlimited()}
            >
              <InfinityIcon
                className={agent.contextBudget?.unlimited ? "size-3.5 text-primary" : "size-3.5"}
              />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="session-delete-button size-7"
              disabled={deleting}
              aria-label={t("agent.delete")}
              title={t("agent.delete")}
              onClick={() => setDeleteDialogOpen(true)}
            >
              {deleting ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
            </Button>
          </div>
        </div>
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
                now={now}
              />
            ))}
          </div>
        </div>

        {subagents.length > 0 && (
          <div className="border-t pt-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <BrainCircuit className="size-3.5" />
                {t("subagents.sessions")}
                <span className="rounded bg-muted px-1.5 py-0.5 tabular-nums">
                  {subagents.length}
                </span>
              </h3>
              {subagents.some((session) => session.status === "running") && (
                <span className="flex items-center gap-1 text-[10px] text-emerald-500">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  {subagents.filter((session) => session.status === "running").length}{" "}
                  {t("subagents.status.running")}
                </span>
              )}
            </div>
            <div className="max-h-[172px] space-y-0.5 overflow-y-auto overscroll-contain pr-1">
              {subagents.map((session) => (
                <button
                  key={session.job_id}
                  type="button"
                  onClick={() => onOpenSubagent?.(session.job_id)}
                  className={`group flex h-14 w-full items-center gap-2 rounded-md pr-1 text-left hover:bg-muted/60 ${session.parent_id ? "pl-5" : "pl-2"}`}
                  title={session.title}
                >
                  <SubagentStatusDot status={session.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{session.title}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {session.parent_id ? "↳ " : ""}
                      {session.profile} · {session.job_id.slice(-8)}
                    </span>
                  </span>
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70 group-hover:text-foreground" />
                </button>
              ))}
            </div>
          </div>
        )}

        {deleteError ? <div className="text-xs text-destructive">{deleteError}</div> : null}
        {stopError ? <div className="text-xs text-destructive">{stopError}</div> : null}
        {limitError ? <div className="text-xs text-destructive">{limitError}</div> : null}
        <SteerComposer agent={agent} />
      </CardContent>
      <ToolCallModal call={selectedCall} onClose={() => setSelectedCallId(undefined)} />
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t("agent.delete")}
        description={t("agent.deleteConfirm", { id: agent.id })}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        confirming={deleting}
        onConfirm={() => void remove()}
      />
    </Card>
  )
}

function ActivityRow({
  call,
  onClick,
  onStop,
  stopping,
  locale,
  now,
}: {
  call: AgentCall
  onClick: () => void
  onStop?: () => void
  stopping?: boolean
  locale: string
  now: number
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
          className="w-14 shrink-0 text-right tabular-nums text-muted-foreground"
          title={t("agent.duration")}
        >
          {formatDuration(Math.max(0, (call.finishedAt ?? now) - call.startedAt))}
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

function SubagentStatusDot({ status }: { status: SubagentSessionSummary["status"] }) {
  return (
    <span
      aria-label={status}
      role="img"
      className={`size-2 shrink-0 rounded-full ${
        status === "running"
          ? "bg-emerald-500"
          : status === "completed"
            ? "bg-sky-500"
            : status === "stopped"
              ? "bg-muted-foreground/60"
              : "bg-rose-500"
      }`}
    />
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

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60_000) {
    const seconds = milliseconds / 1_000
    return `${seconds < 10 ? seconds.toFixed(1).replace(/\.0$/u, "") : Math.round(seconds)}s`
  }
  if (milliseconds < 3_600_000) {
    const minutes = Math.floor(milliseconds / 60_000)
    const seconds = Math.floor((milliseconds % 60_000) / 1_000)
    return `${minutes}m ${seconds}s`
  }
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  return `${hours}h ${minutes}m`
}

function formatClock(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
}
