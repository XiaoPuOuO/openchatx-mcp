import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import { ToolboxRegistry } from "../src/toolbox/registry.js"
import { registerToolboxManagementTools } from "../src/tools/toolbox-management/toolbox-management-tools.js"
import { tempDir } from "./helpers/temp.js"

test("agent can create, inspect, enable, and delete a custom toolbox and tool", async (t) => {
  const root = await tempDir(t, "openchatx-toolbox-manage-")
  const registry = new ToolboxRegistry(root)
  await registry.reload()

  const server = new McpServer({ name: "toolbox-manage-test", version: "1.0.0" })
  const client = new Client({ name: "toolbox-manage-client", version: "1.0.0" })
  registerToolboxManagementTools(server, registry)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(() => Promise.all([client.close(), server.close()]))

  const created = await client.callTool({
    name: "toolbox_manage",
    arguments: { action: "create", kind: "toolbox", toolbox_id: "demo-plugin" },
  })
  assert.equal(created.isError, undefined)
  const createdToolbox = registry.snapshots().find((box) => box.id === "demo-plugin")
  assert.ok(createdToolbox)
  assert.equal(createdToolbox.enabled, false)

  const tool = await client.callTool({
    name: "toolbox_manage",
    arguments: { action: "create", kind: "tool", toolbox_id: "demo-plugin", name: "hello" },
  })
  assert.equal(tool.isError, undefined)
  const sourcePath = (tool.structuredContent as { path: string }).path
  assert.match(await readFile(sourcePath, "utf8"), /defineTool/u)

  await client.callTool({
    name: "toolbox_manage",
    arguments: { action: "enable", kind: "toolbox", toolbox_id: "demo-plugin" },
  })
  assert.equal(registry.isToolboxEnabled("demo-plugin"), true)

  const listed = await client.callTool({ name: "toolbox_list", arguments: {} })
  const toolboxes = (listed.structuredContent as { toolboxes: Array<{ id: string }> }).toolboxes
  assert.ok(toolboxes.some((box) => box.id === "demo-plugin"))

  await client.callTool({
    name: "toolbox_manage",
    arguments: { action: "delete", kind: "toolbox", toolbox_id: "demo-plugin" },
  })
  assert.equal(
    registry.snapshots().some((box) => box.id === "demo-plugin"),
    false
  )
})
