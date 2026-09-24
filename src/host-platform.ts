import { spawnSync } from "node:child_process"
import process from "node:process"

const LINE_BREAK_RE = /\r?\n/u

export type SupportedHostPlatform = "darwin" | "win32"

export function isSupportedHostPlatform(
  platform: NodeJS.Platform = process.platform
): platform is SupportedHostPlatform {
  return platform === "darwin" || platform === "win32"
}

export function hostDisplayName(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "Windows"
  if (platform === "darwin") return "macOS"
  return platform
}

export function defaultShellPath(
  platform: NodeJS.Platform = process.platform
): "pwsh.exe" | "/bin/zsh" {
  return platform === "win32" ? "pwsh.exe" : "/bin/zsh"
}

export function resolveConfiguredShell(
  configured: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== "win32") return configured
  const normalized = configured.toLowerCase()
  if (normalized !== "pwsh.exe" && normalized !== "pwsh") return configured
  return resolvePathExecutable("pwsh.exe", platform) ?? "powershell.exe"
}

export function shellCommandArgs(
  command: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  return platform === "win32"
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
    : ["-f", "-c", command]
}

export function interactiveShellArgs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["-NoLogo", "-NoProfile"] : ["-f"]
}

export function interactiveReadyCommand(
  platform: NodeJS.Platform = process.platform
): 'Write-Output "__OPENCHATX_READY__"' | "printf '__OPENCHATX_READY__\\n'" {
  return platform === "win32"
    ? 'Write-Output "__OPENCHATX_READY__"'
    : "printf '__OPENCHATX_READY__\\n'"
}

export function resolvePathExecutable(
  name: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const command = platform === "win32" ? "where.exe" : "/usr/bin/which"
  const result = spawnSync(command, [name], { encoding: "utf8", windowsHide: true })
  if (result.error || result.status !== 0) return undefined
  const executable = result.stdout
    .split(LINE_BREAK_RE)
    .map((line) => line.trim())
    .find(Boolean)
  return executable || undefined
}

export function signalProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === "win32") {
    const args = ["/PID", String(pid), "/T", "/F"]
    const result = spawnSync("taskkill.exe", args, {
      encoding: "utf8",
      windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.status !== 0 && isProcessRunning(pid, platform)) {
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          `taskkill exited with status ${String(result.status)}.`
      )
    }
    return
  }
  process.kill(-pid, signal)
}

export function isProcessRunning(
  pid: number,
  _platform: NodeJS.Platform = process.platform
): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
