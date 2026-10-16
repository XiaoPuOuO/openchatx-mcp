import assert from "node:assert/strict"
import test from "node:test"

import type { Request } from "express"

import { requestSessionId } from "../src/server/http-server.js"

function requestWithHeaders(headers: Record<string, string>): Request {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  )
  return {
    get(name: string) {
      return normalized[name.toLowerCase()]
    },
  } as unknown as Request
}

test("Dot session identity accepts the standard MCP session header", () => {
  assert.equal(
    requestSessionId(requestWithHeaders({ "mcp-session-id": "dot-session-123" })),
    "dot-session-123"
  )
})

test("OpenAI session header remains the preferred session identity", () => {
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

test("Dot session identity accepts OpenAI conversation/session-id fallbacks", () => {
  assert.equal(
    requestSessionId(requestWithHeaders({ "x-openai-conversation-id": "conversation-1" })),
    "conversation-1"
  )
  assert.equal(
    requestSessionId(requestWithHeaders({ "x-openai-session-id": "session-id-1" })),
    "session-id-1"
  )
})
