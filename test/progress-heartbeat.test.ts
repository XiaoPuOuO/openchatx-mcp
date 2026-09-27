import assert from "node:assert/strict"
import test from "node:test"

import type { AgentIdentity } from "../src/agent/context.js"
import {
  FORCED_PROGRESS_INSTRUCTION,
  ProgressHeartbeatGuard,
} from "../src/mcp/progress-heartbeat.js"

function identity(sessionId: string): AgentIdentity {
  return {
    sessionId,
    agent: `agent-${sessionId}`,
    projectRouting: "unscoped",
  }
}

test("injects the progress instruction on the tool response after every twelve calls", () => {
  const guard = new ProgressHeartbeatGuard()
  const agent = identity("one")

  for (let call = 1; call <= 12; call += 1) {
    assert.equal(guard.record(agent), undefined)
  }

  assert.equal(guard.record(agent), FORCED_PROGRESS_INSTRUCTION)

  for (let call = 14; call <= 25; call += 1) {
    assert.equal(guard.record(agent), undefined)
  }

  assert.equal(guard.record(agent), FORCED_PROGRESS_INSTRUCTION)
})

test("keeps progress call counts isolated by session", () => {
  const guard = new ProgressHeartbeatGuard(2)
  const first = identity("one")
  const second = identity("two")

  assert.equal(guard.record(first), undefined)
  assert.equal(guard.record(first), undefined)
  assert.equal(guard.record(second), undefined)
  assert.equal(guard.record(first), FORCED_PROGRESS_INSTRUCTION)
  assert.equal(guard.record(second), undefined)
  assert.equal(guard.record(second), FORCED_PROGRESS_INSTRUCTION)
})

test("uses the compact hard-coded progress instruction", () => {
  assert.equal(
    FORCED_PROGRESS_INSTRUCTION,
    "Human instruction: Tell me in one sentence what you’ll do next, then continue immediately without waiting for my reply."
  )
})
