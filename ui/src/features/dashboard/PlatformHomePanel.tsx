import { AlertTriangle, ChevronRight, CircleCheck, FolderKanban, PlayCircle } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "../../components/ui/button"
import { Card, CardContent } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import { fetchPlatformOverview } from "../../lib/api"
import type { PlatformOverview } from "../../types"

export function PlatformHomePanel({ onOpenProjects }: { onOpenProjects: () => void }) {
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

        <div
          className={
            overview.needsAttention.length > 0
              ? "overview-strip-item attention-card"
              : "overview-strip-item"
          }
        >
          <div className="overview-icon">
            {overview.needsAttention.length > 0 ? (
              <AlertTriangle className="size-4" />
            ) : (
              <CircleCheck className="size-4" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="overview-label">{t("overview.needsAttention")}</div>
            <div className="overview-value">{overview.needsAttention.length}</div>
            <div className="overview-detail">
              {overview.needsAttention.length === 0
                ? t("overview.allGood")
                : overview.needsAttention[0]?.label}
            </div>
          </div>
          {overview.needsAttention.length > 1 ? (
            <Button variant="ghost" size="sm" className="pointer-events-none h-7 px-2">
              +{overview.needsAttention.length - 1}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
