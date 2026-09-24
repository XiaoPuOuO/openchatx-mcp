import { spawnSync } from "node:child_process"
import { constants, existsSync } from "node:fs"
import { access } from "node:fs/promises"
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
  tunnelProfile = "openchatx",
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

  errors.push(...checkTunnelClient(tunnelProfile, platform))
  return { errors, pm2Path }
}

function checkTunnelClient(tunnelProfile: string, platform: NodeJS.Platform): string[] {
  const errors: string[] = []
  const executable = resolvePathExecutable("tunnel-client", platform) ?? "tunnel-client"
  const check = spawnSync(executable, ["--help"], { encoding: "utf8", windowsHide: true })

  if (hasErrorCode(check.error, "ENOENT")) {
    return [
      platform === "win32"
        ? "OpenAI tunnel-client is not installed. Download the Windows build from openai/tunnel-client releases and put tunnel-client.exe on PATH."
        : "OpenAI tunnel-client is not installed. Download the matching macOS build from openai/tunnel-client releases and put it on PATH.",
    ]
  }
  if (check.status !== 0) {
    return [`tunnel-client could not run${check.stderr?.trim() ? `: ${check.stderr.trim()}` : "."}`]
  }

  const profiles = spawnSync(executable, ["profiles", "list", "--json"], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (profiles.status !== 0 || !profiles.stdout.includes(`"${tunnelProfile}"`)) {
    errors.push(
      `tunnel-client profile "${tunnelProfile}" is missing. Initialize it with tunnel-client init --profile ${tunnelProfile} --tunnel-id <tunnel_id> --mcp-server-url http://127.0.0.1:3333/mcp.`
    )
  }
  if (!process.env.CONTROL_PLANE_API_KEY && !process.env.OPENAI_API_KEY) {
    errors.push(
      "tunnel-client authentication is missing. Set CONTROL_PLANE_API_KEY (preferred) or OPENAI_API_KEY in the environment that starts OpenChatX."
    )
  }
  return errors
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { loadPublicConfig, DEFAULT_PUBLIC_CONFIG } = await import("../src/public-config.cjs")
  const configPath = join(repoRoot, ".openchatx", "config.toml")
  const config = existsSync(configPath) ? loadPublicConfig(configPath) : DEFAULT_PUBLIC_CONFIG
  const { errors } = await checkPublicRuntime(config.tunnel.profile, config.shell.path)
  if (errors.length > 0) {
    printPreflightErrors(errors)
    process.exitCode = 1
  } else {
    console.log("Preflight passed.")
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
