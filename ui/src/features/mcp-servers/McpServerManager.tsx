import {
  CircleAlert,
  CirclePlus,
  FolderOpen,
  RefreshCw,
  Save,
  ServerCog,
  Trash2,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import ReactMarkdown from "react-markdown"
import { PageHeader } from "../../components/PageHeader"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import {
  disconnectMcpAuthorization,
  fetchCapabilityHealth,
  fetchMcpServers,
  openMcpConfigInFinder,
  refreshMcpServers,
  saveMcpServers,
  startMcpAuthorization,
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
  McpServerSnapshot,
} from "../../types"
import { shouldShowMcpOAuthControls } from "./oauth-visibility"

const INPUT_CLASS =
  "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
const TEXTAREA_CLASS =
  "min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"

export function McpServerManager({
  onBack,
  initialServerId,
}: {
  onBack: () => void
  initialServerId?: string
}) {
  const { t } = useI18n()
  const [servers, setServers] = useState<McpServerMap>({})
  const [selectedId, setSelectedId] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [tab, setTab] = useState<"settings" | "tools">("settings")
  const [health, setHealth] = useState<Record<string, CapabilityHealthComponent>>({})
  const [detectedTools, setDetectedTools] = useState<McpDetectedTool[]>([])
  const [authorization, setAuthorization] = useState<
    NonNullable<McpServerSnapshot["authorization"]>
  >({})
  const [authBusy, setAuthBusy] = useState(false)
  const [authorizationUrl, setAuthorizationUrl] = useState<string>()
  const [awaitingAuthId, setAwaitingAuthId] = useState<string>()
  const [message, setMessage] = useState<string>()
  const [error, setError] = useState<string>()
  const [toolRiskOverrides, setToolRiskOverrides] = useState<Record<string, ToolRiskOverride>>({})

  useEffect(() => {
    void Promise.all([fetchMcpServers(), fetchRuntimeControl()])
      .then(([snapshot, runtime]) => {
        setServers(snapshot.servers)
        setDetectedTools(snapshot.tools)
        setAuthorization(snapshot.authorization ?? {})
        setToolRiskOverrides(runtime.toolRiskOverrides)
        setSelectedId(
          initialServerId && snapshot.servers[initialServerId]
            ? initialServerId
            : Object.keys(snapshot.servers)[0]
        )
        void fetchCapabilityHealth()
          .then((healthSnapshot) => setHealth(indexMcpHealth(healthSnapshot.components)))
          .catch(() => undefined)
      })
      .catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      )
      .finally(() => setLoading(false))
  }, [initialServerId])

  useEffect(() => {
    const interval = window.setInterval(() => {
      void Promise.all([fetchMcpServers(), fetchCapabilityHealth()])
        .then(([snapshot, healthSnapshot]) => {
          setAuthorization(snapshot.authorization ?? {})
          setDetectedTools(snapshot.tools)
          setHealth(indexMcpHealth(healthSnapshot.components))
          if (!awaitingAuthId) return
          const status = snapshot.authorization?.[awaitingAuthId]?.status
          if (status === "error") {
            setAuthorizationUrl(undefined)
            setAwaitingAuthId(undefined)
            setMessage(undefined)
          } else if (
            status === "none" &&
            healthSnapshot.components.some(
              (component) =>
                component.id === `mcp:${awaitingAuthId}` && component.status === "healthy"
            )
          ) {
            setAuthorizationUrl(undefined)
            setAwaitingAuthId(undefined)
            setMessage(t("mcp.oauthConnected"))
          }
        })
        .catch(() => undefined)
    }, 5000)
    return () => window.clearInterval(interval)
  }, [awaitingAuthId, t])

  const selected = selectedId ? servers[selectedId] : undefined
  const serverIds = useMemo(() => Object.keys(servers), [servers])
  const loginRequiredIds = serverIds.filter(
    (id) =>
      serverStatus(servers[id], health[`mcp:${id}`], authorization[id]?.status) === "auth_required"
  )
  const selectedStatus =
    selected && selectedId
      ? serverStatus(selected, health[`mcp:${selectedId}`], authorization[selectedId]?.status)
      : undefined
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
      [id]: {
        type: "remote",
        url: "http://127.0.0.1:8000/mcp",
        enabled: true,
        dot: false,
      },
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
      const current = await fetchMcpServers()
      setAuthorization(current.authorization ?? {})
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
      setAuthorization(snapshot.authorization ?? {})
      await refreshHealth()
      setMessage(t("mcp.refreshed"))
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError))
    } finally {
      setRefreshing(false)
    }
  }

  async function connectAccount() {
    if (!selectedId || selected?.type !== "remote") return
    // Open during the user gesture, before asynchronous discovery; avoids popup blocking.
    const popup = window.open("", "_blank")
    setAuthBusy(true)
    setError(undefined)
    setAuthorizationUrl(undefined)
    try {
      const saved = await saveMcpServers(servers)
      setServers(saved.servers)
      const url = await startMcpAuthorization(selectedId)
      setAwaitingAuthId(selectedId)
      if (popup) {
        popup.location.replace(url)
        setMessage(t("mcp.oauthWaiting"))
      } else {
        // WKWebView delegates new windows to the system browser and returns null.
        // Never navigate the desktop dashboard away from OpenChatX.
        setAuthorizationUrl(url)
        setMessage(t("mcp.oauthOpenLink"))
      }
      const snapshot = await fetchMcpServers()
      setAuthorization(snapshot.authorization ?? {})
    } catch (authError) {
      popup?.close()
      setAwaitingAuthId(undefined)
      setError(authError instanceof Error ? authError.message : String(authError))
    } finally {
      setAuthBusy(false)
    }
  }

  async function disconnectAccount() {
    if (!selectedId) return
    setAuthBusy(true)
    setError(undefined)
    setAuthorizationUrl(undefined)
    setAwaitingAuthId(undefined)
    try {
      await disconnectMcpAuthorization(selectedId)
      const snapshot = await fetchMcpServers()
      setAuthorization(snapshot.authorization ?? {})
      setMessage(t("mcp.oauthDisconnected"))
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : String(authError))
    } finally {
      setAuthBusy(false)
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
              {loginRequiredIds.length > 0 && (
                <p className="mt-1 text-xs text-amber-600">
                  {t("mcp.needsLoginCount", { count: loginRequiredIds.length })}
                </p>
              )}
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
                  const status = serverStatus(
                    server,
                    health[`mcp:${id}`],
                    authorization[id]?.status
                  )
                  return (
                    <button
                      type="button"
                      key={id}
                      onClick={() => {
                        setSelectedId(id)
                        setMessage(undefined)
                      }}
                      className={`flex w-full items-center justify-between rounded-lg px-3 py-3 text-left transition-colors ${selectedId === id ? "bg-muted" : "hover:bg-muted/60"}`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`size-2 rounded-full ${serverStatusDot(status)}`} />
                          <span className="truncate text-sm font-medium">{id}</span>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {server.type === "local" ? t("mcp.local") : t("mcp.remote")} ·{" "}
                          {authorization[id]?.status === "authorizing"
                            ? t("mcp.oauthAuthorizing")
                            : status === "healthy"
                              ? t("mcp.available")
                              : t(`status.health.${status}`)}
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
                    {authorization[selectedId]?.status === "authorizing"
                      ? t("mcp.oauthAuthorizing")
                      : selectedStatus === "healthy"
                        ? t("mcp.available")
                        : t(`status.health.${selectedStatus}`)}
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
              {selectedStatus === "auth_required" && (
                <div
                  role="status"
                  className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3"
                >
                  <div className="flex items-center gap-2 text-sm">
                    <CircleAlert className="size-4 shrink-0 text-amber-600" />
                    <span>{t("mcp.loginPrompt")}</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={authBusy || saving}
                    onClick={() => {
                      setTab("settings")
                      void connectAccount()
                    }}
                  >
                    {t("mcp.oauthConnect")}
                  </Button>
                </div>
              )}
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
                              dot: selected.dot,
                            })
                          } else {
                            updateSelected({
                              type: "remote",
                              url: "http://127.0.0.1:8000/mcp",
                              enabled: selected.enabled,
                              dot: selected.dot,
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

                  <label className="flex items-center justify-between rounded-lg border px-4 py-3">
                    <div className="pr-4">
                      <p className="text-sm font-medium">{t("mcp.dotExposure")}</p>
                      <p className="text-xs text-muted-foreground">{t("mcp.dotExposureHint")}</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={selected.dot}
                      onChange={(event) =>
                        updateSelected({ ...selected, dot: event.target.checked })
                      }
                      className="size-4 shrink-0"
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
                      <Field label={t("mcp.authMode")} hint={t("mcp.authHint")}>
                        <select
                          className={INPUT_CLASS}
                          value={selected.auth ?? "auto"}
                          onChange={(event) =>
                            updateSelected({
                              ...selected,
                              auth: event.target.value as "auto" | "none" | "oauth" | "headers",
                            })
                          }
                        >
                          <option value="auto">{t("mcp.authAuto")}</option>
                          <option value="none">{t("mcp.authNone")}</option>
                          <option value="oauth">OAuth 2.1</option>
                          <option value="headers">{t("mcp.authHeaders")}</option>
                        </select>
                      </Field>
                      {shouldShowMcpOAuthControls(selected, authorization[selectedId]) ? (
                        <div className="space-y-3 rounded-lg border p-4">
                          <p className="text-sm font-medium">{t("mcp.oauthTitle")}</p>
                          <p className="text-xs text-muted-foreground">
                            {t("mcp.oauthDescription")}
                          </p>
                          <Field label={t("mcp.oauthRedirect")} hint={t("mcp.oauthRedirectHint")}>
                            <input
                              className={INPUT_CLASS}
                              readOnly
                              value={authorization[selectedId]?.redirectUrl ?? ""}
                              onFocus={(event) => event.currentTarget.select()}
                            />
                          </Field>
                          <Field label={t("mcp.oauthClientId")}>
                            <input
                              className={INPUT_CLASS}
                              value={selected.oauthClientId ?? ""}
                              onChange={(event) =>
                                updateSelected({
                                  ...selected,
                                  oauthClientId: event.target.value || undefined,
                                })
                              }
                              placeholder={t("mcp.oauthOptional")}
                            />
                          </Field>
                          <Field label={t("mcp.oauthMetadataUrl")}>
                            <input
                              className={INPUT_CLASS}
                              value={selected.oauthClientMetadataUrl ?? ""}
                              onChange={(event) =>
                                updateSelected({
                                  ...selected,
                                  oauthClientMetadataUrl: event.target.value || undefined,
                                })
                              }
                              placeholder="https://example.com/oauth/client.json"
                            />
                          </Field>
                          {authorization[selectedId]?.status === "auth_required" && (
                            <p className="text-sm text-amber-600">{t("mcp.oauthRequired")}</p>
                          )}
                          {authorization[selectedId]?.status === "authorizing" && (
                            <p className="text-sm text-muted-foreground">
                              {t("mcp.oauthAuthorizing")}
                            </p>
                          )}
                          {authorization[selectedId]?.status === "error" && (
                            <p className="text-sm text-destructive">{t("mcp.oauthRetry")}</p>
                          )}
                          {authorizationUrl && awaitingAuthId === selectedId && (
                            <a
                              className="text-sm text-primary underline underline-offset-2"
                              href={authorizationUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {t("mcp.oauthOpenBrowser")}
                            </a>
                          )}
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              disabled={authBusy || !selected.enabled}
                              onClick={() => void connectAccount()}
                            >
                              {t("mcp.oauthConnect")}
                            </Button>
                            <Button
                              variant="outline"
                              disabled={authBusy}
                              onClick={() => void disconnectAccount()}
                            >
                              {t("mcp.oauthDisconnect")}
                            </Button>
                          </div>
                        </div>
                      ) : null}
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
  component: CapabilityHealthComponent | undefined,
  authStatus?: NonNullable<McpServerSnapshot["authorization"]>[string]["status"]
): CapabilityHealthStatus {
  if (!server.enabled) return "disabled"
  if (authStatus === "auth_required" || authStatus === "error") return "auth_required"
  if (component?.status === "healthy") return "healthy"
  if (authStatus === "authorizing") return "starting"
  return component?.status ?? "starting"
}

function serverStatusDot(status: CapabilityHealthStatus): string {
  if (status === "healthy") return "bg-[var(--success)]"
  if (status === "auth_required") return "bg-amber-500"
  if (status === "unavailable" || status === "degraded") return "bg-destructive"
  if (status === "starting") return "bg-blue-400"
  return "bg-[var(--status-idle)]"
}

function healthDetail(
  detail: string | undefined,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  if (detail === "Configured but unavailable") return t("status.configuredUnavailable")
  if (detail === "Authentication required") return t("mcp.oauthRequired")
  if (detail === "Authorization failed. Retry connection.") return t("mcp.oauthRetry")
  if (detail === "Completing authorization") return t("mcp.oauthAuthorizing")
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
