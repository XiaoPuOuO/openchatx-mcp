import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import type { ExternalMcpRegistry } from "../src/external-mcp/registry.js"
import { ToolboxRegistry } from "../src/toolbox/registry.js"
import { registerCatalogTools } from "../src/tools/catalog/catalog-tools.js"
import { tempDir } from "./helpers/temp.js"

test("tool_search discovers lazy custom and external tools and tool_call executes them", async (t) => {
  const root = await tempDir(t, "openchatx-catalog-")
  const box = join(root, "demo")
  await mkdir(join(box, "tools"), { recursive: true })
  await mkdir(join(box, "skills"), { recursive: true })
  await writeFile(
    join(box, "toolbox.json"),
    JSON.stringify({ name: "Demo", enabled: true, tools: {}, skills: {} })
  )
  await writeFile(
    join(box, "tools", "hello.ts"),
    `import { z } from "zod"
export default {
  name: "hello",
  description: "Greet a person",
  inputSchema: z.object({ name: z.string() }),
  async execute(input: { name: string }) {
    return { content: [{ type: "text", text: "Hello " + input.name }] }
  }
}
`
  )
  const toolboxes = new ToolboxRegistry(root)
  await toolboxes.reload()
  const external: ExternalMcpRegistry = {
    connectedServers: ["blender", "unreal"],
    toolCount: 2,
    capabilities: () => [
      {
        id: "blender",
        name: "Blender",
        description: "3D modeling",
        available: true,
        toolCount: 1,
      },
      {
        id: "unreal",
        name: "Unreal",
        description: "Game editor",
        available: true,
        toolCount: 1,
      },
    ],
    registerTools() {},
    catalog: () => [
      {
        id: "mcp:blender:get_scene",
        server: "blender",
        name: "blender__get_scene",
        description: "Read Blender scene",
        inputSchema: { type: "object", properties: {} },
      },
      {
        id: "mcp:unreal:get_scene",
        server: "unreal",
        name: "unreal__get_scene",
        description: "Read Unreal scene",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    call: async (id) => ({ content: [{ type: "text", text: `called:${id}` }] }),
    close: async () => {},
  }

  const server = new McpServer({ name: "catalog-test", version: "1.0.0" })
  registerCatalogTools(server, toolboxes, external)
  const client = new Client({ name: "catalog-client", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(() => Promise.all([client.close(), server.close()]))

  const search = await client.callTool({
    name: "tool_search",
    arguments: { query: "hello" },
  })
  const searchText = search.content.find((item) => item.type === "text")?.text ?? ""
  assert.match(searchText, /toolbox:demo:hello/u)

  const blenderSearch = await client.callTool({
    name: "tool_search",
    arguments: { query: "scene", source: "mcp", server: "blender" },
  })
  const blenderSearchText = blenderSearch.content.find((item) => item.type === "text")?.text ?? ""
  assert.match(blenderSearchText, /mcp:blender:get_scene/u)
  assert.doesNotMatch(blenderSearchText, /mcp:unreal:get_scene/u)

  const custom = await client.callTool({
    name: "tool_call",
    arguments: { tool: "toolbox:demo:hello", arguments: { name: "X" } },
  })
  assert.equal(custom.content.find((item) => item.type === "text")?.text, "Hello X")

  const externalCall = await client.callTool({
    name: "tool_call",
    arguments: { tool: "mcp:blender:get_scene", arguments: {} },
  })
  assert.equal(
    externalCall.content.find((item) => item.type === "text")?.text,
    "called:mcp:blender:get_scene"
  )
})
