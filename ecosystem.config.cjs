const { execFileSync } = require("node:child_process")
const { join } = require("node:path")
const { loadPublicConfig } = require("./dist/public-config.cjs")
const { ngrokConfigFiles } = require("./scripts/ngrok-config.cjs")

const shellbyConfig = loadPublicConfig(join(__dirname, ".shellby", "config.toml"))

const apps = [
  {
    name: "shellby-mcp",
    script: "dist/index.js",
    cwd: __dirname,
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    kill_timeout: 10_000,
  },
]

if (shellbyConfig.ngrok.enabled) {
  const ngrokExecutable = execFileSync("/usr/bin/which", ["ngrok"], { encoding: "utf8" }).trim()
  const ngrokArgs = ["http", `http://127.0.0.1:${shellbyConfig.port}`]
  for (const path of ngrokConfigFiles(shellbyConfig, __dirname, ngrokExecutable)) ngrokArgs.push("--config", path)
  if (shellbyConfig.ngrok.url) ngrokArgs.push("--url", shellbyConfig.ngrok.url)
  if (shellbyConfig.ngrok.pooling_enabled) ngrokArgs.push("--pooling-enabled")
  ngrokArgs.push("--traffic-policy-file=./ngrok-traffic-policy.yml", "--inspect=false")
  apps.push({
    name: "shellby-ngrok",
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
