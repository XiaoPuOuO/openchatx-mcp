import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import { rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { MCP_CONFIG } from "../src/config.js"
import { checkPublicRuntime, checkRtkRuntime, printPreflightErrors } from "./preflight.js"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pm2Script = join(repoRoot, "scripts", "pm2.ts")
const healthUrl = `http://${MCP_CONFIG.host}:${MCP_CONFIG.port}/healthz`
const hardRestart = process.argv.includes("--hard")
const restarting = process.argv.includes("--restart") || hardRestart

if (hardRestart && process.env.name === "openchatx-mcp" && process.env.pm_exec_path) {
  console.error(
    "A hard restart must run from a healthy external terminal session because it replaces PM2 itself. Use `npm run restart` inside openchatx-mcp."
  )
  process.exit(1)
}

const { errors } = await checkPublicRuntime(MCP_CONFIG.tunnel.profile, MCP_CONFIG.shell.path)
const rtkError = checkRtkRuntime(MCP_CONFIG.shell.rtk, MCP_CONFIG.shell.rtkExecutable)
if (rtkError) errors.push(rtkError)

if (errors.length > 0) {
  printPreflightErrors(errors)
  process.exit(1)
}

if (process.platform === "win32") run("cmd.exe", ["/d", "/s", "/c", "npm", "run", "build"])
else run("npm", ["run", "build"])
if (hardRestart) {
  // Only a hard restart replaces the daemon's inherited host service context.
  run(process.execPath, ["--import", "tsx", pm2Script, "kill"])
}
if (restarting) await rm(join(repoRoot, "agent-commands.yaml"), { force: true })
// Reload the tunnel before MCP. When restart is invoked through OpenChatX itself,
// reloading MCP can terminate the requesting process before later PM2 commands run.
run(
  process.execPath,
  [
    "--import",
    "tsx",
    pm2Script,
    "startOrReload",
    "ecosystem.config.cjs",
    "--only",
    "openchatx-tunnel",
    "--update-env",
  ],
  { quiet: true }
)
run(
  process.execPath,
  [
    "--import",
    "tsx",
    pm2Script,
    "startOrReload",
    "ecosystem.config.cjs",
    "--only",
    "openchatx-mcp",
    "--update-env",
  ],
  { quiet: true }
)

if (!(await waitForMcp())) {
  console.error(
    `This openchatx-mcp instance did not become healthy at ${healthUrl}. Check for another instance using port ${MCP_CONFIG.port}.`
  )
  process.exit(1)
}

console.log("MCP server: running")
console.log(`OpenAI tunnel-client: running (profile ${MCP_CONFIG.tunnel.profile})`)
run(process.execPath, ["--import", "tsx", join(repoRoot, "scripts", "print-url.ts")])

interface RunOptions {
  quiet?: boolean
}

function run(command: string, args: string[], options: RunOptions = {}): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
  }
  if (!options.quiet) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
  return result
}

async function waitForMcp(attemptsRemaining = 20): Promise<boolean> {
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(500),
    })
    if (response.ok && response.headers.get("x-openchatx-instance") === MCP_CONFIG.instanceId)
      return true
  } catch {
    // PM2 may still be starting the process.
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (attemptsRemaining <= 1) return false
  return waitForMcp(attemptsRemaining - 1)
}
