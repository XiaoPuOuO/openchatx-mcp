import assert from "node:assert/strict"
import test from "node:test"

import { shouldShowMcpOAuthControls } from "../ui/src/features/mcp-servers/oauth-visibility.js"
import type { RemoteMcpServer } from "../ui/src/types.js"

const remote: RemoteMcpServer = {
  type: "remote",
  url: "https://mcp.example.com/mcp",
  enabled: true,
  dot: false,
}

test("OAuth settings stay hidden for normal Auto and header-authenticated MCP servers", () => {
  assert.equal(shouldShowMcpOAuthControls(remote), false)
  assert.equal(shouldShowMcpOAuthControls(remote, { status: "none" }), false)
  assert.equal(
    shouldShowMcpOAuthControls({ ...remote, headers: { Authorization: "Bearer legacy" } }),
    false
  )
  assert.equal(
    shouldShowMcpOAuthControls({ ...remote, auth: "none" }, { status: "auth_required" }),
    false
  )
  assert.equal(
    shouldShowMcpOAuthControls({ ...remote, auth: "headers" }, { status: "auth_required" }),
    false
  )
  assert.equal(
    shouldShowMcpOAuthControls({ ...remote, enabled: false }, { status: "auth_required" }),
    false
  )
  assert.equal(
    shouldShowMcpOAuthControls(
      { type: "local", command: ["node"], enabled: true, dot: false },
      { status: "auth_required" }
    ),
    false
  )
})

test("OAuth settings appear when needed and remain accessible after authorization", () => {
  assert.equal(shouldShowMcpOAuthControls(remote, { status: "auth_required" }), true)
  assert.equal(shouldShowMcpOAuthControls(remote, { status: "authorizing" }), true)
  assert.equal(shouldShowMcpOAuthControls(remote, { status: "error" }), true)
  assert.equal(shouldShowMcpOAuthControls(remote, { status: "none", oauthDetected: true }), true)
  assert.equal(shouldShowMcpOAuthControls({ ...remote, auth: "oauth" }), true)
  assert.equal(shouldShowMcpOAuthControls({ ...remote, auth: "oauth" }, { status: "none" }), true)
})
