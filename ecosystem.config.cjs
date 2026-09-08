const { execFileSync } = require("node:child_process")
const { readFileSync } = require("node:fs")
const { join } = require("node:path")
const { parse } = require("smol-toml")

const ngrokExecutable = execFileSync("/usr/bin/which", ["ngrok"], { encoding: "utf8" }).trim()
const shellbyConfig = parse(readFileSync(join(__dirname, ".shellby", "config.toml"), "utf8"))
const ngrokArgs = ["http", "3333"]

if (shellbyConfig.ngrok?.url) ngrokArgs.push("--url", shellbyConfig.ngrok.url)
if (shellbyConfig.ngrok?.pooling_enabled) ngrokArgs.push("--pooling-enabled")
ngrokArgs.push("--traffic-policy-file=./ngrok-traffic-policy.yml", "--inspect=false")

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
  {
    name: "shellby-ngrok",
    script: ngrokExecutable,
    args: ngrokArgs,
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
