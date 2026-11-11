import {
  ArrowLeft,
  ArrowUp,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleAlert,
  CornerDownRight,
  Download,
  GitFork,
  ListTree,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  RotateCw,
  Search,
  Square,
  Trash2,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "../../components/ui/button"
import { ConfirmDialog } from "../../components/ui/confirm-dialog"
import { useI18n } from "../../i18n"
import {
  deleteSubagentSession,
  fetchSubagentSession,
  fetchSubagentSessions,
  forkSubagentSession,
  renameSubagentSession,
  restoreSubagentSnapshot,
  retrySubagentSession,
  steerSubagentSession,
  stopSubagentSession,
  subagentExportUrl,
} from "../../lib/api"
import type {
  SubagentSessionDetail,
  SubagentSessionEvent,
  SubagentSessionStatus,
  SubagentSessionSummary,
} from "../../types"
import { groupActivity } from "./activity-blocks"
import { SubagentApprovals } from "./SubagentApprovals"
import { SubagentHarnessStatus } from "./SubagentHarnessStatus"
import { SubagentMarkdown } from "./SubagentMarkdown"
import { ToolAction } from "./SubagentToolDetails"

const IS_MOCK = import.meta.env.VITE_MOCK_DASHBOARD === "1"

export function SubagentActivity({
  onBack,
  initialSessionId,
  agentFilter,
}: {
  onBack: () => void
  initialSessionId?: string
  agentFilter?: string
}) {
  const { t } = useI18n()
  const backLabel = agentFilter ? t("subagents.backToDashboard") : t("subagents.configTab")
  const [sessions, setSessions] = useState<SubagentSessionSummary[]>([])
  const [selectedId, setSelectedId] = useState(initialSessionId)
  const [mobilePanel, setMobilePanel] = useState<"sessions" | "detail">(
    initialSessionId ? "detail" : "sessions"
  )
  const [detail, setDetail] = useState<SubagentSessionDetail>()
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string>()
  const [runningOnly, setRunningOnly] = useState(false)
  const [search, setSearch] = useState("")
  const timelineRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const items = await fetchSubagentSessions()
        if (!alive) return
        setSessions(items)
        const scoped = items.filter(
          (session) => !agentFilter || session.owner_agent_id === agentFilter
        )
        setSelectedId((current) =>
          current && scoped.some((session) => session.job_id === current)
            ? current
            : scoped[0]?.job_id
        )
      } catch (failure) {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure))
      }
    }
    void poll()
    const stream =
      !IS_MOCK && typeof EventSource !== "undefined"
        ? new EventSource("/ui/api/subagents/events")
        : undefined
    stream?.addEventListener("open", () => void poll())
    stream?.addEventListener("change", () => void poll())
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void poll()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    // Fallback if the EventSource connection is interrupted or unavailable.
    const timer = window.setInterval(() => void poll(), stream ? 20_000 : 2_000)
    return () => {
      alive = false
      stream?.close()
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.clearInterval(timer)
    }
  }, [agentFilter])

  useEffect(() => {
    if (!selectedId) return
    let alive = true
    const poll = async () => {
      try {
        const next = await fetchSubagentSession(selectedId)
        if (alive) setDetail(next)
      } catch (failure) {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure))
      }
    }
    void poll()
    const stream =
      !IS_MOCK && typeof EventSource !== "undefined"
        ? new EventSource("/ui/api/subagents/events")
        : undefined
    stream?.addEventListener("open", () => void poll())
    stream?.addEventListener("change", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { jobId?: string }
        if (data.jobId === selectedId) void poll()
      } catch {
        void poll()
      }
    })
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void poll()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    const timer = window.setInterval(() => void poll(), stream ? 20_000 : 1_500)
    return () => {
      alive = false
      stream?.close()
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.clearInterval(timer)
    }
  }, [selectedId])

  const eventCount = detail?.events.length ?? 0
  useEffect(() => {
    if (eventCount > 0 && timelineRef.current)
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight
  }, [eventCount])

  async function sendGuidance() {
    const message = draft.trim()
    if (!selectedId || !message || sending) return
    setSending(true)
    setError(undefined)
    try {
      const next = await steerSubagentSession(selectedId, message)
      setDetail(next)
      setDraft("")
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSending(false)
    }
  }

  async function stopSelected() {
    if (!selectedId || stopping) return
    setStopping(true)
    setError(undefined)
    try {
      const next = await stopSubagentSession(selectedId)
      setDetail(next)
      setSessions(await fetchSubagentSessions())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStopping(false)
    }
  }

  async function modifySelected(action: "rename" | "fork" | "retry") {
    if (!selectedId) return
    setError(undefined)
    try {
      let updated: SubagentSessionDetail
      if (action === "rename") {
        const next = window.prompt(t("subagents.renameSession"), selected?.title ?? "")
        if (!next?.trim()) return
        updated = await renameSubagentSession(selectedId, next.trim())
      } else if (action === "fork") {
        const maximum = selected?.active_turns ?? selected?.modelTurns ?? 0
        const chosen = window.prompt(
          t("subagents.forkThroughTurn", { count: maximum }),
          String(maximum)
        )
        if (chosen === null) return
        const throughTurn = Number(chosen.trim())
        if (!Number.isSafeInteger(throughTurn) || throughTurn < 0 || throughTurn > maximum) {
          setError(t("subagents.forkThroughTurn", { count: maximum }))
          return
        }
        updated = await forkSubagentSession(
          selectedId,
          "Continue from this selected model turn.",
          throughTurn
        )
        setSelectedId(updated.job_id)
      } else updated = await retrySubagentSession(selectedId)
      setDetail(updated)
      setSessions(await fetchSubagentSessions())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  async function changeFileSnapshot(snapshotId: string, operation: "undo" | "redo") {
    if (!selectedId || !window.confirm(t("subagents.restoreSnapshotConfirm"))) return
    setError(undefined)
    try {
      setDetail(await restoreSubagentSnapshot(selectedId, snapshotId, operation))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  async function deleteSelected() {
    if (!selectedId || deleting) return
    setDeleting(true)
    setError(undefined)
    try {
      await deleteSubagentSession(selectedId)
      setDeleteConfirmOpen(false)
      setDetail(undefined)
      setSelectedId(undefined)
      setMobilePanel("sessions")
      setSessions(await fetchSubagentSessions())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setDeleteConfirmOpen(false)
    } finally {
      setDeleting(false)
    }
  }

  function selectSession(id: string) {
    setMobilePanel("detail")
    setSelectedId(id)
    setDetail(undefined)
    setDraft("")
    setError(undefined)
  }

  const scopedSessions = sessions.filter(
    (session) => !agentFilter || session.owner_agent_id === agentFilter
  )
  const runningCount = scopedSessions.filter((session) => session.status === "running").length
  const ordered = orderSessions(scopedSessions).filter(
    (session) =>
      (!runningOnly || session.status === "running") &&
      [session.title, session.profile, session.job_id].some((value) =>
        value.toLowerCase().includes(search.trim().toLowerCase())
      )
  )
  const selected = detail?.job_id === selectedId ? detail : undefined

  return (
    <div className="subagent-workspace" data-mobile-panel={mobilePanel}>
      <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r bg-card">
        <div className="border-b px-4 pb-3 pt-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ListTree className="size-4 text-muted-foreground" />
              <h2 className="text-[13px] font-semibold">{t("subagents.sessions")}</h2>
              <span className="rounded bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">
                {scopedSessions.length}
              </span>
            </div>
            <button
              type="button"
              onClick={onBack}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={backLabel}
              title={backLabel}
            >
              <ArrowLeft className="size-4" />
            </button>
          </div>
          {agentFilter && (
            <p className="mt-2 truncate text-[11px] text-muted-foreground">
              ChatGPT / {agentFilter}
            </p>
          )}
          <div className="mt-3 flex gap-1 border-b pb-1">
            <button
              type="button"
              onClick={() => setRunningOnly(false)}
              className={`rounded px-2.5 py-1 text-[11px] transition-colors ${runningOnly ? "text-muted-foreground hover:bg-muted/40" : "bg-muted font-medium"}`}
            >
              {t("subagents.allSessions")}
            </button>
            <button
              type="button"
              onClick={() => setRunningOnly(true)}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] transition-colors ${runningOnly ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/40"}`}
            >
              <span className="size-1.5 rounded-full bg-emerald-500" />
              {t("subagents.status.running")} {runningCount}
            </button>
          </div>
          <label className="mt-2 flex items-center gap-2 rounded border bg-background px-2 text-muted-foreground">
            <Search className="size-3.5 shrink-0" />
            <input
              className="h-8 w-full bg-transparent text-xs outline-none"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("subagents.searchSessions")}
            />
          </label>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
          {scopedSessions.length === 0 && (
            <p className="px-3 py-10 text-center text-xs text-muted-foreground">
              {t("subagents.noSessions")}
            </p>
          )}
          {ordered.map((session) => (
            <button
              key={session.job_id}
              type="button"
              aria-current={selectedId === session.job_id ? "page" : undefined}
              onClick={() => selectSession(session.job_id)}
              className={`group w-full rounded-md px-3 py-3 text-left transition-colors ${session.parent_id ? "pl-6" : ""} ${
                selectedId === session.job_id ? "bg-muted/80" : "hover:bg-muted/40"
              }`}
              title={session.title}
            >
              <div className="flex items-start gap-2">
                {session.parent_id ? (
                  <CornerDownRight className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <SessionDot status={session.status} />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block line-clamp-2 text-[12px] font-medium leading-5">
                    {session.title}
                  </span>
                  <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                    {session.profile}{" "}
                    <span className="opacity-60">· {shortId(session.job_id)}</span>
                  </span>
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between pl-[15px] text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <SessionDot status={session.status} />
                  {t(`subagents.status.${session.status}`)}
                </span>
                <span>{clock(session.updated_at)}</span>
              </div>
            </button>
          ))}
        </div>
        <div className="border-t px-4 py-2 text-[11px] text-muted-foreground">
          {t("subagents.instanceHint")}
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-card">
        {selected ? (
          <>
            <header className="shrink-0 border-b px-5 py-2 sm:px-7">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  className="mobile-session-back"
                  aria-label={t("subagents.sessions")}
                  onClick={() => setMobilePanel("sessions")}
                >
                  <ArrowLeft className="size-4" />
                </button>
                {selected.parent_id && (
                  <button
                    type="button"
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={t("subagents.backToParent")}
                    title={t("subagents.backToParent")}
                    onClick={() => {
                      if (selected.parent_id) selectSession(selected.parent_id)
                    }}
                  >
                    <ArrowLeft className="size-3.5" />
                  </button>
                )}
                <h2
                  className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-tight"
                  title={selected.title}
                >
                  {selected.title}
                </h2>
                {IS_MOCK && (
                  <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    DEMO
                  </span>
                )}
                <SessionStatus status={selected.status} />
                <button
                  type="button"
                  title={t("subagents.renameSession")}
                  aria-label={t("subagents.renameSession")}
                  onClick={() => void modifySelected("rename")}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
                >
                  <Pencil className="size-3.5" />
                </button>
                {selected.status !== "running" && (
                  <>
                    <button
                      type="button"
                      title={t("subagents.forkSession")}
                      aria-label={t("subagents.forkSession")}
                      onClick={() => void modifySelected("fork")}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
                    >
                      <GitFork className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title={t("subagents.retrySession")}
                      aria-label={t("subagents.retrySession")}
                      onClick={() => void modifySelected("retry")}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
                    >
                      <RotateCw className="size-3.5" />
                    </button>
                  </>
                )}
                {!IS_MOCK && (
                  <a
                    href={subagentExportUrl(selected.job_id)}
                    title={t("subagents.exportSession")}
                    aria-label={t("subagents.exportSession")}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
                  >
                    <Download className="size-3.5" />
                  </a>
                )}
                {selected.status === "running" && (
                  <button
                    type="button"
                    onClick={() => void stopSelected()}
                    disabled={stopping}
                    title={t("subagents.stopSession")}
                    aria-label={t("subagents.stopSession")}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                    data-testid="subagent-stop"
                  >
                    {stopping ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <Square className="size-3.5" />
                    )}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setDeleteConfirmOpen(true)}
                  disabled={deleting}
                  title={t("subagents.deleteSession")}
                  aria-label={t("subagents.deleteSession")}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                <span>ChatGPT</span>
                <ChevronRight className="size-3 shrink-0" />
                <span className="shrink-0">{t("subagents.child")}</span>
                <span className="mx-1 opacity-50">·</span>
                <span className="min-w-0 truncate">
                  {selected.provider} / {selected.model}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[10px]" title={selected.job_id}>
                  {shortId(selected.job_id)}
                </span>
              </div>
            </header>
            <SubagentHarnessStatus
              session={selected}
              childCount={
                scopedSessions.filter((item) => item.parent_id === selected.job_id).length
              }
            />
            {(selected.snapshots?.length ?? 0) > 0 && (
              <details className="shrink-0 border-b text-xs">
                <summary className="cursor-pointer px-5 py-2 text-muted-foreground">
                  {t("subagents.fileSnapshots")} · {selected.snapshots?.length ?? 0}
                </summary>
                <div className="max-h-64 space-y-2 overflow-auto border-t px-5 py-3">
                  {selected.snapshots?.map((snapshot) => (
                    <details key={snapshot.id} className="rounded border p-2">
                      <summary className="cursor-pointer font-mono text-[11px]">
                        {snapshot.tool} · {new Date(snapshot.time).toLocaleTimeString()}
                        {snapshot.applied ? "" : ` · ${t("subagents.undone")}`}
                      </summary>
                      <div className="mt-2 space-y-2">
                        {snapshot.changes.map((change) => (
                          <div key={change.path}>
                            <div className="truncate font-mono text-[11px]">{change.path}</div>
                            <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-[10px]">
                              {change.diff}
                            </pre>
                          </div>
                        ))}
                        {selected.status !== "running" && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void changeFileSnapshot(
                                snapshot.id,
                                snapshot.applied ? "undo" : "redo"
                              )
                            }
                          >
                            {snapshot.applied
                              ? t("subagents.undoSnapshot")
                              : t("subagents.redoSnapshot")}
                          </Button>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            )}

            <div
              ref={timelineRef}
              className="min-h-0 flex-1 overflow-y-auto bg-background/30 px-4 py-5 sm:px-7"
            >
              <div className="mx-auto w-full max-w-[780px]">
                <div className="space-y-5">
                  {groupActivity(selected.events).map((block) =>
                    block.kind === "actions" ? (
                      <ToolGroup key={`${selected.job_id}:${block.id}`} events={block.events} />
                    ) : (
                      <ActivityEntry key={`${selected.job_id}:${block.id}`} event={block.event} />
                    )
                  )}
                </div>
                {selected.status !== "running" &&
                  !selected.events.some((event) => event.role === "tool") && (
                    <p className="mt-5 text-[11px] text-muted-foreground">
                      {t("subagents.noToolCalls")}
                    </p>
                  )}
                {selected.error && (
                  <div className="mt-7 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
                    <CircleAlert className="size-4 shrink-0" /> {selected.error}
                  </div>
                )}
                <div />
              </div>
            </div>

            <SubagentApprovals key={selected.session_id} sessionId={selected.session_id} />
            <div className="shrink-0 border-t bg-card px-4 py-3 sm:px-7">
              <form
                className="mx-auto w-full max-w-[780px]"
                onSubmit={(event) => {
                  event.preventDefault()
                  void sendGuidance()
                }}
              >
                <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <MessageSquareText className="size-3.5" /> {t("subagents.guidance")}
                    {selected.pending_guidance > 0 && (
                      <span>
                        · {selected.pending_guidance} {t("subagents.queued")}
                      </span>
                    )}
                  </span>
                  <span>{t("subagents.guidanceShortHint")}</span>
                </div>
                <div className="flex items-end gap-3 rounded-lg border bg-background px-3 py-2 focus-within:border-primary/50">
                  <textarea
                    rows={2}
                    maxLength={8000}
                    className="max-h-32 min-h-12 flex-1 resize-y bg-transparent py-1 text-sm outline-none"
                    aria-label={t("subagents.guidance")}
                    placeholder={t("subagents.guidancePlaceholder")}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault()
                        void sendGuidance()
                      }
                    }}
                  />
                  <Button
                    size="icon"
                    type="submit"
                    className="size-8 shrink-0"
                    aria-label={t("subagents.sendGuidance")}
                    title={t("subagents.sendGuidance")}
                    disabled={!draft.trim() || sending}
                  >
                    {sending ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <ArrowUp className="size-4" />
                    )}
                  </Button>
                </div>
              </form>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <BrainCircuit className="size-9 opacity-40" />
            <p className="text-sm">{t("subagents.selectSession")}</p>
          </div>
        )}
        {error && <p className="border-t px-5 py-2 text-xs text-destructive">{error}</p>}
      </section>
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title={t("subagents.deleteSession")}
        description={t("subagents.deleteSessionConfirm")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        confirming={deleting}
        onConfirm={() => void deleteSelected()}
      />
    </div>
  )
}

function ToolGroup({ events }: { events: SubagentSessionEvent[] }) {
  const { t } = useI18n()
  const calls = events.filter((event) => event.role === "tool")
  const names = [...new Set(calls.map((event) => event.tool ?? t("subagents.toolActivity")))]
  const running = calls.some((event) => event.status === "running")
  const failed = calls.some((event) => event.status === "failed")
  const batches = new Map<string, number>()
  for (const call of calls) {
    if (call.parallelBatch)
      batches.set(call.parallelBatch, (batches.get(call.parallelBatch) ?? 0) + 1)
  }
  const peakParallel = Math.max(0, ...batches.values())
  return (
    <details className="group/actions py-1" data-testid="subagent-action-group">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded px-1 py-1.5 text-xs hover:bg-muted/35">
        <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-open/actions:rotate-90" />
        <span className="shrink-0 font-medium text-foreground/85">
          {t("subagents.usedTools", { count: calls.length })}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{names.join(" · ")}</span>
        {peakParallel > 1 && (
          <span
            className="shrink-0 tabular-nums text-[11px] text-muted-foreground"
            data-testid="parallel-tool-badge"
          >
            {t("subagents.parallelPeak", { count: peakParallel })}
          </span>
        )}
        {running ? (
          <LoaderCircle className="size-3 shrink-0 animate-spin text-emerald-500" />
        ) : failed ? (
          <CircleAlert className="size-3 shrink-0 text-destructive" />
        ) : null}
      </summary>
      <div className="ml-2 mt-1 space-y-0.5 border-l border-border/60 pl-3">
        {events.map((event) =>
          event.role === "tool" ? (
            <ToolAction key={event.id} event={event} />
          ) : (
            <ActivityEntry key={event.id} event={event} />
          )
        )}
      </div>
    </details>
  )
}

function ActivityEntry({ event }: { event: SubagentSessionEvent }) {
  const { t } = useI18n()
  const fromUser = event.role === "user" || event.role === "guidance"

  if (event.role === "harness") {
    const title =
      event.action === "compaction"
        ? t("subagents.compactionEvent")
        : event.action === "retry"
          ? t("subagents.retryEvent")
          : event.action === "snapshot"
            ? t("subagents.fileSnapshots")
            : t("subagents.loopEvent")
    const detail = event.text.split("\n").slice(1).join("\n").trim()
    return (
      <details className="group/harness py-0.5 text-xs" data-testid="subagent-harness-event">
        <summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-muted-foreground hover:text-foreground">
          {event.status === "running" ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : event.status === "failed" ? (
            <CircleAlert className="size-3.5 text-destructive" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
          <span className="shrink-0 font-medium">{title}</span>
          <span className="min-w-0 flex-1 truncate">{event.text.split("\n")[0]}</span>
          {detail && (
            <ChevronRight className="size-3 shrink-0 transition-transform group-open/harness:rotate-90" />
          )}
        </summary>
        {detail && (
          <div className="ml-5 border-l border-border pl-3 py-1 text-foreground">
            <SubagentMarkdown text={detail} />
          </div>
        )}
      </details>
    )
  }

  if (event.role === "thinking") {
    return (
      <details className="group/thinking py-1" data-testid="subagent-thinking">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded py-1 text-xs text-muted-foreground hover:text-foreground">
          <BrainCircuit className="size-3.5 shrink-0" />
          <span>{t("subagents.thinking")}</span>
          {event.reasoningTokens !== undefined && (
            <span className="text-[11px]">
              · {t("subagents.thinkingTokens", { count: event.reasoningTokens })}
            </span>
          )}
          {event.status === "running" && <LoaderCircle className="size-3 animate-spin" />}
          <ChevronRight className="size-3 shrink-0 transition-transform group-open/thinking:rotate-90" />
        </summary>
        <div className="ml-5 mt-2 border-l border-border/60 pl-3 text-[12px] text-muted-foreground">
          {event.text ? (
            <div className="subagent-markdown text-foreground">
              <SubagentMarkdown text={event.text} />
            </div>
          ) : (
            <p>
              {event.status === "running"
                ? t("subagents.thinkingActive")
                : t("subagents.thinkingUnavailable")}
            </p>
          )}
        </div>
      </details>
    )
  }

  if (fromUser) {
    return (
      <div className="flex justify-end py-1" data-testid="subagent-message">
        <div className="max-w-[80%] rounded-xl bg-muted px-4 py-3 text-[13px] leading-6 text-foreground sm:max-w-[72%]">
          <div className="subagent-markdown text-foreground">
            <SubagentMarkdown text={event.text} />
          </div>
          {event.status === "queued" && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">{t("subagents.queued")}</p>
          )}
        </div>
      </div>
    )
  }

  // Tool-only model turns may not contain prose; don't show an empty assistant message.
  if (!event.text && event.status !== "running") return null

  return (
    <div className="py-1 text-[13px] leading-7" data-testid="subagent-message">
      {event.text && (
        <div className="subagent-markdown text-foreground">
          <SubagentMarkdown text={event.text} />
        </div>
      )}
      {event.status === "running" && (
        <LoaderCircle className="mt-1 size-3 animate-spin text-muted-foreground" />
      )}
    </div>
  )
}

function orderSessions(sessions: SubagentSessionSummary[]): SubagentSessionSummary[] {
  const byParent = new Map<string, SubagentSessionSummary[]>()
  const ids = new Set(sessions.map((session) => session.job_id))
  for (const session of sessions) {
    const parent = session.parent_id && ids.has(session.parent_id) ? session.parent_id : ""
    const siblings = byParent.get(parent) ?? []
    siblings.push(session)
    byParent.set(parent, siblings)
  }
  const output: SubagentSessionSummary[] = []
  const add = (parent: string) => {
    const children = (byParent.get(parent) ?? []).sort((a, b) =>
      b.created_at.localeCompare(a.created_at)
    )
    for (const child of children) {
      output.push(child)
      add(child.job_id)
    }
  }
  add("")
  return output
}

function SessionDot({ status }: { status: SubagentSessionStatus }) {
  return (
    <span
      role="img"
      aria-label={status}
      className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
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

function SessionStatus({ status }: { status: SubagentSessionStatus }) {
  const { t } = useI18n()
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 text-[11px] text-muted-foreground">
      {status === "running" ? (
        <LoaderCircle className="size-3 animate-spin" />
      ) : status === "completed" ? (
        <Check className="size-3" />
      ) : status === "stopped" ? (
        <Square className="size-3" />
      ) : (
        <CircleAlert className="size-3 text-destructive" />
      )}
      {t(`subagents.status.${status}`)}
    </span>
  )
}

function shortId(id: string): string {
  return id.replace(/^subagent-/u, "").slice(-8)
}

function clock(time: string) {
  return new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}
