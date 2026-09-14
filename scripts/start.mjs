import { access, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { MCP_CONFIG } from "../src/config.ts"
import { checkPublicRuntime, checkRtkRuntime, printPreflightErrors } from "./preflight.mjs"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pm2Script = join(repoRoot, "scripts", "pm2.mjs")
const healthUrl = `http://${MCP_CONFIG.host}:${MCP_CONFIG.port}/healthz`
const hardRestart = process.argv.includes("--hard")
const restarting = process.argv.includes("--restart") || hardRestart

if (hardRestart && process.env.name === "shellby-mcp" && process.env.pm_exec_path) {
  console.error("A hard restart must run from a healthy Terminal.app session because it replaces PM2 itself. Use `npm run restart` inside Shellby.")
  process.exit(1)
}

const { errors } = await checkPublicRuntime(MCP_CONFIG.ngrok.enabled)
const rtkError = checkRtkRuntime(MCP_CONFIG.shell.rtk, MCP_CONFIG.shell.rtkExecutable)
if (rtkError) errors.push(rtkError)

if (errors.length > 0) {
  printPreflightErrors(errors)
  process.exit(1)
}

const workspace = MCP_CONFIG.workspace
try {
  await access(workspace)
} catch {
  console.error(`Agent workspace does not exist at ${workspace}. Run \`npm run setup\` first.`)
  process.exit(1)
}

run("npm", ["run", "build"])
if (hardRestart) {
  // Only a hard restart replaces the daemon's inherited macOS service context.
  run(process.execPath, ["--import", "tsx", pm2Script, "kill"])
} else {
  runAllowFailure(process.execPath, ["--import", "tsx", pm2Script, "delete", "shellby-cursor-host"])
}
if (restarting) await rm(join(repoRoot, "agent-commands.yaml"), { force: true })
if (MCP_CONFIG.tools.clones || MCP_CONFIG.tools.subagents) {
  run(process.execPath, ["--import", "tsx", join(repoRoot, "scripts", "chatgpt-browser.mjs"), "--auto"])
}
// Reload MCP last: its shutdown can kill this CLI, but the PM2 daemon completes the app restart.
if (MCP_CONFIG.ngrok.enabled) {
  run(process.execPath, ["--import", "tsx", pm2Script, "startOrReload", "ecosystem.config.cjs", "--only", "shellby-ngrok", "--update-env"], { quiet: true })
} else if (!hardRestart) {
  // Removing it from the ecosystem alone leaves an already-running tunnel alive.
  const processes = JSON.parse(run(process.execPath, ["--import", "tsx", pm2Script, "jlist", "--silent"], { quiet: true }).stdout)
  if (processes.some((app) => app.name === "shellby-ngrok")) {
    run(process.execPath, ["--import", "tsx", pm2Script, "delete", "shellby-ngrok"], { quiet: true })
  }
}
run(process.execPath, ["--import", "tsx", pm2Script, "startOrReload", "ecosystem.config.cjs", "--only", "shellby-mcp", "--update-env"], { quiet: true })

if (!(await waitForMcp())) {
  console.error(`This Shellby instance did not become healthy at ${healthUrl}. Check for another instance using port ${MCP_CONFIG.port}.`)
  process.exit(1)
}

console.log("MCP server: running")
console.log(MCP_CONFIG.ngrok.enabled ? "ngrok: running" : "ngrok: disabled (local only)")
run(process.execPath, ["--import", "tsx", join(repoRoot, "scripts", "print-url.mjs")])

function run(command, args, options = {}) {
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

function runAllowFailure(command, args) {
  spawnSync(command, args, { encoding: "utf8" })
}

async function waitForMcp() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(500),
      })
      if (response.ok && response.headers.get("x-shellby-instance") === MCP_CONFIG.instanceId) return true
    } catch {
      // PM2 may still be starting the process.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}
