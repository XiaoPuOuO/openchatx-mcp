import assert from "node:assert/strict"
import test from "node:test"

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"

import { createAgentObserver } from "../src/agent/observer.js"
import { ContextBudgetGuard } from "../src/mcp/context-budget.js"
import { createMcpServerFactory } from "../src/mcp/server-factory.js"
import { startMcpHttpServer } from "../src/server/http-server.js"

test("Dot surface never injects Chat context warnings or progress heartbeat instructions", async (t) => {
  const contextBudget = new ContextBudgetGuard(1, (value) => value.length)
  const agentObserver = createAgentObserver()
  const running = await startMcpHttpServer(
    {
      createMcpServer: createMcpServerFactory({
        persona: "dot",
        contextBudget,
      }),
      agentObserver,
      persona: "dot",
      contextBudget,
    },
    { port: 0 }
  )
  t.after(() => running.close())

  const client = new Client({ name: "dot-surface-test", version: "1.0.0" })
  t.after(() => client.close())
  await client.connect(
    new StreamableHTTPClientTransport(new URL(running.url), {
      requestInit: { headers: { "x-openai-session": "dot-surface-test" } },
    })
  )

  for (let call = 0; call < 15; call += 1) {
    const result = await client.callTool({
      name: "start_here",
      arguments: { task_id: `dot-test-${call}` },
    })
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n")

    assert.doesNotMatch(text, /Context budget warning/u)
    assert.doesNotMatch(text, /Context budget checkpoint/u)
    assert.doesNotMatch(text, /Human instruction: Tell me in one sentence/u)
  }

  assert.ok(
    (contextBudget.usage({
      sessionId: "dot-surface-test",
      agent: "agent-test",
    })?.tokens ?? 0) > 0
  )
  assert.equal(agentObserver.listAgents().length, 1)
  assert.equal(agentObserver.listAgents()[0]?.dot, true)
  assert.ok((agentObserver.listAgents()[0]?.contextBudget?.tokens ?? 0) > 0)
})
