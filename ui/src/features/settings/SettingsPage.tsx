import { Settings } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"

import { PageHeader } from "../../components/PageHeader"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import {
  createBackup,
  type Diagnostics,
  fetchDiagnostics,
  fetchRecoveryState,
  fetchRuntimeSettings,
  fetchUpdateCheck,
  type RecoveryState,
  repairDiagnostic,
  restoreBackup,
  saveRuntimeSettings,
  setSafeMode,
  updateRecoveryState,
} from "../../lib/api"
import type { RuntimeSettings } from "../../types"

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring"

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [settings, setSettings] = useState<RuntimeSettings>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState<string>()
  const [recovery, setRecovery] = useState<RecoveryState>()
  const [diagnostics, setDiagnostics] = useState<Diagnostics>()
  const [restorePath, setRestorePath] = useState("")

  useEffect(() => {
    let cancelled = false
    void fetchRecoveryState()
      .then((value) => !cancelled && setRecovery(value))
      .catch(() => undefined)
    void fetchDiagnostics()
      .then((value) => !cancelled && setDiagnostics(value))
      .catch(() => undefined)
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

            {recovery ? (
              <Card>
                <CardHeader className="pb-3">
                  <div className="text-sm font-semibold">Updates & Recovery</div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Update channel">
                      <select
                        className={INPUT_CLASS}
                        value={recovery.update.channel}
                        onChange={(event) => {
                          const channel = event.target.value === "stable" ? "stable" : "beta"
                          void updateRecoveryState({
                            update: { ...recovery.update, channel },
                          }).then(setRecovery)
                        }}
                      >
                        <option value="stable">Stable</option>
                        <option value="beta">Beta</option>
                      </select>
                    </Field>
                    <label className="flex items-center justify-between rounded-lg border px-4 py-3">
                      <div>
                        <div className="text-sm font-medium">Automatic update checks</div>
                        <div className="text-xs text-muted-foreground">
                          Check the selected channel at startup.
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={recovery.update.autoCheck}
                        onChange={(event) =>
                          void updateRecoveryState({
                            update: { ...recovery.update, autoCheck: event.target.checked },
                          }).then(setRecovery)
                        }
                      />
                    </label>
                    <label className="flex items-center justify-between rounded-lg border px-4 py-3">
                      <div>
                        <div className="text-sm font-medium">Safe Mode</div>
                        <div className="text-xs text-muted-foreground">
                          Starts only core OpenChatX capabilities after restart.
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={recovery.safeMode.enabled}
                        onChange={(event) =>
                          void setSafeMode(event.target.checked).then(setRecovery)
                        }
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={() =>
                        void fetchUpdateCheck(true)
                          .then((result) =>
                            setMessage(
                              result.updateAvailable
                                ? `Update available: ${result.latestVersion}`
                                : `OpenChatX ${result.currentVersion} is up to date.`
                            )
                          )
                          .catch((reason: unknown) =>
                            setError(reason instanceof Error ? reason.message : String(reason))
                          )
                      }
                    >
                      Check for Updates
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        void createBackup()
                          .then((result) => setMessage(`Backup created: ${result.path}`))
                          .catch((reason: unknown) =>
                            setError(reason instanceof Error ? reason.message : String(reason))
                          )
                      }
                    >
                      Create Backup
                    </Button>
                    <input
                      className={INPUT_CLASS}
                      placeholder="Backup path to restore"
                      value={restorePath}
                      onChange={(event) => setRestorePath(event.target.value)}
                    />
                    <Button
                      variant="outline"
                      disabled={!restorePath.trim()}
                      onClick={() => {
                        if (
                          !window.confirm(
                            "Restore this backup? A safety backup will be created first."
                          )
                        )
                          return
                        void restoreBackup(restorePath.trim())
                          .then((result) =>
                            setMessage(
                              `Restored. Safety backup: ${result.safetyBackupPath}. Restart OpenChatX.`
                            )
                          )
                          .catch((reason: unknown) =>
                            setError(reason instanceof Error ? reason.message : String(reason))
                          )
                      }}
                    >
                      Restore
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {diagnostics ? (
              <Card>
                <CardHeader className="pb-3">
                  <div className="text-sm font-semibold">Diagnostics & Doctor</div>
                  <div className="text-xs text-muted-foreground">
                    OpenChatX {diagnostics.version} · {diagnostics.platform} · {diagnostics.arch}
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Button
                    variant="outline"
                    onClick={() => window.open("/ui/api/diagnostics/export", "_blank")}
                  >
                    Export Diagnostic Bundle
                  </Button>
                  {diagnostics.checks.map((check) => (
                    <div
                      key={check.id}
                      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                    >
                      <div>
                        <div className="text-sm font-medium">{check.label}</div>
                        <div className="text-xs text-muted-foreground">{check.detail}</div>
                      </div>
                      {check.repairable ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void repairDiagnostic(check.id)
                              .then(async (result) => {
                                setMessage(result.detail)
                                setDiagnostics(await fetchDiagnostics())
                              })
                              .catch((reason: unknown) =>
                                setError(reason instanceof Error ? reason.message : String(reason))
                              )
                          }
                        >
                          Repair
                        </Button>
                      ) : (
                        <span className="text-xs uppercase text-muted-foreground">
                          {check.status}
                        </span>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}

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
