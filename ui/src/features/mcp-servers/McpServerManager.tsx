import { ArrowLeft, CirclePlus, FolderOpen, Save, ServerCog, Trash2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { LanguageSwitcher } from "../../components/LanguageSwitcher"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import { fetchMcpServers, openMcpConfigInFinder, saveMcpServers } from "../../lib/api"
import type { McpServerConfig, McpServerMap } from "../../types"

const INPUT_CLASS =
  "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
const TEXTAREA_CLASS =
  "min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"

export function McpServerManager({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [servers, setServers] = useState<McpServerMap>({})
  const [selectedId, setSelectedId] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    void fetchMcpServers()
      .then((next) => {
        setServers(next)
        setSelectedId(Object.keys(next)[0])
      })
      .catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      )
      .finally(() => setLoading(false))
  }, [])

  const selected = selectedId ? servers[selectedId] : undefined
  const serverIds = useMemo(() => Object.keys(servers), [servers])

  function updateSelected(next: McpServerConfig) {
    if (!selectedId) return
    setServers((current) => ({ ...current, [selectedId]: next }))
    setMessage(undefined)
  }

  function addServer() {
    let index = 1
    let id = "new-server"
    while (servers[id]) {
      index += 1
      id = `new-server-${index}`
    }
    setServers((current) => ({
      ...current,
      [id]: { type: "remote", url: "http://127.0.0.1:8000/mcp", enabled: true },
    }))
    setSelectedId(id)
    setMessage(undefined)
  }

  function deleteServer(id: string) {
    setServers((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    const remaining = serverIds.filter((item) => item !== id)
    setSelectedId(remaining[0])
    setMessage(undefined)
  }

  async function save() {
    setSaving(true)
    setError(undefined)
    setMessage(undefined)
    try {
      const result = await saveMcpServers(servers)
      setServers(result.servers)
      setMessage(result.restartRequired ? t("mcp.savedRestart") : t("mcp.saved"))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  async function openInFinder() {
    setError(undefined)
    try {
      const opened = await openMcpConfigInFinder()
      if (!opened) setMessage(t("mcp.mockFinder"))
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
              <ServerCog className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold">{t("mcp.title")}</h1>
              <p className="text-xs text-muted-foreground">{t("mcp.subtitle")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => void openInFinder()} disabled={loading}>
              <FolderOpen className="size-4" />
              {t("common.openInFinder")}
            </Button>
            <Button onClick={() => void save()} disabled={saving || loading}>
              <Save className="size-4" />
              {saving ? t("mcp.saving") : t("mcp.save")}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1500px] gap-5 px-5 py-6 lg:grid-cols-[340px_1fr] lg:px-8">
        <Card className="overflow-hidden">
          <CardHeader className="flex-row items-center justify-between border-b">
            <div>
              <h2 className="text-sm font-semibold">{t("mcp.servers")}</h2>
              <p className="text-xs text-muted-foreground">
                {t("mcp.configured", { count: serverIds.length })}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={addServer}>
              <CirclePlus className="size-3.5" />
              {t("mcp.add")}
            </Button>
          </CardHeader>
          <CardContent className="p-2">
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground">{t("mcp.loading")}</div>
            ) : serverIds.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">{t("mcp.none")}</div>
            ) : (
              <div className="space-y-1">
                {serverIds.map((id) => {
                  const server = servers[id]
                  return (
                    <button
                      type="button"
                      key={id}
                      onClick={() => setSelectedId(id)}
                      className={`flex w-full items-center justify-between rounded-lg px-3 py-3 text-left transition-colors ${selectedId === id ? "bg-muted" : "hover:bg-muted/60"}`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={`size-2 rounded-full ${server.enabled ? "bg-emerald-500" : "bg-neutral-300"}`}
                          />
                          <span className="truncate text-sm font-medium">{id}</span>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {server.type === "local" ? t("mcp.local") : t("mcp.remote")}
                        </p>
                      </div>
                      <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                        {server.type}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          {!selected || !selectedId ? (
            <CardContent className="py-24 text-center text-sm text-muted-foreground">
              {t("mcp.select")}
            </CardContent>
          ) : (
            <>
              <CardHeader className="flex-row items-start justify-between border-b">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold">{selectedId}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{t("mcp.validated")}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => deleteServer(selectedId)}>
                  <Trash2 className="size-3.5" />
                  {t("common.delete")}
                </Button>
              </CardHeader>
              <CardContent className="space-y-5 pt-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("mcp.serverId")}>
                    <input
                      className={INPUT_CLASS}
                      value={selectedId}
                      onChange={(event) => {
                        const nextId = event.target.value.trim()
                        if (!nextId || nextId === selectedId || servers[nextId]) return
                        setServers((current) => {
                          const next = { ...current, [nextId]: current[selectedId] }
                          delete next[selectedId]
                          return next
                        })
                        setSelectedId(nextId)
                      }}
                    />
                  </Field>
                  <Field label={t("mcp.type")}>
                    <select
                      className={INPUT_CLASS}
                      value={selected.type}
                      onChange={(event) => {
                        if (event.target.value === "local") {
                          updateSelected({
                            type: "local",
                            command: [""],
                            enabled: selected.enabled,
                          })
                        } else {
                          updateSelected({
                            type: "remote",
                            url: "http://127.0.0.1:8000/mcp",
                            enabled: selected.enabled,
                          })
                        }
                      }}
                    >
                      <option value="local">{t("mcp.localOption")}</option>
                      <option value="remote">{t("mcp.remoteOption")}</option>
                    </select>
                  </Field>
                </div>

                <label className="flex items-center justify-between rounded-lg border px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">{t("common.enabled")}</p>
                    <p className="text-xs text-muted-foreground">{t("mcp.expose")}</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={selected.enabled}
                    onChange={(event) =>
                      updateSelected({ ...selected, enabled: event.target.checked })
                    }
                    className="size-4"
                  />
                </label>

                {selected.type === "remote" ? (
                  <>
                    <Field label={t("mcp.url")}>
                      <input
                        className={INPUT_CLASS}
                        value={selected.url}
                        onChange={(event) =>
                          updateSelected({ ...selected, url: event.target.value })
                        }
                      />
                    </Field>
                    <Field label={t("mcp.headers")} hint={t("mcp.headersHint")}>
                      <textarea
                        className={TEXTAREA_CLASS}
                        value={recordToLines(selected.headers)}
                        onChange={(event) =>
                          updateSelected({
                            ...selected,
                            headers: linesToRecord(event.target.value),
                          })
                        }
                        placeholder="Authorization: Bearer ..."
                      />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label={t("mcp.command")} hint={t("mcp.commandHint")}>
                      <textarea
                        className={TEXTAREA_CLASS}
                        value={selected.command.join("\n")}
                        onChange={(event) =>
                          updateSelected({
                            ...selected,
                            command: event.target.value
                              .split("\n")
                              .filter((line) => line.length > 0),
                          })
                        }
                        placeholder="/opt/homebrew/bin/uvx\nblender-mcp"
                      />
                    </Field>
                    <Field label={t("mcp.cwd")}>
                      <input
                        className={INPUT_CLASS}
                        value={selected.cwd ?? ""}
                        onChange={(event) =>
                          updateSelected({ ...selected, cwd: event.target.value || undefined })
                        }
                        placeholder="/Users/xiaopu/Projects/..."
                      />
                    </Field>
                    <Field label={t("mcp.environment")} hint={t("mcp.environmentHint")}>
                      <textarea
                        className={TEXTAREA_CLASS}
                        value={recordToEnv(selected.environment)}
                        onChange={(event) =>
                          updateSelected({
                            ...selected,
                            environment: envToRecord(event.target.value),
                          })
                        }
                        placeholder="PYTHONPATH=/path\nDEBUG=0"
                      />
                    </Field>
                  </>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("mcp.timeout")}>
                    <input
                      type="number"
                      min={1}
                      className={INPUT_CLASS}
                      value={selected.timeout ?? ""}
                      onChange={(event) =>
                        updateSelected({
                          ...selected,
                          timeout: event.target.value ? Number(event.target.value) : undefined,
                        })
                      }
                      placeholder="120000"
                    />
                  </Field>
                  <Field label={t("mcp.description")}>
                    <input
                      className={INPUT_CLASS}
                      value={selected.description ?? ""}
                      onChange={(event) =>
                        updateSelected({
                          ...selected,
                          description: event.target.value || undefined,
                        })
                      }
                    />
                  </Field>
                </div>

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
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </main>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="block space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}

function recordToLines(record?: Record<string, string>): string {
  return Object.entries(record ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")
}

function linesToRecord(value: string): Record<string, string> | undefined {
  const entries = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf(":")
      return index === -1 ? [line, ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()]
    })
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function recordToEnv(record?: Record<string, string>): string {
  return Object.entries(record ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
}

function envToRecord(value: string): Record<string, string> | undefined {
  const entries = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf("=")
      return index === -1 ? [line, ""] : [line.slice(0, index).trim(), line.slice(index + 1)]
    })
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}
