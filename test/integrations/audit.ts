import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { McpAuditLogger } from "../../src/server/audit-log.js"
import type { ChatGptSubagentService } from "../../src/tools/subagent/chatgpt-subagent-contracts.js"
import { connectClient, startMcpHttpServer } from "./helpers.js"

test("audits tool calls made through the HTTP MCP boundary", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-audit-integration-"))
  const auditPath = join(root, "agent-commands.yaml")
  let observedToolCalls = 0
  const chatGptSubagents: ChatGptSubagentService = {
    async ask({ agentId }) {
      return { agentId, turnId: `turn-${agentId}`, status: "running" }
    },
    async poll(turnId) {
      return { turnId, status: "completed", response: "done" }
    },
    parentSessionForSession(sessionId) {
      return sessionId === "child-session" ? "parent-session" : undefined
    },
    observeSessionToolCall(sessionId, toolName) {
      observedToolCalls += 1
      return sessionId === "child-session" && toolName ? "parent-session" : undefined
    },
    async dispose() {},
  }
  const running = await startMcpHttpServer({
    port: 0,
    auditLogger: new McpAuditLogger(auditPath),
    chatGptSubagents,
  })
  t.after(async () => {
    await running.close()
    await rm(root, { recursive: true, force: true })
  })

  const connected = await connectClient(running.url, "audit-integration-client", undefined, false, "child-session")
  t.after(() => connected.client.close())
  await connected.client.callTool({ name: "shell_list", arguments: {} })
  await connected.client.callTool({
    name: "subagent_run",
    arguments: { agents: [{ agent_id: "audit-check", prompt: "Inspect the audit path." }] },
  })

  const log = await readFile(auditPath, "utf8")
  assert.match(log, /shell_list/)
  assert.match(log, /args: \{\}/)
  assert.match(log, /subagent_run/)
  assert.match(log, /audit-check/)
  assert.match(log, /Inspect the audit path\./)
  assert.match(log, /session: "child-session"/)
  assert.match(log, /parent_session: "parent-session"/)
  assert.equal(observedToolCalls, 2)
})
