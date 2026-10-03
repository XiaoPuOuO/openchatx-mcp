import { Activity, AlertTriangle, X } from "lucide-react"
import { useEffect, useState } from "react"
import { PageHeader } from "../../components/PageHeader"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import { fetchJobDetail, fetchPlatformOverview } from "../../lib/api"
import { dismissAttentionItem, visibleAttentionItems } from "../../lib/attention-dismissals"
import type { DurableJobDetail, PlatformOverview } from "../../types"
import { CapabilityHealthPanel } from "../dashboard/CapabilityHealthPanel"

export function StatusPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [overview, setOverview] = useState<PlatformOverview>()
  const [jobDetail, setJobDetail] = useState<DurableJobDetail>()
  const [jobDetailError, setJobDetailError] = useState<string>()
  const [loadingJobId, setLoadingJobId] = useState<string>()

  async function openJob(jobId: string) {
    setLoadingJobId(jobId)
    setJobDetailError(undefined)
    try {
      setJobDetail(await fetchJobDetail(jobId))
    } catch (error) {
      setJobDetailError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingJobId(undefined)
    }
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const next = await fetchPlatformOverview()
        if (!cancelled) setOverview(next)
      } catch {
        // CapabilityHealthPanel reports health-loading errors separately.
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 10_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const visibleAttention = overview ? visibleAttentionItems(overview.needsAttention) : []

  return (
    <main className="min-h-screen">
      <PageHeader
        icon={Activity}
        title={t("status.title")}
        subtitle={t("status.subtitle")}
        onBack={onBack}
      />

      <div className="mx-auto max-w-6xl px-5 py-6">
        {overview ? (
          <Card className="mb-5">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <AlertTriangle className="size-4" />
                {t("status.needsAttention")}
                <span className="text-xs font-normal text-muted-foreground">
                  {visibleAttention.length}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              {visibleAttention.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("status.noIssues")}</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {visibleAttention.map((item) => (
                    // biome-ignore lint/a11y/noStaticElementInteractions: Only job cards receive interaction handlers and role=button.
                    <div
                      key={`${item.source}:${item.id}:${item.detail}`}
                      className={`rounded-md border px-3 py-2 ${item.source === "job" ? "cursor-pointer transition-colors hover:bg-muted/40" : ""}`}
                      role={item.source === "job" ? "button" : undefined}
                      tabIndex={item.source === "job" ? 0 : undefined}
                      onClick={item.source === "job" ? () => void openJob(item.id) : undefined}
                      onKeyDown={
                        item.source === "job"
                          ? (event) => {
                              if (event.key === "Enter" || event.key === " ") void openJob(item.id)
                            }
                          : undefined
                      }
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 text-sm font-medium">{item.label}</div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="-mr-1 -mt-1 size-7 shrink-0"
                          aria-label={t("common.dismiss")}
                          title={t("common.dismiss")}
                          onClick={(event) => {
                            event.stopPropagation()
                            dismissAttentionItem(item)
                            setOverview((current) =>
                              current
                                ? {
                                    ...current,
                                    needsAttention: current.needsAttention.filter(
                                      (candidate) =>
                                        !(
                                          candidate.source === item.source &&
                                          candidate.id === item.id &&
                                          candidate.detail === item.detail
                                        )
                                    ),
                                  }
                                : current
                            )
                          }}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                      {item.source === "job" && loadingJobId === item.id ? (
                        <div className="mt-1 text-xs text-muted-foreground">Loading details…</div>
                      ) : null}
                      <div className="mt-1 text-xs text-muted-foreground">
                        {item.detail === "Configured but unavailable"
                          ? t("status.configuredUnavailable")
                          : item.detail}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}
        {jobDetailError ? <div className="error-banner mb-5">{jobDetailError}</div> : null}
        {jobDetail ? (
          <Card className="mb-5">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">{jobDetail.job.label}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {jobDetail.job.status} · exit {jobDetail.job.exitCode ?? "unknown"}
                    {jobDetail.job.timedOut ? " · timed out" : ""}
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setJobDetail(undefined)}>
                  <X className="size-3.5" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-md border bg-muted/20 p-3 font-mono text-xs">
                <div className="break-all">$ {jobDetail.job.command}</div>
                <div className="mt-2 break-all text-muted-foreground">cwd: {jobDetail.job.cwd}</div>
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium">Output</div>
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/20 p-3 text-xs">
                  {jobDetail.output || "(no output was captured)"}
                </pre>
                {jobDetail.truncated ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Showing the last 128 KiB.
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ) : null}
        <CapabilityHealthPanel />
      </div>
    </main>
  )
}
