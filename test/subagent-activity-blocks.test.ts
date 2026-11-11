import assert from "node:assert/strict"
import test from "node:test"

import { groupActivity } from "../ui/src/features/subagents/activity-blocks.js"
import type { SubagentSessionEvent } from "../ui/src/types.js"

function item(id: string, role: SubagentSessionEvent["role"], text = ""): SubagentSessionEvent {
  return { id, role, text, time: "2026-11-09T00:00:00.000Z", status: "completed" }
}

test("Subagent actions remain one group across assistant and thinking turns", () => {
  const items = [
    item("request", "user", "Inspect and fix the code"),
    item("thought-1", "thinking", "Planning tools"),
    item("blank", "assistant"),
    item("call-1", "tool", "read"),
    item("progress", "assistant", "I found the file."),
    item("thought-2", "thinking", "Next step"),
    item("call-2", "tool", "patch"),
    item("blank-2", "assistant"),
    item("call-3", "tool", "test"),
    item("answer", "assistant", "All checks passed"),
  ]
  const blocks = groupActivity(items)
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["message", "actions", "message"]
  )
  const group = blocks[1]
  assert.ok(group?.kind === "actions")
  assert.deepEqual(
    group.events.map((event) => event.id),
    items.slice(1, 9).map((event) => event.id)
  )
  assert.equal(group.events.filter((event) => event.role === "tool").length, 3)
  const last = blocks[2]
  assert.ok(last?.kind === "message")
  assert.equal(last.event.text, "All checks passed")
})

test("a new human message starts a separate group without losing event order", () => {
  const blocks = groupActivity([
    item("request", "user"),
    item("tool-1", "tool"),
    item("answer", "assistant", "Done"),
    item("guidance", "guidance", "Now test again"),
    item("tool-2", "tool"),
    item("tool-3", "tool"),
    item("final", "assistant", "Retested"),
  ])
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["message", "actions", "message", "message", "actions", "message"]
  )
  const first = blocks[1]
  const second = blocks[4]
  assert.ok(first?.kind === "actions")
  assert.ok(second?.kind === "actions")
  assert.equal(first.events.length, 1)
  assert.equal(second.events.length, 2)
})

test("sessions with no tools retain their messages and thinking summaries", () => {
  const blocks = groupActivity([
    item("request", "user", "Explain"),
    item("thinking", "thinking", "Summary"),
    item("answer", "assistant", "Explanation"),
  ])
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["message", "message", "message"]
  )
})
