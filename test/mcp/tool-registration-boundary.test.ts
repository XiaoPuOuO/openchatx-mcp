import assert from "node:assert/strict"
import test from "node:test"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { installToolRegistrationBoundary } from "../../src/mcp/tool-registration-boundary.js"

for (const structuredOutput of [false, true]) {
  test(`preserves SDK validation and callback conventions with structuredOutput=${structuredOutput}`, async (t) => {
    const server = new McpServer({ name: "boundary-test", version: "1.0.0" })
    const client = new Client({ name: "boundary-test-client", version: "1.0.0" })
    t.after(() => Promise.all([client.close(), server.close()]))
    let inputCalls = 0
    let contextCalls = 0
    let notices = 0
    installToolRegistrationBoundary(server, {
      structuredOutput,
      drainPendingEvents: () => {
        notices += 1
        return ["fixture notice"]
      },
    })

    server.registerTool(
      "with_input",
      {
        inputSchema: z.object({ name: z.string().trim().min(1) }),
        outputSchema: z.object({ name: z.string() }),
      },
      async ({ name }, context) => {
        inputCalls += 1
        assert.notEqual(context.mcpReq.id, undefined)
        return { structuredContent: { name }, content: [] }
      }
    )
    server.registerTool("without_input", {}, async (context) => {
      contextCalls += 1
      assert.notEqual(context.mcpReq.id, undefined)
      return { content: [{ type: "text", text: "context received" }] }
    })
    server.registerTool("throwing", {}, async () => {
      throw new Error("fixture failure")
    })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const listed = await client.listTools()
    assert.deepEqual(
      Object.keys(
        listed.tools.find((tool) => tool.name === "with_input")?.inputSchema.properties ?? {}
      ),
      ["name"]
    )
    assert.deepEqual(
      Object.keys(
        listed.tools.find((tool) => tool.name === "without_input")?.inputSchema.properties ?? {}
      ),
      []
    )

    const loaded = await client.callTool({ name: "with_input", arguments: { name: " value " } })
    assert.notEqual(loaded.isError, true)
    assert.equal(inputCalls, 1)
    if (structuredOutput) assert.deepEqual(loaded.structuredContent, { name: "value" })
    else assert.equal(loaded.structuredContent, undefined)
    assert.match(JSON.stringify(loaded.content), /fixture notice/u)

    const contextResult = await client.callTool({ name: "without_input", arguments: {} })
    assert.notEqual(contextResult.isError, true)
    assert.equal(contextCalls, 1)
    assert.match(JSON.stringify(contextResult.content), /context received/u)

    const invalid = await client.callTool({ name: "with_input", arguments: { name: 42 } })
    assert.equal(invalid.isError, true)
    assert.equal(inputCalls, 1)
    assert.equal(notices, 2)

    const thrown = await client.callTool({ name: "throwing", arguments: {} })
    assert.equal(thrown.isError, true)
    assert.match(JSON.stringify(thrown.content), /fixture failure/u)
    assert.equal(notices, 2)
  })
}
