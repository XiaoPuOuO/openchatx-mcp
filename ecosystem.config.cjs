const { execFileSync } = require("node:child_process")

const ngrokExecutable = execFileSync("/usr/bin/which", ["ngrok"], { encoding: "utf8" }).trim()
const ngrokArgs = ["http", "3333", "--traffic-policy-file=./ngrok-traffic-policy.yml", "--inspect=false"]

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
