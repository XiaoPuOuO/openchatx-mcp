import { useEffect, useState } from "react"

import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import { fetchSubagentConfig, saveSubagentConfig } from "../../lib/api"
import type { SubagentConfig } from "../../types"

const INPUT_CLASS =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"

export function SubagentLimitsSettings() {
  const { t } = useI18n()
  const [limits, setLimits] = useState<SubagentConfig["limits"]>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState<string>()

  useEffect(() => {
    let active = true
    void fetchSubagentConfig()
      .then((config) => {
        if (active) setLimits(config.limits)
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
    }
  }, [])

  async function save() {
    if (!limits || saving) return
    setSaving(true)
    setError(undefined)
    setMessage(undefined)
    try {
      // The Provider/Model editor owns the rest of this configuration. Merge the
      // latest file contents so saving limits cannot revert Provider changes.
      const latest = await fetchSubagentConfig()
      const result = await saveSubagentConfig({ ...latest, limits })
      setLimits(result.config.limits)
      setMessage(t("settings.savedApplied"))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card data-testid="subagent-limit-settings">
      <CardHeader>
        <h2 className="text-sm font-semibold">{t("subagents.limitsTitle")}</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        {limits ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm">
                <span className="font-medium">{t("subagents.maxDepth")}</span>
                <input
                  className={INPUT_CLASS}
                  type="number"
                  min={1}
                  max={20}
                  value={limits.max_depth}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    if (Number.isInteger(next) && next >= 1 && next <= 20) {
                      setLimits((current) => (current ? { ...current, max_depth: next } : current))
                      setMessage(undefined)
                    }
                  }}
                />
              </label>
              <label className="space-y-2 text-sm">
                <span className="font-medium">{t("subagents.maxChildren")}</span>
                <input
                  className={INPUT_CLASS}
                  type="number"
                  min={1}
                  max={100}
                  value={limits.max_children_per_agent}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    if (Number.isInteger(next) && next >= 1 && next <= 100) {
                      setLimits((current) =>
                        current ? { ...current, max_children_per_agent: next } : current
                      )
                      setMessage(undefined)
                    }
                  }}
                />
              </label>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("subagents.limitsHint")}
            </p>
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? t("settings.saving") : t("common.save")}
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("settings.loading")}</p>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="text-sm text-muted-foreground" role="status">
            {message}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
