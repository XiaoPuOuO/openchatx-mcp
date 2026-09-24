const { execFileSync } = require("node:child_process")
const { join } = require("node:path")
const process = require("node:process")
const { loadPublicConfig } = require("./dist/public-config.cjs")

const LINE_BREAK_RE = /\r?\n/u
const openchatxConfig = loadPublicConfig(join(__dirname, ".openchatx", "config.toml"))

function resolveExecutable(name) {
  const locator = process.platform === "win32" ? "where.exe" : "/usr/bin/which"
  return execFileSync(locator, [name], { encoding: "utf8", windowsHide: true })
    .split(LINE_BREAK_RE)
    .map((line) => line.trim())
    .find(Boolean)
}

const tunnelClientExecutable = resolveExecutable("tunnel-client")
if (!tunnelClientExecutable) throw new Error("tunnel-client executable was not found on PATH.")

const apps = [
  {
    name: "openchatx-mcp",
    script: "dist/index.js",
    cwd: __dirname,
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    kill_timeout: 10_000,
  },
  {
    name: "openchatx-tunnel",
    script: tunnelClientExecutable,
    args: [
      "run",
      "--profile",
      openchatxConfig.tunnel.profile,
      "--health.listen-addr",
      `127.0.0.1:${openchatxConfig.tunnel.health_port}`,
    ],
    cwd: __dirname,
    interpreter: "none",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
  },
]

module.exports = {
  apps,
}
