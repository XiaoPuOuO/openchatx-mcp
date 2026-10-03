import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, chmod, copyFile, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import process from "node:process"

import { MCP_CONFIG } from "../config.js"
import { updateOperationalState } from "../recovery/operational-state.js"
import type { UpdateCheckResult } from "./version-check.js"

const RELEASE_DOWNLOAD_PREFIX = "https://github.com/XiaoPuOuO/openchatx-mcp/releases/download/"
const SAFE_SEGMENT = /[^0-9A-Za-z._-]+/gu
const MACOS_APP_ARCHIVE_PATTERN = /^OpenChatX-macos-(?:x64|arm64)\.app\.zip$/u
const DECIMAL_PID_PATTERN = /^\d+$/u

export interface MacOSUpdateLaunchResult {
  version: string
  installerPath: string
  installerName: string
}

export function isTrustedMacOSUpdateAsset(name: string, url: string): boolean {
  return MACOS_APP_ARCHIVE_PATTERN.test(name) && url.startsWith(RELEASE_DOWNLOAD_PREFIX)
}

export function buildMacOSUpdaterScript(): string {
  return `#!/bin/zsh
set -euo pipefail

ZIP_PATH="\${OPENCHATX_UPDATE_ZIP:?}"
TARGET_APP="\${OPENCHATX_TARGET_APP:?}"
TARGET_PID="\${OPENCHATX_TARGET_PID:?}"
WORK_DIR="\${OPENCHATX_UPDATE_WORK_DIR:?}"
HEALTH_URL="\${OPENCHATX_UPDATE_HEALTH_URL:?}"
STATE_PATH="\${OPENCHATX_OPERATIONAL_STATE_PATH:?}"
STATE_BACKUP="\${OPENCHATX_OPERATIONAL_STATE_BACKUP:?}"
STATE_EXISTED="\${OPENCHATX_OPERATIONAL_STATE_EXISTED:?}"
EXTRACT_DIR="$WORK_DIR/extracted"
NEW_APP="$EXTRACT_DIR/OpenChatX.app"
STAGE_APP="\${TARGET_APP}.update-\${TARGET_PID}"
BACKUP_APP="\${TARGET_APP}.backup-\${TARGET_PID}"

cleanup() {
  /bin/rm -rf "$EXTRACT_DIR" "$STAGE_APP"
}

restore_state() {
  if [[ "$STATE_EXISTED" == "1" && -f "$STATE_BACKUP" ]]; then
    /bin/cp -f "$STATE_BACKUP" "$STATE_PATH"
  elif [[ "$STATE_EXISTED" != "1" ]]; then
    /bin/rm -f "$STATE_PATH"
  fi
}
trap cleanup EXIT

/bin/rm -rf "$EXTRACT_DIR" "$STAGE_APP" "$BACKUP_APP"
/bin/mkdir -p "$EXTRACT_DIR"
/usr/bin/ditto -x -k "$ZIP_PATH" "$EXTRACT_DIR"

/usr/bin/test -d "$NEW_APP"
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$NEW_APP/Contents/Info.plist")
if [[ "$BUNDLE_ID" != "com.openchatx.desktop" ]]; then
  echo "Unexpected bundle identifier: $BUNDLE_ID" >&2
  exit 1
fi

/usr/bin/codesign --verify --deep --strict "$NEW_APP"
/usr/sbin/spctl --assess --type execute "$NEW_APP"
/usr/bin/ditto "$NEW_APP" "$STAGE_APP"
/usr/bin/codesign --verify --deep --strict "$STAGE_APP"

# Give the dashboard time to receive the accepted response before the desktop host exits.
/bin/sleep 1

/bin/kill -TERM "$TARGET_PID" 2>/dev/null || true
for _ in {1..100}; do
  if ! /bin/kill -0 "$TARGET_PID" 2>/dev/null; then
    break
  fi
  /bin/sleep 0.1
done
if /bin/kill -0 "$TARGET_PID" 2>/dev/null; then
  /bin/kill -KILL "$TARGET_PID" 2>/dev/null || true
  /bin/sleep 0.2
fi

/bin/mv "$TARGET_APP" "$BACKUP_APP"
if /bin/mv "$STAGE_APP" "$TARGET_APP"; then
  /usr/bin/open "$TARGET_APP"
  for _ in {1..60}; do
    if /usr/bin/curl -fsS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
      /bin/rm -rf "$BACKUP_APP"
      /bin/rm -f "$STATE_BACKUP"
      trap - EXIT
      /bin/rm -rf "$EXTRACT_DIR"
      exit 0
    fi
    /bin/sleep 0.5
  done

  # The new app did not become healthy. Restore the previous signed app bundle.
  /usr/bin/pkill -x OpenChatX 2>/dev/null || true
  /bin/sleep 0.5
  /bin/rm -rf "$TARGET_APP"
  /bin/mv "$BACKUP_APP" "$TARGET_APP"
  restore_state
  /usr/bin/open "$TARGET_APP"
  exit 1
fi

/bin/mv "$BACKUP_APP" "$TARGET_APP" 2>/dev/null || true
restore_state
exit 1
`
}

export async function launchMacOSDesktopUpdate(
  update: UpdateCheckResult
): Promise<MacOSUpdateLaunchResult> {
  if (process.platform !== "darwin" || process.env.OPENCHATX_DESKTOP !== "1") {
    throw new Error("In-app installation is only available in the macOS desktop app.")
  }
  if (!update.updateAvailable || !update.latestVersion) {
    throw new Error("No OpenChatX update is available.")
  }
  if (!update.downloadUrl || !update.downloadName) {
    throw new Error("This release does not contain a compatible macOS app archive.")
  }
  if (!isTrustedMacOSUpdateAsset(update.downloadName, update.downloadUrl)) {
    throw new Error("The update asset is not a trusted OpenChatX macOS app archive.")
  }

  const targetApp = process.env.OPENCHATX_DESKTOP_APP_PATH?.trim()
  const targetPid = process.env.OPENCHATX_DESKTOP_APP_PID?.trim()
  if (
    !targetApp ||
    basename(targetApp) !== "OpenChatX.app" ||
    !targetPid ||
    !DECIMAL_PID_PATTERN.test(targetPid)
  ) {
    throw new Error("Could not resolve the running OpenChatX desktop app.")
  }
  if (targetApp.startsWith("/Volumes/")) {
    throw new Error("Move OpenChatX to Applications before using in-app updates.")
  }
  await access(dirname(targetApp), constants.W_OK).catch(() => {
    throw new Error("OpenChatX cannot update this app location without write permission.")
  })

  const response = await fetch(update.downloadUrl, {
    headers: { "User-Agent": `OpenChatX/${update.currentVersion}` },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    throw new Error(`OpenChatX macOS update download failed with HTTP ${response.status}.`)
  }

  const versionDirectory = update.latestVersion.replace(SAFE_SEGMENT, "_")
  const updateDirectory = join(tmpdir(), "OpenChatX", "updates", versionDirectory)
  await mkdir(updateDirectory, { recursive: true })
  const archivePath = join(updateDirectory, update.downloadName)
  const scriptPath = join(updateDirectory, "install-macos-update.zsh")
  const statePath = join(MCP_CONFIG.stateDir, "operational-state.json")
  const stateBackup = join(updateDirectory, "operational-state.preupdate.json")
  await writeFile(archivePath, Buffer.from(await response.arrayBuffer()))
  let stateExisted = false
  try {
    await copyFile(statePath, stateBackup)
    stateExisted = true
  } catch (error) {
    if (!isEnoent(error)) throw error
  }
  await writeFile(scriptPath, buildMacOSUpdaterScript(), { encoding: "utf8", mode: 0o700 })
  await chmod(scriptPath, 0o700)
  await updateOperationalState((state) => {
    state.update.phase = "installing"
    state.update.progress = 75
  })

  const installer = spawn("/bin/zsh", [scriptPath], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      OPENCHATX_UPDATE_ZIP: archivePath,
      OPENCHATX_TARGET_APP: targetApp,
      OPENCHATX_TARGET_PID: targetPid,
      OPENCHATX_UPDATE_WORK_DIR: updateDirectory,
      OPENCHATX_UPDATE_HEALTH_URL: `http://127.0.0.1:${MCP_CONFIG.port}/healthz`,
      OPENCHATX_OPERATIONAL_STATE_PATH: statePath,
      OPENCHATX_OPERATIONAL_STATE_BACKUP: stateBackup,
      OPENCHATX_OPERATIONAL_STATE_EXISTED: stateExisted ? "1" : "0",
    },
  })
  installer.unref()

  return {
    version: update.latestVersion,
    installerPath: archivePath,
    installerName: update.downloadName,
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
