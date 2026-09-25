import assert from "node:assert/strict"
import test from "node:test"
import type { AgentIdentity } from "../../src/agent/context.js"
import { createAgentObserver } from "../../src/agent/observer.js"

test("tracks current and recent tool activity for one agent", () => {
  let timestamp = 1_000
  const observer = createAgentObserver(() => timestamp)
  const agent: AgentIdentity = {
    sessionId: "session-a",
    agent: "agent-1",
    taskSlug: "dashboard",
    projectId: "openchatx",
  }

  const callId = observer.startTool(agent, "bash", { command: "npm test" })
  assert.ok(callId)
  assert.deepEqual(observer.listAgents()[0]?.current, {
    id: callId,
    tool: "bash",
    summary: "npm test",
    detail: "npm test",
    detailLanguage: "bash",
    startedAt: 1_000,
    status: "running",
  })

  timestamp = 1_500
  observer.finishTool(agent, callId)
  const snapshot = observer.listAgents()[0]
  assert.equal(snapshot?.projectId, "openchatx")
  assert.equal(snapshot?.current, undefined)
  assert.equal(snapshot?.recent[0]?.status, "completed")
  assert.equal(snapshot?.recent[0]?.finishedAt, 1_500)
})

test("failed tool calls preserve the error reason for the dashboard", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1", taskSlug: "search" }

  const callId = observer.startTool(agent, "glob", {
    pattern: "**/*.png",
    path: "/Users/xiaopu",
  })
  observer.failTool(agent, callId, new Error("GLOB_FAILED: permission denied"))

  assert.deepEqual(
    {
      status: observer.listAgents()[0]?.recent[0]?.status,
      error: observer.listAgents()[0]?.recent[0]?.error,
    },
    {
      status: "failed",
      error: "GLOB_FAILED: permission denied",
    }
  )
})

test("failed MCP results preserve their text error for the dashboard", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1", taskSlug: "patch" }

  const callId = observer.startTool(agent, "apply_patch", { patch: "*** Begin Patch" })
  observer.failTool(agent, callId, {
    isError: true,
    content: [{ type: "text", text: "PATCH_FAILED: invalid patch" }],
  })

  assert.equal(observer.listAgents()[0]?.recent[0]?.error, "PATCH_FAILED: invalid patch")
})

test("completed file edits expose the resulting diff for the dashboard", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1", taskSlug: "edit" }

  const callId = observer.startTool(agent, "file_edit", {
    filePath: "/tmp/example.ts",
    oldString: "const before = true",
    newString: "const after = true",
  })
  observer.finishTool(agent, callId, {
    structuredContent: {
      path: "/tmp/example.ts",
      replacements: 1,
      diff: "--- before\n+++ after\n@@\n-const before = true\n+const after = true",
    },
  })

  assert.deepEqual(
    {
      resultDetail: observer.listAgents()[0]?.recent[0]?.resultDetail,
      resultDetailLanguage: observer.listAgents()[0]?.recent[0]?.resultDetailLanguage,
    },
    {
      resultDetail: "--- before\n+++ after\n@@\n-const before = true\n+const after = true",
      resultDetailLanguage: "diff",
    }
  )
})

test("completed file writes expose the resulting diff for the dashboard", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1", taskSlug: "write" }

  const callId = observer.startTool(agent, "file_write", {
    filePath: "/tmp/new.ts",
    content: "export const value = 1\n",
  })
  observer.finishTool(agent, callId, {
    structuredContent: {
      path: "/tmp/new.ts",
      created: true,
      diff: "--- before\n+++ after\n@@\n+export const value = 1",
    },
  })

  assert.equal(
    observer.listAgents()[0]?.recent[0]?.resultDetail,
    "--- before\n+++ after\n@@\n+export const value = 1"
  )
  assert.equal(observer.listAgents()[0]?.recent[0]?.resultDetailLanguage, "diff")
})

test("queues and delivers steering instructions once", () => {
  let timestamp = 2_000
  const observer = createAgentObserver(() => timestamp)
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1", taskSlug: "dashboard" }

  observer.startTool(agent, "bash", { command: "npm test" })
  const instruction = observer.queueInstruction("agent-1", " Focus only on the dashboard. ")
  assert.equal(instruction?.message, "Focus only on the dashboard.")

  timestamp = 2_500
  assert.deepEqual(observer.drainInstructions(agent), [
    "Human instruction: Focus only on the dashboard.",
  ])
  assert.deepEqual(observer.drainInstructions(agent), [])
  assert.equal(observer.listAgents()[0]?.instructions[0]?.deliveredAt, 2_500)
})

test("cancels queued steering instructions before delivery", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1" }

  observer.startTool(agent, "bash", { command: "pwd" })
  const instruction = observer.queueInstruction("agent-1", "Do not run tests")
  assert.ok(instruction)
  assert.equal(observer.cancelInstruction("agent-1", instruction.id), true)
  assert.deepEqual(observer.drainInstructions(agent), [])
  assert.deepEqual(observer.listAgents()[0]?.instructions, [])
})

test("does not cancel an instruction after it is delivered", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1" }

  observer.startTool(agent, "bash", { command: "pwd" })
  const instruction = observer.queueInstruction("agent-1", "Keep going")
  assert.ok(instruction)
  assert.deepEqual(observer.drainInstructions(agent), ["Human instruction: Keep going"])
  assert.equal(observer.cancelInstruction("agent-1", instruction.id), false)
})

test("keeps steering instructions scoped to the intended agent", () => {
  const observer = createAgentObserver()
  const first: AgentIdentity = { sessionId: "session-a", agent: "agent-1" }
  const second: AgentIdentity = { sessionId: "session-b", agent: "agent-2" }

  observer.startTool(first, "bash", { command: "pwd" })
  observer.startTool(second, "bash", { command: "pwd" })
  observer.queueInstruction("agent-2", "Second agent only")

  assert.deepEqual(observer.drainInstructions(first), [])
  assert.deepEqual(observer.drainInstructions(second), ["Human instruction: Second agent only"])
})

test("emits snapshots when agent state changes", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1" }
  const events: string[] = []
  const unsubscribe = observer.subscribe((event) => events.push(`${event.type}:${event.agent.id}`))

  const callId = observer.startTool(agent, "fetch_url", { url: "https://example.com" })
  observer.finishTool(agent, callId)
  unsubscribe()

  assert.deepEqual(events, ["agent_changed:agent-1", "agent_changed:agent-1"])
})

test("keeps concurrent tool calls from the same agent", () => {
  let timestamp = 3_000
  const observer = createAgentObserver(() => timestamp)
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1" }

  const first = observer.startTool(agent, "bash", { command: "npm test" })
  timestamp = 3_100
  const second = observer.startTool(agent, "fetch_url", { url: "https://example.com" })
  assert.equal(observer.listAgents()[0]?.current?.id, second)

  timestamp = 3_200
  observer.finishTool(agent, second)
  assert.equal(observer.listAgents()[0]?.current?.id, first)

  timestamp = 3_300
  observer.finishTool(agent, first)
  const snapshot = observer.listAgents()[0]
  assert.equal(snapshot?.current, undefined)
  assert.deepEqual(
    snapshot?.recent.map((call) => call.id),
    [first, second]
  )
})
