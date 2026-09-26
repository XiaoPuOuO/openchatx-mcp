import assert from "node:assert/strict"
import test from "node:test"

import { upsertAgentByActivity } from "../ui/src/hooks/agent-order.js"
import type { Agent } from "../ui/src/types.js"

function agent(id: string, lastSeenAt: number): Agent {
  return {
    id,
    firstSeenAt: lastSeenAt,
    lastSeenAt,
    recent: [],
    instructions: [],
  }
}

test("keeps session card order stable when activity times are close", () => {
  const current = [agent("agent-2", 1_000_000), agent("agent-1", 900_000)]
  const updated = agent("agent-1", 1_010_000)

  assert.deepEqual(
    upsertAgentByActivity(current, updated).map((item) => item.id),
    ["agent-2", "agent-1"]
  )
})

test("promotes a session once the preceding activity is at least three minutes older", () => {
  const current = [agent("agent-2", 1_000_000), agent("agent-1", 900_000)]
  const updated = agent("agent-1", 1_180_000)

  assert.deepEqual(
    upsertAgentByActivity(current, updated).map((item) => item.id),
    ["agent-1", "agent-2"]
  )
})

test("moves an updated session ahead of stale cards without overtaking a close active card", () => {
  const current = [
    agent("agent-2", 1_000_000),
    agent("agent-stale", 700_000),
    agent("agent-1", 690_000),
  ]
  const updated = agent("agent-1", 1_010_000)

  assert.deepEqual(
    upsertAgentByActivity(current, updated).map((item) => item.id),
    ["agent-2", "agent-1", "agent-stale"]
  )
})
