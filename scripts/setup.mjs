import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { checkPublicRuntime, checkRtkRuntime } from "./preflight.mjs"
import { failure, intro, note, outro, spinner } from "./setup-ui.mjs"
import { initializeShellbyConfig, initializeWorkspace } from "./workspace-setup.mjs"

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const configOnly = process.argv.includes("--config-only")

if (configOnly) {
  const config = await initializeShellbyConfig()
  await import("../src/config.ts")
  console.log(`${config.configPath}${config.created ? " (created)" : config.updated ? " (updated)" : ""}`)
  process.exit(0)
}

intro()

const config = await initializeShellbyConfig()
note("Configuration", `${config.configPath}${config.created ? " (created)" : config.updated ? " (updated)" : ""}`)
const { MCP_CONFIG } = await import("../src/config.ts")

const prerequisiteStep = spinner("Checking prerequisites")
const { errors } = await checkPublicRuntime(MCP_CONFIG.ngrok.enabled)
if (errors.length > 0) {
  prerequisiteStep.fail("Prerequisites need attention")
  failure("Setup cannot continue", errors)
  process.exit(1)
}
prerequisiteStep.succeed("Prerequisites ready")

await mkdir(MCP_CONFIG.stateDir, { recursive: true })
const rtkError = checkRtkRuntime(MCP_CONFIG.shell.rtk, MCP_CONFIG.shell.rtkExecutable)
if (rtkError) {
  failure("Setup cannot continue", [rtkError])
  process.exit(1)
}

const workspaceStep = spinner("Preparing agent workspace")
const workspace = await initializeWorkspace(MCP_CONFIG.workspace)
workspaceStep.succeed(workspace.created ? "Agent workspace created" : "Agent workspace ready")
note("Workspace", workspace.agentsPath)

await commandStep("Building Shellby MCP", "Build ready", "npm", ["run", "build"])

if (MCP_CONFIG.tools.computer) {
  const computer = await commandStep(
    "Checking Computer Use",
    "Computer Use checked",
    process.execPath,
    [join(scriptsDir, "peekaboo-permissions.mjs"), "--status", "--optional"],
    { allowFailure: true }
  )
  note("Computer Use", combinedOutput(computer))
}

if (MCP_CONFIG.tools.clones || MCP_CONFIG.tools.subagents) {
  const browser = await commandStep(
    "Preparing multi-agent Chrome",
    "Multi-agent Chrome checked",
    process.execPath,
    ["--import", "tsx", join(scriptsDir, "chatgpt-browser.mjs"), "--setup", "--optional"],
    { allowFailure: true }
  )
  note("Multi-agent", combinedOutput(browser))
}

outro(["Sign into ChatGPT if the dedicated Chrome window opened.", "Run `npm start` to launch Shellby MCP."])

async function commandStep(label, successMessage, command, args, options = {}) {
  const step = spinner(label)
  const result = await run(command, args)
  if (result.status === 0) {
    step.succeed(successMessage)
    return result
  }

  if (options.allowFailure) {
    step.warn(`${label} needs attention`)
    return result
  }

  step.fail(`${label} failed`)
  failure(`${label} failed`, [combinedOutput(result) || `Command exited with status ${result.status}.`])
  process.exit(result.status ?? 1)
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.once("error", reject)
    child.once("close", (status) => resolve({ status: status ?? 1, stdout, stderr }))
  })
}

function combinedOutput(result) {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")
}
