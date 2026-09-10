import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { getAgentIdentity, runWithAgent } from "../src/server/agent-context.js"
import { createChatGptSubagentService } from "../src/tools/subagent/chatgpt-subagent.js"
import { ChatGptSubagentError } from "../src/tools/subagent/chatgpt-subagent-contracts.js"
import { createSubagentStore } from "../src/tools/subagent/subagent-store.js"

test("limits each main agent to three persisted delegated agents while allowing reuse", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-agent-limit-"))
  const previousHome = process.env.HOME
  process.env.HOME = directory

  const sessionId = "delegated-agent-limit-session"
  const parentAgent = runWithAgent(sessionId, () => getAgentIdentity()!)
  const store = createSubagentStore()
  assert.ok(store)
  store.set(parentAgent, "clone-a", { conversationUrl: "https://chatgpt.com/c/clone-a", turnCount: 1, kind: "clone" })
  store.set(parentAgent, "researcher", { conversationUrl: "https://chatgpt.com/c/researcher", turnCount: 3, kind: "subagent" })
  store.set(parentAgent, "reviewer", { conversationUrl: "https://chatgpt.com/c/reviewer", turnCount: 2, kind: "subagent" })
  store.close()

  const service = createChatGptSubagentService()
  const controller = new AbortController()
  controller.abort()
  const expectedMessage =
    "This main agent already has the maximum 3 delegated agents. Reuse one of these agent IDs: clone-a (latest_turn_id=clone-a_turn_1), researcher (latest_turn_id=researcher_turn_3), reviewer (latest_turn_id=reviewer_turn_2)."

  try {
    await assert.rejects(
      runWithAgent(sessionId, () => service.ask({ agentId: "fourth", prompt: "New work", memory: true }, { signal: controller.signal })),
      (error: unknown) => error instanceof ChatGptSubagentError && error.code === "AGENT_LIMIT_REACHED" && error.message === expectedMessage
    )
    await assert.rejects(
      runWithAgent(sessionId, () =>
        service.cloneSelf(
          { cloneId: "fourth-clone", sourceConversationUrl: "https://chatgpt.com/c/source", prompt: "New clone work" },
          { signal: controller.signal }
        )
      ),
      (error: unknown) => error instanceof ChatGptSubagentError && error.code === "AGENT_LIMIT_REACHED" && error.message === expectedMessage
    )
    await assert.rejects(
      runWithAgent(sessionId, () => service.ask({ agentId: "reviewer", prompt: "Follow up", memory: true }, { signal: controller.signal })),
      (error: unknown) => error instanceof ChatGptSubagentError && error.code === "REQUEST_ABORTED"
    )
  } finally {
    await service.dispose()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(directory, { recursive: true, force: true })
  }
})
