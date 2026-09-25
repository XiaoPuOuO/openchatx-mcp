import { spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const runtimeRoot = join(
  repositoryRoot,
  "dist-desktop",
  "OpenChatX.app",
  "Contents",
  "Resources",
  "runtime"
)
const node = join(runtimeRoot, "bin", "node")
const tunnelClient = join(runtimeRoot, "bin", "tunnel-client")
const smokeRoot = await mkdtemp(join(tmpdir(), "openchatx-desktop-smoke-"))
const port = 34333
const configDir = join(smokeRoot, "config")
const toolboxes = join(smokeRoot, "toolboxes")
const stateDir = join(smokeRoot, "state")
const logsDir = join(smokeRoot, "logs")
const configPath = join(configDir, "openchatx.toml")

await mkdir(configDir, { recursive: true })
await mkdir(logsDir, { recursive: true })
await cp(join(runtimeRoot, "defaults", "toolboxes"), toolboxes, { recursive: true })
await cp(join(runtimeRoot, "defaults", "mcp-servers.json"), join(configDir, "mcp-servers.json"))
await cp(join(runtimeRoot, "defaults", "subagents.json"), join(configDir, "subagents.json"))
await writeFile(
  configPath,
  [
    `state_dir = ${JSON.stringify(stateDir)}`,
    `port = ${port}`,
    "",
    "[shell]",
    'path = "/bin/zsh"',
    "rtk = false",
    "",
    "[tunnel]",
    'profile = "openchatx"',
    "health_port = 34808",
    "",
    "[mcp]",
    'tool_output = "compact"',
    "",
  ].join("\n"),
  "utf8"
)

const environment = {
  ...process.env,
  PATH: `${join(runtimeRoot, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin`,
  OPENCHATX_PUBLIC_CONFIG: configPath,
  OPENCHATX_EXTERNAL_MCP_CONFIG: join(configDir, "mcp-servers.json"),
  OPENCHATX_SUBAGENT_CONFIG: join(configDir, "subagents.json"),
  OPENCHATX_TOOLBOX_ROOT: toolboxes,
  OPENCHATX_AUDIT_LOG: join(logsDir, "agent-commands.yaml"),
  OPENCHATX_DESKTOP: "1",
}

const child = spawn(node, [join(runtimeRoot, "dist", "index.js")], {
  cwd: runtimeRoot,
  env: environment,
  detached: false,
  stdio: ["ignore", "pipe", "pipe"],
})
let output = ""
child.stdout.on("data", (chunk: Buffer) => {
  output += chunk.toString("utf8")
})
child.stderr.on("data", (chunk: Buffer) => {
  output += chunk.toString("utf8")
})

try {
  const health = await waitForHealth(`http://127.0.0.1:${port}/healthz`)
  if (!health.ok) throw new Error(`Desktop runtime health failed: ${health.status}`)
  const instance = health.headers.get("x-openchatx-instance")
  if (!instance) throw new Error("Desktop runtime did not expose x-openchatx-instance.")

  const dashboard = await fetch(`http://127.0.0.1:${port}/ui/`)
  if (!dashboard.ok) throw new Error(`Desktop dashboard failed: ${dashboard.status}`)
  const html = await dashboard.text()
  if (!html.includes("root")) throw new Error("Desktop dashboard HTML was not served.")

  const tunnelCheck = await runExitCode(tunnelClient, ["--help"])
  if (tunnelCheck !== 0) throw new Error("Bundled tunnel-client failed to execute.")

  console.log(`Desktop runtime smoke test passed on port ${port}.`)
  console.log(`Bundled runtime instance: ${instance.slice(0, 12)}…`)
} finally {
  if (!child.killed) child.kill("SIGTERM")
  await new Promise<void>((resolvePromise) => {
    if (child.exitCode !== null) {
      resolvePromise()
      return
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolvePromise()
    }, 3_000)
    child.once("exit", () => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
  await rm(smokeRoot, { recursive: true, force: true })
  if (child.exitCode && child.exitCode !== 0 && output) {
    process.stderr.write(output.slice(-8_000))
  }
}

async function waitForHealth(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) })
      if (response.ok) return response
    } catch {
      // Runtime is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
  throw new Error("Desktop runtime did not become healthy within 12 seconds.")
}

async function runExitCode(executable: string, args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const helperProcess = spawn(executable, args, { stdio: "ignore" })
    helperProcess.once("error", reject)
    helperProcess.once("exit", (code) => resolvePromise(code ?? 1))
  })
}
