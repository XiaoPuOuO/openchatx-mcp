import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import { registerMcpServerManagementTools } from "../src/tools/mcp-server-management/mcp-server-management-tools.js"
import { tempDir } from "./helpers/temp.js"

test("agent can create, update, disable, list, and delete MCP servers", async (t) => {
  const root = await tempDir(t, "openchatx-mcp-manage-")
  const configPath = join(root, "mcp-servers.json")
  const server = new McpServer({ name: "mcp-manage-test", version: "1.0.0" })
  const client = new Client({ name: "mcp-manage-client", version: "1.0.0" })
  registerMcpServerManagementTools(server, configPath)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(() => Promise.all([client.close(), server.close()]))

  const created = await client.callTool({
    name: "mcp_server_manage",
    arguments: {
      action: "create",
      server_id: "example",
      type: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer secret" },
      description: "Example MCP",
    },
  })
  assert.equal(created.isError, undefined)
  assert.equal((created.structuredContent as { restart_required: boolean }).restart_required, true)

  const listed = await client.callTool({ name: "mcp_server_list", arguments: {} })
  const listedServer = (
    listed.structuredContent as {
      servers: Record<string, { headers?: Record<string, string>; description?: string }>
    }
  ).servers.example
  assert.equal(listedServer?.headers?.Authorization, "<redacted>")
  assert.equal(listedServer?.description, "Example MCP")

  await client.callTool({
    name: "mcp_server_manage",
    arguments: {
      action: "update",
      server_id: "example",
      description: "Updated MCP",
      timeout: 5000,
    },
  })
  await client.callTool({
    name: "mcp_server_manage",
    arguments: { action: "disable", server_id: "example" },
  })

  const saved = JSON.parse(await readFile(configPath, "utf8")) as {
    example: {
      description: string
      timeout: number
      enabled: boolean
      headers: Record<string, string>
    }
  }
  assert.equal(saved.example.description, "Updated MCP")
  assert.equal(saved.example.timeout, 5000)
  assert.equal(saved.example.enabled, false)
  assert.equal(saved.example.headers.Authorization, "Bearer secret")

  await client.callTool({
    name: "mcp_server_manage",
    arguments: { action: "delete", server_id: "example" },
  })
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {})
})
