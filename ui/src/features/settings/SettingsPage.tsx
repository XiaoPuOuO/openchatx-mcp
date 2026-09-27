import { Settings } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"

import { PageHeader } from "../../components/PageHeader"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import { fetchRuntimeSettings, saveRuntimeSettings } from "../../lib/api"
import type { RuntimeSettings } from "../../types"

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring"

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [settings, setSettings] = useState<RuntimeSettings>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState<string>()

  useEffect(() => {
    let cancelled = false
    void fetchRuntimeSettings()
      .then((value) => {
        if (!cancelled) setSettings(value)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function save() {
    if (!settings) return
    setSaving(true)
    setError(undefined)
    setMessage(undefined)
    try {
      const result = await saveRuntimeSettings(settings)
      setSettings(result.settings)
      setMessage(result.restartRequired ? t("settings.savedRestart") : t("settings.savedApplied"))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="min-h-screen">
      <PageHeader
        icon={Settings}
        title={t("settings.title")}
        subtitle={t("settings.subtitle")}
        onBack={onBack}
      />

      <div className="mx-auto max-w-4xl space-y-5 px-5 py-6">
        {!settings ? (
          <Card>
            <CardContent className="py-8 text-sm text-muted-foreground">
              {error ?? t("settings.loading")}
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader className="pb-3">
                <div className="text-sm font-semibold">{t("settings.runtime")}</div>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <Field label={t("settings.port")} hint={t("settings.restartHint")}>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    step={1}
                    className={INPUT_CLASS}
                    value={settings.port}
                    onChange={(event) =>
                      setSettings({ ...settings, port: Number(event.target.value) })
                    }
                  />
                </Field>
                <Field
                  label={t("settings.contextThreshold")}
                  hint={t("settings.contextThresholdHint")}
                >
                  <input
                    type="number"
                    min={1}
                    step={1}
                    className={INPUT_CLASS}
                    value={settings.context.warning_threshold}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        context: {
                          warning_threshold: Number(event.target.value),
                        },
                      })
                    }
                  />
                </Field>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <div className="text-sm font-semibold">{t("settings.shell")}</div>
              </CardHeader>
              <CardContent className="space-y-4">
                <Field label={t("settings.shellPath")} hint={t("settings.restartHint")}>
                  <input
                    className={INPUT_CLASS}
                    value={settings.shell.path}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        shell: { ...settings.shell, path: event.target.value },
                      })
                    }
                  />
                </Field>
                <label className="flex items-center justify-between rounded-lg border px-4 py-3">
                  <div>
                    <div className="text-sm font-medium">{t("settings.rtk")}</div>
                    <div className="text-xs text-muted-foreground">{t("settings.restartHint")}</div>
                  </div>
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={settings.shell.rtk}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        shell: { ...settings.shell, rtk: event.target.checked },
                      })
                    }
                  />
                </label>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <div className="text-sm font-semibold">{t("settings.tunnel")}</div>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <Field label={t("settings.tunnelProfile")} hint={t("settings.restartHint")}>
                  <input
                    className={INPUT_CLASS}
                    value={settings.tunnel.profile}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        tunnel: { ...settings.tunnel, profile: event.target.value },
                      })
                    }
                  />
                </Field>
                <Field label={t("settings.tunnelHealthPort")} hint={t("settings.restartHint")}>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    step={1}
                    className={INPUT_CLASS}
                    value={settings.tunnel.health_port}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        tunnel: {
                          ...settings.tunnel,
                          health_port: Number(event.target.value),
                        },
                      })
                    }
                  />
                </Field>
              </CardContent>
            </Card>

            {error ? <div className="status-banner status-banner-error">{error}</div> : null}
            {message ? <div className="status-banner status-banner-success">{message}</div> : null}

            <div className="flex justify-end">
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? t("settings.saving") : t("common.save")}
              </Button>
            </div>
          </>
        )}
      </div>
    </main>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{label}</div>
      {children}
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  )
}
