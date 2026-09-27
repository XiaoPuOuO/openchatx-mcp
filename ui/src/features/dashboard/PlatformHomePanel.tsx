import { AlertTriangle, ChevronRight, CircleCheck, FolderKanban, PlayCircle } from "lucide-react"
import { useEffect, useState } from "react"

import { Card, CardContent } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import { fetchPlatformOverview } from "../../lib/api"
import { visibleAttentionItems } from "../../lib/attention-dismissals"
import type { PlatformOverview } from "../../types"

export function PlatformHomePanel({
  onOpenProjects,
  onOpenStatus,
}: {
  onOpenProjects: () => void
  onOpenStatus: () => void
}) {
  const { t } = useI18n()
  const [overview, setOverview] = useState<PlatformOverview>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const value = await fetchPlatformOverview()
        if (!cancelled) {
          setOverview(value)
          setError(undefined)
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 10_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  if (error) return <div className="error-banner">{error}</div>
  if (!overview) return null
  const visibleAttention = visibleAttentionItems(overview.needsAttention)

  return (
    <Card className="overview-strip">
      <CardContent className="overview-strip-content">
        <button
          type="button"
          className="overview-strip-item overview-strip-button"
          onClick={onOpenProjects}
        >
          <div className="overview-icon">
            <FolderKanban className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="overview-label">{t("overview.projects")}</div>
            <div className="overview-value">{overview.projects.length}</div>
            <div className="overview-detail">
              {overview.projects.length === 0
                ? t("overview.projectsEmpty")
                : overview.projects.length === 1
                  ? overview.projects[0]?.name
                  : t("overview.projectsCount", { count: overview.projects.length })}
            </div>
          </div>
          <ChevronRight className="size-4 text-muted-foreground" />
        </button>

        <div className="overview-strip-item">
          <div className="overview-icon">
            <PlayCircle className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="overview-label">{t("overview.currentWork")}</div>
            <div className="overview-value">{overview.currentWork.length}</div>
            <div className="overview-detail">
              {overview.currentWork.length === 0
                ? t("overview.noCurrentWork")
                : overview.currentWork[0]?.label}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onOpenStatus}
          className={
            visibleAttention.length > 0
              ? "overview-strip-item overview-strip-button attention-card"
              : "overview-strip-item overview-strip-button"
          }
        >
          <div className="overview-icon">
            {visibleAttention.length > 0 ? (
              <AlertTriangle className="size-4" />
            ) : (
              <CircleCheck className="size-4" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="overview-label">{t("overview.needsAttention")}</div>
            <div className="overview-value">{visibleAttention.length}</div>
            <div className="overview-detail">
              {visibleAttention.length === 0
                ? t("overview.allGood")
                : visibleAttention
                    .slice(0, 3)
                    .map((item) => item.label)
                    .join(" · ")}
            </div>
          </div>
          {visibleAttention.length > 1 ? (
            <span className="rounded-md px-2 py-1 text-xs text-muted-foreground">
              +{visibleAttention.length - 1}
            </span>
          ) : null}
          <ChevronRight className="size-4 text-muted-foreground" />
        </button>
      </CardContent>
    </Card>
  )
}
