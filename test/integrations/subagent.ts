import assert from "node:assert/strict"
import test from "node:test"

import type { ChatGptSubagentService } from "../../src/tools/subagent/chatgpt-subagent-contracts.js"
import { connectClient, startMcpHttpServer } from "./helpers.js"

test("delivers a completed subagent event on the next MCP response exactly once", { timeout: 10_000 }, async (t) => {
  const events = new Map<string, string[]>()
  const chatGptSubagents: ChatGptSubagentService = {
    async ask() {
      throw new Error("unused")
    },
    async cloneSelf() {
      throw new Error("unused")
    },
    async cloneRun() {
      throw new Error("unused")
    },
    async poll() {
      throw new Error("unused")
    },
    drainEvents(sessionId) {
      const pending = events.get(sessionId ?? "") ?? []
      events.delete(sessionId ?? "")
      return pending
    },
    async dispose() {},
  }
  const running = await startMcpHttpServer({ port: 0, chatGptSubagents, toolOutputStructured: "never" })
  t.after(() => running.close())
  const other = await connectClient(running.url, "other-subagent-event-client", undefined, false, "other-session")
  t.after(() => other.client.close())
  await other.client.callTool({ name: "start_here", arguments: { mode: "general" } })
  const unrelated = await other.client.callTool({ name: "shell_list", arguments: {} })
  const unrelatedText = unrelated.content.find((item) => item.type === "text")
  assert.ok(unrelatedText?.type === "text")
  assert.doesNotMatch(unrelatedText.text, /agent_finished/)

  const connected = await connectClient(running.url, "subagent-event-client", undefined, false, "launch-session")
  t.after(() => connected.client.close())
  await connected.client.callTool({ name: "start_here", arguments: { mode: "general" } })
  events.set("launch-session", ["agent_finished agent_id=reviewer turn_id=reviewer_turn_1"])

  const first = await connected.client.callTool({ name: "shell_list", arguments: {} })
  const firstText = first.content.find((item) => item.type === "text")
  assert.ok(firstText?.type === "text")
  assert.match(firstText.text, /\*\*Notice:\*\* agent_finished agent_id=reviewer turn_id=reviewer_turn_1/)

  const second = await connected.client.callTool({ name: "shell_list", arguments: {} })
  const secondText = second.content.find((item) => item.type === "text")
  assert.ok(secondText?.type === "text")
  assert.doesNotMatch(secondText.text, /agent_finished/)
})

test("runs staggered subagents and retrieves turns across MCP client sessions", { timeout: 15_000 }, async (t) => {
  const histories = new Map<string, string[]>()
  const completed = new Map<string, string>()
  const starts: Array<{ agentId: string; at: number; notificationSessionId?: string }> = []
  let activePolls = 0
  let maxActivePolls = 0

  const chatGptSubagents: ChatGptSubagentService = {
    async ask({ agentId, prompt }, context) {
      if (agentId === "unavailable-agent") throw new Error("browser unavailable")
      starts.push({ agentId, at: Date.now(), notificationSessionId: context.notificationSessionId })
      const history = histories.get(agentId) ?? []
      history.push(prompt)
      histories.set(agentId, history)
      const turnId = `turn-${agentId}-${history.length}`
      completed.set(turnId, `${agentId}:${history.length}:${prompt}`)
      return turnId
    },
    async cloneSelf() {
      throw new Error("unused")
    },
    async cloneRun() {
      throw new Error("unused")
    },
    async poll(turnId) {
      activePolls += 1
      maxActivePolls = Math.max(maxActivePolls, activePolls)
      try {
        await new Promise((resolve) => setTimeout(resolve, 25))
        if (turnId === "heartbeat-fixture") {
          return {
            turnId,
            status: "running",
            activity: "Searching the web",
            activityAgeMs: 2_750,
          }
        }
        const response = completed.get(turnId)
        if (!response) throw new Error(`unknown turn ${turnId}`)
        return { turnId, status: "completed", response }
      } finally {
        activePolls -= 1
      }
    },
    drainEvents() {
      return []
    },
    async dispose() {},
  }

  const running = await startMcpHttpServer({ port: 0, chatGptSubagents })
  t.after(() => running.close())

  const first = await connectClient(running.url, "subagent-client-1", undefined, false, "launch-session-1")
  await first.client.callTool({ name: "start_here", arguments: { mode: "general" } })
  const started = await first.client.callTool({
    name: "subagent_run",
    arguments: {
      agents: [
        { agent_id: " architecture-reviewer ", prompt: "Review the architecture." },
        { agent_id: "test-reviewer", prompt: "Review the tests." },
      ],
    },
  })
  assert.deepEqual(started.structuredContent, {
    turns: [
      { agent_id: "architecture-reviewer", turn_id: "turn-architecture-reviewer-1", status: "running" },
      { agent_id: "test-reviewer", turn_id: "turn-test-reviewer-1", status: "running" },
    ],
  })
  assert.ok(starts[1]!.at - starts[0]!.at >= 4_500)
  assert.equal(starts[0]!.notificationSessionId, "launch-session-1")
  assert.equal(starts[1]!.notificationSessionId, "launch-session-1")
  await first.client.close()

  const second = await connectClient(running.url, "subagent-client-2")
  t.after(() => second.client.close())
  const results = await second.client.callTool({
    name: "subagent_result",
    arguments: { turn_ids: ["turn-architecture-reviewer-1", "turn-test-reviewer-1"], wait_ms: 0 },
  })
  assert.deepEqual(results.structuredContent, {
    turns: [
      { turn_id: "turn-architecture-reviewer-1", status: "completed", response: "architecture-reviewer:1:Review the architecture." },
      { turn_id: "turn-test-reviewer-1", status: "completed", response: "test-reviewer:1:Review the tests." },
    ],
  })
  assert.equal(maxActivePolls, 2)

  const mixed = await second.client.callTool({
    name: "subagent_result",
    arguments: { turn_ids: ["turn-architecture-reviewer-1", "missing-turn"], wait_ms: 0 },
  })
  assert.deepEqual(mixed.structuredContent, {
    turns: [
      { turn_id: "turn-architecture-reviewer-1", status: "completed", response: "architecture-reviewer:1:Review the architecture." },
      { turn_id: "missing-turn", status: "failed", error: "subagent_failed: unknown turn missing-turn" },
    ],
  })

  const heartbeat = await second.client.callTool({ name: "subagent_result", arguments: { turn_ids: ["heartbeat-fixture"] } })
  assert.deepEqual(heartbeat.structuredContent, {
    turns: [{ turn_id: "heartbeat-fixture", status: "running", activity: "Searching the web", activity_age_ms: 2_750 }],
  })

  const followUp = await second.client.callTool({
    name: "subagent_run",
    arguments: { agents: [{ agent_id: "architecture-reviewer", prompt: "Now critique your answer." }] },
  })
  assert.deepEqual(followUp.structuredContent, {
    turns: [{ agent_id: "architecture-reviewer", turn_id: "turn-architecture-reviewer-2", status: "running" }],
  })

  const failedStart = await second.client.callTool({
    name: "subagent_run",
    arguments: { agents: [{ agent_id: "unavailable-agent", prompt: "Try to start." }] },
  })
  assert.deepEqual(failedStart.structuredContent, {
    turns: [{ agent_id: "unavailable-agent", status: "failed", error: "subagent_failed: browser unavailable" }],
  })
})
