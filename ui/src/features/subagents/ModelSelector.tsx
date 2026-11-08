import { RefreshCw } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "../../components/ui/button"
import { CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import { fetchSubagentModelDetails, fetchSubagentModels } from "../../lib/api"
import type { SubagentDiscoveredModel } from "../../types"

const SELECT_CLASS =
  "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"

export function ModelSelector({
  providerId,
  value = "",
  onSelect,
}: {
  providerId: string
  value?: string
  onSelect: (model: SubagentDiscoveredModel) => void
}) {
  const { t } = useI18n()
  const [models, setModels] = useState<SubagentDiscoveredModel[]>([])
  const [loading, setLoading] = useState(true)
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string>()
  const [detailWarning, setDetailWarning] = useState<string>()
  const alive = useRef(true)
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current
    setLoading(true)
    setModels([])
    setError(undefined)
    try {
      const items = await fetchSubagentModels(providerId)
      if (alive.current && currentRequest === requestId.current) setModels(items)
    } catch (failure) {
      if (alive.current && currentRequest === requestId.current)
        setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (alive.current && currentRequest === requestId.current) setLoading(false)
    }
  }, [providerId])

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
      requestId.current += 1
    }
  }, [refresh])

  async function choose(modelId: string) {
    const selected = models.find((item) => item.id === modelId)
    if (!selected || resolving) return
    setResolving(true)
    setDetailWarning(undefined)
    let resolved = selected
    try {
      const details = await fetchSubagentModelDetails(providerId, modelId)
      resolved = {
        ...selected,
        ...details,
        id: selected.id,
        context_window: details.context_window ?? selected.context_window,
        max_output_tokens: details.max_output_tokens ?? selected.max_output_tokens,
        thinking: details.thinking ?? selected.thinking,
        description: details.description ?? selected.description,
      }
    } catch {
      if (alive.current) setDetailWarning(t("subagents.detailsUnavailable"))
    } finally {
      if (alive.current) {
        setResolving(false)
        onSelect(resolved)
      }
    }
  }

  const currentIsListed = models.some((model) => model.id === value)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select
          className={SELECT_CLASS}
          value={value}
          disabled={loading || resolving || models.length === 0}
          aria-label={t("subagents.modelId")}
          onChange={(event) => void choose(event.target.value)}
        >
          <option value="">
            {loading ? t("subagents.loadingModels") : t("subagents.chooseDiscoveredModel")}
          </option>
          {value && !currentIsListed && (
            <option value={value}>
              {value} ({t("subagents.currentModelUnavailable")})
            </option>
          )}
          {models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name === item.id ? item.id : `${item.name} (${item.id})`}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={loading || resolving}
          title={t("subagents.discoverModels")}
          aria-label={t("subagents.discoverModels")}
          onClick={() => void refresh()}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {!loading && !error && models.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("subagents.emptyModelList")}</p>
      )}
      {detailWarning && <p className="text-xs text-muted-foreground">{detailWarning}</p>}
      <p className="text-xs text-muted-foreground">{t("subagents.modelMetadataHint")}</p>
    </div>
  )
}

export function NewModelPicker({
  providerId,
  onCreate,
  onCancel,
}: {
  providerId: string
  onCreate: (model: SubagentDiscoveredModel) => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  return (
    <>
      <CardHeader className="flex-row items-center justify-between border-b">
        <h2 className="truncate text-base font-semibold">
          {t("subagents.addModel")} · {providerId}
        </h2>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        <p className="text-sm text-muted-foreground">{t("subagents.selectModelToCreate")}</p>
        <ModelSelector key={providerId} providerId={providerId} onSelect={onCreate} />
      </CardContent>
    </>
  )
}
