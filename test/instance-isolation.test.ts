import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { copyFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import { promisify } from "node:util"

import { OpenChatXAuthStore } from "../src/auth/store.js"
import { MCP_CONFIG } from "../src/config.js"
import { createMcpServerFactory } from "../src/mcp/server-factory.js"
import { startMcpHttpServer } from "../src/server/http-server.js"
import { tempDir } from "./helpers/temp.js"

const run = promisify(execFile)

test("print-url reports the configured tunnel-client profile and local operator URLs", async (t) => {
  const root = await tempDir(t, "openchatx-print-url-")
  await mkdir(join(root, "scripts"), { recursive: true })
  await mkdir(join(root, "src"))
  await writeFile(join(root, "package.json"), '{"type":"module"}\n')
  await copyFile(
    new URL("../scripts/print-url.ts", import.meta.url),
    join(root, "scripts/print-url.ts")
  )
  await writeFile(
    join(root, "src/config.ts"),
    `export const MCP_CONFIG = ${JSON.stringify({
      host: "127.0.0.1",
      port: 3334,
      tunnel: { profile: "secondary", healthPort: 8181 },
    })}`
  )

  const result = await run(
    process.execPath,
    ["--import", "tsx", join(root, "scripts/print-url.ts")],
    { timeout: 10_000 }
  )

  assert.equal(
    result.stdout.trim(),
    [
      "Local MCP target: http://127.0.0.1:3334/mcp",
      "Tunnel profile: secondary",
      "Tunnel UI: http://127.0.0.1:8181/ui",
      "OpenChatX UI: http://127.0.0.1:3334/ui",
    ].join("\n")
  )
})

test("two MCP listeners keep separate health identities and remote owner bindings", async (t) => {
  const root = await tempDir(t, "openchatx-instances-")
  const disabledTools = Object.fromEntries(
    Object.keys(MCP_CONFIG.tools).map((key) => [key, false])
  ) as typeof MCP_CONFIG.tools
  const servers: Array<Awaited<ReturnType<typeof startMcpHttpServer>>> = []

  for (const name of ["first", "second"]) {
    const auth = new OpenChatXAuthStore(join(root, name, "auth.json"))
    await auth.ensureState()
    const server = await startMcpHttpServer(
      {
        createMcpServer: createMcpServerFactory({}, { tools: disabledTools }),
        authStore: auth,
      },
      { port: 0, instanceId: name }
    )
    servers.push(server)
    t.after(() => server.close())

    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`)
    assert.equal(health.headers.get("x-openchatx-instance"), name)
    await health.json()

    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        host: "localhost",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-openai-subject": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "unknown", arguments: {} },
      }),
    })
    await response.text()

    assert.equal(
      (await auth.readState()).subject,
      name,
      "OpenAI subject metadata must bind only this copy"
    )
  }

  const [firstServer, secondServer] = servers
  assert.ok(firstServer)
  assert.ok(secondServer)
  assert.notEqual(firstServer.port, secondServer.port)

  await firstServer.close()
  const health = await fetch(`http://127.0.0.1:${secondServer.port}/healthz`)
  assert.equal(health.headers.get("x-openchatx-instance"), "second")
  assert.deepEqual(await health.json(), { ok: true })
})
