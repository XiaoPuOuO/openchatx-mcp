import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, win32 } from "node:path"
import process from "node:process"

export type DesktopPlatform = "darwin" | "win32"

export interface DesktopInstallPlan {
  platform: DesktopPlatform
  launcherPath: string
  content: string
}

export function desktopInstallPlan(
  repositoryRoot: string,
  platform: NodeJS.Platform = process.platform,
  home = homedir()
): DesktopInstallPlan {
  if (platform === "darwin") {
    const launcherPath = join(
      home,
      "Applications",
      "OpenChatX.app",
      "Contents",
      "MacOS",
      "OpenChatX"
    )
    return {
      platform,
      launcherPath,
      content: macLauncher(repositoryRoot),
    }
  }
  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || win32.join(home, "AppData", "Local")
    const launcherPath = win32.join(localAppData, "OpenChatX", "OpenChatX.cmd")
    return {
      platform,
      launcherPath,
      content: windowsLauncher(repositoryRoot),
    }
  }
  throw new Error("OpenChatX Desktop currently supports macOS and Windows.")
}

export async function installDesktopLauncher(plan: DesktopInstallPlan): Promise<void> {
  await mkdir(dirname(plan.launcherPath), { recursive: true })
  await writeFile(plan.launcherPath, plan.content, "utf8")
  if (plan.platform === "darwin") await chmod(plan.launcherPath, 0o755)
}

export async function uninstallDesktopLauncher(plan: DesktopInstallPlan): Promise<void> {
  const target =
    plan.platform === "darwin"
      ? join(dirname(dirname(dirname(plan.launcherPath))), "OpenChatX.app")
      : win32.dirname(plan.launcherPath)
  await rm(target, { recursive: true, force: true })
}

function macLauncher(repositoryRoot: string): string {
  const quotedRoot = shellQuote(repositoryRoot)
  return `#!/bin/zsh
set -e
cd ${quotedRoot}
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
npm start
/usr/bin/open "http://127.0.0.1:3333/ui"
`
}

function windowsLauncher(repositoryRoot: string): string {
  return `@echo off
setlocal
cd /d "${repositoryRoot.replaceAll('"', '""')}"
call npm start
if errorlevel 1 exit /b %errorlevel%
start "" "http://127.0.0.1:3333/ui"
`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
