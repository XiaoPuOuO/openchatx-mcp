import { access, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { MCP_CONFIG } from "../src/config.ts"
import { checkPublicRuntime, printPreflightErrors } from "./preflight.mjs"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const restarting = process.argv.includes("--restart")
const { errors, pm2Path } = await checkPublicRuntime()

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

if (restarting) await rm(join(repoRoot, "agent-commands.yaml"), { force: true })

run("npm", ["run", "build"])
runAllowFailure(pm2Path, ["delete", "shellby-cursor-host"])
run(pm2Path, ["startOrReload", "ecosystem.config.cjs", "--update-env"], { quiet: true })
if (MCP_CONFIG.tools.clones || MCP_CONFIG.tools.subagents) {
  run(process.execPath, ["--import", "tsx", join(repoRoot, "scripts", "chatgpt-browser.mjs"), "--auto"])
}

if (!(await waitForMcp())) {
  console.error("MCP server did not become healthy at http://127.0.0.1:3333/healthz.")
  process.exit(1)
}

console.log("MCP server: running")
console.log("ngrok: running")
run(process.execPath, [join(repoRoot, "scripts", "print-url.mjs")])

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
}

function runAllowFailure(command, args) {
  spawnSync(command, args, { encoding: "utf8" })
}

async function waitForMcp() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:3333/healthz", {
        signal: AbortSignal.timeout(500),
      })
      if (response.ok) return true
    } catch {
      // PM2 may still be starting the process.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}
