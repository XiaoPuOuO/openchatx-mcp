import { ArrowLeft, Clipboard, FileText, Plus, Save, Trash2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"

import { Badge } from "../../components/ui/badge"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import { createSummary, deleteSummary, fetchSummaries, updateSummary } from "../../lib/api"
import type { TemporarySummary } from "../../types"

export function SummaryManager({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [summaries, setSummaries] = useState<TemporarySummary[]>([])
  const [selectedUuid, setSelectedUuid] = useState<string>()
  const [content, setContent] = useState("")
  const [recentContext, setRecentContext] = useState("")
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const selected = useMemo(
    () => summaries.find((summary) => summary.uuid === selectedUuid),
    [summaries, selectedUuid]
  )

  const load = useCallback(async () => {
    try {
      const next = await fetchSummaries()
      setSummaries(next)
      setSelectedUuid((current) =>
        current && next.some((summary) => summary.uuid === current) ? current : next[0]?.uuid
      )
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!creating) {
      setContent(selected?.content ?? "")
      setRecentContext(selected?.recentContext ?? "")
    }
  }, [creating, selected])

  const startCreate = () => {
    setCreating(true)
    setSelectedUuid(undefined)
    setContent("")
    setRecentContext("")
  }

  const save = async () => {
    const text = content.trim()
    if (!text) return
    setBusy(true)
    try {
      if (creating) {
        const created = await createSummary(text, recentContext)
        await load()
        setSelectedUuid(created.uuid)
        setCreating(false)
      } else if (selected) {
        const updated = await updateSummary(selected.uuid, text, recentContext)
        await load()
        setSelectedUuid(updated.uuid)
      }
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!selected) return
    setBusy(true)
    try {
      await deleteSummary(selected.uuid)
      await load()
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const copyUuid = async () => {
    if (!selected) return
    await navigator.clipboard.writeText(selected.uuid)
  }

  return (
    <main className="min-h-screen bg-muted/20">
      <header className="border-b bg-background/95">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeft className="size-4" />
              {t("common.back")}
            </Button>
            <div className="h-6 w-px bg-border" />
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
              <FileText className="size-4" />
            </div>
            <div className="min-w-0">
              <h1 className="font-semibold">{t("summaries.title")}</h1>
              <p className="truncate text-xs text-muted-foreground">{t("summaries.subtitle")}</p>
            </div>
          </div>
          <Button size="sm" onClick={startCreate}>
            <Plus className="size-4" />
            {t("summaries.create")}
          </Button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-6">
        {error ? (
          <div className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="grid gap-5 lg:h-[calc(100dvh-178px)] lg:min-h-[560px] lg:grid-cols-[320px_minmax(0,1fr)]">
          <Card className="flex min-h-0 flex-col overflow-hidden lg:h-full">
            <CardHeader className="shrink-0 border-b px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">{t("summaries.temporary")}</div>
                <Badge>{summaries.length}</Badge>
              </div>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 overflow-y-auto p-2">
              {summaries.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {t("summaries.empty")}
                </div>
              ) : (
                <div className="space-y-1">
                  {summaries.map((summary) => {
                    const active = summary.uuid === selectedUuid && !creating
                    return (
                      <button
                        key={summary.uuid}
                        type="button"
                        className={
                          "w-full rounded-lg border px-3 py-3 text-left transition-colors " +
                          (active
                            ? "border-border bg-muted/70"
                            : "border-transparent hover:bg-muted/40")
                        }
                        onClick={() => {
                          setCreating(false)
                          setSelectedUuid(summary.uuid)
                        }}
                      >
                        <div className="truncate font-mono text-xs font-medium">{summary.uuid}</div>
                        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {summary.content}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="flex min-h-0 flex-col overflow-hidden lg:h-full">
            <CardHeader className="shrink-0 border-b px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold">
                    {creating
                      ? t("summaries.newTitle")
                      : (selected?.uuid ?? t("summaries.noSelection"))}
                  </div>
                  {!creating && selected ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {t("summaries.updatedAt", {
                        time: new Date(selected.updatedAt).toLocaleString(),
                      })}
                    </div>
                  ) : null}
                </div>
                {!creating && selected ? (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => void copyUuid()}>
                      <Clipboard className="size-4" />
                      {t("summaries.copyUuid")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void remove()}
                    >
                      <Trash2 className="size-4" />
                      {t("common.delete")}
                    </Button>
                  </div>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-4 p-5">
              {creating || selected ? (
                <>
                  <div className="flex min-h-0 flex-[3] flex-col gap-2">
                    <div className="text-xs font-medium text-muted-foreground">
                      {t("summaries.summaryContent")}
                    </div>
                    <textarea
                      className="min-h-0 flex-1 resize-none rounded-lg border bg-background p-4 font-mono text-xs leading-5 outline-none focus:ring-2 focus:ring-ring"
                      value={content}
                      placeholder={t("summaries.placeholder")}
                      onChange={(event) => setContent(event.target.value)}
                    />
                  </div>
                  <div className="flex min-h-0 flex-[2] flex-col gap-2">
                    <div className="text-xs font-medium text-muted-foreground">
                      {t("summaries.recentContext")}
                    </div>
                    <textarea
                      className="min-h-0 flex-1 resize-none rounded-lg border bg-background p-4 font-mono text-xs leading-5 outline-none focus:ring-2 focus:ring-ring"
                      value={recentContext}
                      placeholder={t("summaries.recentContextPlaceholder")}
                      onChange={(event) => setRecentContext(event.target.value)}
                    />
                  </div>
                  <div className="flex shrink-0 justify-end gap-2">
                    {creating ? (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setCreating(false)
                          setSelectedUuid(summaries[0]?.uuid)
                        }}
                      >
                        {t("common.cancel")}
                      </Button>
                    ) : null}
                    <Button disabled={busy || !content.trim()} onClick={() => void save()}>
                      <Save className="size-4" />
                      {creating ? t("summaries.createAndGetUuid") : t("common.save")}
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
                  {t("summaries.empty")}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  )
}
