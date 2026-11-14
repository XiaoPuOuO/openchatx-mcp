import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import express from "express"

import { createDashboardRouter } from "../../src/agent/dashboard-routes.js"
import { createAgentObserver } from "../../src/agent/observer.js"

test("deleting an Agent is idempotent after retention has already evicted it", async (t) => {
  const observer = createAgentObserver()
  const app = express()
  app.use("/ui", createDashboardRouter(observer))
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  )
  const address = server.address()
  assert.ok(address && typeof address === "object")

  observer.setSessionRetention(1)
  observer.updateContextBudget(
    { sessionId: "session-old", agent: "agent-old" },
    { tokens: 0, inputTokens: 0, outputTokens: 0, threshold: 1 }
  )
  observer.updateContextBudget(
    { sessionId: "session-current", agent: "agent-current" },
    { tokens: 0, inputTokens: 0, outputTokens: 0, threshold: 1 }
  )
  assert.deepEqual(
    observer.listAgents().map((agent) => agent.id),
    ["agent-current"]
  )

  // Retention already removed the stale card's Agent; deleting it is still successful.
  const stale = await fetch(`http://127.0.0.1:${address.port}/ui/api/agents/agent-old`, {
    method: "DELETE",
  })
  assert.equal(stale.status, 204)

  const current = await fetch(`http://127.0.0.1:${address.port}/ui/api/agents/agent-current`, {
    method: "DELETE",
  })
  assert.equal(current.status, 204)
  assert.deepEqual(observer.listAgents(), [])
})
