import {
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleAlert,
  GitBranch,
  LoaderCircle,
} from "lucide-react"

import { useI18n } from "../../i18n"
import type { SubagentSessionDetail } from "../../types"

function tokenLabel(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value
  )
}

/** Values shown here come from persisted model usage and tool events, not estimates. */
export function SubagentHarnessStatus({
  session,
  childCount,
}: {
  session: SubagentSessionDetail
  childCount: number
}) {
  const { t } = useI18n()
  const tools = session.events.filter((event) => event.role === "tool")
  const active = tools.filter((event) => event.status === "running").length
  const failed = tools.filter((event) => event.status === "failed").length
  const batches = new Map<string, number>()
  for (const event of tools) {
    if (event.parallelBatch)
      batches.set(event.parallelBatch, (batches.get(event.parallelBatch) ?? 0) + 1)
  }
  const peakParallel = Math.max(0, ...batches.values())
  const turns =
    session.modelTurns ??
    session.events.filter((event) => event.role === "assistant" && event.status === "completed")
      .length
  const usage = session.usage
  const context = usage?.lastInputTokens
  const contextWindow = session.contextWindow
  const usedPercent =
    context !== undefined && contextWindow !== undefined
      ? Math.max(0, Math.round((context / contextWindow) * 100))
      : undefined
  const completed = session.plan?.filter((step) => step.status === "completed").length ?? 0

  return (
    <>
      <div
        className="flex min-w-0 shrink-0 items-center gap-3 overflow-x-auto overscroll-x-contain border-b px-4 py-1.5 text-[11px] text-muted-foreground sm:px-7"
        data-testid="subagent-harness-status"
      >
        <span className="shrink-0 tabular-nums">{t("subagents.turnCount", { count: turns })}</span>
        <span className="shrink-0 tabular-nums">
          {t("subagents.toolCount", { count: tools.length })}
        </span>
        {(session.compactions ?? 0) > 0 && (
          <span className="shrink-0 tabular-nums" data-testid="subagent-compaction-count">
            {t("subagents.contextCompactions", { count: session.compactions ?? 0 })}
          </span>
        )}
        {session.retry && (
          <span
            className="flex shrink-0 items-center gap-1 text-amber-500"
            title={session.retry.reason}
            data-testid="subagent-retry-state"
          >
            <LoaderCircle className="size-3 animate-spin" />
            {t("subagents.retrying", { count: session.retry.attempt })}
          </span>
        )}
        {active > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-emerald-500">
            <LoaderCircle className="size-3 animate-spin" />
            {t("subagents.activeTools", { count: active })}
          </span>
        )}
        {peakParallel > 1 && (
          <span className="shrink-0 tabular-nums">
            {t("subagents.parallelPeak", { count: peakParallel })}
          </span>
        )}
        {failed > 0 && (
          <span className="shrink-0 text-destructive">
            {t("subagents.failedTools", { count: failed })}
          </span>
        )}
        {childCount > 0 && (
          <span className="flex shrink-0 items-center gap-1">
            <GitBranch className="size-3" />
            {t("subagents.childCount", { count: childCount })}
          </span>
        )}
        {usage?.totalTokens !== undefined && (
          <span className="shrink-0 tabular-nums" title={t("subagents.reportedTokens")}>
            {t("subagents.tokenCount", { count: tokenLabel(usage.totalTokens) })}
          </span>
        )}
        {usedPercent !== undefined && context !== undefined && contextWindow !== undefined && (
          <span
            className="flex shrink-0 items-center gap-1.5 tabular-nums"
            title={t("subagents.contextDetail", {
              used: context.toLocaleString(),
              total: contextWindow.toLocaleString(),
            })}
          >
            {t("subagents.contextPercentage", { count: usedPercent })}
            <span className="h-1 w-14 overflow-hidden rounded-full bg-muted">
              <span
                className={`block h-full ${usedPercent >= 85 ? "bg-amber-500" : "bg-primary"}`}
                style={{ width: `${Math.min(100, usedPercent)}%` }}
              />
            </span>
          </span>
        )}
        {session.pending_guidance > 0 && (
          <span className="shrink-0">
            {t("subagents.queuedGuidance", { count: session.pending_guidance })}
          </span>
        )}
      </div>
      {session.plan && session.plan.length > 0 && (
        <details className="group/plan shrink-0 border-b" data-testid="subagent-plan">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-xs text-muted-foreground hover:bg-muted/30 sm:px-7">
            <CheckCircle2 className="size-3.5" />
            <span>{t("subagents.planProgress", { completed, total: session.plan.length })}</span>
            <ChevronDown className="ml-auto size-3.5 transition-transform group-open/plan:rotate-180" />
          </summary>
          <ol className="max-h-48 space-y-2 overflow-y-auto border-t px-5 py-3 sm:px-8">
            {session.plan.map((step) => (
              <li key={step.description} className="flex items-start gap-2 text-[12px] leading-5">
                {step.status === "completed" ? (
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                ) : step.status === "in_progress" ? (
                  <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" />
                ) : step.status === "blocked" ? (
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                ) : (
                  <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span
                  className={
                    step.status === "completed" ? "text-muted-foreground" : "text-foreground"
                  }
                >
                  {step.description}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  )
}
