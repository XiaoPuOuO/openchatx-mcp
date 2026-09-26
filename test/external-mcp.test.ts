import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { createExternalMcpRegistry } from "../src/external-mcp/registry.js"
import { createMcpServerFactory } from "../src/mcp/server-factory.js"
import { startMcpHttpServer } from "../src/server/http-server.js"
import { tempDir } from "./helpers/temp.js"

const NO_BUILTINS = {
  shell: false,
  applyPatch: false,
  fileRead: false,
  fileWrite: false,
  web: false,
  skills: false,
  image: false,
} as const

test("aggregates a local stdio MCP and forwards tool calls", { timeout: 10_000 }, async (t) => {
  const root = await tempDir(t, "shellby-external-stdio-")
  const configPath = join(root, "mcp-servers.json")
  const fixturePath = new URL("../fixtures/external-mcp-stdio.mjs", import.meta.url).pathname
  await writeFile(
    configPath,
    JSON.stringify({
      "local-test": {
        type: "local",
        command: [process.execPath, fixturePath],
        enabled: true,
        description: "Local fixture",
      },
    })
  )

  const registry = await createExternalMcpRegistry(configPath)
  t.after(() => registry.close())
  assert.deepEqual(registry.connectedServers, ["local-test"])
  assert.equal(registry.toolCount, 1)

  const running = await startMcpHttpServer(
    {
      createMcpServer: createMcpServerFactory({ externalMcp: registry }, { tools: NO_BUILTINS }),
    },
    { port: 0 }
  )
  t.after(() => running.close())
  const client = new Client({ name: "external-stdio-test", version: "1.0.0" })
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(running.url)))

  const tools = await client.listTools()
  assert.deepEqual(
    tools.tools.map(({ name }) => name),
    [
      "start_here",
      "rule_resolve",
      "rule_manage",
      "local_test__echo",
    ]
  )
  await client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "external-stdio-test" },
  })
  const result = await client.callTool({
    name: "local_test__echo",
    arguments: { value: "hello" },
  })
  assert.equal(result.content.find((item) => item.type === "text")?.text, "stdio:hello")
  assert.deepEqual(result.structuredContent, { value: "hello", transport: "stdio" })
})

test("external MCP registry hot-reloads direct config file edits", {
  timeout: 10_000,
}, async (t) => {
  const root = await tempDir(t, "openchatx-external-watch-")
  const configPath = join(root, "mcp-servers.json")
  const fixturePath = new URL("../fixtures/external-mcp-stdio.mjs", import.meta.url).pathname
  await writeFile(configPath, "{}")

  const registry = await createExternalMcpRegistry(configPath)
  t.after(() => registry.close())
  assert.equal(registry.toolCount, 0)

  await writeFile(
    configPath,
    JSON.stringify({
      watched: {
        type: "local",
        command: [process.execPath, fixturePath],
        enabled: true,
        description: "Watched fixture",
      },
    })
  )

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (registry.connectedServers.includes("watched") && registry.catalog().length === 1) {
      assert.equal(registry.catalog()[0]?.id, "mcp:watched:echo")
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail("external MCP config watcher did not reconnect the edited server")
})

test("aggregates a remote HTTP MCP and tolerates unavailable peers", {
  timeout: 10_000,
}, async (t) => {
  const upstream = await startMcpHttpServer(
    {
      createMcpServer: () => {
        const server = new McpServer({ name: "external-http-fixture", version: "1.0.0" })
        server.registerTool(
          "ping",
          { inputSchema: z.object({ value: z.string() }) },
          async ({ value }) => ({ content: [{ type: "text", text: `http:${value}` }] })
        )
        return server
      },
    },
    { port: 0 }
  )
  t.after(() => upstream.close())

  const root = await tempDir(t, "shellby-external-http-")
  const configPath = join(root, "mcp-servers.json")
  await writeFile(
    configPath,
    JSON.stringify({
      remote: { type: "remote", url: upstream.url, enabled: true, timeout: 5_000 },
      unavailable: { type: "remote", url: "http://127.0.0.1:1/mcp", enabled: true },
      disabled: { type: "remote", url: "http://127.0.0.1:2/mcp", enabled: false },
    })
  )

  const registry = await createExternalMcpRegistry(configPath)
  t.after(() => registry.close())
  assert.deepEqual(registry.connectedServers, ["remote"])
  assert.equal(registry.toolCount, 1)

  const outer = await startMcpHttpServer(
    {
      createMcpServer: createMcpServerFactory({ externalMcp: registry }, { tools: NO_BUILTINS }),
    },
    { port: 0 }
  )
  t.after(() => outer.close())
  const client = new Client({ name: "external-http-test", version: "1.0.0" })
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(outer.url)))
  await client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "external-http-test" },
  })
  const result = await client.callTool({ name: "remote__ping", arguments: { value: "ok" } })
  assert.equal(result.content.find((item) => item.type === "text")?.text, "http:ok")
})
