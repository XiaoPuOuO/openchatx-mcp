import assert from "node:assert/strict"
import test from "node:test"
import { fetchMockAgents, setMockUnlimitedContext } from "../ui/src/lib/mock-api.js"

test("mock dashboard toggles unlimited context for one agent", async () => {
  await setMockUnlimitedContext("agent-1", true)
  const agents = await fetchMockAgents()
  assert.equal(agents.find((agent) => agent.id === "agent-1")?.contextBudget?.unlimited, true)
  assert.notEqual(agents.find((agent) => agent.id === "agent-2")?.contextBudget?.unlimited, true)
  await setMockUnlimitedContext("agent-1", false)
  assert.notEqual((await fetchMockAgents())[0]?.contextBudget?.unlimited, true)
})
