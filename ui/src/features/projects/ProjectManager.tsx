import { ArrowLeft, FolderKanban, Pencil, Plus, Trash2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

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

export function ProjectManager({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [editingId, setEditingId] = useState<string>()
  const [editDraft, setEditDraft] = useState<{
    name: string
    path: string
    additionalPaths: string
    description: string
    permissions: ProjectRecord["permissions"]
  }>()
  const [draft, setDraft] = useState({
    id: "",
    name: "",
    path: "",
    additionalPaths: "",
    description: "",
    permissions: { ...DEFAULT_PERMISSIONS },
  })

  const load = useCallback(async () => {
    try {
      setProjects(await fetchProjects())
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const submit = async () => {
    setBusy("create")
    try {
      await createProject({
        id: draft.id.trim(),
        name: draft.name.trim(),
        path: draft.path.trim(),
        additionalPaths: draft.additionalPaths
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean),
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        permissions: draft.permissions,
      })
      setDraft({
        id: "",
        name: "",
        path: "",
        additionalPaths: "",
        description: "",
        permissions: { ...DEFAULT_PERMISSIONS },
      })
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

  const startEditing = (project: ProjectRecord) => {
    setEditingId(project.id)
    setEditDraft({
      name: project.name,
      path: project.path,
      additionalPaths: project.additionalPaths.join("\n"),
      description: project.description ?? "",
      permissions: { ...project.permissions },
    })
  }

  const saveEdit = async (project: ProjectRecord) => {
    if (!editDraft) return
    setBusy(project.id)
    try {
      await updateProject(project.id, {
        name: editDraft.name.trim(),
        path: editDraft.path.trim(),
        additionalPaths: editDraft.additionalPaths
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean),
        description: editDraft.description.trim() || undefined,
        permissions: editDraft.permissions,
      })
      setEditingId(undefined)
      setEditDraft(undefined)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const remove = async (id: string) => {
    setBusy(id)
    try {
      await deleteProject(id)
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
          <FolderKanban className="size-5" />
          <div>
            <h1 className="font-semibold">{t("projects.title")}</h1>
            <p className="text-xs text-muted-foreground">{t("projects.subtitle")}</p>
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
            <div className="font-medium">{t("projects.registerTitle")}</div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2">
              <Field
                label={t("projects.projectId")}
                value={draft.id}
                placeholder="openchatx"
                onChange={(value) => setDraft((current) => ({ ...current, id: value }))}
              />
              <Field
                label={t("projects.name")}
                value={draft.name}
                placeholder="OpenChatX"
                onChange={(value) => setDraft((current) => ({ ...current, name: value }))}
              />
              <div className="md:col-span-2">
                <Field
                  label={t("projects.primaryFolderPath")}
                  value={draft.path}
                  placeholder="/Users/me/MyProject/openchatx-mcp"
                  onChange={(value) => setDraft((current) => ({ ...current, path: value }))}
                />
              </div>
              <div className="md:col-span-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">
                    {t("projects.additionalFolderPaths")}
                  </span>
                  <textarea
                    className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    value={draft.additionalPaths}
                    placeholder={"/Users/me/CompanyData\n/Users/me/DesignAssets"}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        additionalPaths: event.target.value,
                      }))
                    }
                  />
                  <span className="mt-1 block text-xs text-muted-foreground">
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

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {(["read", "write", "shell"] as const).map((permission) => (
                <Button
                  key={permission}
                  type="button"
                  size="sm"
                  variant="outline"
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
                  {t(`projects.permission.${permission}`)}:{" "}
                  {draft.permissions[permission] ? t("projects.on") : t("projects.off")}
                </Button>
              ))}
              <Button
                size="sm"
                disabled={
                  busy === "create" || !draft.id.trim() || !draft.name.trim() || !draft.path.trim()
                }
                onClick={() => void submit()}
              >
                <Plus className="size-4" />
                {t("projects.register")}
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          {projects.map((project) => (
            <Card key={project.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">{project.name}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{project.id}</div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === project.id}
                      onClick={() =>
                        editingId === project.id
                          ? (setEditingId(undefined), setEditDraft(undefined))
                          : startEditing(project)
                      }
                    >
                      <Pencil className="size-4" />
                      {editingId === project.id ? t("common.cancel") : t("common.edit")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === project.id}
                      onClick={() => void remove(project.id)}
                    >
                      <Trash2 className="size-4" />
                      {t("projects.unregister")}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {editingId === project.id && editDraft ? (
                  <div className="space-y-3">
                    <Field
                      label={t("projects.name")}
                      value={editDraft.name}
                      placeholder="OpenChatX"
                      onChange={(value) =>
                        setEditDraft((current) => (current ? { ...current, name: value } : current))
                      }
                    />
                    <Field
                      label={t("projects.primaryFolderPath")}
                      value={editDraft.path}
                      placeholder="/Users/me/MyProject/openchatx-mcp"
                      onChange={(value) =>
                        setEditDraft((current) => (current ? { ...current, path: value } : current))
                      }
                    />
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-muted-foreground">
                        {t("projects.additionalFolderPaths")}
                      </span>
                      <textarea
                        className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                        value={editDraft.additionalPaths}
                        placeholder={"/Users/me/CompanyData\n/Users/me/DesignAssets"}
                        onChange={(event) =>
                          setEditDraft((current) =>
                            current ? { ...current, additionalPaths: event.target.value } : current
                          )
                        }
                      />
                    </label>
                    <Field
                      label={t("projects.description")}
                      value={editDraft.description}
                      placeholder={t("projects.optional")}
                      onChange={(value) =>
                        setEditDraft((current) =>
                          current ? { ...current, description: value } : current
                        )
                      }
                    />
                    <div className="flex flex-wrap gap-2">
                      {(["read", "write", "shell"] as const).map((permission) => (
                        <Button
                          key={permission}
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setEditDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    permissions: {
                                      ...current.permissions,
                                      [permission]: !current.permissions[permission],
                                    },
                                  }
                                : current
                            )
                          }
                        >
                          {t(`projects.permission.${permission}`)}:{" "}
                          {editDraft.permissions[permission] ? t("projects.on") : t("projects.off")}
                        </Button>
                      ))}
                      <Button
                        size="sm"
                        disabled={
                          busy === project.id || !editDraft.name.trim() || !editDraft.path.trim()
                        }
                        onClick={() => void saveEdit(project)}
                      >
                        {t("common.save")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="text-xs font-medium text-muted-foreground">
                      {t("projects.primaryRoot")}
                    </div>
                    <div className="break-all text-sm text-muted-foreground">{project.path}</div>
                    {project.additionalPaths.length > 0 ? (
                      <div className="mt-3 space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">
                          {t("projects.additionalRoots")}
                        </div>
                        {project.additionalPaths.map((path) => (
                          <div key={path} className="break-all text-sm text-muted-foreground">
                            {path}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {project.description ? (
                      <p className="mt-2 text-sm text-muted-foreground">{project.description}</p>
                    ) : null}
                    <div className="mt-4 flex flex-wrap gap-2">
                      {(["read", "write", "shell"] as const).map((permission) => (
                        <button
                          key={permission}
                          type="button"
                          disabled={busy === project.id}
                          onClick={() => void togglePermission(project, permission)}
                        >
                          <Badge>
                            {t(`projects.permission.${permission}`)}:
                            {project.permissions[permission] ? t("projects.on") : t("projects.off")}
                          </Badge>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {projects.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {t("projects.emptyPrefix")} <code>project_use</code> {t("projects.emptySuffix")}
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
