import { spawnSync } from "node:child_process"
import { constants, existsSync } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import {
  isSupportedHostPlatform,
  resolveConfiguredShell,
  resolvePathExecutable,
  shellCommandArgs,
} from "../src/host-platform.js"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))

export interface PublicRuntimeCheck {
  errors: string[]
  pm2Path: string
}

export async function checkPublicRuntime(
  ngrokEnabled = true,
  shellPath?: string,
  platform: NodeJS.Platform = process.platform
): Promise<PublicRuntimeCheck> {
  const errors: string[] = []

  if (!isSupportedHostPlatform(platform)) {
    errors.push("This release supports macOS and native Windows only.")
  }
  if (!isSupportedArchitecture(process.arch)) {
    errors.push("This release supports arm64 and x64 hosts only.")
  }

  if (!isSupportedNodeVersion(process.versions.node)) {
    errors.push(`Node.js 22.18.0+ is required. Current version: ${process.versions.node}.`)
  }

  const pm2Path = join(repoRoot, "node_modules", "pm2", "bin", "pm2")
  try {
    await access(pm2Path, platform === "win32" ? constants.F_OK : constants.X_OK)
  } catch {
    errors.push("Local dependencies are missing. Run `npm ci` first.")
  }

  if (shellPath) {
    const executable = resolveConfiguredShell(shellPath, platform)
    const shellCheck = spawnSync(
      executable,
      shellCommandArgs(
        platform === "win32"
          ? 'Write-Output "__OPENCHATX_SHELL_OK__"'
          : "printf '__OPENCHATX_SHELL_OK__\\n'",
        platform
      ),
      { encoding: "utf8", windowsHide: true }
    )
    if (shellCheck.error || shellCheck.status !== 0) {
      errors.push(
        `Configured shell could not run: ${executable}. On Windows install PowerShell 7 (pwsh) or use powershell.exe.`
      )
    }
  }

  if (!ngrokEnabled) return { errors, pm2Path }

  const ngrokExecutable = resolvePathExecutable("ngrok", platform) ?? "ngrok"
  const ngrokVersion = spawnSync(ngrokExecutable, ["version"], { encoding: "utf8" })
  if (hasErrorCode(ngrokVersion.error, "ENOENT")) {
    errors.push(
      platform === "win32"
        ? "ngrok is not installed. Install it with `winget install Ngrok.Ngrok`."
        : "ngrok is not installed. Install it with `brew install --cask ngrok`."
    )
  } else if (ngrokVersion.status !== 0) {
    errors.push(
      `ngrok could not run${ngrokVersion.stderr?.trim() ? `: ${ngrokVersion.stderr.trim()}` : "."}`
    )
  } else if (!(await hasNgrokAuth(ngrokExecutable))) {
    errors.push("ngrok is not authenticated. Run `ngrok config add-authtoken <your-token>`.")
  }

  return { errors, pm2Path }
}

export function isSupportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number)
  return major > 22 || (major === 22 && minor >= 18)
}

export function isSupportedArchitecture(arch: string): boolean {
  return arch === "arm64" || arch === "x64"
}

export function checkRtkRuntime(enabled: boolean, executable?: string): string | undefined {
  if (!enabled) return
  if (process.platform === "win32")
    return "RTK shell rewriting is not supported on Windows yet. Set `shell.rtk = false`."
  if (!executable)
    return "RTK is enabled but not installed. Install it with `brew install rtk`, then restart openchatx-mcp."

  const result = spawnSync(executable, ["rewrite", "--help"], { encoding: "utf8" })
  if (
    result.error ||
    result.status !== 0 ||
    !result.stdout.includes("Rewrite a raw command to its RTK equivalent")
  ) {
    return `shell.rtk points to an incompatible \`rtk\` executable at ${executable}. Install RTK Token Killer with \`brew install rtk\`.`
  }
}

export function printPreflightErrors(errors: readonly string[]): void {
  console.error("Setup cannot continue:\n")
  for (const error of errors) console.error(`- ${error}`)
}

async function hasNgrokAuth(ngrokExecutable: string): Promise<boolean> {
  const check = spawnSync(ngrokExecutable, ["config", "check"], { encoding: "utf8" })
  if (check.status !== 0) return false

  const output = `${check.stdout ?? ""}\n${check.stderr ?? ""}`
  const match = output.match(/Valid configuration file at (.+)$/mu)
  if (!match?.[1]) return false

  try {
    const config = await readFile(expandHome(match[1].trim()), "utf8")
    return /^\s*authtoken\s*:\s*\S+/mu.test(config)
  } catch {
    return false
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { loadPublicConfig, DEFAULT_PUBLIC_CONFIG } = await import("../src/public-config.cjs")
  const configPath = join(repoRoot, ".openchatx", "config.toml")
  const config = existsSync(configPath) ? loadPublicConfig(configPath) : DEFAULT_PUBLIC_CONFIG
  const { errors } = await checkPublicRuntime(config.ngrok.enabled, config.shell.path)
  if (errors.length > 0) {
    printPreflightErrors(errors)
    process.exitCode = 1
  } else {
    console.log("Preflight passed.")
  }
}

function expandHome(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2))
  return value
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
