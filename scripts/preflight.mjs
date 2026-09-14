import { access, readFile } from "node:fs/promises"
import { constants, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))

export async function checkPublicRuntime(ngrokEnabled = true) {
  const errors = []

  if (process.platform !== "darwin") {
    errors.push("This release supports macOS only.")
  }
  if (!isSupportedArchitecture(process.arch)) {
    errors.push("This release supports Apple Silicon and Intel Macs only.")
  }

  if (!isSupportedNodeVersion(process.versions.node)) {
    errors.push(`Node.js 22.13.0+ is required. Current version: ${process.versions.node}.`)
  }

  const pm2Path = join(repoRoot, "node_modules", ".bin", "pm2")
  try {
    await access(pm2Path, constants.X_OK)
  } catch {
    errors.push("Local dependencies are missing. Run `npm ci` first.")
  }

  if (!ngrokEnabled) return { errors, pm2Path }

  const ngrokExecutable = "ngrok"
  const ngrokVersion = spawnSync(ngrokExecutable, ["version"], { encoding: "utf8" })
  if (ngrokVersion.error?.code === "ENOENT") {
    errors.push("ngrok is not installed. Install it with `brew install --cask ngrok`.")
  } else if (ngrokVersion.status !== 0) {
    errors.push(`ngrok could not run${ngrokVersion.stderr?.trim() ? `: ${ngrokVersion.stderr.trim()}` : "."}`)
  } else if (!(await hasNgrokAuth(ngrokExecutable))) {
    errors.push("ngrok is not authenticated. Run `ngrok config add-authtoken <your-token>`.")
  }

  return { errors, pm2Path }
}

export function isSupportedNodeVersion(version) {
  const [major = 0, minor = 0] = version.split(".").map(Number)
  return major > 22 || (major === 22 && minor >= 13)
}

export function isSupportedArchitecture(arch) {
  return arch === "arm64" || arch === "x64"
}

export function checkRtkRuntime(enabled, executable) {
  if (!enabled) return undefined
  if (!executable) return "RTK is enabled but not installed. Install it with `brew install rtk`, then restart Shellby."

  const result = spawnSync(executable, ["rewrite", "--help"], { encoding: "utf8" })
  if (result.error || result.status !== 0 || !result.stdout.includes("Rewrite a raw command to its RTK equivalent")) {
    return `shell.rtk points to an incompatible \`rtk\` executable at ${executable}. Install RTK Token Killer with \`brew install rtk\`.`
  }
  return undefined
}

export function printPreflightErrors(errors) {
  console.error("Setup cannot continue:\n")
  for (const error of errors) console.error(`- ${error}`)
}

async function hasNgrokAuth(ngrokExecutable) {
  const check = spawnSync(ngrokExecutable, ["config", "check"], { encoding: "utf8" })
  if (check.status !== 0) return false

  const output = `${check.stdout ?? ""}\n${check.stderr ?? ""}`
  const match = output.match(/Valid configuration file at (.+)$/m)
  if (!match?.[1]) return false

  try {
    const config = await readFile(expandHome(match[1].trim()), "utf8")
    return /^\s*authtoken\s*:\s*\S+/m.test(config)
  } catch {
    return false
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { loadPublicConfig, DEFAULT_PUBLIC_CONFIG } = await import("../src/public-config.cts")
  const configPath = join(repoRoot, ".shellby", "config.toml")
  const config = existsSync(configPath) ? loadPublicConfig(configPath) : DEFAULT_PUBLIC_CONFIG
  const { errors } = await checkPublicRuntime(config.ngrok.enabled)
  if (errors.length > 0) {
    printPreflightErrors(errors)
    process.exitCode = 1
  } else {
    console.log("Preflight passed.")
  }
}

function expandHome(value) {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return value
}
