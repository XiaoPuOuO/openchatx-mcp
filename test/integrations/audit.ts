import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { McpAuditLogger } from "../../src/server/audit/audit-log.js"
import type { ChatGptDelegationService } from "../../src/tools/delegation/contracts.js"
import { connectClient, startMcpHttpServer } from "./helpers.js"

test("audits tool calls made through the HTTP MCP boundary", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-audit-integration-"))
  const auditPath = join(root, "agent-commands.yaml")
  const chatGptDelegation: ChatGptDelegationService = {
    async ask({ agentId }) {
      return `turn-${agentId}`
    },
    async cloneSelf() {
      throw new Error("unused")
    },
    async cloneRun() {
      throw new Error("unused")
    },
    async poll(_turnId) {
      return { status: "completed", response: "done" }
    },
    drainEvents() {
      return []
    },
    async dispose() {},
  }
  const running = await startMcpHttpServer({
    port: 0,
    auditLogger: new McpAuditLogger(auditPath),
    chatGptDelegation,
  })
  t.after(async () => {
    await running.close()
    await rm(root, { recursive: true, force: true })
  })

  const connected = await connectClient(
    running.url,
    "audit-integration-client",
    undefined,
    false,
    "child-session"
  )
  t.after(() => connected.client.close())
  await connected.client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "audit-integration" },
  })
  await connected.client.callTool({ name: "shell_list", arguments: {} })
  await connected.client.callTool({
    name: "subagent_run",
    arguments: { agents: [{ agent_id: "audit-check", prompt: "Inspect the audit path." }] },
  })
  await connected.client.callTool({
    name: "shell_list",
    arguments: { then_run: { skill_list: {} } },
  })

  const log = await readFile(auditPath, "utf8")
  assert.match(log, /shell_list/u)
  assert.match(log, /args: \{\}/u)
  assert.match(log, /subagent_run/u)
  assert.match(log, /audit-check/u)
  assert.match(log, /Inspect the audit path\./u)
  assert.match(log, /--- # skill_list [\s\S]*?via: then_run/u)
  assert.match(log, /session: "agent-1"/u)
  assert.doesNotMatch(log, /child-session/u)
})
