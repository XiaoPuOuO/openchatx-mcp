import {
  ArrowLeft,
  Blocks,
  CirclePlus,
  FileCode2,
  FolderOpen,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react"
import { useEffect, useState } from "react"
import { LanguageSwitcher } from "../../components/LanguageSwitcher"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import {
  createTool,
  createToolbox,
  createToolboxSkill,
  deleteTool,
  deleteToolbox,
  deleteToolboxSkill,
  fetchToolboxes,
  openToolboxInFinder,
  reloadToolboxes,
  setToolboxEnabled,
  setToolboxSkillEnabled,
  setToolEnabled,
} from "../../lib/api"
import type { ToolboxSnapshot } from "../../types"

export function ToolboxManager({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [toolboxes, setToolboxes] = useState<ToolboxSnapshot[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState<string>()

  useEffect(() => {
    void fetchToolboxes()
      .then((items) => {
        setToolboxes(items)
        setSelectedId(items[0]?.id)
      })
      .catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      )
  }, [])

  const selected = toolboxes.find((item) => item.id === selectedId)

  async function run(action: () => Promise<ToolboxSnapshot[]>, success?: string) {
    setError(undefined)
    setMessage(undefined)
    try {
      const next = await action()
      setToolboxes(next)
      if (success) setMessage(success)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    }
  }

  async function addToolbox() {
    const id = window.prompt(t("toolboxes.promptFolder"))?.trim()
    if (!id) return
    await run(() => createToolbox(id), t("toolboxes.created", { id }))
    setSelectedId(id)
  }

  async function addTool() {
    if (!selected || selected.builtin) return
    const name = window.prompt(t("toolboxes.promptTool"))?.trim()
    if (!name) return
    await run(() => createTool(selected.id, name), t("toolboxes.createdTool", { name }))
  }

  async function addSkill() {
    if (!selected) return
    const name = window.prompt(t("toolboxes.promptSkill"))?.trim()
    if (!name) return
    await run(() => createToolboxSkill(selected.id, name), t("toolboxes.createdSkill", { name }))
  }

  async function removeToolbox() {
    if (!selected || selected.builtin) return
    if (!window.confirm(t("toolboxes.deleteConfirm", { id: selected.id }))) return
    await run(() => deleteToolbox(selected.id), t("toolboxes.deleted", { id: selected.id }))
    setSelectedId(toolboxes.find((box) => box.id !== selected.id)?.id)
  }

  async function removeTool(name: string) {
    if (!selected || selected.builtin) return
    if (!window.confirm(t("toolboxes.deleteToolConfirm", { name }))) return
    await run(() => deleteTool(selected.id, name), t("toolboxes.deletedTool", { name }))
  }

  async function removeSkill(name: string) {
    if (!selected) return
    if (!window.confirm(t("toolboxes.deleteSkillConfirm", { name }))) return
    await run(() => deleteToolboxSkill(selected.id, name), t("toolboxes.deletedSkill", { name }))
  }

  async function openFinder(kind?: "tool" | "skill", name?: string) {
    if (!selected) return
    try {
      const opened = await openToolboxInFinder(selected.id, kind, name)
      if (!opened) setMessage(t("toolboxes.mockFinder"))
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError))
    }
  }

  return (
    <main className="min-h-screen bg-muted/20">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between px-5 py-4 lg:px-8">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={onBack} aria-label={t("common.back")}>
              <ArrowLeft className="size-4" />
            </Button>
            <div className="flex size-9 items-center justify-center rounded-lg bg-foreground text-background">
              <Blocks className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold">{t("toolboxes.title")}</h1>
              <p className="text-xs text-muted-foreground">{t("toolboxes.subtitle")}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <LanguageSwitcher />
            <Button
              variant="outline"
              onClick={() => void run(reloadToolboxes, t("toolboxes.reloaded"))}
            >
              <RefreshCw className="size-4" />
              {t("common.reload")}
            </Button>
            <Button onClick={() => void addToolbox()}>
              <CirclePlus className="size-4" />
              {t("toolboxes.new")}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1500px] gap-5 px-5 py-6 lg:grid-cols-[320px_1fr] lg:px-8">
        <Card className="overflow-hidden">
          <CardHeader className="border-b">
            <h2 className="text-sm font-semibold">{t("toolboxes.folders")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("toolboxes.count", { count: toolboxes.length })}
            </p>
          </CardHeader>
          <CardContent className="space-y-1 p-2">
            {toolboxes.map((box) => (
              <button
                key={box.id}
                type="button"
                onClick={() => setSelectedId(box.id)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-3 text-left ${selectedId === box.id ? "bg-muted" : "hover:bg-muted/60"}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-2 rounded-full ${box.enabled ? "bg-emerald-500" : "bg-neutral-300"}`}
                    />
                    <span className="truncate text-sm font-medium">{box.name}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{box.id}</p>
                </div>
                {box.builtin ? (
                  <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                    {t("common.builtIn")}
                  </span>
                ) : null}
              </button>
            ))}
          </CardContent>
        </Card>

        <div className="space-y-5">
          {selected ? (
            <>
              <Card>
                <CardHeader className="flex-row items-start justify-between border-b">
                  <div>
                    <h2 className="text-base font-semibold">{selected.name}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selected.description ?? selected.path}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 text-xs">
                      {t("common.enabled")}
                      <input
                        type="checkbox"
                        checked={selected.enabled}
                        disabled={selected.tools.some((tool) => tool.required)}
                        onChange={(event) =>
                          void run(() => setToolboxEnabled(selected.id, event.target.checked))
                        }
                      />
                    </label>
                    <Button variant="outline" size="sm" onClick={() => void openFinder()}>
                      <FolderOpen className="size-3.5" />
                      {t("common.openInFinder")}
                    </Button>
                    {!selected.builtin ? (
                      <Button variant="ghost" size="sm" onClick={() => void removeToolbox()}>
                        <Trash2 className="size-3.5" />
                        {t("common.delete")}
                      </Button>
                    ) : null}
                  </div>
                </CardHeader>
              </Card>

              <Card>
                <CardHeader className="flex-row items-center justify-between border-b">
                  <div>
                    <h3 className="text-sm font-semibold">{t("toolboxes.tools")}</h3>
                    <p className="text-xs text-muted-foreground">
                      {t("toolboxes.toolsCount", { count: selected.tools.length })}
                    </p>
                  </div>
                  {!selected.builtin ? (
                    <Button variant="outline" size="sm" onClick={() => void addTool()}>
                      <CirclePlus className="size-3.5" />
                      {t("toolboxes.addTsTool")}
                    </Button>
                  ) : null}
                </CardHeader>
                <CardContent className="divide-y p-0">
                  {selected.tools.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between gap-4 px-5 py-4"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <FileCode2 className="size-4 text-muted-foreground" />
                          <span className="font-mono text-sm font-medium">{tool.name}</span>
                          {tool.required ? (
                            <span className="text-[10px] uppercase text-muted-foreground">
                              {t("common.required")}
                            </span>
                          ) : null}
                        </div>
                        <p
                          className={`mt-1 text-xs ${tool.error ? "text-red-600" : "text-muted-foreground"}`}
                        >
                          {tool.error ?? tool.description ?? tool.path ?? t("toolboxes.tools")}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        {tool.path ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void openFinder("tool", tool.name)}
                          >
                            <FolderOpen className="size-3.5" />
                          </Button>
                        ) : null}
                        {!selected.builtin ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void removeTool(tool.name)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        ) : null}
                        <input
                          type="checkbox"
                          checked={tool.enabled}
                          disabled={tool.required}
                          onChange={(event) =>
                            void run(() =>
                              setToolEnabled(selected.id, tool.name, event.target.checked)
                            )
                          }
                        />
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex-row items-center justify-between border-b">
                  <div>
                    <h3 className="text-sm font-semibold">{t("toolboxes.skills")}</h3>
                    <p className="text-xs text-muted-foreground">
                      {t("toolboxes.skillsCount", { count: selected.skills.length })}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void addSkill()}>
                    <CirclePlus className="size-3.5" />
                    {t("toolboxes.addSkill")}
                  </Button>
                </CardHeader>
                <CardContent className="divide-y p-0">
                  {selected.skills.length === 0 ? (
                    <div className="px-5 py-8 text-sm text-muted-foreground">
                      {t("toolboxes.noSkills")}
                    </div>
                  ) : (
                    selected.skills.map((skill) => (
                      <div
                        key={skill.name}
                        className="flex items-center justify-between gap-4 px-5 py-4"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Sparkles className="size-4 text-muted-foreground" />
                            <span className="text-sm font-medium">{skill.name}</span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {skill.description ?? skill.path}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void openFinder("skill", skill.name)}
                          >
                            <FolderOpen className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void removeSkill(skill.name)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                          <input
                            type="checkbox"
                            checked={skill.enabled}
                            onChange={(event) =>
                              void run(() =>
                                setToolboxSkillEnabled(
                                  selected.id,
                                  skill.name,
                                  event.target.checked
                                )
                              )
                            }
                          />
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}
          {message ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              {message}
            </div>
          ) : null}
        </div>
      </div>
    </main>
  )
}
