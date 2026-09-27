import { Activity, AlertTriangle, X } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { PageHeader } from "../../components/PageHeader"
import { useI18n } from "../../i18n"
import { fetchPlatformOverview } from "../../lib/api"
import { dismissAttentionItem, visibleAttentionItems } from "../../lib/attention-dismissals"
import type { PlatformOverview } from "../../types"
import { CapabilityHealthPanel } from "../dashboard/CapabilityHealthPanel"

export function StatusPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [overview, setOverview] = useState<PlatformOverview>()

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
                    <div
                      key={`${item.source}:${item.id}:${item.detail}`}
                      className="rounded-md border px-3 py-2"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 text-sm font-medium">{item.label}</div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="-mr-1 -mt-1 size-7 shrink-0"
                          aria-label={t("common.dismiss")}
                          title={t("common.dismiss")}
                          onClick={() => {
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
        <CapabilityHealthPanel />
      </div>
    </main>
  )
}
