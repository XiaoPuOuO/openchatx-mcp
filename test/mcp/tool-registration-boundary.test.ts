import assert from "node:assert/strict"
import test from "node:test"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { runWithAgent, setAgentTaskSlug } from "../../src/agent/context.js"
import { createAgentObserver } from "../../src/agent/observer.js"
import { installToolRegistrationBoundary } from "../../src/mcp/tool-registration-boundary.js"

for (const structuredOutput of [false, true]) {
  test(`preserves SDK validation and callback conventions with structuredOutput=${structuredOutput}`, async (t) => {
    const server = new McpServer({ name: "boundary-test", version: "1.0.0" })
    const client = new Client({ name: "boundary-test-client", version: "1.0.0" })
    t.after(() => Promise.all([client.close(), server.close()]))
    let inputCalls = 0
    let contextCalls = 0
    installToolRegistrationBoundary(server, {
      structuredOutput,
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

    const contextResult = await client.callTool({ name: "without_input", arguments: {} })
    assert.notEqual(contextResult.isError, true)
    assert.equal(contextCalls, 1)
    assert.match(JSON.stringify(contextResult.content), /context received/u)

    const invalid = await client.callTool({ name: "with_input", arguments: { name: 42 } })
    assert.equal(invalid.isError, true)
    assert.equal(inputCalls, 1)

    const thrown = await client.callTool({ name: "throwing", arguments: {} })
    assert.equal(thrown.isError, true)
    assert.match(JSON.stringify(thrown.content), /fixture failure/u)
  })
}

test("forced stop returns immediately with queued human instructions", async (t) => {
  const server = new McpServer({ name: "forced-stop-test", version: "1.0.0" })
  const client = new Client({ name: "forced-stop-client", version: "1.0.0" })
  const observer = createAgentObserver()
  t.after(() => Promise.all([client.close(), server.close()]))

  installToolRegistrationBoundary(server, {
    structuredOutput: false,
    agentObserver: observer,
  })
  server.registerTool("blocking", {}, (context) => {
    return new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(context.mcpReq.signal.reason)
      if (context.mcpReq.signal.aborted) onAbort()
      else context.mcpReq.signal.addEventListener("abort", onAbort, { once: true })
    })
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const resultPromise = runWithAgent("forced-stop-session", () => {
    setAgentTaskSlug("forced-stop-test")
    return client.callTool({ name: "blocking", arguments: {} })
  })

  await waitFor(() => observer.listAgents()[0]?.current?.status === "running")
  const agent = observer.listAgents()[0]
  assert.ok(agent?.current)
  assert.ok(observer.queueInstruction(agent.id, "先說明目前做到哪裡，再繼續"))
  assert.equal(observer.stopTool(agent.id, agent.current.id), true)

  const result = await resultPromise
  assert.notEqual(result.isError, true)
  const content = JSON.stringify(result.content)
  assert.match(content, /interrupted by user/u)
  assert.match(content, /Human instruction: 先說明目前做到哪裡，再繼續/u)
  assert.equal(observer.listAgents()[0]?.recent[0]?.status, "interrupted")
})

test("forced stop finishes an uncooperative tool after the interrupt grace period", async (t) => {
  const server = new McpServer({ name: "uncooperative-stop-test", version: "1.0.0" })
  const client = new Client({ name: "uncooperative-stop-client", version: "1.0.0" })
  const observer = createAgentObserver()
  t.after(() => Promise.all([client.close(), server.close()]))

  installToolRegistrationBoundary(server, {
    structuredOutput: false,
    agentObserver: observer,
  })
  server.registerTool("ignores_abort", {}, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    return { content: [{ type: "text", text: "too late" }] }
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const startedAt = Date.now()
  const resultPromise = runWithAgent("uncooperative-stop-session", () => {
    setAgentTaskSlug("uncooperative-stop-test")
    return client.callTool({ name: "ignores_abort", arguments: {} })
  })

  await waitFor(() => observer.listAgents()[0]?.current?.status === "running")
  const agent = observer.listAgents()[0]
  assert.ok(agent?.current)
  assert.equal(observer.stopTool(agent.id, agent.current.id), true)

  const result = await resultPromise
  assert.ok(Date.now() - startedAt < 2_000)
  assert.notEqual(result.isError, true)
  assert.match(JSON.stringify(result.content), /interrupted by user/u)
  assert.doesNotMatch(JSON.stringify(result.content), /too late/u)
  assert.equal(observer.listAgents()[0]?.recent[0]?.status, "interrupted")
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for test condition.")
}
