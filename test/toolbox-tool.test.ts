import assert from "node:assert/strict"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import { defineTool, Tool, z } from "../src/toolbox/tool.js"

class EchoTool extends Tool<typeof EchoTool.input> {
  static readonly input = z.object({ text: z.string() })
  readonly name = "echo"
  readonly description = "Echo text"
  readonly inputSchema = EchoTool.input

  execute(input: z.infer<typeof EchoTool.input>) {
    return { content: [{ type: "text" as const, text: input.text }] }
  }
}

test("Tool subclass registers through the common contract", async (t) => {
  const server = new McpServer({ name: "toolbox-test", version: "1.0.0" })
  const client = new Client({ name: "toolbox-test-client", version: "1.0.0" })
  t.after(() => Promise.all([client.close(), server.close()]))

  new EchoTool().register(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const result = await client.callTool({ name: "echo", arguments: { text: "hello" } })
  assert.equal(result.content.find((item) => item.type === "text")?.text, "hello")
})

test("defineTool creates the same runtime contract", async (t) => {
  const server = new McpServer({ name: "toolbox-test", version: "1.0.0" })
  const client = new Client({ name: "toolbox-test-client", version: "1.0.0" })
  t.after(() => Promise.all([client.close(), server.close()]))

  defineTool({
    name: "sum",
    description: "Add two numbers",
    inputSchema: z.object({ left: z.number(), right: z.number() }),
    execute: ({ left, right }) => ({
      content: [{ type: "text", text: String(left + right) }],
    }),
  }).register(server)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const result = await client.callTool({ name: "sum", arguments: { left: 2, right: 3 } })
  assert.equal(result.content.find((item) => item.type === "text")?.text, "5")
})
