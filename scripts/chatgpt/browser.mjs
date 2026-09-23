import { spawn, spawnSync } from "node:child_process"
import { constants } from "node:fs"
import { access, mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { MCP_CONFIG } from "../../src/config.ts"

const setup = process.argv.includes("--setup")
const auto = process.argv.includes("--auto")
const optional = process.argv.includes("--optional")
const endpoint = new URL(MCP_CONFIG.chatGpt.cdpEndpoint)
const profileDir = join(MCP_CONFIG.stateDir, "chatgpt-chrome")
const markerPath = join(profileDir, ".configured")
const mobileUserAgent =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
const mobileWindowSize = "430,900"
const configured = await exists(markerPath)
const cdpReady = await isCdpReady(endpoint)

if (!isLocalEndpoint(endpoint)) {
  console.log(`ChatGPT browser: using configured CDP endpoint ${endpoint.href}`)
  process.exit(0)
}

if (cdpReady && !findManagedChromePid()) {
  fail(
    `CDP endpoint ${endpoint.href} is already in use by another Chrome profile. Give this copy a different chatgpt.cdp_endpoint port or close that browser first.`
  )
}

if (!setup && !configured) {
  let message
  if (cdpReady) message = "ChatGPT browser: existing CDP session detected (not managed by setup)"
  else if (auto)
    message = "ChatGPT browser: not configured (run `npm run setup:chatgpt` to enable subagents)"
  else message = "ChatGPT browser is not configured. Run `npm run setup:chatgpt` first."
  console.log(message)
  process.exit(0)
}

if (cdpReady) {
  if (setup && !configured) {
    fail(
      `${endpoint.host} is already serving a Chrome DevTools session. Close that debug Chrome or configure a different chatgpt.cdp_endpoint before setup.`
    )
  }
  if (auto) hideManagedChrome()
  else showManagedChrome()
  console.log("ChatGPT browser: already running")
  if (setup) console.log("Sign into ChatGPT in that dedicated Chrome window if needed.")
  process.exit(0)
}

const chrome = await findChrome()
if (!chrome) {
  const message = "Google Chrome was not found in /Applications or ~/Applications."
  if (auto || optional) {
    console.warn(`ChatGPT browser: ${message}`)
    process.exit(0)
  }
  console.error(message)
  process.exit(1)
}

await mkdir(profileDir, { recursive: true })
const port = endpoint.port
const child = spawn(
  chrome,
  [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    `--user-agent=${mobileUserAgent}`,
    `--window-size=${mobileWindowSize}`,
    "--force-dark-mode", // Enables dark mode for Chrome UI
    "--enable-features=WebUIDarkMode", // Enables WebUI dark mode flag
    "--disable-extensions",
    "--disable-sync",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-breakpad",
    "--no-first-run",
    "--no-default-browser-check",
    MCP_CONFIG.chatGpt.projectUrl,
  ],
  { detached: true, stdio: "ignore" }
)
child.unref()

if (!(await waitForCdp(endpoint))) {
  const message = `Chrome launched but CDP did not become available at ${endpoint.href}`
  if (auto || optional) {
    console.warn(`ChatGPT browser: ${message}`)
    process.exit(0)
  }
  console.error(message)
  process.exit(1)
}

await writeFile(markerPath, "configured\n", "utf8")
if (auto) hideManagedChrome()
console.log("ChatGPT browser: running")
if (setup) {
  console.log(
    "Sign into ChatGPT in the dedicated Chrome window. Future `npm start` runs will launch this profile automatically."
  )
}

async function findChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    join(homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
  ]

  const available = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        return null
      }
    })
  )
  return available.find((candidate) => candidate !== null)
}

async function waitForCdp(url, attemptsRemaining = 40) {
  if (await isCdpReady(url)) return true
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (attemptsRemaining <= 1) return false
  return waitForCdp(url, attemptsRemaining - 1)
}

async function isCdpReady(url) {
  try {
    const versionUrl = new URL("/json/version", url)
    const response = await fetch(versionUrl, { signal: AbortSignal.timeout(500) })
    if (!response.ok) return false
    const payload = await response.json()
    return typeof payload.webSocketDebuggerUrl === "string"
  } catch {
    return false
  }
}

function isLocalEndpoint(url) {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
}

function hideManagedChrome() {
  const pid = findManagedChromePid()
  if (!pid) return false

  // JXA exposes no-argument Objective-C selectors as properties. Reading
  // `.hide` invokes NSRunningApplication.hide() for this exact Chrome PID.
  const script = `ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).hide`
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
    stdio: "ignore",
    timeout: 1_000,
  })
  return !result.error && result.status === 0
}

function showManagedChrome() {
  const pid = findManagedChromePid()
  if (!pid) return false

  const script = `ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).activateWithOptions($.NSApplicationActivateIgnoringOtherApps)`
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
    stdio: "ignore",
    timeout: 1_000,
  })
  return !result.error && result.status === 0
}

function findManagedChromePid() {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error || result.status !== 0 || !result.stdout) return

  const profileArg = `--user-data-dir=${profileDir}`
  const portArg = `--remote-debugging-port=${endpoint.port}`
  for (const line of result.stdout.split("\n")) {
    const command = `${line} `
    if (
      !command.includes("Google Chrome.app/Contents/MacOS/Google Chrome") ||
      !command.includes(` ${profileArg} `) ||
      !command.includes(` ${portArg} `)
    )
      continue
    const match = line.trim().match(/^(\d+)\s/u)
    if (match) return Number(match[1])
  }
}

function fail(message) {
  if (optional) {
    console.warn(`ChatGPT browser setup skipped: ${message}`)
    process.exit(0)
  }
  console.error(message)
  process.exit(1)
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
