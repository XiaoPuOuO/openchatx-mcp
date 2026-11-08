import { BrainCircuit, ChevronDown, CirclePlus, FolderOpen, Save, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { PageHeader } from "../../components/PageHeader"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import {
  beginChatGPTLogin,
  disconnectChatGPT,
  fetchChatGPTAuthStatus,
  fetchSubagentConfig,
  openSubagentConfigInFinder,
  saveSubagentConfig,
} from "../../lib/api"
import type {
  ChatGPTAuthStatus,
  SubagentConfig,
  SubagentDiscoveredModel,
  SubagentModelProfile,
  SubagentProviderConfig,
  SubagentThinkingConfig,
} from "../../types"
import { ModelSelector, NewModelPicker } from "./ModelSelector"

const INPUT_CLASS =
  "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
const TEXTAREA_CLASS =
  "min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"

type Selection = { kind: "provider" | "model" | "new-model"; id: string }
type ProviderChoice = "chatgpt" | "claude" | "gemini" | "openai" | "custom"

export function SubagentManager({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [config, setConfig] = useState<SubagentConfig>({
    limits: { max_depth: 5, max_children_per_agent: 12 },
    providers: {},
    models: {},
  })
  const [selection, setSelection] = useState<Selection>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    void fetchSubagentConfig()
      .then((next) => {
        setConfig(next)
        const provider = Object.keys(next.providers)[0]
        const model = Object.keys(next.models)[0]
        setSelection(
          provider
            ? { kind: "provider", id: provider }
            : model
              ? { kind: "model", id: model }
              : undefined
        )
      })
      .catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      )
      .finally(() => setLoading(false))
  }, [])

  const selectedProvider =
    selection?.kind === "provider" ? config.providers[selection.id] : undefined
  const selectedModel = selection?.kind === "model" ? config.models[selection.id] : undefined

  function addProvider(choice: ProviderChoice) {
    let id = choice === "custom" ? "custom" : choice
    let suffix = 2
    while (config.providers[id]) id = `${choice}-${suffix++}`
    const provider: SubagentProviderConfig =
      choice === "chatgpt"
        ? { type: "openai-chatgpt", enabled: true, timeout: 120000 }
        : {
            type:
              choice === "claude"
                ? "anthropic"
                : choice === "gemini"
                  ? "google"
                  : "openai-compatible",
            base_url:
              choice === "claude"
                ? "https://api.anthropic.com/v1"
                : choice === "gemini"
                  ? "https://generativelanguage.googleapis.com/v1beta"
                  : choice === "openai"
                    ? "https://api.openai.com/v1"
                    : "http://127.0.0.1:8000/v1",
            enabled: true,
            timeout: 120000,
          }
    setConfig((current) => ({
      ...current,
      providers: {
        [id]: provider,
        ...current.providers,
      },
    }))
    setSelection({ kind: "provider", id })
  }

  function addModel(provider: string) {
    setSelection({ kind: "new-model", id: provider })
  }

  function createModel(provider: string, discovered: SubagentDiscoveredModel) {
    const id = nextId(discovered.id, config.models)
    setConfig((current) => ({
      ...current,
      models: {
        ...current.models,
        [id]: {
          provider,
          model: discovered.id,
          name: discovered.id,
          description: discovered.description?.trim() || `Subagent using ${discovered.id}.`,
          enabled: true,
          execution_mode: "sync",
          ...(discovered.context_window ? { context_window: discovered.context_window } : {}),
          ...(discovered.max_output_tokens
            ? { max_output_tokens: discovered.max_output_tokens }
            : {}),
          thinking: discovered.thinking ?? { mode: "none" },
        },
      },
    }))
    setSelection({ kind: "model", id })
  }

  function updateProvider(next: SubagentProviderConfig) {
    if (selection?.kind !== "provider") return
    setConfig((current) => ({
      ...current,
      providers: { ...current.providers, [selection.id]: next },
    }))
  }

  function updateModel(next: SubagentModelProfile) {
    if (selection?.kind !== "model") return
    setConfig((current) => ({
      ...current,
      models: { ...current.models, [selection.id]: next },
    }))
  }

  function renameSelection(nextIdValue: string) {
    const nextId = nextIdValue.trim()
    if (!selection || !nextId || nextId === selection.id) return
    if (selection.kind === "provider") {
      if (config.providers[nextId]) return
      setConfig((current) => ({
        ...current,
        providers: Object.fromEntries(
          Object.entries(current.providers).map(([id, value]) => [
            id === selection.id ? nextId : id,
            value,
          ])
        ),
        models: Object.fromEntries(
          Object.entries(current.models).map(([id, model]) => [
            id,
            model.provider === selection.id ? { ...model, provider: nextId } : model,
          ])
        ),
      }))
    } else {
      if (config.models[nextId]) return
      setConfig((current) => ({
        ...current,
        models: Object.fromEntries(
          Object.entries(current.models).map(([id, value]) => [
            id === selection.id ? nextId : id,
            value,
          ])
        ),
      }))
    }
    setSelection({ ...selection, id: nextId })
  }

  function removeSelection() {
    if (!selection) return
    if (selection.kind === "provider") {
      if (!window.confirm(t("subagents.deleteProvider", { id: selection.id }))) return
      setConfig((current) => ({
        ...current,
        providers: Object.fromEntries(
          Object.entries(current.providers).filter(([id]) => id !== selection.id)
        ),
        models: Object.fromEntries(
          Object.entries(current.models).filter(([, model]) => model.provider !== selection.id)
        ),
      }))
    } else {
      if (!window.confirm(t("subagents.deleteModel", { id: selection.id }))) return
      setConfig((current) => ({
        ...current,
        models: Object.fromEntries(
          Object.entries(current.models).filter(([id]) => id !== selection.id)
        ),
      }))
    }
    setSelection(undefined)
  }

  async function save() {
    setSaving(true)
    setError(undefined)
    try {
      const result = await saveSubagentConfig(config)
      setConfig(result.config)
      setMessage(result.restartRequired ? t("subagents.saved") : t("subagents.saved"))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  async function openFinder() {
    setError(undefined)
    try {
      const opened = await openSubagentConfigInFinder()
      if (!opened) setMessage(t("subagents.mockFinder"))
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError))
    }
  }

  return (
    <main className="min-h-screen bg-muted/20">
      <PageHeader
        icon={BrainCircuit}
        title={t("subagents.title")}
        subtitle={t("subagents.subtitle")}
        onBack={onBack}
        actions={
          <>
            <Button variant="outline" onClick={() => void openFinder()}>
              <FolderOpen className="size-4" />
              {t("common.openInFinder")}
            </Button>
            <Button onClick={() => void save()} disabled={saving || loading}>
              <Save className="size-4" />
              {saving ? t("subagents.saving") : t("subagents.save")}
            </Button>
          </>
        }
      />

      <div className="mx-auto grid max-w-[1500px] gap-5 px-5 py-6 lg:h-[calc(100dvh-178px)] lg:min-h-[560px] lg:grid-cols-[340px_1fr] lg:px-8">
        <Card className="flex min-h-0 flex-col overflow-hidden lg:h-full">
          <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("subagents.providers")}
            </h2>
            <select
              className={INPUT_CLASS}
              aria-label={t("subagents.addProvider")}
              value=""
              onChange={(event) => {
                if (event.target.value) addProvider(event.target.value as ProviderChoice)
              }}
            >
              <option value="">+ {t("subagents.addProvider")}</option>
              <option value="chatgpt">ChatGPT (OAuth / Codex quota)</option>
              <option value="claude">Claude API Key</option>
              <option value="gemini">Gemini API Key</option>
              <option value="openai">OpenAI API Key</option>
              <option value="custom">{t("subagents.customProvider")}</option>
            </select>
            {Object.keys(config.providers).length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {t("subagents.noProviders")}
              </p>
            ) : (
              <div className="space-y-3">
                {Object.keys(config.providers).map((providerId) => (
                  <ProviderGroup
                    key={providerId}
                    id={providerId}
                    enabled={config.providers[providerId].enabled}
                    models={Object.entries(config.models).filter(
                      ([, model]) => model.provider === providerId
                    )}
                    selected={selection}
                    onSelectProvider={() => setSelection({ kind: "provider", id: providerId })}
                    onSelectModel={(id) => setSelection({ kind: "model", id })}
                    onAddModel={() => addModel(providerId)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="min-h-0 overflow-hidden lg:h-full">
          <div className="h-full overflow-y-auto">
            {!selection ? (
              <CardContent className="py-24 text-center text-sm text-muted-foreground">
                {t("subagents.select")}
              </CardContent>
            ) : selection.kind === "new-model" && config.providers[selection.id] ? (
              <NewModelPicker
                key={selection.id}
                providerId={selection.id}
                onCreate={(discovered) => createModel(selection.id, discovered)}
                onCancel={() => setSelection({ kind: "provider", id: selection.id })}
              />
            ) : selectedProvider ? (
              <ProviderEditor
                id={selection.id}
                provider={selectedProvider}
                onRename={renameSelection}
                onChange={updateProvider}
                onDelete={removeSelection}
              />
            ) : selectedModel ? (
              <ModelEditor
                key={`${selection.id}:${selectedModel.provider}`}
                id={selection.id}
                model={selectedModel}
                providerIds={Object.keys(config.providers)}
                onRename={renameSelection}
                onChange={updateModel}
                onDelete={removeSelection}
              />
            ) : null}
            {error ? <div className="status-banner status-banner-error m-5">{error}</div> : null}
            {message ? (
              <div className="status-banner status-banner-success m-5">{message}</div>
            ) : null}
          </div>
        </Card>
      </div>
    </main>
  )
}

function ProviderEditor({
  id,
  provider,
  onRename,
  onChange,
  onDelete,
}: {
  id: string
  provider: SubagentProviderConfig
  onRename: (id: string) => void
  onChange: (provider: SubagentProviderConfig) => void
  onDelete: () => void
}) {
  const { t } = useI18n()
  return (
    <>
      <EditorHeader title={id} onDelete={onDelete} />
      <CardContent className="space-y-5 pt-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("subagents.providerId")}>
            <input
              className={INPUT_CLASS}
              value={id}
              onChange={(event) => onRename(event.target.value)}
            />
          </Field>
          <Field label={t("subagents.providerType")}>
            <input
              className={INPUT_CLASS}
              value={
                provider.type === "openai-chatgpt"
                  ? "ChatGPT OAuth (subscription)"
                  : provider.type === "anthropic"
                    ? "Anthropic Messages API"
                    : provider.type === "google"
                      ? "Gemini API"
                      : t("subagents.openaiCompatible")
              }
              disabled
            />
          </Field>
        </div>
        <Toggle
          enabled={provider.enabled}
          onChange={(enabled) => onChange({ ...provider, enabled })}
        />
        {provider.type === "openai-chatgpt" ? (
          <ChatGPTLoginPanel />
        ) : (
          <>
            <Field label={t("subagents.baseUrl")}>
              <input
                className={INPUT_CLASS}
                value={provider.base_url}
                onChange={(event) => onChange({ ...provider, base_url: event.target.value })}
              />
            </Field>
            <Field label={t("subagents.apiKey")}>
              <input
                className={INPUT_CLASS}
                type="password"
                autoComplete="off"
                value={provider.api_key ?? ""}
                onChange={(event) =>
                  onChange({ ...provider, api_key: event.target.value || undefined })
                }
              />
            </Field>
            {provider.type === "openai-compatible" && (
              <Field label={t("subagents.headers")}>
                <textarea
                  className={TEXTAREA_CLASS}
                  value={recordToLines(provider.headers)}
                  onChange={(event) =>
                    onChange({ ...provider, headers: linesToRecord(event.target.value) })
                  }
                />
              </Field>
            )}
          </>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("subagents.timeout")}>
            <input
              className={INPUT_CLASS}
              type="number"
              min={1}
              value={provider.timeout}
              onChange={(event) => onChange({ ...provider, timeout: Number(event.target.value) })}
            />
          </Field>
          <Field label={t("subagents.description")}>
            <input
              className={INPUT_CLASS}
              value={provider.description ?? ""}
              onChange={(event) =>
                onChange({ ...provider, description: event.target.value || undefined })
              }
            />
          </Field>
        </div>
      </CardContent>
    </>
  )
}

function ChatGPTLoginPanel() {
  const { t } = useI18n()
  const [status, setStatus] = useState<ChatGPTAuthStatus>()
  const [error, setError] = useState<string>()
  const [url, setUrl] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    const refresh = () =>
      void fetchChatGPTAuthStatus()
        .then((value) => {
          if (active) setStatus(value)
        })
        .catch((failure) => {
          if (active) setError(String(failure))
        })
    refresh()
    const interval = window.setInterval(refresh, 2500)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [])

  async function login() {
    // Open the window in the click handler to avoid browser popup blocking.
    const popup = window.open("", "_blank")
    setBusy(true)
    setError(undefined)
    try {
      const { authorizationUrl } = await beginChatGPTLogin()
      setUrl(authorizationUrl)
      if (popup) popup.location.href = authorizationUrl
    } catch (failure) {
      popup?.close()
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  async function logout() {
    setBusy(true)
    setError(undefined)
    try {
      await disconnectChatGPT()
      setStatus(await fetchChatGPTAuthStatus())
      setUrl(undefined)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-4 text-sm">
      <p className="text-muted-foreground">{t("subagents.oauthHint")}</p>
      <p>
        {status?.authorized
          ? `${t("subagents.connected")}: ${status.email ?? "ChatGPT"}`
          : t("subagents.notConnected")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void login()}>
          {t("subagents.connectChatGPT")}
        </Button>
        {status?.connected && (
          <Button variant="outline" disabled={busy} onClick={() => void logout()}>
            {t("subagents.disconnectChatGPT")}
          </Button>
        )}
      </div>
      {url && !status?.authorized && (
        <a className="underline" href={url} target="_blank" rel="noreferrer">
          {t("subagents.openSignIn")}
        </a>
      )}
      {(error ?? status?.error) && <p className="text-destructive">{error ?? status?.error}</p>}
    </div>
  )
}

function ModelEditor({
  id,
  model,
  providerIds,
  onRename,
  onChange,
  onDelete,
}: {
  id: string
  model: SubagentModelProfile
  providerIds: string[]
  onRename: (id: string) => void
  onChange: (model: SubagentModelProfile) => void
  onDelete: () => void
}) {
  const { t } = useI18n()
  const [newEffortLevel, setNewEffortLevel] = useState("")
  const thinking = model.thinking
  const setThinkingMode = (mode: SubagentThinkingConfig["mode"]) => {
    const thinking: SubagentThinkingConfig =
      mode === "none"
        ? { mode: "none" }
        : mode === "boolean"
          ? { mode: "boolean", request_field: "enable_thinking", default_enabled: true }
          : {
              mode: "effort",
              request_field: "reasoning_effort",
              levels: ["low", "medium", "high"],
              default: "medium",
              enabled_field: "enable_thinking",
              default_enabled: true,
            }
    onChange({ ...model, thinking })
  }
  return (
    <>
      <EditorHeader title={model.name || id} onDelete={onDelete} />
      <CardContent className="space-y-5 pt-5">
        <Toggle enabled={model.enabled} onChange={(enabled) => onChange({ ...model, enabled })} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("subagents.profileId")}>
            <input
              className={INPUT_CLASS}
              value={id}
              onChange={(event) => onRename(event.target.value)}
            />
          </Field>
          <Field label={t("subagents.displayName")}>
            <input
              className={INPUT_CLASS}
              value={model.name}
              onChange={(event) => onChange({ ...model, name: event.target.value })}
            />
          </Field>
          <Field label={t("subagents.provider")}>
            <select
              className={INPUT_CLASS}
              value={model.provider}
              onChange={(event) => onChange({ ...model, provider: event.target.value })}
            >
              {providerIds.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("subagents.modelId")}>
            <ModelSelector
              key={model.provider}
              providerId={model.provider}
              value={model.model}
              onSelect={(discovered) =>
                onChange({
                  ...model,
                  model: discovered.id,
                  name: model.name.trim() ? model.name : discovered.id,
                  context_window: discovered.context_window,
                  max_output_tokens: discovered.max_output_tokens,
                  thinking: discovered.thinking ?? { mode: "none" },
                })
              }
            />
          </Field>
        </div>
        <Field label={t("subagents.description")} hint={t("subagents.purposeHint")}>
          <textarea
            className={TEXTAREA_CLASS}
            value={model.description}
            onChange={(event) => onChange({ ...model, description: event.target.value })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t("subagents.contextWindow")}>
            <input
              className={INPUT_CLASS}
              type="number"
              min={1}
              value={model.context_window ?? ""}
              onChange={(event) =>
                onChange({
                  ...model,
                  context_window: event.target.value ? Number(event.target.value) : undefined,
                })
              }
            />
          </Field>
          <Field label={t("subagents.maxOutput")}>
            <input
              className={INPUT_CLASS}
              type="number"
              min={1}
              value={model.max_output_tokens ?? ""}
              onChange={(event) =>
                onChange({
                  ...model,
                  max_output_tokens: event.target.value ? Number(event.target.value) : undefined,
                })
              }
            />
          </Field>
          <Field label={t("subagents.temperature")}>
            <input
              className={INPUT_CLASS}
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={model.temperature ?? ""}
              onChange={(event) =>
                onChange({
                  ...model,
                  temperature: event.target.value ? Number(event.target.value) : undefined,
                })
              }
            />
          </Field>
        </div>
        <Field label={t("subagents.thinkingMode")}>
          <select
            className={INPUT_CLASS}
            value={model.thinking.mode}
            onChange={(event) =>
              setThinkingMode(event.target.value as SubagentThinkingConfig["mode"])
            }
          >
            <option value="none">{t("subagents.thinkingNone")}</option>
            <option value="boolean">{t("subagents.thinkingBoolean")}</option>
            <option value="effort">{t("subagents.thinkingEffort")}</option>
          </select>
        </Field>
        {thinking.mode === "boolean" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("subagents.requestField")}>
              <input
                className={INPUT_CLASS}
                value={thinking.request_field}
                onChange={(event) =>
                  onChange({
                    ...model,
                    thinking: {
                      mode: "boolean",
                      request_field: event.target.value,
                      default_enabled: thinking.default_enabled,
                    },
                  })
                }
              />
            </Field>
            <label className="flex items-center gap-2 pt-6 text-sm">
              <input
                type="checkbox"
                checked={thinking.default_enabled}
                onChange={(event) =>
                  onChange({
                    ...model,
                    thinking: {
                      mode: "boolean",
                      request_field: thinking.request_field,
                      default_enabled: event.target.checked,
                    },
                  })
                }
              />
              {t("subagents.defaultEnabled")}
            </label>
          </div>
        ) : null}
        {thinking.mode === "effort" ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t("subagents.requestField")}>
                <input
                  className={INPUT_CLASS}
                  value={thinking.request_field}
                  onChange={(event) =>
                    onChange({
                      ...model,
                      thinking: { ...thinking, request_field: event.target.value },
                    })
                  }
                />
              </Field>
              <Field label={t("subagents.effortLevels")}>
                <div className="space-y-2">
                  <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border bg-background px-2 py-1.5">
                    {thinking.levels.map((level) => (
                      <span
                        key={level}
                        className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs"
                      >
                        {level}
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            if (thinking.levels.length === 1) return
                            const levels = thinking.levels.filter((item) => item !== level)
                            const defaultEffort =
                              thinking.default === level
                                ? (levels[0] ?? thinking.default)
                                : thinking.default
                            onChange({
                              ...model,
                              thinking: { ...thinking, levels, default: defaultEffort },
                            })
                          }}
                          aria-label={`Remove ${level}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  <input
                    className={INPUT_CLASS}
                    value={newEffortLevel}
                    placeholder={t("subagents.addEffortPlaceholder")}
                    onChange={(event) => setNewEffortLevel(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return
                      event.preventDefault()
                      const level = newEffortLevel.trim()
                      if (!level || thinking.levels.includes(level)) return
                      onChange({
                        ...model,
                        thinking: { ...thinking, levels: [...thinking.levels, level] },
                      })
                      setNewEffortLevel("")
                    }}
                  />
                </div>
              </Field>
              <Field label={t("subagents.defaultEffort")}>
                <select
                  className={INPUT_CLASS}
                  value={thinking.default}
                  onChange={(event) =>
                    onChange({ ...model, thinking: { ...thinking, default: event.target.value } })
                  }
                >
                  {thinking.levels.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t("subagents.effortToggleField")}
                hint={t("subagents.effortToggleHint")}
              >
                <input
                  className={INPUT_CLASS}
                  value={thinking.enabled_field ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...model,
                      thinking: {
                        ...thinking,
                        enabled_field: event.target.value || undefined,
                      },
                    })
                  }
                  placeholder="enable_thinking"
                />
              </Field>
              <label className="flex items-center gap-2 pt-6 text-sm">
                <input
                  type="checkbox"
                  checked={thinking.default_enabled}
                  onChange={(event) =>
                    onChange({
                      ...model,
                      thinking: { ...thinking, default_enabled: event.target.checked },
                    })
                  }
                />
                {t("subagents.defaultThinkingEnabled")}
              </label>
            </div>
          </div>
        ) : null}
      </CardContent>
    </>
  )
}

function ProviderGroup({
  id,
  enabled,
  models,
  selected,
  onSelectProvider,
  onSelectModel,
  onAddModel,
}: {
  id: string
  enabled: boolean
  models: Array<[string, SubagentModelProfile]>
  selected?: Selection
  onSelectProvider: () => void
  onSelectModel: (id: string) => void
  onAddModel: () => void
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(true)
  const selectedProvider = selected?.kind === "provider" && selected.id === id
  const selectedModel = models.some(
    ([modelId]) => selected?.kind === "model" && selected.id === modelId
  )

  return (
    <section
      className={`rounded-lg border p-2 ${selectedProvider || selectedModel ? "border-border bg-muted/20" : "border-border/70"}`}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onSelectProvider}
          className={`min-w-0 flex flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-semibold ${selectedProvider ? "bg-muted" : "hover:bg-muted/60"}`}
        >
          <StatusLight enabled={enabled} />
          <span className="min-w-0 truncate">{id}</span>
        </button>
        <span className="text-xs tabular-nums text-muted-foreground">{models.length}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={onAddModel}
          aria-label={`${t("subagents.addModel")}: ${id}`}
          title={`${t("subagents.addModel")}: ${id}`}
        >
          <CirclePlus className="size-4" />
        </Button>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? t("subagents.collapseModels") : t("subagents.expandModels")}: ${id}`}
          title={expanded ? t("subagents.collapseModels") : t("subagents.expandModels")}
          onClick={() => setExpanded((current) => !current)}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronDown className={`size-4 transition-transform ${expanded ? "" : "-rotate-90"}`} />
        </button>
      </div>
      {expanded && (
        <div className="ml-3 border-l border-border/70 pl-3">
          <h3 className="mb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("subagents.models")}
          </h3>
          {models.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">{t("subagents.noModels")}</p>
          ) : (
            <div className="space-y-1">
              {models.map(([modelId, model]) => (
                <button
                  key={modelId}
                  type="button"
                  onClick={() => onSelectModel(modelId)}
                  className={`w-full rounded-md px-2 py-2 text-left ${selected?.kind === "model" && selected.id === modelId ? "bg-muted" : "hover:bg-muted/60"}`}
                >
                  <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                    <StatusLight enabled={model.enabled} />
                    <span className="min-w-0 truncate">{model.name}</span>
                  </span>
                  {model.name !== modelId ? (
                    <span className="block truncate pl-4 text-[11px] text-muted-foreground">
                      {modelId}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function StatusLight({ enabled }: { enabled: boolean }) {
  const { t } = useI18n()
  const label = enabled ? t("common.enabled") : t("subagents.disabled")
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-block size-2 shrink-0 rounded-full ${enabled ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
    />
  )
}

function EditorHeader({ title, onDelete }: { title: string; onDelete: () => void }) {
  const { t } = useI18n()
  return (
    <CardHeader className="flex-row items-center justify-between border-b">
      <h2 className="truncate text-base font-semibold">{title}</h2>
      <Button variant="ghost" size="sm" onClick={onDelete}>
        <Trash2 className="size-3.5" /> {t("common.delete")}
      </Button>
    </CardHeader>
  )
}

function Toggle({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  const { t } = useI18n()
  return (
    <label className="flex items-center justify-between rounded-lg border px-4 py-3 text-sm">
      <span>{t("common.enabled")}</span>
      <input
        type="checkbox"
        checked={enabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
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
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}

function nextId(prefix: string, values: Record<string, unknown>): string {
  let index = 1
  let id = prefix
  while (values[id]) {
    index += 1
    id = `${prefix}-${index}`
  }
  return id
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
