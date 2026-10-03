import { CirclePlus, FolderOpen, RefreshCw, Save, ServerCog, Trash2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import ReactMarkdown from "react-markdown"
import { PageHeader } from "../../components/PageHeader"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import {
  fetchCapabilityHealth,
  fetchMcpServers,
  openMcpConfigInFinder,
  refreshMcpServers,
  saveMcpServers,
} from "../../lib/api"
import {
  fetchRuntimeControl,
  type ToolRiskOverride,
  updateToolRiskOverride,
} from "../../lib/runtime-control-api"
import type {
  CapabilityHealthComponent,
  CapabilityHealthStatus,
  McpDetectedTool,
  McpServerConfig,
  McpServerMap,
} from "../../types"

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
  const [refreshing, setRefreshing] = useState(false)
  const [tab, setTab] = useState<"settings" | "tools">("settings")
  const [health, setHealth] = useState<Record<string, CapabilityHealthComponent>>({})
  const [detectedTools, setDetectedTools] = useState<McpDetectedTool[]>([])
  const [message, setMessage] = useState<string>()
  const [error, setError] = useState<string>()
  const [toolRiskOverrides, setToolRiskOverrides] = useState<Record<string, ToolRiskOverride>>({})

  useEffect(() => {
    void Promise.all([fetchMcpServers(), fetchRuntimeControl()])
      .then(([snapshot, runtime]) => {
        setServers(snapshot.servers)
        setDetectedTools(snapshot.tools)
        setToolRiskOverrides(runtime.toolRiskOverrides)
        setSelectedId(Object.keys(snapshot.servers)[0])
        void fetchCapabilityHealth()
          .then((healthSnapshot) => setHealth(indexMcpHealth(healthSnapshot.components)))
          .catch(() => undefined)
      })
      .catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      )
      .finally(() => setLoading(false))
  }, [])

  const selected = selectedId ? servers[selectedId] : undefined
  const serverIds = useMemo(() => Object.keys(servers), [servers])
  const selectedTools = useMemo(
    () => detectedTools.filter((tool) => tool.server === selectedId),
    [detectedTools, selectedId]
  )

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
      await refreshHealth().catch(() => undefined)
      setMessage(result.restartRequired ? t("mcp.savedRestart") : t("mcp.saved"))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  async function setToolRisk(tool: McpDetectedTool, risk: ToolRiskOverride | undefined) {
    const key = `mcp:${tool.server}:${tool.name}`
    setError(undefined)
    try {
      await updateToolRiskOverride(key, risk)
      setToolRiskOverrides((current) => {
        const next = { ...current }
        if (risk) next[key] = risk
        else delete next[key]
        return next
      })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    }
  }

  async function refreshHealth() {
    const healthSnapshot = await fetchCapabilityHealth()
    setHealth(indexMcpHealth(healthSnapshot.components))
  }

  async function refresh() {
    setRefreshing(true)
    setError(undefined)
    setMessage(undefined)
    try {
      const snapshot = await refreshMcpServers()
      setServers(snapshot.servers)
      setDetectedTools(snapshot.tools)
      await refreshHealth()
      setMessage(t("mcp.refreshed"))
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError))
    } finally {
      setRefreshing(false)
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
      <PageHeader
        icon={ServerCog}
        title={t("mcp.title")}
        subtitle={t("mcp.subtitle")}
        onBack={onBack}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => void refresh()}
              disabled={loading || refreshing}
            >
              <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
              {refreshing ? t("mcp.refreshing") : t("common.refresh")}
            </Button>
            <Button variant="outline" onClick={() => void openInFinder()} disabled={loading}>
              <FolderOpen className="size-4" />
              {t("common.openInFinder")}
            </Button>
            <Button onClick={() => void save()} disabled={saving || loading}>
              <Save className="size-4" />
              {saving ? t("mcp.saving") : t("mcp.save")}
            </Button>
          </>
        }
      />

      <div className="mx-auto grid max-w-[1500px] gap-5 px-5 py-6 lg:h-[calc(100dvh-178px)] lg:min-h-[560px] lg:grid-cols-[340px_1fr] lg:px-8">
        <Card className="flex min-h-0 flex-col overflow-hidden lg:h-full">
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
          <CardContent className="min-h-0 flex-1 overflow-y-auto p-2">
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground">{t("mcp.loading")}</div>
            ) : serverIds.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">{t("mcp.none")}</div>
            ) : (
              <div className="space-y-1">
                {serverIds.map((id) => {
                  const server = servers[id]
                  const status = serverStatus(server, health[`mcp:${id}`])
                  return (
                    <button
                      type="button"
                      key={id}
                      onClick={() => setSelectedId(id)}
                      className={`flex w-full items-center justify-between rounded-lg px-3 py-3 text-left transition-colors ${selectedId === id ? "bg-muted" : "hover:bg-muted/60"}`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`size-2 rounded-full ${serverStatusDot(status)}`} />
                          <span className="truncate text-sm font-medium">{id}</span>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {server.type === "local" ? t("mcp.local") : t("mcp.remote")} ·{" "}
                          {t(`status.health.${status}`)}
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

        <Card className="flex min-h-0 flex-col overflow-hidden lg:h-full">
          {!selected || !selectedId ? (
            <CardContent className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
              {t("mcp.select")}
            </CardContent>
          ) : (
            <>
              <CardHeader className="flex-row items-start justify-between border-b">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold">{selectedId}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(`status.health.${serverStatus(selected, health[`mcp:${selectedId}`])}`)}
                    {health[`mcp:${selectedId}`]?.detail
                      ? ` · ${healthDetail(health[`mcp:${selectedId}`]?.detail, t)}`
                      : ""}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => deleteServer(selectedId)}>
                  <Trash2 className="size-3.5" />
                  {t("common.delete")}
                </Button>
              </CardHeader>
              <div className="flex border-b bg-muted/20 px-3 pt-2">
                {(["settings", "tools"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setTab(item)}
                    className={`rounded-t-lg px-4 py-2 text-sm font-medium ${
                      tab === item
                        ? "border border-b-background bg-background text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {item === "settings" ? t("mcp.settingsTab") : t("mcp.toolsTab")}
                  </button>
                ))}
              </div>

              {tab === "settings" ? (
                <CardContent className="min-h-0 flex-1 space-y-5 overflow-y-auto pt-5">
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

                  {error ? <div className="status-banner status-banner-error">{error}</div> : null}
                  {message ? (
                    <div className="status-banner status-banner-success">{message}</div>
                  ) : null}
                </CardContent>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="flex items-center justify-between px-5 py-3">
                    <span className="text-xs text-muted-foreground">
                      {t("mcp.detectedToolsCount", { count: selectedTools.length })}
                    </span>
                  </div>
                  {selectedTools.length === 0 ? (
                    <div className="border-t px-5 py-8 text-sm text-muted-foreground">
                      {t("mcp.noDetectedTools")}
                    </div>
                  ) : (
                    <div className="divide-y border-t">
                      {selectedTools.map((tool) => {
                        const riskKey = `mcp:${tool.server}:${tool.name}`
                        return (
                          <div
                            key={`${tool.server}:${tool.name}`}
                            className="flex items-start justify-between gap-4 px-5 py-4"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="break-all font-mono text-sm font-medium">
                                {tool.name}
                              </div>
                              <div className="mcp-tool-description mt-2">
                                <ReactMarkdown>
                                  {tool.description || t("mcp.noToolDescription")}
                                </ReactMarkdown>
                              </div>
                            </div>
                            <select
                              className="h-8 shrink-0 rounded-md border bg-background px-2 text-xs"
                              value={toolRiskOverrides[riskKey] ?? "default"}
                              title={t("toolboxes.riskPolicy")}
                              onChange={(event) => {
                                const value = event.target.value
                                void setToolRisk(
                                  tool,
                                  value === "low" || value === "approval" ? value : undefined
                                )
                              }}
                            >
                              <option value="default">{t("toolboxes.risk.default")}</option>
                              <option value="low">{t("toolboxes.risk.low")}</option>
                              <option value="approval">{t("toolboxes.risk.approval")}</option>
                            </select>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </main>
  )
}

function indexMcpHealth(
  components: CapabilityHealthComponent[]
): Record<string, CapabilityHealthComponent> {
  return Object.fromEntries(
    components
      .filter((component) => component.kind === "mcp")
      .map((component) => [component.id, component])
  )
}

function serverStatus(
  server: McpServerConfig,
  component: CapabilityHealthComponent | undefined
): CapabilityHealthStatus {
  if (!server.enabled) return "disabled"
  return component?.status ?? "starting"
}

function serverStatusDot(status: CapabilityHealthStatus): string {
  if (status === "healthy") return "bg-[var(--success)]"
  if (status === "unavailable" || status === "degraded") return "bg-amber-500"
  if (status === "starting") return "bg-blue-400"
  return "bg-[var(--status-idle)]"
}

function healthDetail(
  detail: string | undefined,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  if (detail === "Configured but unavailable") return t("status.configuredUnavailable")
  return detail ?? ""
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
