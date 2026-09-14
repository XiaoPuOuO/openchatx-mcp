import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { ShellbyAuthStore } from "../src/auth/auth.js"
import { MCP_CONFIG } from "../src/config.js"
import { startMcpHttpServer } from "../src/server/http-server.js"
import { tempDir } from "./helpers/temp.js"

const run = promisify(execFile)
const { ngrokConfigFiles } = createRequire(import.meta.url)("../scripts/ngrok-config.cjs") as {
  ngrokConfigFiles(config: { state_dir: string; ngrok: { api_port: number } }, root: string, executable: string): string[]
}

for (const version of ["2", "3"]) {
  test(`ngrok v${version} keeps credentials in native config and isolates API addresses`, async (t) => {
    const root = await tempDir(t, "shellby-ngrok-")
    const nativePath = join(root, "native config.yml")
    const nativeSource = `version: "${version}"\n${version === "3" ? "agent:\n  " : ""}authtoken: test-secret\n`
    await writeFile(nativePath, nativeSource)
    const executable = join(root, "ngrok")
    await writeFile(executable, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(`Valid configuration file at ${nativePath}`)})\n`, { mode: 0o755 })
    for (const [name, port] of [
      ["first", 4040],
      ["second", 4041],
    ] as const) {
      const files = ngrokConfigFiles({ state_dir: name, ngrok: { api_port: port } }, root, executable)
      assert.deepEqual(files, [nativePath, join(root, name, "ngrok-agent.json")])
      const overlay = await readFile(files[1]!, "utf8")
      const address = { web_addr: `127.0.0.1:${port}` }
      assert.deepEqual(JSON.parse(overlay), version === "3" ? { version, agent: address } : { version, ...address })
      assert.ok(!overlay.includes("test-secret"))
    }
    assert.equal(await readFile(nativePath, "utf8"), nativeSource)
  })
}

test("print-url uses this copy's ngrok API and filters other upstreams and domains", async (t) => {
  const root = await tempDir(t, "shellby-print-url-")
  let requests = 0
  const api = createServer((_req, res) => {
    requests++
    res.setHeader("content-type", "application/json")
    res.end(
      JSON.stringify({
        tunnels: [
          { proto: "https", public_url: "https://second.ngrok.app", config: { addr: "http://127.0.0.1:3333" } },
          { proto: "https", public_url: "https://wrong.ngrok.app", config: { addr: "http://127.0.0.1:3334" } },
          { proto: "https", public_url: "https://second.ngrok.app", config: { addr: "http://127.0.0.1:3334" } },
        ],
      })
    )
  })
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve, reject) => api.close((error) => (error ? reject(error) : resolve()))))
  const address = api.address()
  assert.ok(address && typeof address !== "string")
  await mkdir(join(root, "scripts"))
  await mkdir(join(root, "src"))
  await copyFile(new URL("../scripts/print-url.mjs", import.meta.url), join(root, "scripts/print-url.mjs"))
  await writeFile(
    join(root, "src/config.ts"),
    `export const MCP_CONFIG = ${JSON.stringify({ port: 3334, ngrok: { enabled: true, apiPort: address.port, url: "https://second.ngrok.app" } })}`
  )
  const result = await run(process.execPath, ["--import", "tsx", join(root, "scripts/print-url.mjs"), "--optional"], { timeout: 10_000 })
  assert.equal(result.stdout.trim(), "MCP URL: https://second.ngrok.app/mcp")
  assert.equal(requests, 1)
})

test("print-url reports the configured local address without contacting ngrok when disabled", async (t) => {
  const root = await tempDir(t, "shellby-local-url-")
  await mkdir(join(root, "scripts"))
  await mkdir(join(root, "src"))
  await copyFile(new URL("../scripts/print-url.mjs", import.meta.url), join(root, "scripts/print-url.mjs"))
  await writeFile(join(root, "src/config.ts"), 'export const MCP_CONFIG = { host: "127.0.0.1", port: 3334, ngrok: { enabled: false } }')
  const result = await run(
    process.execPath,
    ["--import", "tsx", "--import", "data:text/javascript,globalThis.fetch=()=>{process.exit(9)}", join(root, "scripts/print-url.mjs")],
    { timeout: 10_000 }
  )
  assert.equal(result.stdout.trim(), "MCP URL: http://127.0.0.1:3334/mcp (local only)")
})

test("two MCP listeners keep separate health identities and remote owner bindings", async (t) => {
  const root = await tempDir(t, "shellby-instances-")
  const previous = { port: MCP_CONFIG.port, instanceId: MCP_CONFIG.instanceId, tools: MCP_CONFIG.tools }
  t.after(() => Object.assign(MCP_CONFIG, previous))
  MCP_CONFIG.tools = Object.fromEntries(Object.keys(previous.tools).map((key) => [key, false])) as typeof previous.tools
  MCP_CONFIG.port = 0
  const servers = []
  for (const name of ["first", "second"]) {
    MCP_CONFIG.instanceId = name
    const auth = new ShellbyAuthStore(join(root, name, "auth.json"))
    await auth.ensureState()
    const server = await startMcpHttpServer({ authStore: auth })
    servers.push(server)
    t.after(() => server.close())
    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`)
    assert.equal(health.headers.get("x-shellby-instance"), name)
    await health.json()
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        host: "localhost",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-shellby-remote": "1",
        "x-openai-subject": name,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "unknown", arguments: {} } }),
    })
    await response.text()
    assert.equal((await auth.readState()).subject, name, "Host rewrite must pass the guard and bind only this copy")
  }
  assert.notEqual(servers[0]!.port, servers[1]!.port)
  await servers[0]!.close()
  const health = await fetch(`http://127.0.0.1:${servers[1]!.port}/healthz`)
  assert.equal(health.headers.get("x-shellby-instance"), "second")
  assert.deepEqual(await health.json(), { ok: true })
})

test("browser setup refuses a CDP endpoint belonging to another profile", async (t) => {
  const root = await tempDir(t, "shellby-browser-isolation-")
  const api = createServer((_req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/test" }))
  })
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve, reject) => api.close((error) => (error ? reject(error) : resolve()))))
  const address = api.address()
  assert.ok(address && typeof address !== "string")
  await mkdir(join(root, "scripts"))
  await mkdir(join(root, "src"))
  await copyFile(new URL("../scripts/chatgpt-browser.mjs", import.meta.url), join(root, "scripts/chatgpt-browser.mjs"))
  await writeFile(
    join(root, "src/config.ts"),
    `export const MCP_CONFIG = ${JSON.stringify({ stateDir: root, chatGpt: { cdpEndpoint: `http://127.0.0.1:${address.port}` } })}`
  )
  await assert.rejects(
    run(process.execPath, ["--import", "tsx", join(root, "scripts/chatgpt-browser.mjs"), "--setup"], { timeout: 10_000 }),
    (error: unknown) => {
      assert.equal((error as { code: number }).code, 1)
      assert.match((error as { stderr: string }).stderr, /already in use by another Chrome profile/)
      return true
    }
  )
})
