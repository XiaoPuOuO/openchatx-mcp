import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
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
    ["start_here", "rule_resolve", "rule_manage", "local_test__echo"]
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

test("external MCP registry creates a missing config directory before watching it", async (t) => {
  const root = await tempDir(t, "openchatx-external-missing-config-dir-")
  const configPath = join(root, "safe-mode", "mcp-servers.json")

  const registry = await createExternalMcpRegistry(configPath)
  t.after(() => registry.close())

  assert.equal(registry.toolCount, 0)
  assert.deepEqual(registry.connectedServers, [])
})

test("unavailable loopback MCP retries without crashing the runtime", {
  timeout: 10_000,
}, async (t) => {
  const port = await reservePort()
  const root = await tempDir(t, "openchatx-external-unavailable-retry-")
  const configPath = join(root, "mcp-servers.json")
  await writeFile(
    configPath,
    JSON.stringify({ unavailable: { type: "remote", url: `http://127.0.0.1:${port}/mcp` } })
  )

  const registry = await createExternalMcpRegistry(configPath)
  t.after(() => registry.close())
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  assert.deepEqual(registry.connectedServers, [])
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
  assert.equal(registry.authorization?.().remote?.status, "none")
  assert.equal(registry.authorization?.().remote?.oauthDetected, undefined)

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

test("per-tool disable filters discovery and rejects calls across reloads", {
  timeout: 20_000,
}, async (t) => {
  const invoked: string[] = []
  const upstream = await startMcpHttpServer(
    {
      createMcpServer: () => {
        const server = new McpServer({ name: "multi-tool-fixture", version: "1.0.0" })
        for (const name of ["generate_or_edit_image", "generate_video"]) {
          server.registerTool(name, { inputSchema: z.object({}) }, async () => {
            invoked.push(name)
            return { content: [{ type: "text", text: name }] }
          })
        }
        return server
      },
    },
    { port: 0 }
  )
  t.after(() => upstream.close())

  const root = await tempDir(t, "openchatx-external-tool-toggle-")
  const configPath = join(root, "mcp-servers.json")
  const serverConfig = {
    type: "remote",
    url: upstream.url,
    enabled: true,
    disabledTools: ["generate_or_edit_image"],
  }
  await writeFile(configPath, JSON.stringify({ "mcp-api": serverConfig }))
  const registry = await createExternalMcpRegistry(configPath)
  t.after(() => registry.close())

  assert.deepEqual(
    registry.detectedTools().map(({ name }) => name),
    ["generate_or_edit_image", "generate_video"]
  )
  assert.deepEqual(
    registry.catalog().map(({ originalName }) => originalName),
    ["generate_video"]
  )
  assert.equal(registry.capabilities()[0]?.toolCount, 1)
  await assert.rejects(
    () => registry.call("mcp:mcp-api:generate_or_edit_image", {}),
    /disabled or unavailable/u
  )
  assert.deepEqual(invoked, [])

  const outer = await startMcpHttpServer(
    { createMcpServer: createMcpServerFactory({ externalMcp: registry }, { tools: NO_BUILTINS }) },
    { port: 0 }
  )
  t.after(() => outer.close())
  const client = new Client({ name: "external-tool-toggle-test", version: "1.0.0" })
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(outer.url)))
  const published = (await client.listTools()).tools.map(({ name }) => name)
  assert.ok(published.includes("mcp_api__generate_video"))
  assert.ok(!published.includes("mcp_api__generate_or_edit_image"))
  await client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "external-tool-toggle-test" },
  })

  // Keep a direct MCP session alive across the reload to check cached registrations.
  const persistentServer = new McpServer({ name: "persistent-registry-test", version: "1.0.0" })
  registry.registerTools(persistentServer)
  const persistentClient = new Client({ name: "persistent-registry-client", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    persistentServer.connect(serverTransport),
    persistentClient.connect(clientTransport),
  ])
  t.after(() => Promise.all([persistentClient.close(), persistentServer.close()]))

  await writeFile(
    configPath,
    JSON.stringify({ "mcp-api": { ...serverConfig, disabledTools: ["generate_video"] } })
  )
  await registry.reload()
  assert.deepEqual(
    registry.catalog().map(({ originalName }) => originalName),
    ["generate_or_edit_image"]
  )
  assert.deepEqual(
    registry.detectedTools().map(({ name }) => name),
    ["generate_or_edit_image", "generate_video"]
  )
  await assert.rejects(() => registry.call("mcp:mcp-api:generate_video", {}), /disabled/u)
  await assert.rejects(
    () => client.callTool({ name: "mcp_api__generate_video", arguments: {} }),
    /not found/u
  )
  const result = await persistentClient.callTool({
    name: "mcp_api__generate_video",
    arguments: {},
  })
  assert.equal(result.isError, true)
  assert.deepEqual(invoked, [])
  await registry.call("mcp:mcp-api:generate_or_edit_image", {})
  assert.deepEqual(invoked, ["generate_or_edit_image"])
})

test("forced external MCP reload reconnects unchanged config", { timeout: 10_000 }, async (t) => {
  const port = await reservePort()
  const root = await tempDir(t, "openchatx-external-force-reload-")
  const configPath = join(root, "mcp-servers.json")
  await writeFile(
    configPath,
    JSON.stringify({
      remote: {
        type: "remote",
        url: `http://127.0.0.1:${port}/mcp`,
        enabled: true,
        timeout: 2_000,
      },
    })
  )

  const registry = await createExternalMcpRegistry(configPath)
  t.after(() => registry.close())
  assert.equal(registry.capabilities()[0]?.available, false)

  const upstream = await startMcpHttpServer(
    {
      createMcpServer: () => {
        const server = new McpServer({ name: "force-reload-fixture", version: "1.0.0" })
        server.registerTool("ping", { inputSchema: z.object({}) }, async () => ({
          content: [{ type: "text", text: "pong" }],
        }))
        return server
      },
    },
    { port }
  )
  t.after(() => upstream.close())

  await registry.reload(true)
  assert.equal(registry.capabilities()[0]?.available, true)
  assert.deepEqual(registry.connectedServers, ["remote"])
})

test("remote MCP tools/list changes refresh the catalog without restarting OpenChatX", {
  timeout: 25_000,
}, async (t) => {
  let exposeBeta = false
  const upstream = await startMcpHttpServer(
    {
      createMcpServer: () => {
        const server = new McpServer({ name: "dynamic-tools-fixture", version: "1.0.0" })
        server.registerTool("alpha", { inputSchema: z.object({}) }, async () => ({
          content: [{ type: "text", text: "alpha" }],
        }))
        if (exposeBeta) {
          server.registerTool("beta", { inputSchema: z.object({}) }, async () => ({
            content: [{ type: "text", text: "beta" }],
          }))
        }
        return server
      },
    },
    { port: 0 }
  )
  t.after(() => upstream.close())

  const root = await tempDir(t, "openchatx-dynamic-mcp-tools-")
  const configPath = join(root, "mcp-servers.json")
  await writeFile(
    configPath,
    JSON.stringify({
      dynamic: { type: "remote", url: upstream.url, enabled: true },
    })
  )
  const registry = await createExternalMcpRegistry(configPath)
  t.after(() => registry.close())
  assert.deepEqual(
    registry.catalog().map((x) => x.originalName),
    ["alpha"]
  )

  exposeBeta = true
  for (let i = 0; i < 95; i += 1) {
    if (registry.catalog().some((x) => x.originalName === "beta")) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.deepEqual(
    registry
      .catalog()
      .map((x) => x.originalName)
      .sort((a, b) => a.localeCompare(b)),
    ["alpha", "beta"]
  )
  exposeBeta = false
  for (let i = 0; i < 95; i += 1) {
    if (registry.catalog().every((x) => x.originalName !== "beta")) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.deepEqual(
    registry.catalog().map((x) => x.originalName),
    ["alpha"]
  )
})

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Failed to reserve a TCP port")
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return address.port
}
