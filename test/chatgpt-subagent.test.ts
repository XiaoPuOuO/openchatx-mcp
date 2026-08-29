import assert from "node:assert/strict"
import test from "node:test"

import { MCP_CONFIG } from "../src/config.js"
import { appendFirstTurnMode, conversationUrlForStart } from "../src/tools/subagent/chatgpt-subagent.js"

test("first-turn oververbosity injection preserves the prompt contract", () => {
  const injected =
    "Respond terse like smart caveman — drop articles, filler, pleasantries. Fragments OK. Technical terms exact. Code unchanged. Pattern: [thing] [action] [reason]. [next step].\n\nNot use `subagent` or `computer_*` tools."

  assert.equal(appendFirstTurnMode("prompt", 1), `prompt\n\n---\n\nSwitch to caveman ultra mode. ${injected}`)
  assert.equal(appendFirstTurnMode("prompt", 2), `prompt\n\n---\n\nSwitch to caveman full mode. ${injected}`)
  assert.equal(appendFirstTurnMode("prompt", 3), `prompt\n\n---\n\nSwitch to caveman lite mode. ${injected}`)
  assert.equal(appendFirstTurnMode("prompt", 4), `prompt\n\n---\n\nSwitch to caveman lite mode. ${injected} Favor completeness over terseness when useful.`)
  assert.equal(appendFirstTurnMode(" prompt ", 5), " prompt ")
})

test("conversation URL fallback preserves project scope", () => {
  assert.equal(conversationUrlForStart("https://chatgpt.com/g/g-p-example/project", "conversation-1"), "https://chatgpt.com/g/g-p-example/c/conversation-1")
  assert.equal(conversationUrlForStart("https://chatgpt.com/", "conversation-1"), "https://chatgpt.com/c/conversation-1")
})

test("tool-facing ChatGPT defaults remain configured", () => {
  assert.equal(MCP_CONFIG.chatGpt.defaultOververbosity, 2)
  assert.equal(MCP_CONFIG.chatGpt.defaultPollWaitMs, 30_000)
  assert.equal(MCP_CONFIG.chatGpt.maxPollWaitMs, 270_000)
})
