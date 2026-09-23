import assert from "node:assert/strict"
import test from "node:test"

import { type AgentIdentity, getAgentIdentity } from "../../src/agent/context.js"
import {
  ChatGptDelegationError,
  type ChatGptDelegationService,
} from "../../src/tools/delegation/contracts.js"
import { connectClient, startMcpHttpServer, toolText } from "./helpers.js"

test("delivers a completed subagent event on the next MCP response exactly once", {
  timeout: 10_000,
}, async (t) => {
  const events = new Map<string, string[]>()
  const chatGptDelegation: ChatGptDelegationService = {
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
    drainEvents() {
      const key = getAgentIdentity()?.taskSlug ?? ""
      const pending = events.get(key) ?? []
      events.delete(key)
      return pending
    },
    async dispose() {},
  }
  const running = await startMcpHttpServer({ chatGptDelegation })
  t.after(() => running.close())
  const other = await connectClient(
    running.url,
    "other-subagent-event-client",
    undefined,
    false,
    "other-session"
  )
  t.after(() => other.client.close())
  await other.client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "other-subagent-session" },
  })
  const unrelated = await other.client.callTool({ name: "shell_list", arguments: {} })
  const unrelatedText = unrelated.content.find((item) => item.type === "text")
  assert.ok(unrelatedText?.type === "text")
  assert.doesNotMatch(unrelatedText.text, /agent_finished/u)

  const connected = await connectClient(
    running.url,
    "subagent-event-client",
    undefined,
    false,
    "launch-session"
  )
  t.after(() => connected.client.close())
  await connected.client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "subagent-events" },
  })
  events.set("subagent-events", ["agent_finished agent_id=reviewer turn_id=reviewer_turn_1"])

  const first = await connected.client.callTool({ name: "shell_list", arguments: {} })
  const firstText = first.content.find((item) => item.type === "text")
  assert.ok(firstText?.type === "text")
  assert.match(
    firstText.text,
    /\*\*Notice:\*\* agent_finished agent_id=reviewer turn_id=reviewer_turn_1/u
  )

  const second = await connected.client.callTool({ name: "shell_list", arguments: {} })
  const secondText = second.content.find((item) => item.type === "text")
  assert.ok(secondText?.type === "text")
  assert.doesNotMatch(secondText.text, /agent_finished/u)
})

test("runs staggered subagents and retrieves turns across MCP client sessions", {
  timeout: 15_000,
}, async (t) => {
  const histories = new Map<string, string[]>()
  const completed = new Map<string, string>()
  const starts: Array<{ agentId: string; at: number; parentAgent?: AgentIdentity }> = []
  let activePolls = 0
  let maxActivePolls = 0

  const chatGptDelegation: ChatGptDelegationService = {
    async ask({ agentId, prompt }, context) {
      if (agentId === "unavailable-agent") {
        throw new ChatGptDelegationError(
          "BROWSER_UNAVAILABLE",
          "Expected an already-running debuggable Chrome instance at http://127.0.0.1:9222."
        )
      }
      assert.ok(context.signal)
      starts.push({ agentId, at: Date.now(), parentAgent: getAgentIdentity() })
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
            status: "running",
            activity: "Searching the web",
            activityAgeMs: 2_750,
          }
        }
        if (turnId === "backend-failure") {
          return {
            status: "failed",
            errorCode: "BROWSER_UNAVAILABLE",
            errorMessage: "Chrome disconnected while observing the turn.",
          }
        }
        const response = completed.get(turnId)
        if (!response)
          throw new ChatGptDelegationError("UNKNOWN_TURN", `Unknown agent turn: ${turnId}`)
        return { status: "completed", response }
      } finally {
        activePolls -= 1
      }
    },
    drainEvents() {
      return []
    },
    async dispose() {},
  }

  const running = await startMcpHttpServer({ chatGptDelegation })
  t.after(() => running.close())

  const first = await connectClient(
    running.url,
    "subagent-client-1",
    undefined,
    false,
    "launch-session-1"
  )
  await first.client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "subagent-state" },
  })
  const started = await first.client.callTool({
    name: "subagent_run",
    arguments: {
      agents: [
        { agent_id: " architecture-reviewer ", prompt: "Review the architecture." },
        { agent_id: "test-reviewer", prompt: "Review the tests." },
      ],
    },
  })
  assert.equal(
    toolText(started),
    [
      "turns:",
      "",
      "- agent_id=architecture-reviewer turn_id=turn-architecture-reviewer-1 status=running",
      "- agent_id=test-reviewer turn_id=turn-test-reviewer-1 status=running",
    ].join("\n")
  )
  const [firstStart, secondStart] = starts
  assert.ok(firstStart)
  assert.ok(secondStart)
  assert.ok(secondStart.at - firstStart.at >= 4_500)
  assert.ok(firstStart.parentAgent)
  assert.equal(secondStart.parentAgent, firstStart.parentAgent)
  assert.equal(firstStart.parentAgent.taskSlug, "subagent-state")
  await first.client.close()

  const second = await connectClient(running.url, "subagent-client-2")
  t.after(() => second.client.close())
  const results = await second.client.callTool({
    name: "subagent_result",
    arguments: { turn_ids: ["turn-architecture-reviewer-1", "turn-test-reviewer-1"], wait_ms: 0 },
  })
  assert.equal(
    toolText(results),
    [
      "---- turn_id=turn-architecture-reviewer-1 status=completed ----",
      "",
      "architecture-reviewer:1:Review the architecture.",
      "",
      "---- turn_id=turn-test-reviewer-1 status=completed ----",
      "",
      "test-reviewer:1:Review the tests.",
    ].join("\n")
  )
  assert.equal(maxActivePolls, 2)

  const mixed = await second.client.callTool({
    name: "subagent_result",
    arguments: { turn_ids: ["turn-architecture-reviewer-1", "missing-turn"], wait_ms: 0 },
  })
  assert.equal(
    toolText(mixed),
    [
      "---- turn_id=turn-architecture-reviewer-1 status=completed ----",
      "",
      "architecture-reviewer:1:Review the architecture.",
      "",
      "---- turn_id=missing-turn status=failed ----",
      "",
      "UNKNOWN_TURN: Unknown agent turn: missing-turn",
    ].join("\n")
  )

  const heartbeat = await second.client.callTool({
    name: "subagent_result",
    arguments: { turn_ids: ["heartbeat-fixture"] },
  })
  assert.equal(
    toolText(heartbeat),
    '---- turn_id=heartbeat-fixture status=running activity="Searching the web" activity_age_ms=2750 ----'
  )

  const followUp = await second.client.callTool({
    name: "subagent_run",
    arguments: {
      agents: [{ agent_id: "architecture-reviewer", prompt: "Now critique your answer." }],
    },
  })
  assert.equal(
    toolText(followUp),
    "turns:\n\n- agent_id=architecture-reviewer turn_id=turn-architecture-reviewer-2 status=running"
  )

  const failedStart = await second.client.callTool({
    name: "subagent_run",
    arguments: { agents: [{ agent_id: "unavailable-agent", prompt: "Try to start." }] },
  })
  assert.equal(
    toolText(failedStart),
    [
      "turns:",
      "",
      "- agent_id=unavailable-agent status=failed",
      "",
      "  error:",
      "    SUBAGENT_UNAVAILABLE: The subagent service is temporarily unavailable. Retry the same subagent call once. If it fails again, continue without delegation. Do not change the task or prompt as a workaround.",
    ].join("\n")
  )

  const failedResult = await second.client.callTool({
    name: "subagent_result",
    arguments: { turn_ids: ["backend-failure"], wait_ms: 0 },
  })
  assert.equal(
    toolText(failedResult),
    "---- turn_id=backend-failure status=failed ----\n\nSUBAGENT_UNAVAILABLE: The subagent service is temporarily unavailable. Retry the same subagent call once. If it fails again, continue without delegation. Do not change the task or prompt as a workaround."
  )
})
