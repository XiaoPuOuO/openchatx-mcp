import { ArrowLeft, BrainCircuit, CirclePlus, FolderOpen, Save, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"

import { LanguageSwitcher } from "../../components/LanguageSwitcher"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import { fetchSubagentConfig, openSubagentConfigInFinder, saveSubagentConfig } from "../../lib/api"
import type {
  SubagentConfig,
  SubagentModelProfile,
  SubagentProviderConfig,
  SubagentThinkingConfig,
} from "../../types"

const INPUT_CLASS =
  "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
const TEXTAREA_CLASS =
  "min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"

type Selection = { kind: "provider" | "model"; id: string }

export function SubagentManager({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [config, setConfig] = useState<SubagentConfig>({ providers: {}, models: {} })
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

  function addProvider() {
    const id = nextId("provider", config.providers)
    setConfig((current) => ({
      ...current,
      providers: {
        ...current.providers,
        [id]: {
          type: "openai-compatible",
          base_url: "http://127.0.0.1:8000/v1",
          enabled: true,
          timeout: 120000,
        },
      },
    }))
    setSelection({ kind: "provider", id })
  }

  function addModel() {
    const provider = Object.keys(config.providers)[0]
    if (!provider) {
      setError(t("subagents.noProviders"))
      return
    }
    const id = nextId("model", config.models)
    setConfig((current) => ({
      ...current,
      models: {
        ...current.models,
        [id]: {
          provider,
          model: "model-id",
          name: id,
          description: "Describe what this model is best used for.",
          enabled: true,
          context_window: 131072,
          thinking: { mode: "none" },
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
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between px-5 py-4 lg:px-8">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={onBack} aria-label={t("common.back")}>
              <ArrowLeft className="size-4" />
            </Button>
            <div className="flex size-9 items-center justify-center rounded-lg bg-foreground text-background">
              <BrainCircuit className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold">{t("subagents.title")}</h1>
              <p className="text-xs text-muted-foreground">{t("subagents.subtitle")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => void openFinder()}>
              <FolderOpen className="size-4" />
              {t("common.openInFinder")}
            </Button>
            <Button onClick={() => void save()} disabled={saving || loading}>
              <Save className="size-4" />
              {saving ? t("subagents.saving") : t("subagents.save")}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1500px] gap-5 px-5 py-6 lg:h-[calc(100dvh-178px)] lg:min-h-[560px] lg:grid-cols-[340px_1fr] lg:px-8">
        <Card className="flex min-h-0 flex-col overflow-hidden lg:h-full">
          <CardContent className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
            <ListSection
              title={t("subagents.providers")}
              ids={Object.keys(config.providers)}
              selected={selection}
              kind="provider"
              empty={t("subagents.noProviders")}
              onSelect={(id) => setSelection({ kind: "provider", id })}
              onAdd={addProvider}
              addLabel={t("subagents.addProvider")}
            />
            <ListSection
              title={t("subagents.models")}
              ids={Object.keys(config.models)}
              labels={Object.fromEntries(
                Object.entries(config.models).map(([id, model]) => [id, model.name])
              )}
              selected={selection}
              kind="model"
              empty={t("subagents.noModels")}
              onSelect={(id) => setSelection({ kind: "model", id })}
              onAdd={addModel}
              addLabel={t("subagents.addModel")}
            />
          </CardContent>
        </Card>

        <Card className="min-h-0 overflow-hidden lg:h-full">
          <div className="h-full overflow-y-auto">
            {!selection ? (
              <CardContent className="py-24 text-center text-sm text-muted-foreground">
                {t("subagents.select")}
              </CardContent>
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
                id={selection.id}
                model={selectedModel}
                providerIds={Object.keys(config.providers)}
                onRename={renameSelection}
                onChange={updateModel}
                onDelete={removeSelection}
              />
            ) : null}
            {error ? (
              <div className="m-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            ) : null}
            {message ? (
              <div className="m-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                {message}
              </div>
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
            <input className={INPUT_CLASS} value={t("subagents.openaiCompatible")} disabled />
          </Field>
        </div>
        <Toggle
          enabled={provider.enabled}
          onChange={(enabled) => onChange({ ...provider, enabled })}
        />
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
            value={provider.api_key ?? ""}
            onChange={(event) =>
              onChange({ ...provider, api_key: event.target.value || undefined })
            }
          />
        </Field>
        <Field label={t("subagents.headers")}>
          <textarea
            className={TEXTAREA_CLASS}
            value={recordToLines(provider.headers)}
            onChange={(event) =>
              onChange({ ...provider, headers: linesToRecord(event.target.value) })
            }
          />
        </Field>
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
            <input
              className={INPUT_CLASS}
              value={model.model}
              onChange={(event) => onChange({ ...model, model: event.target.value })}
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
              value={model.context_window}
              onChange={(event) =>
                onChange({ ...model, context_window: Number(event.target.value) })
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

function ListSection({
  title,
  ids,
  labels,
  selected,
  kind,
  empty,
  onSelect,
  onAdd,
  addLabel,
}: {
  title: string
  ids: string[]
  labels?: Record<string, string>
  selected?: Selection
  kind: Selection["kind"]
  empty: string
  onSelect: (id: string) => void
  onAdd: () => void
  addLabel: string
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onAdd}>
          <CirclePlus className="size-3.5" /> {addLabel}
        </Button>
      </div>
      {ids.length === 0 ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="space-y-1">
          {ids.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className={`w-full rounded-lg px-3 py-2 text-left ${selected?.kind === kind && selected.id === id ? "bg-muted" : "hover:bg-muted/60"}`}
            >
              <div className="truncate text-sm font-medium">{labels?.[id] ?? id}</div>
              {labels?.[id] && labels[id] !== id ? (
                <div className="truncate text-[11px] text-muted-foreground">{id}</div>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
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
  let id = `new-${prefix}`
  while (values[id]) {
    index += 1
    id = `new-${prefix}-${index}`
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
