const { execFileSync } = require("node:child_process")
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs")
const { homedir } = require("node:os")
const { join, resolve } = require("node:path")
const { load } = require("js-yaml")

// Merge a per-instance API address with ngrok's native config; never copy its credentials.
function ngrokConfigFiles(config, repositoryRoot, executable) {
  const output = execFileSync(executable, ["config", "check"], { encoding: "utf8" })
  const nativePath = output.match(/Valid configuration file at (.+)$/mu)?.[1]?.trim()
  if (!nativePath)
    throw new Error("Could not locate ngrok's configuration. Run `ngrok config check`.")
  const nativeConfig = load(readFileSync(nativePath, "utf8"))
  const version = String(nativeConfig?.version)
  if (!["2", "3"].includes(version))
    throw new Error("Shellby requires ngrok config version 2 or 3.")
  const configured = config.state_dir
  let stateDir
  if (configured === "~") stateDir = homedir()
  else if (configured.startsWith("~/")) stateDir = join(homedir(), configured.slice(2))
  else stateDir = resolve(repositoryRoot, configured)
  const overridePath = join(stateDir, "ngrok-agent.json")
  const address = { web_addr: `127.0.0.1:${config.ngrok.api_port}` }
  const override = version === "3" ? { version, agent: address } : { version, ...address }
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(overridePath, `${JSON.stringify(override, null, 2)}\n`, { mode: 0o600 })
  return [nativePath, overridePath]
}

module.exports = { ngrokConfigFiles }
