import assert from "node:assert/strict"
import test from "node:test"
import type { Request } from "express"
import {
  forgetAgentIdentity,
  getAgentIdentity,
  resolveAgentId,
  runWithAgent,
  runWithAgentId,
  setAgentTaskSlug,
} from "../src/agent/context.js"
import { createAgentObserver } from "../src/agent/observer.js"
import { requestHasDotWindow, requestSessionId } from "../src/server/http-server.js"

function requestWithHeaders(headers: Record<string, string>, body?: unknown): Request {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  )
  return {
    body,
    get(name: string) {
      return normalized[name.toLowerCase()]
    },
  } as unknown as Request
}

test("accepts the standard MCP session header", () => {
  assert.equal(
    requestSessionId(requestWithHeaders({ "mcp-session-id": "mcp-session-123" })),
    "mcp-session-123"
  )
})

test("prefers the OpenAI session header", () => {
  assert.equal(
    requestSessionId(
      requestWithHeaders({
        "x-openai-session": "openai-session",
        "mcp-session-id": "mcp-session",
      })
    ),
    "openai-session"
  )
})

test("accepts OpenAI conversation and session-id fallbacks", () => {
  assert.equal(
    requestSessionId(requestWithHeaders({ "x-openai-conversation-id": "conversation-1" })),
    "conversation-1"
  )
  assert.equal(
    requestSessionId(requestWithHeaders({ "x-openai-session-id": "session-id-1" })),
    "session-id-1"
  )
})

test("does not use windowId to split a shared parent MCP session", () => {
  const headers = { "x-openai-session": "shared-parent-session" }
  const first = requestSessionId(
    requestWithHeaders(headers, {
      method: "tools/call",
      params: { _meta: { windowId: "window-a" } },
    })
  )
  const second = requestSessionId(
    requestWithHeaders(headers, {
      method: "tools/call",
      params: { _meta: { windowId: "window-b" } },
    })
  )

  assert.equal(first, "shared-parent-session")
  assert.equal(second, first)
})

test("uses windowId only as a Dot source marker", () => {
  assert.equal(
    requestHasDotWindow({
      method: "tools/call",
      params: { _meta: { windowId: "dot-window" } },
    }),
    true
  )
  assert.equal(
    requestHasDotWindow({
      method: "tools/call",
      params: { _meta: { sessionId: "chat-session" } },
    }),
    false
  )
})

test("stable Agent UUIDs separate parallel Agents sharing one parent session", (t) => {
  const parentSession = "shared-dot-parent"
  const firstId = "123e4567-e89b-42d3-a456-426614174000"
  const secondId = "123e4567-e89b-42d3-a456-426614174001"
  t.after(() => {
    forgetAgentIdentity(`agent:${firstId}`)
    forgetAgentIdentity(`agent:${secondId}`)
  })

  const first = runWithAgent(parentSession, () => {
    const id = resolveAgentId(firstId)
    assert.equal(id, firstId)
    return runWithAgentId(id, () => {
      setAgentTaskSlug("task-a")
      return getAgentIdentity()!
    })
  })
  assert.equal(
    runWithAgent(parentSession, () => resolveAgentId()),
    undefined,
    "Agent identity is never inferred when agent_id is omitted"
  )

  const second = runWithAgent(parentSession, () => {
    const id = resolveAgentId(secondId)
    assert.equal(id, secondId)
    return runWithAgentId(id, () => {
      setAgentTaskSlug("task-b")
      return getAgentIdentity()!
    })
  })

  assert.notEqual(first.sessionId, second.sessionId)
  assert.equal(first.agentId, firstId)
  assert.equal(second.agentId, secondId)
  assert.equal(
    runWithAgentId(firstId, () => getAgentIdentity()?.taskSlug),
    "task-a"
  )
  assert.equal(
    runWithAgentId(secondId, () => getAgentIdentity()?.taskSlug),
    "task-b"
  )
  assert.equal(
    runWithAgent(parentSession, () => resolveAgentId()),
    undefined,
    "omitting agent_id never falls back to another Agent identity"
  )

  const observer = createAgentObserver()
  runWithAgentId(firstId, () =>
    observer.startTool(getAgentIdentity(), "bash", { command: "agent-a" })
  )
  runWithAgentId(secondId, () =>
    observer.startTool(getAgentIdentity(), "bash", { command: "agent-b" })
  )
  assert.deepEqual(
    observer
      .listAgents()
      .map((agent) => agent.agentId)
      .sort((left, right) => (left ?? "").localeCompare(right ?? "")),
    [firstId, secondId]
  )
})
