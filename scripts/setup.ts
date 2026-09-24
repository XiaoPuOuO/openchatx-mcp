import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import process from "node:process"
import { checkPublicRuntime, checkRtkRuntime } from "./preflight.js"
import { failure, intro, note, outro, spinner } from "./setup-console.js"
import {
  type ConfigInitializationResult,
  initializeOpenChatXConfig,
  initializeWorkspace,
} from "./workspace-setup.js"

const configOnly = process.argv.includes("--config-only")

interface CommandResult {
  status: number
  stdout: string
  stderr: string
}

interface CommandStepOptions {
  allowFailure?: boolean
}

function formatConfigPath(configResult: ConfigInitializationResult): string {
  let suffix = ""
  if (configResult.created) suffix = " (created)"
  else if (configResult.updated) suffix = " (updated)"
  return `${configResult.configPath}${suffix}`
}

if (configOnly) {
  const config = await initializeOpenChatXConfig()
  await import("../src/config.js")
  console.log(formatConfigPath(config))
  process.exit(0)
}

intro()

const config = await initializeOpenChatXConfig()
note("Configuration", formatConfigPath(config))
const { MCP_CONFIG } = await import("../src/config.js")

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

await commandStep("Building openchatx-mcp", "Build ready", "npm", ["run", "build"])

outro(["Run `npm start` to launch openchatx-mcp."])

async function commandStep(
  label: string,
  successMessage: string,
  command: string,
  args: string[],
  options: CommandStepOptions = {}
): Promise<CommandResult> {
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
  failure(`${label} failed`, [
    combinedOutput(result) || `Command exited with status ${result.status}.`,
  ])
  process.exit(result.status)
}

function run(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once("error", reject)
    child.once("close", (status) => resolve({ status: status ?? 1, stdout, stderr }))
  })
}

function combinedOutput(result: CommandResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")
}
