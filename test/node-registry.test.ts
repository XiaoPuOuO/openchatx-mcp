import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { NodeRegistry } from "../src/nodes/node-registry.js"

test("node registry persists nodes, redacts tokens, and probes health", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.statusCode = 200
      res.end("ok")
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  )
  const address = server.address()
  assert.ok(address && typeof address === "object")

  const root = await mkdtemp(join(tmpdir(), "openchatx-nodes-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const statePath = join(root, "nodes.json")
  const registry = new NodeRegistry(statePath)
  await registry.upsert({
    id: "desktop",
    name: "Desktop",
    url: `http://127.0.0.1:${address.port}/mcp`,
    token: "secret",
  })

  const listed = await registry.list()
  assert.equal(listed[0]?.hasToken, true)
  assert.equal("token" in (listed[0] ?? {}), false)
  assert.deepEqual(await registry.probe("desktop"), {
    id: "desktop",
    ok: true,
    status: 200,
  })

  const restored = new NodeRegistry(statePath)
  assert.equal((await restored.list())[0]?.id, "desktop")
})
