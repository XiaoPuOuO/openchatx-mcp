import assert from "node:assert/strict"
import test from "node:test"

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client"

import { MCP_CONFIG } from "../../src/config.js"
import { callUntilComplete, connectClient, connectLegacyClient, postWithHost, startMcpHttpServer } from "./helpers.js"

test("publishes the assembled MCP tool surface", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer({ port: 0 })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "tool-surface-client")
  t.after(() => connected.client.close())

  assert.equal(connected.client.getProtocolEra(), "modern")
  assert.equal(connected.client.getNegotiatedProtocolVersion(), "2026-07-28")
  assert.ok(connected.client.getDiscoverResult())

  const tools = await connected.client.listTools()
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    [
      "shell_run",
      "shell_poll",
      "apply_patch",
      "shell_reset",
      "shell_list",
      "shell_close",
      "clone_self",
      "clone_run",
      "clone_result",
      "subagent_run",
      "subagent_result",
      "fetch_url",
      "skill_list",
      "skill_load",
      "image_view",
      "computer_list",
      "computer_observe",
      "computer_inspect",
      "computer_click",
      "computer_type",
      "computer_press",
      "computer_hotkey",
      "computer_scroll",
      "computer_drag",
      "computer_app",
      "computer_window",
    ]
  )

  const shellRun = tools.tools.find((tool) => tool.name === "shell_run")
  const shellPoll = tools.tools.find((tool) => tool.name === "shell_poll")
  const fetchUrl = tools.tools.find((tool) => tool.name === "fetch_url")
  const subagentResult = tools.tools.find((tool) => tool.name === "subagent_result")
  assert.ok(shellRun && shellPoll && fetchUrl && subagentResult)

  const runWait = (shellRun.inputSchema.properties as Record<string, Record<string, unknown>>).wait_ms
  const pollWait = (shellPoll.inputSchema.properties as Record<string, Record<string, unknown>>).wait_ms
  const webProperties = fetchUrl.inputSchema.properties as Record<string, Record<string, unknown>>
  const webTokens = webProperties.max_output_tokens
  const webCompact = webProperties.compact
  const webFormat = webProperties.format
  const subagentWait = (subagentResult.inputSchema.properties as Record<string, Record<string, unknown>>).wait_ms
  assert.equal(runWait?.default, MCP_CONFIG.shell.defaultWaitMs)
  assert.equal(runWait?.maximum, MCP_CONFIG.shell.maxWaitMs)
  assert.equal(pollWait?.default, MCP_CONFIG.shell.defaultPollWaitMs)
  assert.equal(pollWait?.maximum, MCP_CONFIG.shell.maxPollWaitMs)
  assert.equal(webTokens?.default, MCP_CONFIG.web.defaultOutputTokens)
  assert.equal(webTokens?.maximum, MCP_CONFIG.web.maxOutputTokens)
  assert.equal(webCompact?.default, false)
  assert.deepEqual(webFormat?.enum, ["markdown", "html"])
  assert.ok(fetchUrl.outputSchema)
  assert.equal(subagentWait?.default, MCP_CONFIG.chatGpt.defaultPollWaitMs)
  assert.equal(subagentWait?.maximum, MCP_CONFIG.chatGpt.maxPollWaitMs)
})

test("keeps the stateless 2025-era fallback available", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer({ port: 0 })
  t.after(() => running.close())
  const connected = await connectLegacyClient(running.url, "legacy-compatibility-client")
  t.after(() => connected.client.close())

  assert.equal(connected.client.getProtocolEra(), "legacy")
  assert.equal(connected.client.getNegotiatedProtocolVersion(), "2025-11-25")
  assert.ok((await connected.client.listTools()).tools.length > 0)
})

test("supports structured output modes through the public MCP surface", { timeout: 20_000 }, async () => {
  for (const mode of ["always", "optional", "never"] as const) {
    const running = await startMcpHttpServer({ port: 0, toolOutputStructured: mode })
    const connected = await connectClient(running.url, `tool-output-${mode}`)
    try {
      const tools = await connected.client.listTools()
      const shellList = tools.tools.find((tool) => tool.name === "shell_list")
      assert.ok(shellList)
      const properties = shellList.inputSchema.properties as Record<string, Record<string, unknown>>

      if (mode === "always") {
        assert.ok(shellList.outputSchema)
        assert.equal("structured" in properties, false)
      } else {
        assert.equal(shellList.outputSchema, undefined)
        assert.equal("structured" in properties, mode === "optional")
      }

      const result = await connected.client.callTool({ name: "shell_list", arguments: {} })
      assert.equal(Boolean(result.structuredContent), mode === "always")
      if (mode !== "always") assert.ok(result.content.some((item) => item.type === "text"))

      if (mode === "optional") {
        const structured = await connected.client.callTool({ name: "shell_list", arguments: { structured: true } })
        assert.ok(structured.structuredContent)
      }
    } finally {
      await connected.client.close()
      await running.close()
    }
  }
})

test("continues serving an existing client after an HTTP server restart", { timeout: 20_000 }, async (t) => {
  const firstServer = await startMcpHttpServer({ port: 0 })
  const { port, url } = firstServer
  const connection = await connectClient(url, "restart-client")

  let activeServer = firstServer
  t.after(async () => {
    await connection.client.close()
    await activeServer.close()
  })

  assert.equal((await callUntilComplete(connection.client, "before-restart", "printf before")).output, "before")
  await firstServer.close()
  activeServer = await startMcpHttpServer({ port })
  assert.equal((await callUntilComplete(connection.client, "after-restart", "printf after")).output, "after")
})

test("rejects a mismatched HTTP Host", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer({ port: 0 })
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
