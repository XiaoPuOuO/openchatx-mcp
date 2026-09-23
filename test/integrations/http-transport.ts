import assert from "node:assert/strict"
import test from "node:test"

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client"
import {
  callUntilComplete,
  connectClient,
  connectLegacyClient,
  postWithHost,
  startMcpHttpServer,
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

  assert.equal(
    (await callUntilComplete(connection.client, "before-restart", "printf before")).output,
    "before"
  )
  await firstServer.close()
  activeServer = await startMcpHttpServer({ port })
  assert.equal(
    (await callUntilComplete(connection.client, "after-restart", "printf after")).output,
    "after"
  )
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
