import assert from "node:assert/strict"
import test from "node:test"

import { getAgentIdentity, runWithAgent, setAgentTaskSlug } from "../src/server/agent-context.js"

test("keeps one process-wide identity per OpenAI session and adds task context", () => {
  const first = runWithAgent("agent-context-a", () => getAgentIdentity()!)
  const same = runWithAgent("agent-context-a", () => getAgentIdentity()!)
  const second = runWithAgent("agent-context-b", () => getAgentIdentity()!)

  assert.equal(same, first)
  assert.equal(same.agent, first.agent)
  assert.equal(Number(second.agent.slice("agent-".length)), Number(first.agent.slice("agent-".length)) + 1)

  runWithAgent("agent-context-a", () => setAgentTaskSlug("identity-context-test"))
  const updated = runWithAgent("agent-context-a", () => getAgentIdentity()!)
  assert.equal(updated.taskSlug, "identity-context-test")
  assert.equal(getAgentIdentity(), undefined)
})
