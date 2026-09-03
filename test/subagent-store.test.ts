import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { AgentIdentity } from "../src/server/agent-context.js"
import { createSubagentStore } from "../src/tools/subagent/subagent-store.js"

test("persists subagent conversation state across store reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-subagents-"))
  const path = join(directory, "subagents.sqlite")
  const mainA: AgentIdentity = { sessionId: "main-session-a", agent: "agent-1" }
  const mainB: AgentIdentity = { sessionId: "main-session-b", agent: "agent-2" }
  try {
    const first = createSubagentStore(path)
    assert.ok(first)
    first.set(mainA, "reviewer", { conversationUrl: "https://chatgpt.com/c/example-a", turnCount: 4, kind: "subagent" })
    first.set(mainB, "reviewer", { conversationUrl: "https://chatgpt.com/c/example-b", turnCount: 2, kind: "subagent" })
    first.close()

    const second = createSubagentStore(path)
    assert.ok(second)
    assert.deepEqual(second.get(mainA, "reviewer"), {
      conversationUrl: "https://chatgpt.com/c/example-a",
      turnCount: 4,
      kind: "subagent",
    })
    assert.deepEqual(second.get(mainB, "reviewer"), {
      conversationUrl: "https://chatgpt.com/c/example-b",
      turnCount: 2,
      kind: "subagent",
    })
    second.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
