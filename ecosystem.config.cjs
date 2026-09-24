const { execFileSync } = require("node:child_process")
const { join } = require("node:path")
const process = require("node:process")
const { loadPublicConfig } = require("./dist/public-config.cjs")
const { ngrokConfigFiles } = require("./scripts/ngrok-config.cjs")

const LINE_BREAK_RE = /\r?\n/u
const openchatxConfig = loadPublicConfig(join(__dirname, ".openchatx", "config.toml"))

function resolveExecutable(name) {
  const locator = process.platform === "win32" ? "where.exe" : "/usr/bin/which"
  return execFileSync(locator, [name], { encoding: "utf8", windowsHide: true })
    .split(LINE_BREAK_RE)
    .map((line) => line.trim())
    .find(Boolean)
}

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
]

if (openchatxConfig.ngrok.enabled) {
  const ngrokExecutable = resolveExecutable("ngrok")
  if (!ngrokExecutable) throw new Error("ngrok executable was not found on PATH.")
  const ngrokArgs = ["http", `http://127.0.0.1:${openchatxConfig.port}`]
  for (const path of ngrokConfigFiles(openchatxConfig, __dirname, ngrokExecutable))
    ngrokArgs.push("--config", path)
  if (openchatxConfig.ngrok.url) ngrokArgs.push("--url", openchatxConfig.ngrok.url)
  if (openchatxConfig.ngrok.pooling_enabled) ngrokArgs.push("--pooling-enabled")
  ngrokArgs.push("--traffic-policy-file=./ngrok-traffic-policy.yml", "--inspect=false")
  apps.push({
    name: "openchatx-ngrok",
    script: ngrokExecutable,
    args: ngrokArgs,
    cwd: __dirname,
    interpreter: "none",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
  })
}

module.exports = {
  apps,
}
