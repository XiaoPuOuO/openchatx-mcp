import assert from "node:assert/strict"
import test from "node:test"

import {
  getAgentIdentity,
  initializeAgentProjectRouting,
  recordAgentSkillSearch,
  runWithAgent,
  setAgentProjectId,
  setAgentProjectRoutingPending,
  setAgentSkillSelection,
  setAgentTaskSlug,
} from "../../src/agent/context.js"

test("keeps one process-wide identity per OpenAI session and adds task context", () => {
  const first = runWithAgent("agent-context-a", () => getAgentIdentity()!)
  const same = runWithAgent("agent-context-a", () => getAgentIdentity()!)
  const second = runWithAgent("agent-context-b", () => getAgentIdentity()!)

  assert.equal(same, first)
  assert.equal(same.agent, first.agent)
  assert.equal(
    Number(second.agent.slice("agent-".length)),
    Number(first.agent.slice("agent-".length)) + 1
  )

  runWithAgent("agent-context-a", () => {
    setAgentTaskSlug("identity-context-test")
    setAgentProjectId("openchatx")
  })
  const updated = runWithAgent("agent-context-a", () => getAgentIdentity()!)
  assert.equal(updated.taskSlug, "identity-context-test")
  assert.equal(updated.projectId, "openchatx")
  runWithAgent("agent-context-a", () => setAgentProjectId(undefined))
  assert.equal(
    runWithAgent("agent-context-a", () => getAgentIdentity()?.projectId),
    undefined
  )
  assert.equal(getAgentIdentity(), undefined)
})

test("tracks whether Project routing is pending, project-scoped, or explicitly unscoped", () => {
  runWithAgent("agent-project-routing", () => {
    initializeAgentProjectRouting(false)
    assert.equal(getAgentIdentity()?.projectRouting, "pending")

    setAgentProjectId("openchatx")
    assert.equal(getAgentIdentity()?.projectRouting, "project")
    assert.equal(getAgentIdentity()?.projectId, "openchatx")

    setAgentProjectRoutingPending()
    assert.equal(getAgentIdentity()?.projectRouting, "pending")
    assert.equal(getAgentIdentity()?.projectId, undefined)

    setAgentProjectId(undefined)
    assert.equal(getAgentIdentity()?.projectRouting, "unscoped")
  })
})

test("requires a fresh Skill decision for each task and preserves it within the task", () => {
  runWithAgent("agent-skill-routing", () => {
    setAgentTaskSlug("task-one")
    assert.equal(getAgentIdentity()?.skillRouting, "pending")

    recordAgentSkillSearch(["coding.review"])
    assert.equal(getAgentIdentity()?.skillRouting, "searched")
    assert.deepEqual(getAgentIdentity()?.skillSearchResults, ["coding.review"])

    setAgentSkillSelection("coding.review")
    assert.equal(getAgentIdentity()?.skillRouting, "selected")
    setAgentTaskSlug("task-one")
    assert.equal(getAgentIdentity()?.skillRouting, "selected")
    setAgentTaskSlug("task-two")
    assert.equal(getAgentIdentity()?.skillRouting, "pending")
    assert.deepEqual(getAgentIdentity()?.skillSearchResults, [])

    recordAgentSkillSearch([])
    setAgentSkillSelection(null)
    assert.equal(getAgentIdentity()?.skillRouting, "skipped")
  })
})
