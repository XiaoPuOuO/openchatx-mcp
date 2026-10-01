import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"

import type { UpdateCheckResult } from "./version-check.js"

const RELEASE_DOWNLOAD_PREFIX = "https://github.com/XiaoPuOuO/openchatx-mcp/releases/download/"
const SAFE_SEGMENT = /[^0-9A-Za-z._-]+/gu
const WINDOWS_INSTALLER_NAME_PATTERN = /^OpenChatX-Setup-(?:x64|arm64)\.exe$/u

export interface WindowsUpdateLaunchResult {
  version: string
  installerPath: string
  installerName: string
}

export async function launchWindowsDesktopUpdate(
  update: UpdateCheckResult
): Promise<WindowsUpdateLaunchResult> {
  if (process.platform !== "win32" || process.env.OPENCHATX_DESKTOP !== "1") {
    throw new Error("In-app installation is only available in the Windows desktop app.")
  }
  if (!update.updateAvailable || !update.latestVersion) {
    throw new Error("No OpenChatX update is available.")
  }
  if (!update.downloadUrl || !update.downloadName) {
    throw new Error("This release does not contain a compatible Windows installer.")
  }
  if (
    !update.downloadUrl.startsWith(RELEASE_DOWNLOAD_PREFIX) ||
    !WINDOWS_INSTALLER_NAME_PATTERN.test(update.downloadName)
  ) {
    throw new Error("The update asset is not a trusted OpenChatX Windows installer.")
  }

  const response = await fetch(update.downloadUrl, {
    headers: { "User-Agent": `OpenChatX/${update.currentVersion}` },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    throw new Error(`OpenChatX installer download failed with HTTP ${response.status}.`)
  }

  const versionDirectory = update.latestVersion.replace(SAFE_SEGMENT, "_")
  const updateDirectory = join(tmpdir(), "OpenChatX", "updates", versionDirectory)
  await mkdir(updateDirectory, { recursive: true })
  const installerPath = join(updateDirectory, update.downloadName)
  await writeFile(installerPath, Buffer.from(await response.arrayBuffer()))

  const installer = spawn(
    installerPath,
    ["/SILENT", "/SUPPRESSMSGBOXES", "/CLOSEAPPLICATIONS", "/RESTARTAPPLICATIONS"],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    }
  )
  installer.unref()

  return {
    version: update.latestVersion,
    installerPath,
    installerName: update.downloadName,
  }
}
