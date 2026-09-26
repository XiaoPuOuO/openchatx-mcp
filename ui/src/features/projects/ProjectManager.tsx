import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderKanban,
  FolderOpen,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"

import { Badge } from "../../components/ui/badge"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import { createProject, deleteProject, fetchProjects, updateProject } from "../../lib/api"
import type { ProjectRecord } from "../../types"

const DEFAULT_PERMISSIONS: ProjectRecord["permissions"] = {
  read: true,
  write: true,
  shell: true,
}

type ProjectDraft = {
  id: string
  name: string
  path: string
  additionalPaths: string
  description: string
  permissions: ProjectRecord["permissions"]
}

const EMPTY_DRAFT: ProjectDraft = {
  id: "",
  name: "",
  path: "",
  additionalPaths: "",
  description: "",
  permissions: { ...DEFAULT_PERMISSIONS },
}

export function ProjectManager({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [mode, setMode] = useState<"detail" | "create" | "edit">("detail")
  const [draft, setDraft] = useState<ProjectDraft>({ ...EMPTY_DRAFT })

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedId),
    [projects, selectedId]
  )

  const load = useCallback(async () => {
    try {
      const next = await fetchProjects()
      setProjects(next)
      setSelectedId((current) =>
        current && next.some((project) => project.id === current) ? current : next[0]?.id
      )
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const beginCreate = () => {
    setDraft({ ...EMPTY_DRAFT, permissions: { ...DEFAULT_PERMISSIONS } })
    setMode("create")
  }

  const beginEdit = (project: ProjectRecord) => {
    setDraft({
      id: project.id,
      name: project.name,
      path: project.path,
      additionalPaths: project.additionalPaths.join("\n"),
      description: project.description ?? "",
      permissions: { ...project.permissions },
    })
    setMode("edit")
  }

  const cancelForm = () => {
    setMode("detail")
    setDraft({ ...EMPTY_DRAFT, permissions: { ...DEFAULT_PERMISSIONS } })
  }

  const submitCreate = async () => {
    setBusy("create")
    try {
      const created = await createProject({
        id: draft.id.trim(),
        name: draft.name.trim(),
        path: draft.path.trim(),
        additionalPaths: splitPaths(draft.additionalPaths),
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        permissions: draft.permissions,
      })
      await load()
      setSelectedId(created.id)
      setMode("detail")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const saveEdit = async () => {
    if (!selectedProject) return
    setBusy(selectedProject.id)
    try {
      await updateProject(selectedProject.id, {
        name: draft.name.trim(),
        path: draft.path.trim(),
        additionalPaths: splitPaths(draft.additionalPaths),
        description: draft.description.trim() || undefined,
        permissions: draft.permissions,
      })
      await load()
      setMode("detail")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const remove = async (project: ProjectRecord) => {
    setBusy(project.id)
    try {
      await deleteProject(project.id)
      setMode("detail")
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const togglePermission = async (
    project: ProjectRecord,
    permission: keyof ProjectRecord["permissions"]
  ) => {
    setBusy(project.id)
    try {
      await updateProject(project.id, {
        permissions: {
          ...project.permissions,
          [permission]: !project.permissions[permission],
        },
      })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
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
              <FolderKanban className="size-4" />
            </div>
            <div className="min-w-0">
              <h1 className="font-semibold">{t("projects.title")}</h1>
              <p className="truncate text-xs text-muted-foreground">{t("projects.subtitle")}</p>
            </div>
          </div>
          <Button size="sm" onClick={beginCreate}>
            <Plus className="size-4" />
            {t("projects.registerTitle")}
          </Button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-6">
        {error ? (
          <div className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="grid gap-5 lg:h-[calc(100dvh-178px)] lg:min-h-[560px] lg:grid-cols-[300px_minmax(0,1fr)]">
          <Card className="flex min-h-0 flex-col overflow-hidden lg:h-full">
            <CardHeader className="border-b px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">{t("projects.title")}</div>
                <Badge>{projects.length}</Badge>
              </div>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 overflow-y-auto p-2">
              {projects.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {t("projects.emptyPrefix")}
                </div>
              ) : (
                <div className="space-y-1">
                  {projects.map((project) => {
                    const selected = project.id === selectedId && mode !== "create"
                    return (
                      <button
                        key={project.id}
                        type="button"
                        className={
                          "group flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors " +
                          (selected
                            ? "border-border bg-muted/70"
                            : "border-transparent hover:bg-muted/40")
                        }
                        onClick={() => {
                          setSelectedId(project.id)
                          setMode("detail")
                        }}
                      >
                        <div
                          className={
                            "flex size-9 shrink-0 items-center justify-center rounded-lg " +
                            (selected ? "bg-background shadow-sm" : "bg-muted")
                          }
                        >
                          {selected ? (
                            <FolderOpen className="size-4" />
                          ) : (
                            <Folder className="size-4" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{project.name}</div>
                          <div className="mt-0.5 truncate text-xs text-muted-foreground">
                            {project.path}
                          </div>
                        </div>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
                      </button>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="min-h-0 min-w-0 lg:h-full">
            {mode === "create" ? (
              <ProjectFormCard
                title={t("projects.registerTitle")}
                draft={draft}
                setDraft={setDraft}
                busy={busy === "create"}
                submitLabel={t("projects.register")}
                submitDisabled={!draft.id.trim() || !draft.name.trim() || !draft.path.trim()}
                onSubmit={() => void submitCreate()}
                onCancel={cancelForm}
                t={t}
                showId
              />
            ) : selectedProject ? (
              mode === "edit" ? (
                <ProjectFormCard
                  title={selectedProject.name}
                  draft={draft}
                  setDraft={setDraft}
                  busy={busy === selectedProject.id}
                  submitLabel={t("common.save")}
                  submitDisabled={!draft.name.trim() || !draft.path.trim()}
                  onSubmit={() => void saveEdit()}
                  onCancel={cancelForm}
                  t={t}
                />
              ) : (
                <ProjectDetail
                  project={selectedProject}
                  busy={busy === selectedProject.id}
                  onEdit={() => beginEdit(selectedProject)}
                  onDelete={() => void remove(selectedProject)}
                  onToggle={(permission) => void togglePermission(selectedProject, permission)}
                  t={t}
                />
              )
            ) : (
              <Card className="flex min-h-[420px] items-center justify-center lg:h-full">
                <CardContent className="max-w-sm text-center">
                  <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-muted">
                    <FolderKanban className="size-5 text-muted-foreground" />
                  </div>
                  <div className="font-medium">{t("projects.title")}</div>
                  <p className="mt-2 text-sm text-muted-foreground">{t("projects.emptyPrefix")}</p>
                  <Button className="mt-4" size="sm" onClick={beginCreate}>
                    <Plus className="size-4" />
                    {t("projects.registerTitle")}
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}

function ProjectDetail({
  project,
  busy,
  onEdit,
  onDelete,
  onToggle,
  t,
}: {
  project: ProjectRecord
  busy: boolean
  onEdit: () => void
  onDelete: () => void
  onToggle: (permission: keyof ProjectRecord["permissions"]) => void
  t: (key: string, params?: Record<string, string | number>) => string
}) {
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden lg:h-full">
      <CardHeader className="shrink-0 border-b px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{project.name}</h2>
              <Badge>{project.id}</Badge>
            </div>
            {project.description ? (
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{project.description}</p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={onEdit}>
              <Pencil className="size-4" />
              {t("common.edit")}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={onDelete}>
              <Trash2 className="size-4" />
              {t("projects.unregister")}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
        <section>
          <div className="mb-3 flex items-center gap-2 text-sm font-medium">
            <FolderOpen className="size-4" />
            {t("projects.primaryRoot")}
          </div>
          <PathRow path={project.path} primary primaryLabel={t("projects.primaryBadge")} />
        </section>

        {project.additionalPaths.length > 0 ? (
          <section>
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <Folder className="size-4" />
              {t("projects.additionalRoots")}
              <Badge>{project.additionalPaths.length}</Badge>
            </div>
            <div className="space-y-2">
              {project.additionalPaths.map((path) => (
                <PathRow key={path} path={path} />
              ))}
            </div>
          </section>
        ) : null}

        <section>
          <div className="mb-3 flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4" />
            {t("projects.permissions")}
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {(["read", "write", "shell"] as const).map((permission) => {
              const enabled = project.permissions[permission]
              return (
                <button
                  key={permission}
                  type="button"
                  disabled={busy}
                  className={
                    "flex items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors " +
                    (enabled ? "bg-muted/50" : "opacity-60 hover:bg-muted/30")
                  }
                  onClick={() => onToggle(permission)}
                >
                  <span className="text-sm font-medium">
                    {t(`projects.permission.${permission}`)}
                  </span>
                  <span
                    className={enabled ? "text-xs font-medium" : "text-xs text-muted-foreground"}
                  >
                    {enabled ? t("projects.on") : t("projects.off")}
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      </CardContent>
    </Card>
  )
}

function ProjectFormCard({
  title,
  draft,
  setDraft,
  busy,
  submitLabel,
  submitDisabled,
  onSubmit,
  onCancel,
  t,
  showId = false,
}: {
  title: string
  draft: ProjectDraft
  setDraft: React.Dispatch<React.SetStateAction<ProjectDraft>>
  busy: boolean
  submitLabel: string
  submitDisabled: boolean
  onSubmit: () => void
  onCancel: () => void
  t: (key: string, params?: Record<string, string | number>) => string
  showId?: boolean
}) {
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden lg:h-full">
      <CardHeader className="shrink-0 border-b px-6 py-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t("projects.subtitle")}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onCancel} aria-label={t("common.cancel")}>
            <X className="size-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
        <div className="grid gap-4 md:grid-cols-2">
          {showId ? (
            <Field
              label={t("projects.projectId")}
              value={draft.id}
              placeholder="openchatx"
              onChange={(value) => setDraft((current) => ({ ...current, id: value }))}
            />
          ) : null}
          <Field
            label={t("projects.name")}
            value={draft.name}
            placeholder="OpenChatX"
            onChange={(value) => setDraft((current) => ({ ...current, name: value }))}
          />
          <div className={showId ? "md:col-span-2" : "md:col-span-2"}>
            <Field
              label={t("projects.primaryFolderPath")}
              value={draft.path}
              placeholder="/Users/me/MyProject/openchatx-mcp"
              onChange={(value) => setDraft((current) => ({ ...current, path: value }))}
            />
          </div>
          <div className="md:col-span-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                {t("projects.additionalFolderPaths")}
              </span>
              <textarea
                className="min-h-28 w-full resize-y rounded-lg border bg-background px-3 py-2.5 text-sm outline-none transition-shadow focus:ring-2 focus:ring-ring"
                value={draft.additionalPaths}
                placeholder={"/Users/me/CompanyData\n/Users/me/DesignAssets"}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, additionalPaths: event.target.value }))
                }
              />
              <span className="mt-1.5 block text-xs text-muted-foreground">
                {t("projects.additionalFolderPathsHint")}
              </span>
            </label>
          </div>
          <div className="md:col-span-2">
            <Field
              label={t("projects.description")}
              value={draft.description}
              placeholder={t("projects.optional")}
              onChange={(value) => setDraft((current) => ({ ...current, description: value }))}
            />
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            {t("projects.permissions")}
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {(["read", "write", "shell"] as const).map((permission) => {
              const enabled = draft.permissions[permission]
              return (
                <button
                  key={permission}
                  type="button"
                  className={
                    "flex items-center justify-between rounded-lg border px-3 py-2.5 transition-colors " +
                    (enabled ? "bg-muted/50" : "opacity-60")
                  }
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      permissions: {
                        ...current.permissions,
                        [permission]: !current.permissions[permission],
                      },
                    }))
                  }
                >
                  <span className="text-sm font-medium">
                    {t(`projects.permission.${permission}`)}
                  </span>
                  <span className="text-xs">{enabled ? t("projects.on") : t("projects.off")}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t pt-5">
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy || submitDisabled} onClick={onSubmit}>
            {modeIcon(submitLabel, t("projects.register"))}
            {submitLabel}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function PathRow({
  path,
  primary = false,
  primaryLabel = "Primary",
}: {
  path: string
  primary?: boolean
  primaryLabel?: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border bg-background px-3 py-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        {primary ? <FolderOpen className="size-4" /> : <Folder className="size-4" />}
      </div>
      <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{path}</code>
      {primary ? <Badge>{primaryLabel}</Badge> : null}
    </div>
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
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      <input
        className="h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-shadow focus:ring-2 focus:ring-ring"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

function splitPaths(value: string): string[] {
  return value
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean)
}

function modeIcon(label: string, registerLabel: string) {
  return label === registerLabel ? <Plus className="size-4" /> : <Save className="size-4" />
}
