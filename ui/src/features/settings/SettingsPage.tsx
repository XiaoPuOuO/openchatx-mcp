import {
  Bell,
  type LucideIcon,
  RefreshCcw,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Stethoscope,
} from "lucide-react"
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
import {
  type AccessMode,
  fetchRuntimeControl,
  type PermissionPolicy,
  type RuntimeControlState,
  setAccessMode,
  updateDangerousActionPolicy,
  updateNotificationSettings,
} from "../../lib/runtime-control-api"
import type { RuntimeSettings } from "../../types"

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring"

const DANGEROUS_ACTIONS = [
  ["filesystem-destructive", "settings.danger.filesystem-destructive"],
  ["git-destructive", "settings.danger.git-destructive"],
  ["process-control", "settings.danger.process-control"],
  ["package-removal", "settings.danger.package-removal"],
  ["system-change", "settings.danger.system-change"],
  ["credential-access", "settings.danger.credential-access"],
  ["network-write", "settings.danger.network-write"],
  ["disk-destructive", "settings.danger.disk-destructive"],
] as const

const ACCESS_MODE_OPTIONS: Array<{
  id: AccessMode
  titleKey: string
  descriptionKey: string
  default?: boolean
}> = [
  {
    id: "always-question",
    titleKey: "settings.accessMode.always-question.title",
    descriptionKey: "settings.accessMode.always-question.description",
  },
  {
    id: "allow-low-risk",
    titleKey: "settings.accessMode.allow-low-risk.title",
    descriptionKey: "settings.accessMode.allow-low-risk.description",
    default: true,
  },
  {
    id: "full-access",
    titleKey: "settings.accessMode.full-access.title",
    descriptionKey: "settings.accessMode.full-access.description",
  },
]

type SettingsSection = "general" | "trust" | "recovery" | "notifications" | "diagnostics"

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection
  icon: LucideIcon
  labelKey: string
}> = [
  { id: "general", icon: SlidersHorizontal, labelKey: "settings.nav.general" },
  { id: "trust", icon: ShieldAlert, labelKey: "settings.nav.trust" },
  { id: "recovery", icon: RefreshCcw, labelKey: "settings.nav.recovery" },
  { id: "notifications", icon: Bell, labelKey: "settings.nav.notifications" },
  { id: "diagnostics", icon: Stethoscope, labelKey: "settings.nav.diagnostics" },
]

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [section, setSection] = useState<SettingsSection>("general")
  const [settings, setSettings] = useState<RuntimeSettings>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState<string>()
  const [recovery, setRecovery] = useState<RecoveryState>()
  const [diagnostics, setDiagnostics] = useState<Diagnostics>()
  const [restorePath, setRestorePath] = useState("")
  const [runtimeControl, setRuntimeControl] = useState<RuntimeControlState>()

  useEffect(() => {
    let cancelled = false
    void fetchRecoveryState()
      .then((value) => !cancelled && setRecovery(value))
      .catch(() => undefined)
    void fetchDiagnostics()
      .then((value) => !cancelled && setDiagnostics(value))
      .catch(() => undefined)
    void fetchRuntimeControl()
      .then((value) => !cancelled && setRuntimeControl(value))
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

  async function refreshRuntimeControl() {
    setRuntimeControl(await fetchRuntimeControl())
  }

  async function changeAccessMode(mode: AccessMode) {
    setError(undefined)
    setMessage(undefined)
    if (mode === "full-access") {
      const first = window.confirm(t("settings.accessMode.full-access.confirmFirst"))
      if (!first) return
      const second = window.confirm(t("settings.accessMode.full-access.confirmSecond"))
      if (!second) return
    }
    try {
      await setAccessMode(mode)
      await refreshRuntimeControl()
      setMessage(t("settings.accessMode.changed", { mode: t(`settings.accessMode.${mode}.title`) }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  async function setDangerousPolicy(category: string, policy: PermissionPolicy) {
    try {
      await updateDangerousActionPolicy(category, policy)
      await refreshRuntimeControl()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  async function setNotification(
    key: keyof RuntimeControlState["notifications"],
    enabled: boolean
  ) {
    try {
      await updateNotificationSettings({ [key]: enabled })
      await refreshRuntimeControl()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-muted/20">
      <PageHeader
        icon={Settings}
        title={t("settings.title")}
        subtitle={t("settings.subtitle")}
        onBack={onBack}
        actions={
          settings && section === "general" ? (
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? t("settings.saving") : t("common.save")}
            </Button>
          ) : null
        }
      />

      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 px-4 py-4 md:px-5 md:py-5">
        <div className="grid min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-sm md:grid-cols-[220px_minmax(0,1fr)]">
          <nav className="flex gap-1 overflow-x-auto border-b p-2 md:min-h-0 md:flex-col md:overflow-y-auto md:border-r md:border-b-0 md:p-3">
            {SETTINGS_SECTIONS.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  className={[
                    "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                    section === item.id
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  ].join(" ")}
                  onClick={() => setSection(item.id)}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="whitespace-nowrap">{t(item.labelKey)}</span>
                  {item.id === "trust" && runtimeControl?.accessMode === "full-access" ? (
                    <span className="ml-auto size-2 rounded-full bg-amber-500" />
                  ) : null}
                </button>
              )
            })}
          </nav>

          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
              <div className="mx-auto w-full max-w-5xl space-y-4">
                {error ? <div className="status-banner status-banner-error">{error}</div> : null}
                {message ? (
                  <div className="status-banner status-banner-success">{message}</div>
                ) : null}

                {!settings ? (
                  <Card>
                    <CardContent className="py-8 text-sm text-muted-foreground">
                      {error ?? t("settings.loading")}
                    </CardContent>
                  </Card>
                ) : (
                  <>
                    {section === "general" ? (
                      <GeneralSettingsPage settings={settings} setSettings={setSettings} />
                    ) : null}
                    {section === "trust" ? (
                      <TrustSettingsPage
                        runtimeControl={runtimeControl}
                        onAccessModeChange={changeAccessMode}
                        onDangerousPolicyChange={setDangerousPolicy}
                      />
                    ) : null}
                    {section === "recovery" ? (
                      <RecoverySettingsPage
                        recovery={recovery}
                        restorePath={restorePath}
                        setRestorePath={setRestorePath}
                        setRecovery={setRecovery}
                        setError={setError}
                        setMessage={setMessage}
                      />
                    ) : null}
                    {section === "notifications" ? (
                      <NotificationSettingsPage
                        runtimeControl={runtimeControl}
                        onNotificationChange={setNotification}
                      />
                    ) : null}
                    {section === "diagnostics" ? (
                      <DiagnosticsSettingsPage
                        diagnostics={diagnostics}
                        setDiagnostics={setDiagnostics}
                        setError={setError}
                        setMessage={setMessage}
                      />
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  )
}

function GeneralSettingsPage({
  settings,
  setSettings,
}: {
  settings: RuntimeSettings
  setSettings: (value: RuntimeSettings) => void
}) {
  const { t } = useI18n()
  return (
    <>
      <SettingsPageIntro
        title={t("settings.general.title")}
        subtitle={t("settings.general.subtitle")}
      />

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
              onChange={(event) => setSettings({ ...settings, port: Number(event.target.value) })}
            />
          </Field>
          <Field label={t("settings.contextThreshold")} hint={t("settings.contextThresholdHint")}>
            <input
              type="number"
              min={1}
              step={1}
              className={INPUT_CLASS}
              value={settings.context.warning_threshold}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  context: { warning_threshold: Number(event.target.value) },
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
    </>
  )
}

function TrustSettingsPage({
  runtimeControl,
  onAccessModeChange,
  onDangerousPolicyChange,
}: {
  runtimeControl?: RuntimeControlState
  onAccessModeChange: (mode: AccessMode) => Promise<void>
  onDangerousPolicyChange: (category: string, policy: PermissionPolicy) => Promise<void>
}) {
  const { t } = useI18n()

  if (!runtimeControl) return <LoadingCard />

  const lowRiskMode = runtimeControl.accessMode === "allow-low-risk"

  return (
    <>
      <SettingsPageIntro
        title={t("settings.trust.title")}
        subtitle={t("settings.trust.subtitle")}
      />

      <Card>
        <CardHeader className="pb-3">
          <div className="text-sm font-semibold">{t("settings.accessMode.title")}</div>
          <div className="text-xs text-muted-foreground">
            {t("settings.accessMode.description")}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-3">
            {ACCESS_MODE_OPTIONS.map((option) => {
              const selected = runtimeControl.accessMode === option.id
              return (
                <label
                  key={option.id}
                  className={[
                    "relative cursor-pointer rounded-lg border p-4 text-left transition-colors",
                    selected
                      ? option.id === "full-access"
                        ? "border-amber-500/60 bg-amber-500/10"
                        : "border-ring bg-accent/50"
                      : "hover:bg-accent/30",
                  ].join(" ")}
                >
                  <input
                    type="radio"
                    name="openchatx-access-mode"
                    value={option.id}
                    className="sr-only"
                    checked={selected}
                    onChange={() => {
                      if (!selected) void onAccessModeChange(option.id)
                    }}
                  />
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium">{t(option.titleKey)}</div>
                    <div
                      className={[
                        "mt-0.5 size-4 shrink-0 rounded-full border",
                        selected
                          ? "border-primary bg-primary shadow-[inset_0_0_0_3px_var(--background)]"
                          : "",
                      ].join(" ")}
                    />
                  </div>
                  <div className="mt-2 text-xs leading-5 text-muted-foreground">
                    {t(option.descriptionKey)}
                  </div>
                  {option.default ? (
                    <span className="mt-3 inline-flex rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">
                      {t("settings.accessMode.default")}
                    </span>
                  ) : null}
                </label>
              )
            })}
          </div>

          {runtimeControl.accessMode === "always-question" ? (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              {t("settings.accessMode.alwaysQuestionNotice")}
            </div>
          ) : null}
          {runtimeControl.accessMode === "allow-low-risk" ? (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
              {t("settings.accessMode.lowRiskNotice")}
            </div>
          ) : null}
          {runtimeControl.accessMode === "full-access" ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              <strong>{t("settings.accessMode.full-access.enabledWarningTitle")}</strong>{" "}
              {t("settings.accessMode.full-access.enabledWarningBody")}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className={lowRiskMode ? "" : "opacity-70"}>
        <CardHeader className="pb-3">
          <div className="text-sm font-semibold">{t("settings.dangerous.title")}</div>
          <div className="text-xs text-muted-foreground">
            {lowRiskMode
              ? t("settings.dangerous.hint")
              : runtimeControl.accessMode === "always-question"
                ? t("settings.accessMode.dangerousDisabledAlways")
                : t("settings.accessMode.dangerousDisabledFull")}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {DANGEROUS_ACTIONS.map(([category, labelKey]) => (
            <div
              key={category}
              className="grid items-center gap-3 rounded-lg border px-4 py-3 sm:grid-cols-[minmax(0,1fr)_180px]"
            >
              <div className="text-sm font-medium">{t(labelKey)}</div>
              <select
                className={INPUT_CLASS}
                value={runtimeControl.dangerousActions[category] ?? "ask"}
                disabled={!lowRiskMode}
                onChange={(event) =>
                  void onDangerousPolicyChange(category, permissionPolicy(event.target.value))
                }
              >
                <option value="ask">{t("settings.policy.ask")}</option>
                <option value="allow">{t("settings.policy.allow")}</option>
                <option value="deny">{t("settings.policy.deny")}</option>
              </select>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  )
}

function RecoverySettingsPage({
  recovery,
  restorePath,
  setRestorePath,
  setRecovery,
  setError,
  setMessage,
}: {
  recovery?: RecoveryState
  restorePath: string
  setRestorePath: (value: string) => void
  setRecovery: (value: RecoveryState) => void
  setError: (value: string | undefined) => void
  setMessage: (value: string | undefined) => void
}) {
  const { t } = useI18n()

  if (!recovery) return <LoadingCard />

  return (
    <>
      <SettingsPageIntro
        title={t("settings.recovery.title")}
        subtitle={t("settings.recovery.subtitle")}
      />

      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("settings.recovery.updateChannel")}>
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
                <option value="stable">{t("settings.recovery.stable")}</option>
                <option value="beta">{t("settings.recovery.beta")}</option>
              </select>
            </Field>
            <ToggleSetting
              title={t("settings.recovery.autoCheck")}
              hint={t("settings.recovery.autoCheckHint")}
              checked={recovery.update.autoCheck}
              onChange={(checked) =>
                void updateRecoveryState({
                  update: { ...recovery.update, autoCheck: checked },
                }).then(setRecovery)
              }
            />
            <ToggleSetting
              title={t("settings.recovery.closeToTray")}
              hint={t("settings.recovery.closeToTrayHint")}
              checked={recovery.desktop.closeToTray}
              onChange={(checked) =>
                void updateRecoveryState({
                  desktop: { ...recovery.desktop, closeToTray: checked },
                }).then(setRecovery)
              }
            />
            <ToggleSetting
              title={t("settings.recovery.startMinimized")}
              hint={t("settings.recovery.startMinimizedHint")}
              checked={recovery.desktop.startMinimized}
              onChange={(checked) =>
                void updateRecoveryState({
                  desktop: { ...recovery.desktop, startMinimized: checked },
                }).then(setRecovery)
              }
            />
            <ToggleSetting
              title={t("settings.recovery.safeMode")}
              hint={t("settings.recovery.safeModeHint")}
              checked={recovery.safeMode.enabled}
              onChange={(checked) => void setSafeMode(checked).then(setRecovery)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="text-sm font-semibold">{t("settings.recovery.actionsTitle")}</div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() =>
                void fetchUpdateCheck(true)
                  .then((result) =>
                    setMessage(
                      result.updateAvailable
                        ? t("settings.recovery.updateAvailableMessage", {
                            version: result.latestVersion ?? "?",
                          })
                        : t("settings.recovery.upToDateMessage", {
                            version: result.currentVersion,
                          })
                    )
                  )
                  .catch((reason: unknown) =>
                    setError(reason instanceof Error ? reason.message : String(reason))
                  )
              }
            >
              {t("settings.recovery.checkUpdates")}
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                void createBackup()
                  .then((result) =>
                    setMessage(t("settings.recovery.backupCreated", { path: result.path }))
                  )
                  .catch((reason: unknown) =>
                    setError(reason instanceof Error ? reason.message : String(reason))
                  )
              }
            >
              {t("settings.recovery.createBackup")}
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <input
              className={INPUT_CLASS}
              placeholder={t("settings.recovery.restorePath")}
              value={restorePath}
              onChange={(event) => setRestorePath(event.target.value)}
            />
            <Button
              variant="outline"
              disabled={!restorePath.trim()}
              onClick={() => {
                if (!window.confirm(t("settings.recovery.restoreConfirm"))) return
                void restoreBackup(restorePath.trim())
                  .then((result) =>
                    setMessage(
                      t("settings.recovery.restored", {
                        path: result.safetyBackupPath,
                      })
                    )
                  )
                  .catch((reason: unknown) =>
                    setError(reason instanceof Error ? reason.message : String(reason))
                  )
              }}
            >
              {t("settings.recovery.restore")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  )
}

function NotificationSettingsPage({
  runtimeControl,
  onNotificationChange,
}: {
  runtimeControl?: RuntimeControlState
  onNotificationChange: (
    key: keyof RuntimeControlState["notifications"],
    enabled: boolean
  ) => Promise<void>
}) {
  const { t } = useI18n()

  if (!runtimeControl) return <LoadingCard />

  const items = [
    ["enabled", "settings.notifications.enabled"],
    ["agentCompleted", "settings.notifications.agentCompleted"],
    ["approvalRequired", "settings.notifications.approvalRequired"],
    ["tunnelDisconnected", "settings.notifications.tunnelDisconnected"],
    ["updateAvailable", "settings.notifications.updateAvailable"],
    ["jobFinished", "settings.notifications.jobFinished"],
  ] as const

  return (
    <>
      <SettingsPageIntro
        title={t("settings.notifications.title")}
        subtitle={t("settings.notifications.subtitle")}
      />
      <Card>
        <CardContent className="grid gap-2 pt-5 sm:grid-cols-2">
          {items.map(([key, labelKey]) => (
            <ToggleSetting
              key={key}
              title={t(labelKey)}
              checked={runtimeControl.notifications[key]}
              disabled={key !== "enabled" && !runtimeControl.notifications.enabled}
              onChange={(checked) => void onNotificationChange(key, checked)}
            />
          ))}
        </CardContent>
      </Card>
    </>
  )
}

function DiagnosticsSettingsPage({
  diagnostics,
  setDiagnostics,
  setError,
  setMessage,
}: {
  diagnostics?: Diagnostics
  setDiagnostics: (value: Diagnostics) => void
  setError: (value: string | undefined) => void
  setMessage: (value: string | undefined) => void
}) {
  const { t } = useI18n()

  if (!diagnostics) return <LoadingCard />

  return (
    <>
      <SettingsPageIntro
        title={t("settings.diagnostics.title")}
        subtitle={t("settings.diagnostics.subtitle")}
      />

      <Card>
        <CardHeader className="pb-3">
          <div className="text-xs text-muted-foreground">
            OpenChatX {diagnostics.version} · {diagnostics.platform} · {diagnostics.arch}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button
            variant="outline"
            onClick={() => window.open("/ui/api/diagnostics/export", "_blank")}
          >
            {t("settings.diagnostics.export")}
          </Button>
          {diagnostics.checks.map((check) => (
            <div
              key={check.id}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
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
                  {t("settings.diagnostics.repair")}
                </Button>
              ) : (
                <span className="shrink-0 text-xs uppercase text-muted-foreground">
                  {check.status}
                </span>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  )
}

function SettingsPageIntro({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
    </div>
  )
}

function LoadingCard() {
  const { t } = useI18n()
  return (
    <Card>
      <CardContent className="py-8 text-sm text-muted-foreground">
        {t("settings.loading")}
      </CardContent>
    </Card>
  )
}

function ToggleSetting({
  title,
  hint,
  checked,
  disabled,
  onChange,
}: {
  title: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      </div>
      <input
        type="checkbox"
        className="size-4 shrink-0"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

function permissionPolicy(value: string): PermissionPolicy {
  if (value === "allow" || value === "deny") return value
  return "ask"
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
