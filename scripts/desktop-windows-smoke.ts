import { spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"

if (process.platform !== "win32") {
  throw new Error("desktop-windows-smoke must run on Windows.")
}

const arch = process.argv[2] === "arm64" ? "arm64" : "x64"
const repositoryRoot = process.cwd()
const appRoot = join(repositoryRoot, "dist-desktop", `windows-${arch}`, "OpenChatX")
const runtimeRoot = join(appRoot, "runtime")
const node = join(runtimeRoot, "bin", "node.exe")
const tunnelClient = join(runtimeRoot, "bin", "tunnel-client.exe")
const shell = join(appRoot, "OpenChatX.exe")
const smokeRoot = await mkdtemp(join(tmpdir(), "openchatx-windows-desktop-smoke-"))
const port = 34333
const configDir = join(smokeRoot, "config")
const toolboxes = join(smokeRoot, "toolboxes")
const stateDir = join(smokeRoot, "state")
const logsDir = join(smokeRoot, "logs")
const configPath = join(configDir, "openchatx.toml")

for (const required of [node, tunnelClient, shell]) await stat(required)
await mkdir(configDir, { recursive: true })
await mkdir(logsDir, { recursive: true })
await cp(join(runtimeRoot, "defaults", "toolboxes"), toolboxes, { recursive: true })
await cp(join(runtimeRoot, "defaults", "mcp-servers.json"), join(configDir, "mcp-servers.json"))
await cp(join(runtimeRoot, "defaults", "subagents.json"), join(configDir, "subagents.json"))
await writeFile(
  configPath,
  [
    `state_dir = ${JSON.stringify(stateDir.replaceAll("\\", "/"))}`,
    `port = ${port}`,
    "",
    "[shell]",
    'path = "powershell.exe"',
    "rtk = false",
    "",
    "[tunnel]",
    'profile = "openchatx"',
    "health_port = 34808",
    "",
    "[mcp]",
    'tool_output = "compact"',
    "",
    "[tools]",
    "apply_patch = false",
    "",
  ].join("\n"),
  "utf8"
)

const environment = {
  ...process.env,
  PATH: `${join(runtimeRoot, "bin")};${process.env.PATH ?? ""}`,
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
  windowsHide: true,
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
  if (!health.ok) throw new Error(`Windows desktop runtime health failed: ${health.status}`)
  if (!health.headers.get("x-openchatx-instance")) {
    throw new Error("Windows desktop runtime did not expose x-openchatx-instance.")
  }

  const dashboard = await fetch(`http://127.0.0.1:${port}/ui/`)
  if (!dashboard.ok) throw new Error(`Windows desktop dashboard failed: ${dashboard.status}`)
  if (!(await dashboard.text()).includes("root")) {
    throw new Error("Windows desktop dashboard HTML was not served.")
  }

  const tunnelExit = await runExitCode(tunnelClient, ["--help"])
  if (tunnelExit !== 0) throw new Error("Bundled Windows tunnel-client failed to execute.")

  console.log(`Windows desktop runtime smoke test passed on port ${port}.`)
} finally {
  if (!child.killed) child.kill()
  await new Promise<void>((resolvePromise) => {
    if (child.exitCode !== null) {
      resolvePromise()
      return
    }
    const timer = setTimeout(() => {
      child.kill()
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
  throw new Error("Windows desktop runtime did not become healthy within 12 seconds.")
}

async function runExitCode(executable: string, args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const helper = spawn(executable, args, { stdio: "ignore", windowsHide: true })
    helper.once("error", reject)
    helper.once("exit", (code) => resolvePromise(code ?? 1))
  })
}
