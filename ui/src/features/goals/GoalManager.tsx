import { ArrowLeft, Plus, Target, Trash2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import { Badge } from "../../components/ui/badge"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import { createGoal, deleteGoal, fetchGoals, fetchProjects, updateGoal } from "../../lib/api"
import type { GoalRecord, GoalStatus, ProjectRecord } from "../../types"

const STATUSES: GoalStatus[] = ["pending", "in_progress", "blocked", "completed", "cancelled"]

export function GoalManager({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [goals, setGoals] = useState<GoalRecord[]>([])
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [statusFilter, setStatusFilter] = useState<GoalStatus | "all">("all")
  const [draft, setDraft] = useState({
    id: "",
    title: "",
    description: "",
    projectId: "",
  })

  const load = useCallback(async () => {
    try {
      const [nextGoals, nextProjects] = await Promise.all([
        fetchGoals(statusFilter === "all" ? {} : { status: statusFilter }),
        fetchProjects(),
      ])
      setGoals(nextGoals)
      setProjects(nextProjects)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  const submit = async () => {
    setBusy("create")
    try {
      await createGoal({
        id: draft.id.trim(),
        title: draft.title.trim(),
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        ...(draft.projectId ? { projectId: draft.projectId } : {}),
      })
      setDraft({ id: "", title: "", description: "", projectId: "" })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const setStatus = async (goal: GoalRecord, status: GoalStatus) => {
    setBusy(goal.id)
    try {
      await updateGoal(goal.id, { status })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const remove = async (id: string) => {
    if (!window.confirm(t("goals.deleteConfirm"))) return
    setBusy(id)
    try {
      await deleteGoal(id)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <main className="min-h-screen">
      <header className="border-b bg-background/95">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-4">
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="size-4" />
            {t("common.back")}
          </Button>
          <Target className="size-5" />
          <div>
            <h1 className="font-semibold">{t("goals.title")}</h1>
            <p className="text-xs text-muted-foreground">{t("goals.subtitle")}</p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-5 px-5 py-6">
        {error ? (
          <div className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <div className="font-medium">{t("goals.createTitle")}</div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2">
              <Field
                label={t("goals.id")}
                value={draft.id}
                placeholder="ship-desktop-v1"
                onChange={(value) => setDraft((current) => ({ ...current, id: value }))}
              />
              <Field
                label={t("goals.name")}
                value={draft.title}
                placeholder={t("goals.namePlaceholder")}
                onChange={(value) => setDraft((current) => ({ ...current, title: value }))}
              />
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("goals.project")}
                </span>
                <select
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  value={draft.projectId}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, projectId: event.target.value }))
                  }
                >
                  <option value="">{t("goals.noProject")}</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="md:col-span-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">
                    {t("goals.description")}
                  </span>
                  <textarea
                    className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    value={draft.description}
                    placeholder={t("goals.descriptionPlaceholder")}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, description: event.target.value }))
                    }
                  />
                </label>
              </div>
            </div>
            <div className="mt-4">
              <Button
                size="sm"
                disabled={busy === "create" || !draft.id.trim() || !draft.title.trim()}
                onClick={() => void submit()}
              >
                <Plus className="size-4" />
                {t("goals.create")}
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">{t("goals.listTitle")}</div>
          <select
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as GoalStatus | "all")}
          >
            <option value="all">{t("goals.status.all")}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`goals.status.${status}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {goals.map((goal) => (
            <Card key={goal.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">{goal.title}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{goal.id}</div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={busy === goal.id}
                    onClick={() => void remove(goal.id)}
                    aria-label={t("goals.delete")}
                    title={t("goals.delete")}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {goal.description ? (
                  <p className="text-sm leading-6 text-muted-foreground">{goal.description}</p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {goal.projectId ? (
                    <Badge>{goal.projectId}</Badge>
                  ) : (
                    <Badge>{t("goals.noProject")}</Badge>
                  )}
                  <Badge>{t(`goals.status.${goal.status}`)}</Badge>
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{t("goals.statusLabel")}</span>
                  <select
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                    value={goal.status}
                    disabled={busy === goal.id}
                    onChange={(event) => void setStatus(goal, event.target.value as GoalStatus)}
                  >
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {t(`goals.status.${status}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {goals.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {t("goals.empty")}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </main>
  )
}

function Field({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  onChange: (value: string) => void
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <input
        className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}
