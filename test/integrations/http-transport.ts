import assert from "node:assert/strict"
import test from "node:test"

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client"
import {
  compactField,
  connectClient,
  connectLegacyClient,
  postWithHost,
  startMcpHttpServer,
  toolText,
} from "./helpers.js"

test("keeps the stateless 2025-era fallback available", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectLegacyClient(running.url, "legacy-compatibility-client")
  t.after(() => connected.client.close())

  assert.equal(connected.client.getProtocolEra(), "legacy")
  assert.equal(connected.client.getNegotiatedProtocolVersion(), "2025-11-25")
  assert.ok((await connected.client.listTools()).tools.length > 0)
})

test("continues serving an existing client after an HTTP server restart", {
  timeout: 20_000,
}, async (t) => {
  const firstServer = await startMcpHttpServer()
  const { port, url } = firstServer
  const connection = await connectClient(url, "restart-client")

  let activeServer = firstServer
  t.after(async () => {
    await connection.client.close()
    await activeServer.close()
  })

  const before = await connection.client.callTool({
    name: "bash",
    arguments: { command: "printf before" },
  })
  assert.equal(compactField(toolText(before), "output"), "before")
  await firstServer.close()
  activeServer = await startMcpHttpServer({ port })
  let after: Awaited<ReturnType<typeof connection.client.callTool>> | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      after = await connection.client.callTool({
        name: "bash",
        arguments: { command: "printf after" },
      })
      break
    } catch (error) {
      if (attempt > 0) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  assert.ok(after)
  assert.equal(compactField(toolText(after), "output"), "after")
})

test("rejects a mismatched HTTP Host", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())

  const status = await postWithHost(running.url, "attacker.example", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "host-validation-test", version: "1.0.0" },
    },
  })

  assert.equal(status, 403)
})
