import { spawn } from "node:child_process"
import process from "node:process"

import { loadOperationalState } from "../recovery/operational-state.js"

export type NotificationKind =
  | "agentCompleted"
  | "approvalRequired"
  | "tunnelDisconnected"
  | "updateAvailable"
  | "jobFinished"

export class DesktopNotificationService {
  async notify(kind: NotificationKind, title: string, message: string): Promise<void> {
    if (process.env.OPENCHATX_DESKTOP !== "1") return
    const state = await loadOperationalState().catch(() => undefined)
    if (!state?.notifications.enabled || !state.notifications[kind]) return

    if (process.platform === "darwin") {
      this.notifyMac(title, message)
      return
    }
    if (process.platform === "win32") this.notifyWindows(title, message)
  }

  private notifyMac(title: string, message: string): void {
    const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`
    const child = spawn("/usr/bin/osascript", ["-e", script], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  }

  private notifyWindows(title: string, message: string): void {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$template=[Windows.UI.Notifications.ToastTemplateType]::ToastText02",
      "$xml=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)",
      `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode(${psString(title)})) | Out-Null`,
      `$xml.GetElementsByTagName('text')[1].AppendChild($xml.CreateTextNode(${psString(message)})) | Out-Null`,
      "$toast=[Windows.UI.Notifications.ToastNotification]::new($xml)",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('OpenChatX').Show($toast)",
    ].join(";")
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { detached: true, stdio: "ignore", windowsHide: true }
    )
    child.unref()
  }
}

export const desktopNotificationService = new DesktopNotificationService()

function appleScriptString(value: string): string {
  return JSON.stringify(value.replaceAll("\r", " ").replaceAll("\n", " "))
}

function psString(value: string): string {
  return `'${value.replaceAll("'", "''").replaceAll("\r", " ").replaceAll("\n", " ")}'`
}
