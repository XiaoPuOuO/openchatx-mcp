import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createSubagentStore } from "../src/tools/subagent/subagent-store.js"

test("persists subagent conversation state across store reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-subagents-"))
  const path = join(directory, "subagents.sqlite")
  try {
    const first = createSubagentStore(path)
    assert.ok(first)
    first.set("reviewer", { conversationUrl: "https://chatgpt.com/c/example", turnCount: 4, kind: "subagent" })
    first.close()

    const second = createSubagentStore(path)
    assert.ok(second)
    assert.deepEqual(second.get("reviewer"), { conversationUrl: "https://chatgpt.com/c/example", turnCount: 4, kind: "subagent" })
    second.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
