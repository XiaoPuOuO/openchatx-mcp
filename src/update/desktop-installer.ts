import process from "node:process"

import { updateOperationalState } from "../recovery/operational-state.js"
import { launchMacOSDesktopUpdate } from "./macos-installer.js"
import type { UpdateCheckResult } from "./version-check.js"
import { launchWindowsDesktopUpdate } from "./windows-installer.js"

export interface DesktopUpdateLaunchResult {
  version: string
  installerPath: string
  installerName: string
}

export async function launchDesktopUpdate(
  update: UpdateCheckResult
): Promise<DesktopUpdateLaunchResult> {
  if (update.latestVersion) {
    await updateOperationalState((state) => {
      state.update.pendingHealthCheck = update.latestVersion
      state.update.phase = "downloading"
      state.update.progress = 5
    })
  }
  if (process.platform === "win32") return launchWindowsDesktopUpdate(update)
  if (process.platform === "darwin") return launchMacOSDesktopUpdate(update)
  throw new Error("In-app updates are not supported on this platform.")
}
